import mysql from 'mysql2/promise';
import type { ConnectorType, SchemaInfo, Table } from './types.ts';

// One pool per distinct connection config, created lazily.
const pools = new Map<string, mysql.Pool>();

function pool(config: Record<string, any>): mysql.Pool {
  const password = config.password_env ? process.env[config.password_env] ?? '' : '';
  const key = JSON.stringify([config.host, config.port, config.user, config.database, config.password_env]);
  let p = pools.get(key);
  if (!p) {
    p = mysql.createPool({
      host: config.host || '127.0.0.1',
      port: Number(config.port || 3306),
      user: config.user,
      password,
      database: config.database,
      connectionLimit: 3,
      dateStrings: true,      // keep DATETIME as text so cursors and payloads stay JSON-safe
      decimalNumbers: false,  // DECIMAL stays a string, no silent float rounding
    });
    pools.set(key, p);
  }
  return p;
}

function jsonSafe(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') out[k] = v.toString();
    else if (Buffer.isBuffer(v)) out[k] = v.toString('base64');
    else if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = v;
  }
  return out;
}

function cursorParam(value: string): string | number {
  return /^-?\d+$/.test(value) ? Number(value) : value;
}

export const mysqlConnector: ConnectorType = {
  type: 'mysql',
  description: 'MySQL / MariaDB database. Watches a table for new rows and can insert rows.',
  configFields: {
    host: { required: true, description: 'Hostname' },
    port: { required: false, description: 'Port (default 3306)' },
    user: { required: true, description: 'User (a read-mostly account is recommended)' },
    database: { required: true, description: 'Database name' },
    password_env: { required: false, description: 'Name of the env var holding the password' },
  },
  triggers: [{
    type: 'mysql.new_row',
    description: 'Fires once for every new row in a table, detected by an increasing cursor column (an auto-increment id is best).',
    params: {
      table: { required: true, description: 'Table to watch' },
      cursor_column: { required: true, description: 'Monotonically increasing column, e.g. id or created_at' },
    },
    needsConnector: true,
  }],
  actions: [{
    name: 'mysql.insert_row',
    kind: 'write',
    description: 'Insert one row into a table.',
    target: { table: { required: true, description: 'Table to insert into' } },
    mappingKeys: 'columns',
  }],

  async introspect(config): Promise<SchemaInfo> {
    const [rows] = await pool(config).query(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS ty, COLUMN_KEY AS k, IS_NULLABLE AS n
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [config.database],
    );
    const tables = new Map<string, Table>();
    for (const r of rows as any[]) {
      if (!tables.has(r.t)) tables.set(r.t, { name: r.t, columns: [] });
      tables.get(r.t)!.columns.push({ name: r.c, type: r.ty, key: r.k || '', nullable: r.n === 'YES' });
    }
    return { tables: [...tables.values()] };
  },

  async currentCursor(config, params) {
    const [rows] = await pool(config).query('SELECT MAX(??) AS m FROM ??', [params.cursor_column, params.table]);
    const m = (rows as any[])[0]?.m;
    return m === null || m === undefined ? null : String(m);
  },

  async poll(config, params, cursor, limit) {
    const col = params.cursor_column;
    const [rows] = cursor === null
      ? await pool(config).query('SELECT * FROM ?? ORDER BY ?? ASC LIMIT ?', [params.table, col, limit])
      : await pool(config).query('SELECT * FROM ?? WHERE ?? > ? ORDER BY ?? ASC LIMIT ?',
        [params.table, col, cursorParam(cursor), col, limit]);
    const list = (rows as Record<string, unknown>[]).map(jsonSafe);
    const last = list.length ? list[list.length - 1][col] : null;
    return { rows: list, cursor: last === null || last === undefined ? cursor : String(last) };
  },

  async execute(action, target, payload, config) {
    if (action !== 'mysql.insert_row') throw new Error(`mysql: unsupported action ${action}`);
    const [res] = await pool(config).query('INSERT INTO ?? SET ?', [target.table, payload]);
    return { insertId: (res as any).insertId, affectedRows: (res as any).affectedRows };
  },

  async close() {
    for (const p of pools.values()) await p.end();
    pools.clear();
  },
};
