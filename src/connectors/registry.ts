import type { ActionSpec, ConnectorType, TriggerSpec } from './types.ts';
import { mysqlConnector } from './mysql.ts';
import { sheetsConnector } from './sheets.ts';
import { webhookConnector } from './webhook.ts';
import { websiteConnector } from './website.ts';

// Adding a system = implementing ConnectorType and listing it here.
export class Registry {
  types = new Map<string, ConnectorType>();

  constructor(types: ConnectorType[]) {
    for (const t of types) this.types.set(t.type, t);
  }

  enabled(): ConnectorType[] {
    return [...this.types.values()].filter((t) => !t.enabled || t.enabled());
  }

  type(name: string): ConnectorType | undefined {
    const t = this.types.get(name);
    return t && (!t.enabled || t.enabled()) ? t : undefined;
  }

  action(name: string): { spec: ActionSpec; type: ConnectorType } | undefined {
    for (const t of this.enabled()) {
      const spec = t.actions.find((a) => a.name === name);
      if (spec) return { spec, type: t };
    }
    return undefined;
  }

  trigger(name: string): { spec: TriggerSpec; type: ConnectorType } | undefined {
    for (const t of this.enabled()) {
      const spec = t.triggers.find((tr) => tr.type === name);
      if (spec) return { spec, type: t };
    }
    return undefined;
  }

  async close(): Promise<void> {
    for (const t of this.types.values()) await t.close?.();
  }
}

export function defaultRegistry(): Registry {
  return new Registry([mysqlConnector, sheetsConnector, webhookConnector, websiteConnector]);
}
