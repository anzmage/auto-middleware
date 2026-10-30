import { randomBytes } from 'node:crypto';
import type { Registry } from '../connectors/registry.ts';
import type { SchemaInfo } from '../connectors/types.ts';
import type { Store, WorkflowRow } from '../db.ts';
import { renderMapping } from './mapping.ts';
import { actionHash, decide } from './policy.ts';
import type { Step, Workflow } from './types.ts';
import { validateWorkflow, type ConnectorInfo, type ValidationContext } from './validate.ts';

// Deterministic runtime: trigger event -> render each step's mapping -> policy gate -> execute,
// hold for approval, or block. No model call happens here.

const POLL_BATCH = 50;

export class Engine {
  store: Store;
  registry: Registry;
  schemaCache = new Map<string, { schema: SchemaInfo | null; error?: string; at: number }>();
  private polling = false;

  constructor(store: Store, registry: Registry) {
    this.store = store;
    this.registry = registry;
  }

  async schema(name: string, refresh = false): Promise<{ schema: SchemaInfo | null; error?: string }> {
    const cached = this.schemaCache.get(name);
    if (cached && !refresh && Date.now() - cached.at < 5 * 60_000) return cached;
    const c = this.store.getConnector(name);
    const type = c && this.registry.type(c.type);
    let entry: { schema: SchemaInfo | null; error?: string; at: number };
    if (!c || !type) entry = { schema: null, error: 'unknown or disabled connector type', at: Date.now() };
    else {
      try { entry = { schema: await type.introspect(c.config), at: Date.now() }; }
      catch (e) { entry = { schema: null, error: (e as Error).message, at: Date.now() }; }
    }
    this.schemaCache.set(name, entry);
    return entry;
  }

  async context(): Promise<ValidationContext> {
    const connectors = new Map<string, ConnectorInfo>();
    for (const c of this.store.listConnectors()) {
      connectors.set(c.name, { type: c.type, schema: (await this.schema(c.name)).schema });
    }
    return { registry: this.registry, connectors };
  }

  async validate(definition: unknown) {
    return validateWorkflow(definition, await this.context());
  }

  async activate(id: number): Promise<{ ok: boolean; errors: string[]; hookSecret?: string }> {
    const wf = this.store.getWorkflow(id);
    if (!wf) return { ok: false, errors: ['workflow not found'] };
    const result = await this.validate(wf.definition);
    if (!result.ok) return { ok: false, errors: result.errors };
    const def = result.workflow!;
    const trig = this.registry.trigger(def.trigger.type)!;
    if (trig.type.poll && this.store.getCursor(id) === undefined) {
      // Start from "now": only rows created after activation fire the workflow.
      const c = this.store.getConnector(def.trigger.connector!)!;
      const cursor = await trig.type.currentCursor!(c.config, def.trigger.params);
      this.store.setCursor(id, cursor ?? '');
    }
    let hookSecret: string | undefined;
    if (def.trigger.type === 'webhook.received') {
      hookSecret = wf.hook_secret || randomBytes(24).toString('base64url');
      this.store.setWorkflowStatus(id, 'active', hookSecret);
    } else {
      this.store.setWorkflowStatus(id, 'active');
    }
    this.store.logRun({ workflow_id: id, step_id: null, event_key: null, decision: '-', status: 'activated', detail: def.name });
    return { ok: true, errors: [], hookSecret };
  }

  // Runs one trigger event through every step. Returns false for duplicates.
  async handleEvent(wf: WorkflowRow, eventKey: string, data: Record<string, unknown>): Promise<boolean> {
    if (!this.store.claimEvent(wf.id, eventKey)) {
      this.store.logRun({ workflow_id: wf.id, step_id: null, event_key: eventKey, decision: '-', status: 'duplicate', detail: 'event already processed' });
      return false;
    }
    const def = wf.definition as Workflow;
    const context = { trigger: data, meta: { event_key: eventKey, workflow: def.name, now: new Date().toISOString() } };
    for (const step of def.steps) await this.runStep(wf.id, step, eventKey, context);
    return true;
  }

  private async runStep(workflowId: number, step: Step, eventKey: string, context: Record<string, unknown>) {
    const found = this.registry.action(step.action);
    if (!found) {
      this.store.logRun({ workflow_id: workflowId, step_id: step.id, event_key: eventKey, decision: 'BLOCK', status: 'failed', detail: `action ${step.action} unavailable` });
      return;
    }
    const payload = renderMapping(step.mapping, context);
    const decision = decide(step, found.spec.kind);
    const base = { workflow_id: workflowId, step_id: step.id, event_key: eventKey };

    if (decision === 'BLOCK') {
      this.store.logRun({ ...base, decision, status: 'blocked', detail: `policy deny for ${step.action}` });
      return;
    }
    if (decision === 'ESCALATE') {
      const hash = actionHash({ workflow_id: workflowId, step_id: step.id, action: step.action, connector: step.connector, target: step.target, payload });
      const approvalId = this.store.createApproval({
        workflow_id: workflowId, step_id: step.id, action: step.action, connector: step.connector,
        payload: { target: step.target, data: payload }, payload_hash: hash, event_key: eventKey,
      });
      this.store.logRun({ ...base, decision, status: 'held', detail: `approval #${approvalId}` });
      return;
    }
    await this.execute(workflowId, step.id, eventKey, step.action, step.connector, step.target, payload, decision);
  }

