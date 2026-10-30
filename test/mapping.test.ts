import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeholders, renderMapping, renderValue } from '../src/workflow/mapping.ts';

const ctx = { trigger: { id: 7, total: '12.50', note: null, nested: { city: 'Bandung' } }, meta: { event_key: 'orders:7' } };

test('a single placeholder keeps the source type', () => {
  assert.equal(renderValue('{{trigger.id}}', ctx), 7);
  assert.equal(renderValue('{{ trigger.total }}', ctx), '12.50');
  assert.equal(renderValue('{{trigger.note}}', ctx), null);
  assert.equal(renderValue('{{trigger.missing}}', ctx), null);
});

test('mixed templates render as text, missing values as empty', () => {
  assert.equal(renderValue('Order #{{trigger.id}} ({{trigger.missing}})', ctx), 'Order #7 ()');
  assert.equal(renderValue('{{trigger.nested.city}}!', ctx), 'Bandung!');
  assert.equal(renderValue('literal', ctx), 'literal');
});

test('lookups do not walk the prototype chain', () => {
  assert.equal(renderValue('{{trigger.constructor}}', ctx), null);
  assert.equal(renderValue('{{trigger.__proto__}}', ctx), null);
});

test('renderMapping and placeholders', () => {
  assert.deepEqual(renderMapping({ 'Order ID': '{{trigger.id}}', Key: '{{meta.event_key}}' }, ctx), { 'Order ID': 7, Key: 'orders:7' });
  assert.deepEqual(placeholders('{{a.b}} and {{ c.d }}'), ['a.b', 'c.d']);
});
