import type { Registry } from '../connectors/registry.ts';
import type { SchemaInfo, Table } from '../connectors/types.ts';
import { META_FIELDS, placeholders } from './mapping.ts';
import type { Workflow } from './types.ts';

// Strict validation of a workflow definition. Whatever the LLM (or a person) produced is
// rejected unless every key, connector, action, target field and referenced column checks out.

export interface ConnectorInfo { type: string; schema?: SchemaInfo | null }
export interface ValidationContext { registry: Registry; connectors: Map<string, ConnectorInfo> }
export interface ValidationResult { ok: boolean; errors: string[]; workflow?: Workflow }

const ID = /^[a-z0-9_-]{1,32}$/;
const HOOK_PATH = /^[a-z0-9][a-z0-9-]{0,63}$/;
const POLICIES = ['auto', 'require_approval', 'deny'];
const MAX_STEPS = 10;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function onlyKeys(obj: Record<string, unknown>, allowed: string[], where: string, errors: string[]) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown key "${k}"`);
}

function stringRecord(v: unknown, where: string, errors: string[]): Record<string, string> | null {
  if (!isObj(v)) { errors.push(`${where} must be an object`); return null; }
  for (const [k, val] of Object.entries(v)) if (typeof val !== 'string') errors.push(`${where}.${k} must be a string`);
  return v as Record<string, string>;
}

function findTable(schema: SchemaInfo | null | undefined, name: string): Table | undefined {
  return schema?.tables?.find((t) => t.name === name);
}

export function validateWorkflow(input: unknown, ctx: ValidationContext): ValidationResult {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['workflow must be a JSON object'] };
  onlyKeys(input, ['name', 'trigger', 'steps'], 'workflow', errors);

  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) {
    errors.push('workflow.name must be a non-empty string (max 100 chars)');
  }

  // Trigger
  let triggerFields: Set<string> | null = null; // null = free-form source (webhook JSON)
  const trigger = input.trigger;
  if (!isObj(trigger)) {
    errors.push('workflow.trigger must be an object');
  } else {
    onlyKeys(trigger, ['type', 'connector', 'params'], 'trigger', errors);
    const found = typeof trigger.type === 'string' ? ctx.registry.trigger(trigger.type) : undefined;
    if (!found) {
      errors.push(`trigger.type "${String(trigger.type)}" is not an available trigger`);
    } else {
      const params = stringRecord(trigger.params ?? {}, 'trigger.params', errors) ?? {};
      onlyKeys(params, Object.keys(found.spec.params), 'trigger.params', errors);
      for (const [k, f] of Object.entries(found.spec.params)) {
        if (f.required && !params[k]) errors.push(`trigger.params.${k} is required`);
      }
      if (found.spec.needsConnector) {
        const c = typeof trigger.connector === 'string' ? ctx.connectors.get(trigger.connector) : undefined;
        if (!c) errors.push(`trigger.connector "${String(trigger.connector)}" does not exist`);
        else if (c.type !== found.type.type) errors.push(`trigger.connector "${trigger.connector}" is a ${c.type} connector, ${trigger.type} needs ${found.type.type}`);
        else if (trigger.type === 'mysql.new_row' && c.schema) {
          const table = findTable(c.schema, params.table);
          if (!table) errors.push(`trigger table "${params.table}" not found in ${trigger.connector}`);
          else {
            triggerFields = new Set(table.columns.map((col) => col.name));
            if (!triggerFields.has(params.cursor_column)) errors.push(`cursor_column "${params.cursor_column}" not found in ${params.table}`);
          }
        }
      } else if (trigger.connector !== undefined) {
        errors.push(`trigger "${trigger.type}" takes no connector`);
      }
      if (trigger.type === 'webhook.received' && params.path && !HOOK_PATH.test(params.path)) {
        errors.push('trigger.params.path must be lowercase letters, digits and dashes');
      }
    }
  }

  // Steps
  const steps = input.steps;
  if (!Array.isArray(steps) || steps.length === 0) errors.push('workflow.steps must be a non-empty array');
  else if (steps.length > MAX_STEPS) errors.push(`workflow.steps has more than ${MAX_STEPS} steps`);
  else {
    const ids = new Set<string>();
    steps.forEach((step, i) => {
      const where = `steps[${i}]`;
      if (!isObj(step)) { errors.push(`${where} must be an object`); return; }
      onlyKeys(step, ['id', 'action', 'connector', 'target', 'mapping', 'policy'], where, errors);
      if (typeof step.id !== 'string' || !ID.test(step.id)) errors.push(`${where}.id must match ${ID}`);
      else if (ids.has(step.id)) errors.push(`${where}.id "${step.id}" is duplicated`);
      else ids.add(step.id);
      if (step.policy !== undefined && !POLICIES.includes(step.policy as string)) {
        errors.push(`${where}.policy must be one of ${POLICIES.join(', ')}`);
      }

      const found = typeof step.action === 'string' ? ctx.registry.action(step.action) : undefined;
      if (!found) { errors.push(`${where}.action "${String(step.action)}" is not an available action`); return; }
      if (found.spec.kind === 'delete' && step.policy === 'auto') errors.push(`${where}: delete actions cannot run with policy auto`);

      const c = typeof step.connector === 'string' ? ctx.connectors.get(step.connector) : undefined;
      if (!c) errors.push(`${where}.connector "${String(step.connector)}" does not exist`);
      else if (c.type !== found.type.type) errors.push(`${where}.connector "${step.connector}" is a ${c.type} connector, ${step.action} needs ${found.type.type}`);

      const target = stringRecord(step.target ?? {}, `${where}.target`, errors) ?? {};
      onlyKeys(target, Object.keys(found.spec.target), `${where}.target`, errors);
      for (const [k, f] of Object.entries(found.spec.target)) {
        if (f.required && !target[k]) errors.push(`${where}.target.${k} is required`);
      }

      const mapping = stringRecord(step.mapping, `${where}.mapping`, errors);
      if (!mapping) return;
      const keys = Object.keys(mapping);
      if (keys.length === 0) errors.push(`${where}.mapping must map at least one field`);
      if (keys.length > 100) errors.push(`${where}.mapping maps more than 100 fields`);

      if (found.spec.mappingKeys === 'columns' && c?.schema) {
        const table = findTable(c.schema, target.table);
        if (!table) errors.push(`${where}.target.table "${target.table}" not found in ${step.connector}`);
        else {
          const cols = new Set(table.columns.map((col) => col.name));
          for (const k of keys) if (!cols.has(k)) errors.push(`${where}.mapping key "${k}" is not a column of ${target.table}`);
        }
      }
      if (step.action === 'sheets.upsert_row' && target.key_column && !keys.includes(target.key_column)) {
        errors.push(`${where}: key_column "${target.key_column}" must also be a mapping key`);
      }

      for (const [k, template] of Object.entries(mapping)) {
        for (const ref of placeholders(template)) {
          const [root, field, ...rest] = ref.split('.');
          if (root === 'meta') {
            if (!META_FIELDS.includes(field) || rest.length) errors.push(`${where}.mapping.${k}: unknown "{{${ref}}}"`);
          } else if (root !== 'trigger' || !field) {
            errors.push(`${where}.mapping.${k}: "{{${ref}}}" must start with trigger. or meta.`);
          } else if (triggerFields && !triggerFields.has(field)) {
            errors.push(`${where}.mapping.${k}: "{{${ref}}}" is not a column of the trigger table`);
          }
        }
      }
    });
  }

  return errors.length ? { ok: false, errors } : { ok: true, errors, workflow: input as unknown as Workflow };
}
