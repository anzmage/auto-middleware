import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRegistry } from '../src/connectors/registry.ts';
import { validateWorkflow, type ValidationContext } from '../src/workflow/validate.ts';
import { SHOP_SCHEMA } from './helpers.ts';

const ctx: ValidationContext = {
  registry: defaultRegistry(),
  connectors: new Map([
    ['shop_db', { type: 'mysql', schema: SHOP_SCHEMA }],
    ['sheet', { type: 'sheets', schema: { note: 'ok' } }],
    ['notify', { type: 'webhook', schema: { note: 'ok' } }],
  ]),
};

const valid = () => ({
  name: 'Orders to sheet',
  trigger: { type: 'mysql.new_row', connector: 'shop_db', params: { table: 'orders', cursor_column: 'id' } },
  steps: [
    { id: 'sheet', action: 'sheets.append_row', connector: 'sheet', target: { spreadsheet_id: 'abc', sheet: 'Orders' },
      mapping: { 'Order ID': '{{trigger.id}}', Total: '{{trigger.total}}', Key: '{{meta.event_key}}' } },
    { id: 'notify', action: 'webhook.post', connector: 'notify', target: {}, mapping: { text: 'New order {{trigger.id}} from {{trigger.customer}}' } },
    { id: 'audit', action: 'mysql.insert_row', connector: 'shop_db', target: { table: 'audit' }, mapping: { note: 'order {{trigger.id}}' }, policy: 'auto' },
  ],
});

test('accepts a well-formed workflow', () => {
  const r = validateWorkflow(valid(), ctx);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('rejects unknown keys everywhere', () => {
  const w: any = valid();
  w.extra = 1;
  w.trigger.retries = 3;
  w.steps[0].readonly = true;
  const r = validateWorkflow(w, ctx);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('workflow: unknown key "extra"')));
  assert.ok(r.errors.some((e) => e.includes('trigger: unknown key "retries"')));
  assert.ok(r.errors.some((e) => e.includes('steps[0]: unknown key "readonly"')));
});

test('rejects invented tables, columns, connectors and actions', () => {
  const w: any = valid();
  w.trigger.params.table = 'orderz';
  w.steps[1].connector = 'slack';
  w.steps[2].action = 'mysql.drop_table';
  const r = validateWorkflow(w, ctx);
  assert.ok(r.errors.some((e) => e.includes('trigger table "orderz" not found')));
  assert.ok(r.errors.some((e) => e.includes('connector "slack" does not exist')));
  assert.ok(r.errors.some((e) => e.includes('"mysql.drop_table" is not an available action')));
});

test('checks referenced trigger columns and insert columns', () => {
  const w: any = valid();
  w.steps[0].mapping.Email = '{{trigger.email}}';
  w.steps[2].mapping = { comment: 'x' };
  w.steps[1].mapping.x = '{{secrets.key}}';
  const r = validateWorkflow(w, ctx);
  assert.ok(r.errors.some((e) => e.includes('"{{trigger.email}}" is not a column of the trigger table')));
  assert.ok(r.errors.some((e) => e.includes('mapping key "comment" is not a column of audit')));
  assert.ok(r.errors.some((e) => e.includes('must start with trigger. or meta.')));
});

test('connector type must match the action', () => {
  const w: any = valid();
  w.steps[0].connector = 'notify';
  const r = validateWorkflow(w, ctx);
  assert.ok(r.errors.some((e) => e.includes('is a webhook connector, sheets.append_row needs sheets')));
});

test('webhook trigger takes no connector and a safe path', () => {
  const w: any = valid();
  w.trigger = { type: 'webhook.received', connector: 'notify', params: { path: 'New Lead!' } };
  w.steps = [w.steps[1]];
  const r = validateWorkflow(w, ctx);
  assert.ok(r.errors.some((e) => e.includes('takes no connector')));
  assert.ok(r.errors.some((e) => e.includes('path must be lowercase')));
});

test('upsert needs its key column mapped; bad policy and ids rejected', () => {
  const w: any = valid();
  w.steps[0].action = 'sheets.upsert_row';
  w.steps[0].target.key_column = 'Email';
  w.steps[1].policy = 'yolo';
  w.steps[2].id = 'sheet';
  const r = validateWorkflow(w, ctx);
  assert.ok(r.errors.some((e) => e.includes('key_column "Email" must also be a mapping key')));
  assert.ok(r.errors.some((e) => e.includes('policy must be one of')));
  assert.ok(r.errors.some((e) => e.includes('"sheet" is duplicated')));
});

test('website adapter is unavailable unless enabled', () => {
  const w: any = valid();
  w.steps = [{ id: 'web', action: 'website.run_task', connector: 'notify', target: { task: 'x' }, mapping: { a: 'b' } }];
  const r = validateWorkflow(w, ctx);
  assert.ok(r.errors.some((e) => e.includes('"website.run_task" is not an available action')));
});
