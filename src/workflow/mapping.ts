// Field mapping templates: "{{trigger.total}}", "Order #{{trigger.id}}", or a plain literal.
// A template that is exactly one placeholder keeps the source value's type (number, null, ...);
// anything else is rendered as text. There is no expression language on purpose: what runs is
// what was reviewed.

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;
const SINGLE = /^\{\{\s*([A-Za-z0-9_.]+)\s*\}\}$/;

export const META_FIELDS = ['event_key', 'workflow', 'now'];

export function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

export function lookup(context: Record<string, unknown>, path: string): unknown {
  let cur: unknown = context;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function renderValue(template: string, context: Record<string, unknown>): unknown {
  const single = template.match(SINGLE);
  if (single) {
    const v = lookup(context, single[1]);
    return v === undefined ? null : v;
  }
  return template.replace(PLACEHOLDER, (_, path) => {
    const v = lookup(context, path);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

export function renderMapping(mapping: Record<string, string>, context: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, template] of Object.entries(mapping)) out[key] = renderValue(template, context);
  return out;
}
