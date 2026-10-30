import type { ConnectorType } from './types.ts';

// Placeholder for a website adapter in the style of Pomerado: explore a site once, record one
// worked example of a task, generalise it into a deterministic request sequence, then replay it.
// Off by default (ENABLE_WEBSITE_ADAPTER=1) and not implemented in this MVP; it exists so the
// connector interface is exercised by a third action shape.

export const websiteConnector: ConnectorType = {
  type: 'website',
  description: 'Website without an API (planned). Replays a recorded, generalised task deterministically.',
  configFields: {
    base_url: { required: true, description: 'Site origin' },
  },
  triggers: [],
  actions: [{
    name: 'website.run_task',
    kind: 'write',
    description: 'Run a recorded task with mapped inputs (not implemented in the MVP).',
    target: { task: { required: true, description: 'Recorded task name' } },
    mappingKeys: 'free',
  }],
  enabled: () => process.env.ENABLE_WEBSITE_ADAPTER === '1',

  async introspect() {
    return { note: 'Website adapter is a planned module; no tasks are recorded yet.' };
  },

  async execute() {
    throw new Error('website: adapter not implemented in this version');
  },
};
