import { existsSync, readFileSync } from 'node:fs';

// Minimal .env loader: KEY=VALUE lines, # comments, optional surrounding quotes.
// Values already present in the environment win, so hosting dashboards override the file.
export function loadEnvFile(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export interface Config {
  host: string;
  port: number;
  adminToken: string;
  dbPath: string;
  pollIntervalMs: number;
  llm: { baseUrl: string; apiKey: string; model: string };
  enableWebsiteAdapter: boolean;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 8790),
    adminToken: env.ADMIN_TOKEN || '',
    dbPath: env.DB_PATH || 'data/auto-middleware.sqlite',
    pollIntervalMs: Number(env.POLL_INTERVAL_MS || 15000),
    llm: {
      baseUrl: (env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
      apiKey: env.LLM_API_KEY || '',
      model: env.LLM_MODEL || 'deepseek-chat',
    },
    enableWebsiteAdapter: env.ENABLE_WEBSITE_ADAPTER === '1',
  };
}
