import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/db.ts';
import { Registry } from '../src/connectors/registry.ts';
import { sheetsConnector } from '../src/connectors/sheets.ts';
import { webhookConnector } from '../src/connectors/webhook.ts';
import { readConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';
import { fakeMysql, mockServer, SHOP_SCHEMA } from './helpers.ts';

// Full HTTP flow with no external services: fake MySQL table, mock Google token + Sheets API
// (the real JWT signing path is exercised and verified), mock outbound webhook, scripted LLM.

const TOKEN = 'test-admin-token-1234567890';

test('describe -> review -> activate -> poll -> sheet row + held webhook -> approve', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sheetRows: unknown[][] = [];
  const google = await mockServer((r) => {
    if (r.url === '/token') {
      const assertion = new URLSearchParams(r.body).get('assertion')!;
      const [h, c, s] = assertion.split('.');
      const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'));
      return ok ? { json: { access_token: 'tok', expires_in: 3600 } } : { status: 401 };
    }
    if (r.headers.authorization !== 'Bearer tok') return { status: 401 };
    if (r.method === 'GET') return { json: { values: sheetRows.length ? [sheetRows[0]] : [] } };
    const values = JSON.parse(r.body).values;
    if (r.method === 'PUT') sheetRows[0] = values[0];
    else sheetRows.push(values[0]);
    return { json: { updates: { updatedRange: `Orders!A${sheetRows.length}` } } };
  });
  const hookTarget = await mockServer(() => ({ json: { received: true } }));

  process.env.TEST_SA_JSON = JSON.stringify({
    client_email: 'bot@test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: `${google.url}/token`,
  });

  const orders: Record<string, unknown>[] = [{ id: 10, customer: 'Old', total: '1.00', created_at: '2026-10-01 10:00:00' }];
  const registry = new Registry([fakeMysql({ orders }, SHOP_SCHEMA), sheetsConnector, webhookConnector]);
  const store = new Store(':memory:');
  const planned = {
    name: 'New orders',
    trigger: { type: 'mysql.new_row', connector: 'shop_db', params: { table: 'orders', cursor_column: 'id' } },
    steps: [
      { id: 'sheet', action: 'sheets.append_row', connector: 'sheet', target: { spreadsheet_id: 'S1', sheet: 'Orders' },
        mapping: { 'Order ID': '{{trigger.id}}', Customer: '{{trigger.customer}}', Total: '{{trigger.total}}' } },
      { id: 'notify', action: 'webhook.post', connector: 'notify', target: {}, mapping: { text: 'New order {{trigger.id}}', total: '{{trigger.total}}' } },
    ],
  };
  const replies = [JSON.stringify({ ...planned, steps: [{ ...planned.steps[0], connector: 'sheets_main' }, planned.steps[1]] }), JSON.stringify(planned)];
  let chatCalls = 0;
  const { server } = createApp({
    config: { ...readConfig({}), adminToken: TOKEN },
    store, registry,
    chat: async () => replies[chatCalls++],
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  after(() => { server.close(); google.server.close(); hookTarget.server.close(); });

  const call = async (method: string, path: string, body?: unknown, token = TOKEN) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() as any };
  };

  // Auth and static UI
  assert.equal((await call('GET', '/api/meta', undefined, 'wrong')).status, 401);
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy')!, /script-src 'self'/);

  // Connectors
  assert.equal((await call('POST', '/api/connectors', { name: 'shop_db', type: 'mysql', config: { host: 'h', user: 'u', database: 'shop', password: 'plain' } })).status, 400, 'plain secrets rejected');
  assert.equal((await call('POST', '/api/connectors', { name: 'shop_db', type: 'mysql', config: { host: 'h', user: 'u', database: 'shop' } })).status, 201);
  assert.equal((await call('POST', '/api/connectors', { name: 'sheet', type: 'sheets', config: { credentials_env: 'TEST_SA_JSON', api_base: google.url } })).status, 201);
  assert.equal((await call('POST', '/api/connectors', { name: 'notify', type: 'webhook', config: { url: `${hookTarget.url}/in` } })).status, 201);
  const schema = await call('GET', '/api/connectors/shop_db/schema');
  assert.equal(schema.data.schema.tables[0].name, 'orders');

  // Plan: first reply names a missing connector, the repair round fixes it.
  const plan = await call('POST', '/api/plan', { rule: 'When a new order arrives, add it to the Orders sheet and notify.' });
  assert.equal(plan.data.ok, true);
  assert.equal(plan.data.attempts, 2);

  // Reviewer lets the sheet append run automatically; the webhook keeps the default approval.
  const def = plan.data.definition;
  def.steps[0].policy = 'auto';
  const saved = await call('POST', '/api/workflows', { rule: 'r', definition: def });
  assert.equal(saved.status, 201);
  const activated = await call('POST', `/api/workflows/${saved.data.id}/activate`);
  assert.equal(activated.data.ok, true);
  assert.equal((await call('PUT', `/api/workflows/${saved.data.id}`, { definition: def })).status, 409, 'active workflows are not editable');

  // A new row arrives.
  orders.push({ id: 11, customer: 'Ana', total: '12.50', created_at: '2026-10-30 09:00:00' });
  assert.equal((await call('POST', '/api/poll')).data.handled, 1);
  assert.deepEqual(sheetRows, [['Order ID', 'Customer', 'Total'], [11, 'Ana', '12.50']]);
  assert.equal(hookTarget.calls.length, 0, 'webhook waits for approval');

  const pending = (await call('GET', '/api/approvals?status=pending')).data;
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].payload.data, { text: 'New order 11', total: '12.50' });
  assert.equal((await call('POST', `/api/approvals/${pending[0].id}/approve`)).status, 200);
  assert.equal(hookTarget.calls.length, 1);
  assert.deepEqual(JSON.parse(hookTarget.calls[0].body), { text: 'New order 11', total: '12.50' });
  assert.equal((await call('POST', `/api/approvals/${pending[0].id}/approve`)).status, 409, 'no double execution');

  const runs = (await call('GET', '/api/runs')).data;
  assert.ok(runs.some((r: any) => r.step_id === 'sheet' && r.status === 'executed' && r.decision === 'ALLOW'));
  assert.ok(runs.some((r: any) => r.step_id === 'notify' && r.status === 'executed' && r.decision === 'APPROVED'));
});

