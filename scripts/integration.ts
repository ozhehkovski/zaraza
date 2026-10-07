import "dotenv/config";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { connect } from "../src/database/client.js";
import { migrate } from "../src/database/migrate.js";
import { Repository } from "../src/database/repository.js";
import { parseProduct } from "../src/providers/zara/parser.js";
import { ProviderRegistry } from "../src/providers/types.js";
import { ZaraProvider } from "../src/providers/zara/ZaraProvider.js";
import { createBot } from "../src/telegram/bot.js";
import { NotificationService } from "../src/notifications/service.js";
import { sql } from "drizzle-orm";
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://tracker:tracker@localhost:5433/tracker_integration";
if (databaseUrl === process.env.DATABASE_URL)
  throw new Error("Integration tests require a separate database");
const { db, pool } = connect(databaseUrl);
await migrate(pool);
const repo = new Repository(db);
const fixture = JSON.parse(
  await readFile("tests/fixtures/zara-details.json", "utf8"),
);
const url = "https://www.zara.com/pl/pl/anorak-p01255713.html?v1=545470428";
const provider = new ZaraProvider({ json: async () => fixture });
const bot = createBot(
  "123456789:TEST_ONLY_TOKEN_FOR_LOCAL_TESTS",
  repo,
  new ProviderRegistry([provider]),
  60,
);
bot.botInfo = {
  id: 123456789,
  is_bot: true,
  first_name: "Test",
  username: "test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
} as any;
const responses: { method: string; payload: any }[] = [];
bot.api.config.use(async (_prev, method, payload) => {
  responses.push({ method, payload });
  return {
    ok: true,
    result:
      method === "answerCallbackQuery"
        ? true
        : {
            message_id: responses.length,
            date: 1,
            chat: { id: 90000001, type: "private" },
            text: "ok",
          },
  } as any;
});
let sequence = 0;
const from = { id: 90000001, is_bot: false, first_name: "Tester" };
const chat = { id: from.id, type: "private" as const, first_name: "Tester" };
async function message(text: string) {
  await bot.handleUpdate({
    update_id: ++sequence,
    message: {
      message_id: sequence,
      date: 1,
      chat,
      from,
      text,
      ...(text.startsWith("/")
        ? {
            entities: [
              { type: "bot_command" as const, offset: 0, length: text.length },
            ],
          }
        : {}),
    },
  });
}
async function callback(data: string, userId = from.id) {
  await bot.handleUpdate({
    update_id: ++sequence,
    callback_query: {
      id: String(sequence),
      chat_instance: "test",
      from: { ...from, id: userId },
      data,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: userId, type: "private", first_name: "Tester" },
        text: "test",
      },
    },
  });
}
try {
  // Test-only user, safe cleanup confined to the separate test database.
  await db.execute(
    sql`delete from notification_outbox where watch_id in (select id from watches where user_id in (select id from users where telegram_id=${from.id}))`,
  );
  await db.execute(
    sql`delete from watches where user_id in (select id from users where telegram_id=${from.id})`,
  );
  await message("/start");
  await message(url);
  const u = await repo.user(from.id);
  const draft = await repo.draft(u.id);
  assert(draft);
  const sizes = await repo.sizes(draft.productId);
  const m = sizes.find((s) => s.variant.size === "M")!;
  await callback(`size:${draft.productId}:${m.variant.id}`);
  await callback(`rule:${m.variant.id}:target`);
  await message("199");
  let watched = await repo.list(u.id);
  assert.equal(watched.length, 1);
  assert.equal(watched[0].watch.targetPrice, 19900);
  const product = parseProduct(fixture, url);
  const p = await repo.product(product);
  // Reset baseline explicitly, then test actual DB event/outbox pipeline.
  await repo.apply(p.id, product, 60);
  await db.execute(
    sql`delete from notification_outbox where watch_id=${watched[0].watch.id}`,
  );
  const discounted = {
    ...product,
    currentPrice: 19900,
    variants: product.variants.map((v) => ({ ...v, price: 19900 })),
  };
  await repo.apply(p.id, discounted, 60);
  const pending = await repo.pending();
  assert.equal(
    pending.filter((r) => r.entry.watchId === watched[0].watch.id).length,
    1,
  );
  const notifier = new NotificationService(repo, bot.api);
  await notifier.tick();
  assert(
    responses.some(
      (r) =>
        r.method === "sendMessage" &&
        String(r.payload.text).includes("CENA DOCELOWA"),
    ),
  );
  const countBefore = (await db.execute(
    sql`select count(*)::int as n from price_history where product_id=${p.id}`,
  )) as any;
  await repo.apply(p.id, discounted, 60);
  const countAfter = (await db.execute(
    sql`select count(*)::int as n from price_history where product_id=${p.id}`,
  )) as any;
  assert.equal(countBefore.rows[0].n, countAfter.rows[0].n);
  await message("/list");
  await callback(`hist:${watched[0].watch.id}`);
  assert(
    responses.some((r) => String(r.payload.text).includes("Najniższa cena")),
  );
  await callback(`del:${watched[0].watch.id}`, 90000002);
  assert.equal((await repo.list(u.id)).length, 1);
  const reconnect = connect(databaseUrl);
  const resumed = new Repository(reconnect.db);
  assert.equal((await resumed.list(u.id)).length, 1);
  await reconnect.pool.end();
  await callback(`del:${watched[0].watch.id}`);
  assert.equal((await repo.list(u.id)).length, 0);
  // Restock with stock-only rule, durable pending event, cancelled watch suppresses delivery.
  await repo.setDraft(u.id, p.id, "rule", m.variant.id);
  await repo.watch(u.id, {
    watchPrice: false,
    watchStock: true,
    targetPrice: null,
  });
  const absent = {
    ...product,
    variants: product.variants.map((v) => ({ ...v, available: false })),
  };
  await repo.apply(p.id, absent, 60);
  await notifier.tick();
  await repo.apply(p.id, product, 60);
  assert(
    (await repo.pending()).some((r) =>
      (r.entry.payload as any).types.includes("RESTOCK"),
    ),
  );
  const currentWatch = (await repo.list(u.id))[0];
  // A rotated primary SKU with an explicit alias retains the watch and history.
  await notifier.tick();
  const historyBeforeRotation = await repo.priceHistory(
    u.id,
    currentWatch.watch.id,
  );
  const rotated = {
    ...product,
    variants: product.variants.map((v) =>
      v.size === "M" ? { ...v, id: "999000111", aliasIds: [v.id] } : v,
    ),
  };
  await repo.apply(p.id, rotated, 60);
  const afterRotation = (await repo.list(u.id))[0];
  assert.equal(afterRotation.watch.variantId, currentWatch.watch.variantId);
  assert.equal(
    afterRotation.variant.externalVariantId,
    m.variant.externalVariantId,
  );
  const historyAfterRotation = await repo.priceHistory(
    u.id,
    currentWatch.watch.id,
  );
  assert.deepEqual(historyAfterRotation.rows, historyBeforeRotation.rows);
  assert.equal(historyAfterRotation.min, historyBeforeRotation.min);
  assert.equal((await repo.pending()).length, 0);
  assert.equal(
    (await repo.sizes(p.id)).filter((r) => r.variant.size === "M").length,
    1,
  );
  // A different SKU with no explicit alias remains unknown, not a fake restock.
  await repo.apply(
    p.id,
    {
      ...rotated,
      variants: rotated.variants.map((v) => ({ ...v, aliasIds: [] })),
    },
    60,
  );
  assert.match((await repo.byProductId(p.id)).lastError!, /Watched SKU absent/);
  await repo.apply(p.id, rotated, 60);
  assert.equal((await repo.byProductId(p.id)).lastError, null);
  await repo.apply(p.id, absent, 60);
  await notifier.tick();
  await repo.apply(p.id, product, 60);
  await repo.remove(u.id, currentWatch.watch.id);
  const sent = responses.length;
  await notifier.tick();
  assert.equal(responses.length, sent);
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "Telegram URL→size→target→watch",
          "target event→outbox→Telegram message",
          "unchanged history",
          "history command",
          "ownership",
          "database reconnect",
          "remove",
          "restock",
          "rotated SKU preserves watch/history without false alerts",
          "unrelated SKU remains unknown",
          "cancel suppresses pending notifications",
        ],
        telegramCalls: responses.length,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
