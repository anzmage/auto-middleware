import type { Registry } from '../connectors/registry.ts';
import type { ChatMessage } from '../llm.ts';
import { validateWorkflow, type ValidationContext } from './validate.ts';

// Natural language rule -> workflow JSON. The model only proposes; the strict validator decides,
// and a person reviews the result before it can be activated. One repair round is attempted
// with the validator's errors.

export type Chat = (messages: ChatMessage[]) => Promise<string>;

export interface PlanResult { ok: boolean; definition: unknown; errors: string[]; attempts: number }

function catalog(registry: Registry, ctx: ValidationContext): string {
  const lines: string[] = ['CONNECTORS (use these exact names):'];
  for (const [name, info] of ctx.connectors) {
    lines.push(`- ${name} (type ${info.type})`);
    for (const t of info.schema?.tables ?? []) {
      lines.push(`    table ${t.name}: ${t.columns.map((c) => `${c.name} ${c.type}${c.key === 'PRI' ? ' PK' : ''}`).join(', ')}`);
    }
    if (info.schema?.note) lines.push(`    note: ${info.schema.note}`);
  }
  lines.push('', 'TRIGGERS:');
  for (const t of registry.enabled()) for (const tr of t.triggers) {
    lines.push(`- ${tr.type}: ${tr.description} params: ${Object.keys(tr.params).join(', ')}; ${tr.needsConnector ? `connector of type ${t.type} required` : 'no connector'}`);
  }
  lines.push('', 'ACTIONS:');
  for (const t of registry.enabled()) for (const a of t.actions) {
    lines.push(`- ${a.name} (connector type ${t.type}, ${a.kind}): ${a.description} target: ${Object.keys(a.target).join(', ') || 'none'}; mapping keys: ${a.mappingKeys === 'columns' ? 'columns of target.table' : 'free-form field names'}`);
  }
  return lines.join('\n');
}

const SHAPE = `{
  "name": "short human name",
  "trigger": { "type": "<trigger type>", "connector": "<name, only if required>", "params": { ... } },
  "steps": [
    { "id": "lowercase_id", "action": "<action>", "connector": "<name>", "target": { ... },
      "mapping": { "<destination field>": "{{trigger.<source field>}}" } }
  ]
}`;

export function buildMessages(rule: string, registry: Registry, ctx: ValidationContext): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You design integration workflows for a middleware. Reply with ONE JSON object and nothing else, in this shape:',
        SHAPE,
        'Rules:',
        '- Use only the connectors, triggers, actions, tables and columns listed below. Never invent names.',
        '- Templates: "{{trigger.<field>}}" for trigger data, "{{meta.event_key}}", "{{meta.workflow}}", "{{meta.now}}". Literal text is allowed around them.',
        '- Map every field the user asked for; when unspecified, map the obviously useful columns with readable destination names.',
        '- Do not add a "policy" key; safety policy is chosen by the reviewer.',
        '- If the request cannot be met with what is listed, return {"error": "<one sentence why>"}.',
        '',
        catalog(registry, ctx),
      ].join('\n'),
    },
    { role: 'user', content: rule },
  ];
}

function parse(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  return JSON.parse(trimmed);
}

export async function planWorkflow(rule: string, registry: Registry, ctx: ValidationContext, chat: Chat): Promise<PlanResult> {
  const messages = buildMessages(rule, registry, ctx);
  let definition: unknown = null;
  let errors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await chat(messages);
    try {
      definition = parse(reply);
    } catch {
      errors = ['model reply was not valid JSON'];
      messages.push({ role: 'assistant', content: reply }, { role: 'user', content: 'That was not valid JSON. Reply with the JSON object only.' });
      continue;
    }
    if (definition && typeof definition === 'object' && 'error' in definition) {
      return { ok: false, definition, errors: [String((definition as any).error)], attempts: attempt };
    }
    const result = validateWorkflow(definition, ctx);
    if (result.ok) return { ok: true, definition, errors: [], attempts: attempt };
    errors = result.errors;
    messages.push(
      { role: 'assistant', content: reply },
      { role: 'user', content: `The workflow is invalid:\n- ${errors.join('\n- ')}\nReturn a corrected JSON object.` },
    );
  }
  return { ok: false, definition, errors, attempts: 2 };
}
