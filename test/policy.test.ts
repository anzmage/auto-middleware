import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionHash, decide, effectivePolicy } from '../src/workflow/policy.ts';

test('defaults are fail-closed by action kind', () => {
  assert.equal(decide({}, 'read'), 'ALLOW');
  assert.equal(decide({}, 'write'), 'ESCALATE');
  assert.equal(decide({}, 'delete'), 'BLOCK');
});

test('step overrides apply, but a delete never runs unattended', () => {
  assert.equal(decide({ policy: 'auto' }, 'write'), 'ALLOW');
  assert.equal(decide({ policy: 'deny' }, 'write'), 'BLOCK');
  assert.equal(effectivePolicy({ policy: 'auto' }, 'delete'), 'require_approval');
  assert.equal(decide({ policy: 'require_approval' }, 'delete'), 'ESCALATE');
});

test('action hash binds the exact action and ignores key order', () => {
  const base = { workflow_id: 1, step_id: 's1', action: 'webhook.post', connector: 'n', target: {}, payload: { a: 1, b: 'x' } };
  const same = { ...base, payload: { b: 'x', a: 1 } };
  assert.equal(actionHash(base), actionHash(same));
  assert.notEqual(actionHash(base), actionHash({ ...base, payload: { a: 2, b: 'x' } }));
  assert.notEqual(actionHash(base), actionHash({ ...base, connector: 'other' }));
});
