import type { ConnectorType } from './types.ts';

// Outbound HTTP POST to a fixed URL. Inbound webhooks are a trigger handled by the server
// (POST /hooks/<path>), so they need no connector instance.

export const webhookConnector: ConnectorType = {
  type: 'webhook',
  description: 'Outbound HTTP endpoint. Sends the mapped fields as a JSON body.',
  configFields: {
    url: { required: true, description: 'https URL to POST to' },
    secret_header: { required: false, description: 'Header name for a shared secret, e.g. X-Signature' },
    secret_env: { required: false, description: 'Env var holding that secret' },
  },
  triggers: [{
    type: 'webhook.received',
    description: 'Fires when JSON is POSTed to /hooks/<path> with the workflow secret in the X-Hook-Secret header.',
    params: { path: { required: true, description: 'URL-safe name, e.g. new-lead' } },
    needsConnector: false,
  }],
  actions: [{
    name: 'webhook.post',
    kind: 'write',
    description: 'POST the mapped fields as JSON to the connector URL.',
    target: {},
    mappingKeys: 'free',
  }],

  async introspect(config) {
    const url = new URL(config.url);
    return { note: `POST target ${url.origin}${url.pathname}. Body fields are free-form.` };
  },

  async execute(action, _target, payload, config) {
    if (action !== 'webhook.post') throw new Error(`webhook: unsupported action ${action}`);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'auto-middleware/0.1' };
    if (config.secret_header && config.secret_env) headers[config.secret_header] = process.env[config.secret_env] ?? '';
    const res = await fetch(config.url, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
    });
    const text = (await res.text()).slice(0, 500);
    if (!res.ok) throw new Error(`webhook: ${res.status} ${text}`);
    return { status: res.status, body: text };
  },
};
