// A connector type knows how to describe, inspect and act on one kind of system.
// Instances (a specific database, sheet account or endpoint) live in the store as
// { name, type, config }; secrets are never stored there, only env var names or file paths.

export type ActionKind = 'read' | 'write' | 'delete';

export interface FieldSpec { required: boolean; description: string }

export interface ActionSpec {
  name: string;                       // e.g. "sheets.append_row"
  kind: ActionKind;                   // drives the default safety policy
  description: string;
  target: Record<string, FieldSpec>;  // static parameters chosen when the workflow is designed
  // "columns": mapping keys must be columns of target.table in the introspected schema.
  // "free": mapping keys are free-form (sheet headers, JSON body fields).
  mappingKeys: 'columns' | 'free';
}

export interface TriggerSpec {
  type: string;                       // e.g. "mysql.new_row"
  description: string;
  params: Record<string, FieldSpec>;
  needsConnector: boolean;
}

export interface Column { name: string; type: string; key: string; nullable: boolean }
export interface Table { name: string; columns: Column[] }
export interface SchemaInfo { tables?: Table[]; note?: string }

export interface PollResult { rows: Record<string, unknown>[]; cursor: string | null }

export interface ConnectorType {
  type: string;
  description: string;
  configFields: Record<string, FieldSpec>;
  triggers: TriggerSpec[];
  actions: ActionSpec[];
  enabled?: () => boolean;
  introspect(config: Record<string, any>): Promise<SchemaInfo>;
  execute(action: string, target: Record<string, any>, payload: Record<string, unknown>, config: Record<string, any>): Promise<unknown>;
  // Polling triggers only.
  currentCursor?(config: Record<string, any>, params: Record<string, any>): Promise<string | null>;
  poll?(config: Record<string, any>, params: Record<string, any>, cursor: string | null, limit: number): Promise<PollResult>;
  close?(): Promise<void>;
}
