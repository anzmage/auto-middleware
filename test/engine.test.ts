import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { Registry } from '../src/connectors/registry.ts';
import { webhookConnector } from '../src/connectors/webhook.ts';
import { sheetsConnector } from '../src/connectors/sheets.ts';
import { Engine } from '../src/workflow/engine.ts';
import { fakeMysql, SHOP_SCHEMA } from './helpers.ts';

function setup() {
  const orders: Record<string, unknown>[] = [
    { id: 1, customer: 'Old', total: '1.00', created_at: '2026-10-01 10:00:00' },
    { id: 2, customer: 'Old', total: '2.00', created_at: '2026-10-01 11:00:00' },
  ];
  const db = fakeMysql({ orders }, SHOP_SCHEMA);
  const store = new Store(':memory:');
  const engine = new Engine(store, new Registry([db, webhookConnector, sheetsConnector]));
  store.upsertConnector('shop_db', 'mysql', { host: 'x', user: 'x', database: 'shop' });
  const id = store.createWorkflow('Orders audit', 'rule', {
    name: 'Orders audit',
    trigger: { type: 'mysql.new_row', connector: 'shop_db', params: { table: 'orders', cursor_column: 'id' } },
    steps: [
      { id: 'auto_audit', action: 'mysql.insert_row', connector: 'shop_db', target: { table: 'audit' }, mapping: { note: 'order {{trigger.id}} {{trigger.total}}' }, policy: 'auto' },
      { id: 'held_audit', action: 'mysql.insert_row', connector: 'shop_db', target: { table: 'audit' }, mapping: { note: 'held {{trigger.id}}' } },
      { id: 'never', action: 'mysql.insert_row', connector: 'shop_db', target: { table: 'audit' }, mapping: { note: 'x' }, policy: 'deny' },
    ],
  });
  return { orders, db, store, engine, id };
}

test('activation starts the cursor at the newest row; only later rows fire', async () => {
  const { orders, db, store, engine, id } = setup();
  assert.deepEqual((await engine.activate(id)).errors, []);
  assert.equal(store.getCursor(id), '2');
  assert.equal(await engine.pollOnce(), 0);

  orders.push({ id: 3, customer: 'Ana', total: '12.50', created_at: '2026-10-30 09:00:00' });
  orders.push({ id: 4, customer: 'Budi', total: '7.00', created_at: '2026-10-30 09:01:00' });
  assert.equal(await engine.pollOnce(), 2);
  assert.equal(store.getCursor(id), '4');
  assert.deepEqual(db.inserted.map((i: any) => i.payload.note), ['order 3 12.50', 'order 4 7.00']);

  // Nothing new: no duplicate processing.
  assert.equal(await engine.pollOnce(), 0);
  assert.equal(db.inserted.length, 2);

  const runs = store.listRuns();
  assert.equal(runs.filter((r) => r.status === 'held').length, 2);
  assert.equal(runs.filter((r) => r.status === 'blocked').length, 2);
  assert.equal(store.listApprovals('pending').length, 2);
});

test('a reset cursor does not reprocess rows already handled', async () => {
  const { orders, db, store, engine, id } = setup();
  await engine.activate(id);
  orders.push({ id: 3, customer: 'Ana', total: '1', created_at: '' });
  await engine.pollOnce();
  store.setCursor(id, '2'); // e.g. crash before the cursor was saved
  assert.equal(await engine.pollOnce(), 0);
  assert.equal(db.inserted.length, 1);
  assert.ok(store.listRuns().some((r) => r.status === 'duplicate'));
});

test('approve executes the exact held action once; reject and replays are refused', async () => {
  const { orders, db, store, engine, id } = setup();
  await engine.activate(id);
  orders.push({ id: 3, customer: 'Ana', total: '1', created_at: '' }, { id: 4, customer: 'B', total: '2', created_at: '' });
  await engine.pollOnce();
  const [second, first] = store.listApprovals('pending');
  const before = db.inserted.length;

  assert.deepEqual(await engine.approve(first.id), { ok: true });
  assert.equal(db.inserted.length, before + 1);
  assert.deepEqual((db.inserted.at(-1) as any).payload, { note: 'held 3' });
  assert.equal(store.getApproval(first.id)!.status, 'executed');
  assert.equal((await engine.approve(first.id)).ok, false);
  assert.equal(db.inserted.length, before + 1);

  assert.equal(engine.reject(second.id).ok, true);
  assert.equal((await engine.approve(second.id)).ok, false);
  assert.equal(db.inserted.length, before + 1);
});

test('editing the step after an action was held invalidates the approval', async () => {
  const { orders, db, store, engine, id } = setup();
  await engine.activate(id);
  orders.push({ id: 3, customer: 'Ana', total: '1', created_at: '' });
  await engine.pollOnce();
  const [held] = store.listApprovals('pending');
  const wf = store.getWorkflow(id)!;
  (wf.definition as any).steps[1].target = { table: 'orders' };
  store.updateWorkflowDefinition(id, wf.definition);
  const before = db.inserted.length;
  const r = await engine.approve(held.id);
  assert.equal(r.ok, false);
  assert.equal(db.inserted.length, before);
  assert.equal(store.getApproval(held.id)!.status, 'rejected');
});

test('activation refuses an invalid workflow', async () => {
  const { store, engine } = setup();
  const bad = store.createWorkflow('bad', '', { name: 'bad', trigger: { type: 'mysql.new_row', connector: 'shop_db', params: { table: 'nope', cursor_column: 'id' } }, steps: [] });
  const r = await engine.activate(bad);
  assert.equal(r.ok, false);
  assert.equal(store.getWorkflow(bad)!.status, 'draft');
});
