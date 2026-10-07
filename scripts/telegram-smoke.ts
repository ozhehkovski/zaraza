import "dotenv/config";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Bot } from "grammy";
import { connect } from "../src/database/client.js";
import { migrate } from "../src/database/migrate.js";
import { Repository } from "../src/database/repository.js";
import { NotificationService } from "../src/notifications/service.js";
import { sql } from "drizzle-orm";
import type { Product } from "../src/providers/types.js";
// Explicitly run smoke test only for the single chat that has initiated this test bot.
const live = connect(process.env.DATABASE_URL!);
const url = new URL(process.env.DATABASE_URL!);
url.pathname = "/tracker_smoke";
const isolated = connect(url.href);
try {
  const receivers = await live.pool.query(
    "select telegram_id from users limit 2",
  );
  if (receivers.rows.length !== 1)
    throw new Error("Smoke test requires exactly one known test chat");
  const chatId = Number(receivers.rows[0].telegram_id);
  const before = await live.pool.query(
    "select count(*)::int as n from price_history",
  );
  await migrate(isolated.pool);
  const repo = new Repository(isolated.db);
  const product: Product = {
    store: "test",
    externalId: "simulation",
    name: "🧪 TEST — symulacja, nie jest to zmiana w Zara",
    url: "https://www.zara.com/pl/",
    image: null,
    currency: "PLN",
    currentPrice: 29900,
    originalPrice: null,
    variants: [
      { id: "simulation-M", size: "M", available: false, price: 29900 },
    ],
  };
  const p = await repo.product(product);
  await repo.apply(p.id, product, 60);
  const u = await repo.user(chatId);
  const [variant] = await repo.sizes(p.id);
  await repo.setDraft(u.id, p.id, "rule", variant.variant.id);
  await repo.watch(u.id, {
    watchPrice: true,
    watchStock: true,
    targetPrice: null,
  });
  await isolated.db.execute(sql`delete from notification_outbox`);
  await repo.apply(
    p.id,
    {
      ...product,
      currentPrice: 19900,
      variants: [{ ...product.variants[0], price: 19900, available: true }],
    },
    60,
  );
  assert.equal((await repo.pending()).length, 1);
  const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);
  await bot.init();
  // Keep real Telegram HTTP delivery, add an unmistakable test banner and remove live-action callbacks.
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === "sendMessage")
      return prev(
        method,
        {
          ...payload,
          text:
            "🧪 TEST BOTА — symulacja powiadomienia\nTo nie jest rzeczywista obniżka ani restock.\n\n" +
            (payload as any).text,
          reply_markup: undefined,
        } as any,
        signal,
      );
    return prev(method, payload, signal);
  });
  await new NotificationService(repo, bot.api).tick();
  const pending = await repo.pending();
  assert.equal(pending.length, 0);
  const delivered = await isolated.pool.query(
    "select count(*)::int as n from notification_outbox where sent_at is not null",
  );
  assert.equal(delivered.rows[0].n, 1);
  const after = await live.pool.query(
    "select count(*)::int as n from price_history",
  );
  assert.equal(
    before.rows[0].n,
    after.rows[0].n,
    "Live price history must stay untouched",
  );
  await repo.remove(u.id, (await repo.list(u.id))[0].watch.id);
  const report = {
    testedAt: new Date().toISOString(),
    telegramDelivery: true,
    events: ["PRICE_DROP", "RESTOCK"],
    simulated: true,
    isolatedDatabase: true,
    liveHistoryUntouched: true,
  };
  await writeFile(
    process.env.SMOKE_REPORT_PATH ?? "docs/telegram-smoke-results.json",
    JSON.stringify(report, null, 2),
  );
  console.log(report);
} finally {
  await live.pool.end();
  await isolated.pool.end();
}
