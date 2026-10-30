import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ConnectorType } from './types.ts';

// Google Sheets over the REST API with a service-account JWT (no googleapis dependency).
// Share the spreadsheet with the service account's client_email as Editor.

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }

const tokens = new Map<string, { token: string; exp: number }>();

function credentials(config: Record<string, any>): ServiceAccount {
  const raw = config.credentials_env
    ? process.env[config.credentials_env] ?? ''
    : readFileSync(config.credentials_file, 'utf8');
  const sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key) throw new Error('sheets: credentials need client_email and private_key');
  return sa;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

async function accessToken(config: Record<string, any>): Promise<string> {
  const sa = credentials(config);
  const cached = tokens.get(sa.client_email);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: tokenUri, iat: now, exp: now + 3600,
  }));
  const signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key);
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claims}.${b64url(signature)}`,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`sheets: token request failed (${res.status})`);
  const body: any = await res.json();
  tokens.set(sa.client_email, { token: body.access_token, exp: now + Number(body.expires_in || 3600) });
  return body.access_token;
}

async function api(config: Record<string, any>, method: string, path: string, body?: unknown): Promise<any> {
  const base = (config.api_base || 'https://sheets.googleapis.com').replace(/\/+$/, '');
  const res = await fetch(`${base}/v4/spreadsheets/${path}`, {
    method,
    headers: { authorization: `Bearer ${await accessToken(config)}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`sheets: ${method} failed (${res.status}) ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const quoteSheet = (sheet: string) => `'${String(sheet).replace(/'/g, "''")}'`;
const range = (target: Record<string, any>, a1: string) =>
  `${encodeURIComponent(target.spreadsheet_id)}/values/${encodeURIComponent(`${quoteSheet(target.sheet)}!${a1}`)}`;

export function columnLetter(index: number): string {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Places payload values under the matching header; new keys extend the header row.
export function alignToHeader(header: string[], payload: Record<string, unknown>): { header: string[]; row: unknown[]; headerChanged: boolean } {
  const next = [...header];
  for (const key of Object.keys(payload)) if (!next.includes(key)) next.push(key);
  const row = next.map((h) => (payload[h] === undefined || payload[h] === null ? '' : payload[h]));
  return { header: next, row, headerChanged: next.length !== header.length };
}

async function readHeader(config: Record<string, any>, target: Record<string, any>): Promise<string[]> {
  const r = await api(config, 'GET', range(target, '1:1'));
  return (r.values?.[0] ?? []).map(String);
}

async function writeHeader(config: Record<string, any>, target: Record<string, any>, header: string[]) {
  // RAW: values are stored as typed, never evaluated as formulas (blocks "=IMPORTXML(...)" injection).
  await api(config, 'PUT', `${range(target, `A1:${columnLetter(header.length - 1)}1`)}?valueInputOption=RAW`, { values: [header] });
}

export const sheetsConnector: ConnectorType = {
  type: 'sheets',
  description: 'Google Sheets via a service account. Appends or upserts rows aligned to the header row.',
  configFields: {
    credentials_file: { required: false, description: 'Path to the service-account JSON key file' },
    credentials_env: { required: false, description: 'Or: env var holding the service-account JSON' },
    api_base: { required: false, description: 'Override the API base URL (tests only)' },
  },
  triggers: [],
  actions: [
    {
      name: 'sheets.append_row',
      kind: 'write',
      description: 'Append one row. Values go under matching header cells; unknown keys become new header columns.',
      target: {
        spreadsheet_id: { required: true, description: 'The id in the sheet URL /spreadsheets/d/<id>/' },
        sheet: { required: true, description: 'Tab name, e.g. Orders' },
      },
      mappingKeys: 'free',
    },
    {
      name: 'sheets.upsert_row',
      kind: 'write',
      description: 'Update the row whose key column equals the mapped key value, or append it when missing.',
      target: {
        spreadsheet_id: { required: true, description: 'The id in the sheet URL' },
        sheet: { required: true, description: 'Tab name' },
        key_column: { required: true, description: 'Header name used to find the row; must also be a mapping key' },
      },
      mappingKeys: 'free',
    },
  ],

  async introspect(config) {
    await accessToken(config);
    return { note: 'Credentials OK. Sheets are schemaless here: mapping keys are matched to the header row (row 1) at run time.' };
  },

  async execute(action, target, payload, config) {
    const current = await readHeader(config, target);
    const { header, row, headerChanged } = alignToHeader(current, payload);
    if (headerChanged) await writeHeader(config, target, header);

    if (action === 'sheets.append_row') {
      const r = await api(config, 'POST',
        `${range(target, `A1:${columnLetter(header.length - 1)}1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { values: [row] });
      return { updatedRange: r.updates?.updatedRange };
    }
    if (action === 'sheets.upsert_row') {
      const keyIndex = header.indexOf(target.key_column);
      if (keyIndex < 0) throw new Error(`sheets: key column "${target.key_column}" not in header`);
      const col = await api(config, 'GET', range(target, `${columnLetter(keyIndex)}:${columnLetter(keyIndex)}`));
      const values: string[] = (col.values ?? []).map((v: unknown[]) => String(v?.[0] ?? ''));
      const found = values.findIndex((v, i) => i > 0 && v === String(payload[target.key_column] ?? ''));
      if (found < 0) {
        const r = await api(config, 'POST',
          `${range(target, `A1:${columnLetter(header.length - 1)}1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
          { values: [row] });
        return { appended: true, updatedRange: r.updates?.updatedRange };
      }
      const n = found + 1;
      const r = await api(config, 'PUT',
        `${range(target, `A${n}:${columnLetter(header.length - 1)}${n}`)}?valueInputOption=RAW`, { values: [row] });
      return { updated: true, updatedRange: r.updatedRange };
    }
    throw new Error(`sheets: unsupported action ${action}`);
  },
};