test('inbound webhook trigger needs the per-workflow secret and de-duplicates by X-Event-Id', async () => {
  const hookTarget = await mockServer(() => ({ json: {} }));
  const store = new Store(':memory:');
  const { server } = createApp({
    config: { ...readConfig({}), adminToken: TOKEN }, store,
    registry: new Registry([webhookConnector]), chat: async () => '{}',
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  after(() => { server.close(); hookTarget.server.close(); });
  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  await fetch(`${base}/api/connectors`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'out', type: 'webhook', config: { url: hookTarget.url } }) });
  const saved = await (await fetch(`${base}/api/workflows`, { method: 'POST', headers: auth, body: JSON.stringify({ definition: {
    name: 'Lead relay', trigger: { type: 'webhook.received', params: { path: 'new-lead' } },
    steps: [{ id: 'relay', action: 'webhook.post', connector: 'out', target: {}, mapping: { name: '{{trigger.name}}' }, policy: 'auto' }],
  } }) })).json() as any;
  const act = await (await fetch(`${base}/api/workflows/${saved.id}/activate`, { method: 'POST', headers: auth })).json() as any;
  assert.ok(act.hookSecret);

  const post = (secret: string, eventId: string) => fetch(`${base}/hooks/new-lead`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hook-secret': secret, 'x-event-id': eventId },
    body: JSON.stringify({ name: 'Citra' }),
  });
  assert.equal((await post('wrong', 'e1')).status, 404);
  assert.equal((await post(act.hookSecret, 'e1')).status, 202);
  const dup = await (await post(act.hookSecret, 'e1')).json() as any;
  assert.equal(dup.duplicate, true);
  assert.equal(hookTarget.calls.length, 1);
  assert.deepEqual(JSON.parse(hookTarget.calls[0].body), { name: 'Citra' });
});
