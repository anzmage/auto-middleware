import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { mysqlConnector } from '../src/connectors/mysql.ts';
import { Registry } from '../src/connectors/registry.ts';
import { webhookConnector } from '../src/connectors/webhook.ts';
import { Store } from '../src/db.ts';
import { Engine } from '../src/workflow/engine.ts';

// Runs only against a disposable database: `npm run test:mysql` starts one in Docker.
const port = process.env.MYSQL_TEST_PORT;
const skip = port ? false : 'set MYSQL_TEST_PORT (npm run test:mysql) to run against a throwaway MySQL';

test('real MySQL: introspection, cursor polling and insert through the engine', { skip }, async () => {
  process.env.AM_TEST_DB_PASSWORD = 'testpass';
  const config = { host: '127.0.0.1', port, user: 'root', database: 'am_test', password_env: 'AM_TEST_DB_PASSWORD' };
  const admin = await mysql.createConnection({ host: '127.0.0.1', port: Number(port), user: 'root', password: 'testpass' });
  after(async () => { await admin.end(); await mysqlConnector.close!(); });
  await admin.query('DROP DATABASE IF EXISTS am_test');
  await admin.query('CREATE DATABASE am_test');
  await admin.query('CREATE TABLE am_test.orders (id INT AUTO_INCREMENT PRIMARY KEY, customer VARCHAR(100) NOT NULL, total DECIMAL(10,2) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  await admin.query('CREATE TABLE am_test.audit (id INT AUTO_INCREMENT PRIMARY KEY, note TEXT)');
  await admin.query("INSERT INTO am_test.orders (customer, total) VALUES ('Old', 1.00)");

  const schema = await mysqlConnector.introspect(config);
  const orders = schema.tables!.find((t) => t.name === 'orders')!;
  assert.deepEqual(orders.columns.map((c) => c.name), ['id', 'customer', 'total', 'created_at']);
  assert.equal(orders.columns[0].key, 'PRI');

  const store = new Store(':memory:');
  const engine = new Engine(store, new Registry([mysqlConnector, webhookConnector]));
  store.upsertConnector('shop_db', 'mysql', config);
  const id = store.createWorkflow('Audit orders', '', {
    name: 'Audit orders',
    trigger: { type: 'mysql.new_row', connector: 'shop_db', params: { table: 'orders', cursor_column: 'id' } },
    steps: [{ id: 'audit', action: 'mysql.insert_row', connector: 'shop_db', target: { table: 'audit' },
      mapping: { note: 'order {{trigger.id}} by {{trigger.customer}}: {{trigger.total}}' }, policy: 'auto' }],
  });
  assert.deepEqual((await engine.activate(id)).errors, []);
  assert.equal(store.getCursor(id), '1');

  await admin.query("INSERT INTO am_test.orders (customer, total) VALUES ('Ana', 12.50), ('Budi; DROP TABLE audit', 7)");
  assert.equal(await engine.pollOnce(), 2);
  assert.equal(await engine.pollOnce(), 0);
  const [rows] = await admin.query('SELECT note FROM am_test.audit ORDER BY id');
  assert.deepEqual((rows as any[]).map((r) => r.note), ['order 2 by Ana: 12.50', 'order 3 by Budi; DROP TABLE audit: 7.00']);
});
