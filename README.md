# Auto Middleware

Connect the systems you already have without writing integration code. Describe a rule in
plain language, review the workflow the AI proposes, and let it run deterministically, with
every write waiting for your approval until you trust it.

```
"When a new order appears in shop_db.orders, add the order id, customer and total
 to the Orders tab of our sales sheet, then notify our webhook."
```

becomes a validated workflow:

```
mysql.new_row (shop_db.orders, cursor id)
  ├─ sheets.append_row  → sales_sheet / Orders   { Order ID ← id, Customer ← customer, Total ← total }
  └─ webhook.post       → notify                 { message ← "New order #{{id}} …" }
```

One Node.js process, one SQLite file, one runtime dependency (`mysql2`). No build step.

## What it does

- **Reads the systems you connect.** MySQL schemas are introspected from
  `information_schema`; the model only sees real tables and columns.
- **Turns a sentence into a workflow.** Any OpenAI-compatible model (DeepSeek by default)
  proposes JSON; a strict validator rejects invented tables, columns, connectors, actions
  and unknown keys, and gives the model one chance to repair it.
- **Runs without AI.** Once saved, a workflow is plain data: trigger → field mapping →
  actions. No model call happens at run time, so runs are predictable and cheap.
- **Gates every action.** Each step gets a policy: `auto`, `require_approval` (default for
  writes) or `deny` (default for deletes). Held actions show the exact payload; approving
  executes that payload once, and changing the step's action, connector or target
  invalidates its pending approvals.
- **Never processes an event twice.** Polling uses a cursor column and an event ledger;
  inbound webhooks de-duplicate by `X-Event-Id`.
- **Logs everything.** Every decision (ALLOW / ESCALATE / BLOCK / APPROVED) and result is
  in the run log.

### Connectors in this version

| Connector | Triggers | Actions |
|---|---|---|
| MySQL / MariaDB | `mysql.new_row` (poll by id/timestamp cursor) | `mysql.insert_row` |
| Google Sheets (service account) | – | `sheets.append_row`, `sheets.upsert_row` (aligned to the header row) |
| Webhook | `webhook.received` (`POST /hooks/<path>` + per-workflow secret) | `webhook.post` |
| Website (planned, off) | – | `website.run_task` |

## Five-minute setup

Requirements: Node.js 22.18 or newer (TypeScript runs natively), or Docker.

```bash
git clone https://github.com/anzmage/auto-middleware.git
cd auto-middleware
npm install
cp .env.example .env        # set ADMIN_TOKEN (openssl rand -hex 24) and LLM_API_KEY
npm start                   # http://127.0.0.1:8790
```

or `docker compose up -d --build`.

Then in the browser:

1. **Connectors** → add your systems. Secrets are never stored in the database: give the
   *name* of an env var (`password_env: SHOP_DB_PASSWORD`) or a file path. Click **Schema**
   to check the connection.
2. **Workflows** → describe the rule → **Generate workflow** → review the trigger, every
   mapped field and each step's policy → **Save as draft** → **Activate**.
3. **Approvals** → approve or reject held writes. Set a step's policy to `auto` once you
   trust it.

Google Sheets: create a service account, download its JSON key, share the spreadsheet with
the service account's `client_email` as Editor, then point `credentials_file` (or
`credentials_env`) at the key.

Database access: use a dedicated MySQL user with `SELECT` on the watched tables and
`INSERT` only where a workflow writes.

## Architecture

```
            ┌──────────────── design time ────────────────┐
 rule text ─┤ planner: schemas + catalog → LLM → JSON     │
            │ validator: strict schema, real columns only  │──► draft ──► human review ──► active
            └──────────────────────────────────────────────┘
            ┌──────────────── run time (no LLM) ──────────┐
 MySQL poll ┤ trigger event ─► event ledger (dedupe)      │
 /hooks/... ┤   └─► per step: render mapping ─► policy    │
            │        ALLOW ─► connector.execute ─► log    │
            │        ESCALATE ─► approval queue ─► approve ─► execute once ─► log
            │        BLOCK ─► log                          │
            └──────────────────────────────────────────────┘
 SQLite: connectors · workflows · cursors · events · approvals · runs
```

```
src/
  server.ts            HTTP API, inbound hooks, static UI, poll scheduler
  db.ts                SQLite store (node:sqlite)
  llm.ts               OpenAI-compatible chat call (design time only)
  connectors/          types.ts, registry.ts, mysql.ts, sheets.ts, webhook.ts, website.ts
  workflow/            validate.ts, planner.ts, mapping.ts, policy.ts, engine.ts
public/                index.html, app.js, style.css (no build step)
test/                  unit, end-to-end (mocked services) and real-MySQL tests
```

Adding a system means implementing `ConnectorType` (describe, introspect, execute, and
optionally poll) and listing it in `connectors/registry.ts`.

## Tests

```bash
npm test             # unit + end-to-end with mocked Sheets/webhook and a fake table
npm run test:mysql   # same engine against a throwaway MySQL 8 container (Docker)
npm run smoke:llm    # one real planning call to the configured model
```

## Limitations (honest list)

- Early version. Three working connectors; the website adapter is a placeholder.
- Polling triggers detect **new** rows only (not updates or deletes). Use an auto-increment
  id as the cursor; a timestamp cursor can miss rows that share the same second.
- Steps of a workflow run independently: a held or failed step does not stop later steps,
  and there is no automatic retry yet (failures are in the run log).
- Mapping is substitution only (`{{trigger.field}}`); no conditions or computed values.
- One admin token, no user accounts or roles. Keep it on localhost or behind a reverse
  proxy with TLS.
- The model can still misunderstand intent while passing validation, which is why every
  workflow is reviewed before it is activated and writes default to approval.
- Inspired by other open-source projects; see [NOTICE](NOTICE).

## License

MIT © 2026 ZaidanLab
