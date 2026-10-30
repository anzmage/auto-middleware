// One real planning call against the configured LLM, with a sample schema and no database.
// Usage: LLM_API_KEY=... npm run smoke:llm
import { loadEnvFile, readConfig } from '../src/config.ts';
import { defaultRegistry } from '../src/connectors/registry.ts';
import { chatJson } from '../src/llm.ts';
import { planWorkflow } from '../src/workflow/planner.ts';

loadEnvFile();
const config = readConfig();
const registry = defaultRegistry();
const ctx = {
  registry,
  connectors: new Map([
    ['shop_db', { type: 'mysql', schema: { tables: [
      { name: 'orders', columns: [
        { name: 'id', type: 'int', key: 'PRI', nullable: false },
        { name: 'customer_name', type: 'varchar(100)', key: '', nullable: false },
        { name: 'email', type: 'varchar(200)', key: '', nullable: true },
        { name: 'grand_total', type: 'decimal(10,2)', key: '', nullable: false },
        { name: 'status', type: 'varchar(20)', key: '', nullable: false },
        { name: 'created_at', type: 'datetime', key: '', nullable: false },
      ] },
    ] } }],
    ['sales_sheet', { type: 'sheets', schema: { note: 'mapping keys become header cells' } }],
    ['notify', { type: 'webhook', schema: { note: 'POST target' } }],
  ]),
};
const rule = process.argv[2] ?? 'When a new order appears in shop_db, add the order number, customer, email and total to the "Orders" tab of spreadsheet 1AbCdEf, then send a short notification to notify.';

const started = Date.now();
const result = await planWorkflow(rule, registry, ctx, (m) => chatJson(config.llm, m));
console.log(JSON.stringify({ model: config.llm.model, ms: Date.now() - started, ...result }, null, 2));
process.exit(result.ok ? 0 : 1);
