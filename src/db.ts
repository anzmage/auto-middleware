import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ConnectorRow { name: string; type: string; config: Record<string, unknown>; created_at: string }
export interface WorkflowRow {
  id: number; name: string; rule: string; definition: unknown;
  status: 'draft' | 'active' | 'paused'; hook_secret: string | null; created_at: string;
}
export interface ApprovalRow {
  id: number; workflow_id: number; step_id: string; action: string; connector: string;
  payload: unknown; payload_hash: string; status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  event_key: string; created_at: string; decided_at: string | null;
}
export interface RunRow {
  id: number; workflow_id: number | null; step_id: string | null; event_key: string | null;
  decision: string; status: string; detail: string; created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connectors (
  name TEXT PRIMARY KEY, type TEXT NOT NULL, config TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, rule TEXT NOT NULL,
  definition TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', hook_secret TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS cursors (
  workflow_id INTEGER PRIMARY KEY, value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS events (
  workflow_id INTEGER NOT NULL, event_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (workflow_id, event_key));
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER NOT NULL, step_id TEXT NOT NULL,
  action TEXT NOT NULL, connector TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', event_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), decided_at TEXT);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, step_id TEXT, event_key TEXT,
  decision TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
`;

// Thin persistence layer over node:sqlite (no ORM, no native build step).
export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  // Connectors
  upsertConnector(name: string, type: string, config: Record<string, unknown>): void {
    this.db.prepare(`INSERT INTO connectors (name, type, config) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET type = excluded.type, config = excluded.config`)
      .run(name, type, JSON.stringify(config));
  }
  listConnectors(): ConnectorRow[] {
    return this.db.prepare('SELECT * FROM connectors ORDER BY name').all()
      .map((r: any) => ({ ...r, config: JSON.parse(r.config) }));
  }
  getConnector(name: string): ConnectorRow | undefined {
    const r: any = this.db.prepare('SELECT * FROM connectors WHERE name = ?').get(name);
    return r ? { ...r, config: JSON.parse(r.config) } : undefined;
  }
  deleteConnector(name: string): void {
    this.db.prepare('DELETE FROM connectors WHERE name = ?').run(name);
  }

  // Workflows
  createWorkflow(name: string, rule: string, definition: unknown): number {
    const r = this.db.prepare('INSERT INTO workflows (name, rule, definition) VALUES (?, ?, ?)')
      .run(name, rule, JSON.stringify(definition));
    return Number(r.lastInsertRowid);
  }
  updateWorkflowDefinition(id: number, definition: unknown): void {
    this.db.prepare('UPDATE workflows SET definition = ?, name = ? WHERE id = ?')
      .run(JSON.stringify(definition), String((definition as any)?.name ?? ''), id);
  }
  setWorkflowStatus(id: number, status: WorkflowRow['status'], hookSecret?: string | null): void {
    if (hookSecret === undefined) this.db.prepare('UPDATE workflows SET status = ? WHERE id = ?').run(status, id);
    else this.db.prepare('UPDATE workflows SET status = ?, hook_secret = ? WHERE id = ?').run(status, hookSecret, id);
  }
  listWorkflows(): WorkflowRow[] {
    return this.db.prepare('SELECT * FROM workflows ORDER BY id DESC').all()
      .map((r: any) => ({ ...r, definition: JSON.parse(r.definition) }));
  }
  getWorkflow(id: number): WorkflowRow | undefined {
    const r: any = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
    return r ? { ...r, definition: JSON.parse(r.definition) } : undefined;
  }
  deleteWorkflow(id: number): void {
    this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM cursors WHERE workflow_id = ?').run(id);
  }

  // Cursors and event de-duplication
  getCursor(workflowId: number): string | undefined {
    const r: any = this.db.prepare('SELECT value FROM cursors WHERE workflow_id = ?').get(workflowId);
    return r?.value;
  }
  setCursor(workflowId: number, value: string): void {
    this.db.prepare(`INSERT INTO cursors (workflow_id, value) VALUES (?, ?)
      ON CONFLICT(workflow_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
      .run(workflowId, value);
  }
  // Returns false when the event was already seen, so retries never act twice.
  claimEvent(workflowId: number, eventKey: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO events (workflow_id, event_key) VALUES (?, ?)')
      .run(workflowId, eventKey);
    return Number(r.changes) === 1;
  }

  // Approvals
  createApproval(a: Omit<ApprovalRow, 'id' | 'status' | 'created_at' | 'decided_at'>): number {
    const r = this.db.prepare(`INSERT INTO approvals (workflow_id, step_id, action, connector, payload, payload_hash, event_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(a.workflow_id, a.step_id, a.action, a.connector, JSON.stringify(a.payload), a.payload_hash, a.event_key);
    return Number(r.lastInsertRowid);
  }
  listApprovals(status?: string): ApprovalRow[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY id DESC').all(status)
      : this.db.prepare('SELECT * FROM approvals ORDER BY id DESC LIMIT 200').all();
    return rows.map((r: any) => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  getApproval(id: number): ApprovalRow | undefined {
    const r: any = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
    return r ? { ...r, payload: JSON.parse(r.payload) } : undefined;
  }
  // Compare-and-set so a double click cannot execute an approval twice.
  transitionApproval(id: number, from: string, to: string): boolean {
    const r = this.db.prepare(`UPDATE approvals SET status = ?, decided_at = datetime('now') WHERE id = ? AND status = ?`)
      .run(to, id, from);
    return Number(r.changes) === 1;
  }

  // Run log
  logRun(r: Omit<RunRow, 'id' | 'created_at'>): void {
    this.db.prepare('INSERT INTO runs (workflow_id, step_id, event_key, decision, status, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.workflow_id, r.step_id, r.event_key, r.decision, r.status, r.detail.slice(0, 4000));
  }
  listRuns(limit = 200): RunRow[] {
    return this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit) as any;
  }
}
