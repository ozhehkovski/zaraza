import "dotenv/config";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import assert from "node:assert/strict";
import { connect } from "../src/database/client.js";
import { migrate } from "../src/database/migrate.js";
import { Repository } from "../src/database/repository.js";
import { MonitoringEngine } from "../src/monitor/engine.js";
import {
  ProviderRegistry,
  type Product,
  type StoreProvider,
} from "../src/providers/types.js";
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://tracker:tracker@localhost:5433/tracker_test";
if (databaseUrl === process.env.DATABASE_URL)
  throw new Error("Load test requires separate database");
const { db, pool } = connect(databaseUrl);
await migrate(pool);
const repo = new Repository(db);
let calls = 0,
  active = 0,
  maxActive = 0;
let price = 29900;
const product = (id: string): Product => ({
  store: "mock",
  externalId: id,
  url: `https://example.test/${id}`,
  name: `Mock ${id}`,
  image: null,
  currency: "PLN",
  currentPrice: price,
  originalPrice: null,
  variants: [{ id: `${id}-M`, size: "M", available: true, price }],
});
const provider: StoreProvider = {
  store: "mock",
  canHandle: (u) => u.startsWith("https://example.test"),
  async getProduct(url) {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return product(url.split("/").at(-1)!);
  },
  async getPrice() {
    return { currentPrice: price, originalPrice: null, currency: "PLN" };
  },
  async getAvailability() {
    return { variants: [] };
  },
  async getSizes() {
    return [];
  },
};
try {
  // Repeatable cleanup only of this test's mock store in isolated test DB.
  await db.execute(
    sql`delete from notification_outbox where watch_id in (select w.id from watches w join products p on p.id=w.product_id where p.store='mock')`,
  );
  await db.execute(
    sql`delete from watches where product_id in (select id from products where store='mock')`,
  );
  await db.execute(
    sql`delete from drafts where product_id in (select id from products where store='mock')`,
  );
  await db.execute(
    sql`delete from price_history where product_id in (select id from products where store='mock')`,
  );
  await db.execute(
    sql`delete from product_state where product_id in (select id from products where store='mock')`,
  );
  await db.execute(
    sql`delete from variants where product_id in (select id from products where store='mock')`,
  );
  await db.execute(sql`delete from products where store='mock'`);
  const users = await Promise.all(
    Array.from({ length: 100 }, (_, i) => repo.user(91000000 + i)),
  );
  const started = performance.now();
  for (let i = 0; i < 200; i++) {
    const p = await repo.product(product(String(i)));
    const [v] = await repo.sizes(p.id);
    for (let j = 0; j < 10; j++) {
      const u = users[(i + j) % 100];
      await repo.setDraft(u.id, p.id, "rule", v.variant.id);
      await repo.watch(u.id, {
        watchPrice: true,
        watchStock: true,
        targetPrice: null,
      });
    }
  }
  const engine = new MonitoringEngine(
    repo,
    new ProviderRegistry([provider]),
    60,
    10,
  );
  const start = performance.now();
  await engine.tick();
  const baselineMs = performance.now() - start;
  assert.equal(calls, 200);
  price = 19900;
  await db.execute(
    sql`update products set next_check_at=now() where store='mock'`,
  );
  calls = 0;
  const dropStart = performance.now();
  await engine.tick();
  const changeMs = performance.now() - dropStart;
  assert.equal(calls, 200);
  const out = await db.execute(
    sql`select count(*)::int as n from notification_outbox n join watches w on w.id=n.watch_id join products p on p.id=w.product_id where p.store='mock'`,
  );
  assert.equal(out.rows[0].n, 2000);
  const hist = await db.execute(
    sql`select count(*)::int as n from price_history h join products p on p.id=h.product_id where p.store='mock'`,
  );
  assert.equal(hist.rows[0].n, 400);
  await db.execute(
    sql`update products set next_check_at=now() where store='mock'`,
  );
  await engine.tick();
  const hist2 = await db.execute(
    sql`select count(*)::int as n from price_history h join products p on p.id=h.product_id where p.store='mock'`,
  );
  assert.equal(hist2.rows[0].n, 400);
  assert(baselineMs < 60000 && changeMs < 60000);
  const result = {
    testedAt: new Date().toISOString(),
    users: 100,
    products: 200,
    watches: 2000,
    requestsPerCycle: 200,
    maxConcurrency: maxActive,
    baselineMs: Math.round(baselineMs),
    changeMs: Math.round(changeMs),
    events: 2000,
    historyRecords: 400,
    totalMs: Math.round(performance.now() - started),
    passed: true,
  };
  await writeFile(
    "docs/load-test-results.json",
    JSON.stringify(result, null, 2),
  );
  console.log(result);
} finally {
  await pool.end();
}
