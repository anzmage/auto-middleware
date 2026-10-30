import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, readConfig, type Config } from './config.ts';
import { Store } from './db.ts';
import { defaultRegistry, type Registry } from './connectors/registry.ts';
import { Engine } from './workflow/engine.ts';
import { planWorkflow, type Chat } from './workflow/planner.ts';
import { chatJson } from './llm.ts';
import type { Workflow } from './workflow/types.ts';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC: Record<string, string> = {
  '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css',
};
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_BODY = 1024 * 1024;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'body must be JSON'); }
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export interface AppDeps { config: Config; store: Store; registry: Registry; chat: Chat }

export function createApp({ config, store, registry, chat }: AppDeps): { server: Server; engine: Engine } {
  const engine = new Engine(store, registry);

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), config.adminToken)) throw new HttpError(401, 'unauthorized');
    const m = req.method ?? 'GET';
    const parts = path.split('/').filter(Boolean); // ["api", ...]
    const [, resource, id, sub] = parts;

    if (resource === 'meta' && m === 'GET') {
      return send(res, 200, {
        llmConfigured: !!config.llm.apiKey, model: config.llm.model,
        types: registry.enabled().map((t) => ({
          type: t.type, description: t.description, configFields: t.configFields,
          triggers: t.triggers, actions: t.actions,
        })),
      });
    }

    if (resource === 'connectors') {
      if (!id && m === 'GET') return send(res, 200, store.listConnectors());
      if (!id && m === 'POST') {
        const b = await readJson(req);
        if (typeof b.name !== 'string' || !NAME.test(b.name)) throw new HttpError(400, 'name: lowercase letters, digits, - and _');
        if (!registry.type(b.type)) throw new HttpError(400, `unknown connector type ${b.type}`);
        if (!b.config || typeof b.config !== 'object') throw new HttpError(400, 'config must be an object');
        const fields = registry.type(b.type)!.configFields;
        for (const k of Object.keys(b.config)) if (!fields[k]) throw new HttpError(400, `config: unknown field ${k}`);
        for (const [k, f] of Object.entries(fields)) if (f.required && !b.config[k]) throw new HttpError(400, `config.${k} is required`);
        store.upsertConnector(b.name, b.type, b.config);
        engine.schemaCache.delete(b.name);
        return send(res, 201, { ok: true });
      }
      if (id && sub === 'schema' && m === 'GET') {
        if (!store.getConnector(id)) throw new HttpError(404, 'connector not found');
        return send(res, 200, await engine.schema(id, true));
      }
      if (id && !sub && m === 'DELETE') { store.deleteConnector(id); engine.schemaCache.delete(id); return send(res, 200, { ok: true }); }
    }

    if (resource === 'plan' && m === 'POST') {
      const b = await readJson(req);
      if (typeof b.rule !== 'string' || !b.rule.trim()) throw new HttpError(400, 'rule is required');
      return send(res, 200, await planWorkflow(b.rule.slice(0, 2000), registry, await engine.context(), chat));
    }

    if (resource === 'validate' && m === 'POST') {
      const b = await readJson(req);
      const r = await engine.validate(b.definition);
      return send(res, 200, { ok: r.ok, errors: r.errors });
    }

    if (resource === 'workflows') {
      if (!id && m === 'GET') return send(res, 200, store.listWorkflows().map(({ hook_secret, ...w }) => ({ ...w, has_hook_secret: !!hook_secret })));
      if (!id && m === 'POST') {
        const b = await readJson(req);
        const r = await engine.validate(b.definition);
        if (!r.ok) return send(res, 422, { ok: false, errors: r.errors });
        const newId = store.createWorkflow((b.definition as Workflow).name, String(b.rule ?? ''), b.definition);
        return send(res, 201, { ok: true, id: newId });
      }
      const wid = Number(id);
      const wf = store.getWorkflow(wid);
      if (!wf) throw new HttpError(404, 'workflow not found');
      if (!sub && m === 'PUT') {
        if (wf.status === 'active') throw new HttpError(409, 'pause the workflow before editing it');
        const b = await readJson(req);
        const r = await engine.validate(b.definition);
        if (!r.ok) return send(res, 422, { ok: false, errors: r.errors });
        store.updateWorkflowDefinition(wid, b.definition);
        return send(res, 200, { ok: true });
      }
      if (sub === 'activate' && m === 'POST') {
        const r = await engine.activate(wid);
        return send(res, r.ok ? 200 : 422, r);
      }
      if (sub === 'pause' && m === 'POST') { store.setWorkflowStatus(wid, 'paused'); return send(res, 200, { ok: true }); }
      if (!sub && m === 'DELETE') { store.deleteWorkflow(wid); return send(res, 200, { ok: true }); }
    }

    if (resource === 'approvals') {
      if (!id && m === 'GET') {
        const status = new URL(req.url ?? '', 'http://x').searchParams.get('status') ?? undefined;
        return send(res, 200, store.listApprovals(status));
      }
      if (sub === 'approve' && m === 'POST') { const r = await engine.approve(Number(id)); return send(res, r.ok ? 200 : 409, r); }
      if (sub === 'reject' && m === 'POST') { const r = engine.reject(Number(id)); return send(res, r.ok ? 200 : 409, r); }
    }

    if (resource === 'runs' && m === 'GET') return send(res, 200, store.listRuns());
    if (resource === 'poll' && m === 'POST') return send(res, 200, { handled: await engine.pollOnce() });

    throw new HttpError(404, 'not found');
  }

  async function hook(req: IncomingMessage, res: ServerResponse, path: string) {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const wf = engine.findHookWorkflow(path);
    const secret = String(req.headers['x-hook-secret'] ?? '');
    // Same answer for unknown path and wrong secret, so paths cannot be probed.
    if (!wf || !wf.hook_secret || !safeEqual(secret, wf.hook_secret)) throw new HttpError(404, 'not found');
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
    const eventId = String(req.headers['x-event-id'] ?? '') || randomUUID();
    const fresh = await engine.handleEvent(wf, `hook:${eventId.slice(0, 100)}`, body);
    return send(res, 202, { accepted: true, duplicate: !fresh });
  }

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'GET' && STATIC[path]) {
        const file = STATIC[path];
        res.writeHead(200, {
          'content-type': TYPES[file.split('.').pop()!],
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
        });
        return res.end(readFileSync(join(PUBLIC, file)));
      }
      if (path.startsWith('/api/')) return await api(req, res, path);
      if (path.startsWith('/hooks/')) return await hook(req, res, path.slice('/hooks/'.length));
      if (path === '/healthz') return send(res, 200, { ok: true });
      throw new HttpError(404, 'not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { ok: false, error: status === 500 ? 'internal error' : (e as Error).message });
    }
  });

  return { server, engine };
}

function main() {
  loadEnvFile();
  const config = readConfig();
  if (config.adminToken.length < 16) {
    console.error('ADMIN_TOKEN must be set to at least 16 characters (see .env.example).');
    process.exit(1);
  }
  const store = new Store(config.dbPath);
  const registry = defaultRegistry();
  const { server, engine } = createApp({ config, store, registry, chat: (msgs) => chatJson(config.llm, msgs) });
  const timer = setInterval(() => { engine.pollOnce().catch((e) => console.error('poll failed', e)); }, config.pollIntervalMs);
  server.listen(config.port, config.host, () => {
    console.log(`auto-middleware listening on http://${config.host}:${config.port} (poll every ${config.pollIntervalMs} ms)`);
  });
  const stop = async () => {
    clearInterval(timer);
    server.close();
    await registry.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main();