  private async execute(workflowId: number, stepId: string, eventKey: string, action: string,
    connectorName: string, target: Record<string, string>, payload: Record<string, unknown>, decision: string): Promise<boolean> {
    const base = { workflow_id: workflowId, step_id: stepId, event_key: eventKey, decision };
    const c = this.store.getConnector(connectorName);
    const found = this.registry.action(action);
    if (!c || !found || c.type !== found.type.type) {
      this.store.logRun({ ...base, status: 'failed', detail: `connector ${connectorName} missing or wrong type` });
      return false;
    }
    try {
      const result = await found.type.execute(action, target, payload, c.config);
      this.store.logRun({ ...base, status: 'executed', detail: JSON.stringify(result ?? null) });
      return true;
    } catch (e) {
      this.store.logRun({ ...base, status: 'failed', detail: (e as Error).message });
      return false;
    }
  }

  // Approving executes the held action exactly once, and only if it still matches what was
  // queued and the workflow step has not been changed since.
  async approve(id: number): Promise<{ ok: boolean; error?: string }> {
    const a = this.store.getApproval(id);
    if (!a) return { ok: false, error: 'approval not found' };
    if (a.status !== 'pending') return { ok: false, error: `approval is ${a.status}` };
    const { target, data } = a.payload as { target: Record<string, string>; data: Record<string, unknown> };
    const hash = actionHash({ workflow_id: a.workflow_id, step_id: a.step_id, action: a.action, connector: a.connector, target, payload: data });
    const wf = this.store.getWorkflow(a.workflow_id);
    const step = (wf?.definition as Workflow | undefined)?.steps.find((s) => s.id === a.step_id);
    const unchanged = step && step.action === a.action && step.connector === a.connector
      && JSON.stringify(step.target) === JSON.stringify(target);
    if (hash !== a.payload_hash || !unchanged) {
      this.store.transitionApproval(id, 'pending', 'rejected');
      this.store.logRun({ workflow_id: a.workflow_id, step_id: a.step_id, event_key: a.event_key, decision: 'BLOCK', status: 'rejected', detail: 'approval no longer matches the workflow or payload' });
      return { ok: false, error: 'held action no longer matches the workflow; rejected' };
    }
    if (!this.store.transitionApproval(id, 'pending', 'approved')) return { ok: false, error: 'approval was already decided' };
    const ok = await this.execute(a.workflow_id, a.step_id, a.event_key, a.action, a.connector, target, data, 'APPROVED');
    this.store.transitionApproval(id, 'approved', ok ? 'executed' : 'failed');
    return ok ? { ok: true } : { ok: false, error: 'execution failed, see run log' };
  }

  reject(id: number): { ok: boolean; error?: string } {
    const a = this.store.getApproval(id);
    if (!a || !this.store.transitionApproval(id, 'pending', 'rejected')) return { ok: false, error: 'not a pending approval' };
    this.store.logRun({ workflow_id: a.workflow_id, step_id: a.step_id, event_key: a.event_key, decision: 'REJECTED', status: 'rejected', detail: `approval #${id}` });
    return { ok: true };
  }

  // One pass over every active polling workflow. Cursor advances row by row, so a crash
  // mid-batch resumes after the last processed row; claimEvent prevents double processing.
  async pollOnce(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    let handled = 0;
    try {
      for (const wf of this.store.listWorkflows()) {
        if (wf.status !== 'active') continue;
        const def = wf.definition as Workflow;
        const trig = this.registry.trigger(def.trigger.type);
        if (!trig?.type.poll) continue;
        const c = this.store.getConnector(def.trigger.connector!);
        if (!c) continue;
        try {
          const stored = this.store.getCursor(wf.id);
          const cursor = stored === undefined || stored === '' ? null : stored;
          const { rows } = await trig.type.poll(c.config, def.trigger.params, cursor, POLL_BATCH);
          for (const row of rows) {
            const key = `${def.trigger.params.table}:${String(row[def.trigger.params.cursor_column])}`;
            if (await this.handleEvent(wf, key, row)) handled++;
            this.store.setCursor(wf.id, String(row[def.trigger.params.cursor_column]));
          }
        } catch (e) {
          this.store.logRun({ workflow_id: wf.id, step_id: null, event_key: null, decision: '-', status: 'poll_error', detail: (e as Error).message });
        }
      }
    } finally {
      this.polling = false;
    }
    return handled;
  }

  findHookWorkflow(path: string): WorkflowRow | undefined {
    return this.store.listWorkflows().find((w) => w.status === 'active'
      && (w.definition as Workflow).trigger.type === 'webhook.received'
      && (w.definition as Workflow).trigger.params.path === path);
  }
}
