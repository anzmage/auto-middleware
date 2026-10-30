import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mysqlConnector } from '../src/connectors/mysql.ts';
import type { ConnectorType, SchemaInfo } from '../src/connectors/types.ts';

// An in-memory stand-in for a MySQL table, exposed through the real mysql connector's
// trigger/action specs so validation and the engine see exactly the same contract.
export function fakeMysql(tables: Record<string, Record<string, unknown>[]>, schema: SchemaInfo): ConnectorType & { inserted: unknown[] } {
  const inserted: unknown[] = [];
  return {
    ...mysqlConnector,
    inserted,
    async introspect() { return schema; },
    async currentCursor(_c, p) {
      const rows = tables[p.table] ?? [];
      return rows.length ? String(rows[rows.length - 1][p.cursor_column]) : null;
    },
    async poll(_c, p, cursor, limit) {
      const rows = (tables[p.table] ?? [])
        .filter((r) => cursor === null || Number(r[p.cursor_column]) > Number(cursor))
        .slice(0, limit);
      return { rows, cursor: rows.length ? String(rows[rows.length - 1][p.cursor_column]) : cursor };
    },
    async execute(action, target, payload) {
      inserted.push({ action, target, payload });
      return { insertId: inserted.length };
    },
    async close() {},
  };
}

export const SHOP_SCHEMA: SchemaInfo = {
  tables: [
    { name: 'orders', columns: [
      { name: 'id', type: 'int', key: 'PRI', nullable: false },
      { name: 'customer', type: 'varchar(100)', key: '', nullable: false },
      { name: 'total', type: 'decimal(10,2)', key: '', nullable: false },
      { name: 'created_at', type: 'datetime', key: '', nullable: false },
    ] },
    { name: 'audit', columns: [
      { name: 'id', type: 'int', key: 'PRI', nullable: false },
      { name: 'note', type: 'text', key: '', nullable: true },
    ] },
  ],
};

export interface Recorded { method: string; url: string; headers: IncomingMessage['headers']; body: string }

// Tiny programmable HTTP server for webhook / Google API mocks.
export async function mockServer(handler: (r: Recorded) => { status?: number; json?: unknown }): Promise<{ url: string; calls: Recorded[]; server: Server }> {
  const calls: Recorded[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const rec = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
    calls.push(rec);
    const out = handler(rec);
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.json ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, calls, server };
}
