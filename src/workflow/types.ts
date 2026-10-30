export type PolicyMode = 'auto' | 'require_approval' | 'deny';

export interface Trigger {
  type: string;                          // "mysql.new_row" | "webhook.received"
  connector?: string;                    // required when the trigger type needs one
  params: Record<string, string>;
}

export interface Step {
  id: string;
  action: string;                        // e.g. "sheets.append_row"
  connector: string;                     // connector instance name
  target: Record<string, string>;        // static parameters (table, sheet, ...)
  mapping: Record<string, string>;       // destination field -> template, e.g. "{{trigger.total}}"
  policy?: PolicyMode;                   // overrides the default for the action kind
}

export interface Workflow {
  name: string;
  trigger: Trigger;
  steps: Step[];
}
