import { createHash } from 'node:crypto';
import type { ActionKind } from '../connectors/types.ts';
import type { PolicyMode, Step } from './types.ts';

// Every action passes one gate before it touches a system:
//   ALLOW    -> executed now
//   ESCALATE -> held in the approval queue, executed once after a human approves that exact payload
//   BLOCK    -> never executed, logged
// Defaults are fail-closed: writes wait for approval, deletes are blocked.

export type Decision = 'ALLOW' | 'ESCALATE' | 'BLOCK';

export const DEFAULT_POLICY: Record<ActionKind, PolicyMode> = {
  read: 'auto',
  write: 'require_approval',
  delete: 'deny',
};

export function effectivePolicy(step: Pick<Step, 'policy'>, kind: ActionKind): PolicyMode {
  const mode = step.policy ?? DEFAULT_POLICY[kind];
  // A delete can be approved by a human, but never runs unattended.
  if (kind === 'delete' && mode === 'auto') return 'require_approval';
  return mode;
}

export function decide(step: Pick<Step, 'policy'>, kind: ActionKind): Decision {
  const mode = effectivePolicy(step, kind);
  if (mode === 'auto') return 'ALLOW';
  if (mode === 'deny') return 'BLOCK';
  return 'ESCALATE';
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// Binds an approval to the exact action: workflow, step, action, connector, target and payload.
export function actionHash(a: {
  workflow_id: number; step_id: string; action: string; connector: string;
  target: Record<string, unknown>; payload: unknown;
}): string {
  return createHash('sha256').update(canonical(a)).digest('hex');
}
