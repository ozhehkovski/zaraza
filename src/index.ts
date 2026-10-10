import { createServer } from "node:http";
import { config } from "./config.js";
import { connect } from "./database/client.js";
import { migrate } from "./database/migrate.js";
import { Repository } from "./database/repository.js";
import { ProviderRegistry } from "./providers/types.js";
import { ZaraProvider } from "./providers/zara/ZaraProvider.js";
import { ZaraTransport } from "./providers/zara/transport.js";
import { MonitoringEngine } from "./monitor/engine.js";
import { NotificationService } from "./notifications/service.js";
import { createBot } from "./telegram/bot.js";
import { log, safeError } from "./log.js";
const { db, pool } = connect(config.DATABASE_URL);
await migrate(pool);
// One active instance per database, including Telegram polling and outbox delivery.
const leader = await pool.connect();
const lock = await leader.query(
  "select pg_try_advisory_lock(729352) as acquired",
);
if (!lock.rows[0].acquired) {
  log.fatal("Another app instance owns this database");
  await pool.end();
  process.exit(1);
}
leader.on("error", () => {
  log.fatal("Database leader connection lost");
  process.exit(1);
});
const repo = new Repository(db);
const transport = new ZaraTransport({
  mode: config.ZARA_TRANSPORT,
  cookie: config.ZARA_COOKIE,
  proxy: config.ZARA_PROXY_URL,
  headless: config.ZARA_BROWSER_HEADLESS === "true",
  executable: config.ZARA_BROWSER_EXECUTABLE,
  timeout: config.REQUEST_TIMEOUT_MS,
  rps: config.ZARA_REQUESTS_PER_SECOND,
  browserPages: config.ZARA_MAX_BROWSER_PAGES,
});
const registry = new ProviderRegistry([
  new ZaraProvider(transport, config.ZARA_DATA_SOURCE),
]);
const engine = new MonitoringEngine(
  repo,
  registry,
  config.CHECK_INTERVAL_SECONDS,
  config.MAX_CONCURRENT_REQUESTS,
);
const bot = createBot(
  config.TELEGRAM_BOT_TOKEN,
  repo,
  registry,
  config.CHECK_INTERVAL_SECONDS,
);
await bot.init();
await bot.api.setMyCommands(
  ["start", "help", "watch", "list", "history", "settings"].map((command) => ({
    command,
    description: (
      {
        start: "Начать",
        help: "Помощь",
        watch: "Добавить товар",
        list: "Отслеживаемые товары",
        history: "История цены",
        settings: "Настройки",
      } as Record<string, string>
    )[command],
  })),
);
const notifier = new NotificationService(repo, bot.api);
let polling = false;
const server = createServer(async (req, res) => {
  if (req.url !== "/health") {
    res.writeHead(404);
    res.end();
    return;
  }
  let database = "ok";
  let failedProducts = 0;
  try {
    const result = await pool.query(
      "select count(*)::int as n from products p where p.last_error is not null and exists(select 1 from watches w where w.product_id=p.id and w.enabled)",
    );
    failedProducts = result.rows[0].n;
  } catch {
    database = "error";
  }
  const healthy =
    database === "ok" &&
    engine.running &&
    !engine.lastError &&
    polling &&
    !transport.health.lastError &&
    failedProducts === 0;
  res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      status: healthy ? "ok" : "degraded",
      database,
      monitor: engine.running ? "running" : "stopped",
      telegram: polling ? "polling" : "stopped",
      lastCycle: engine.lastCycle,
      zara: transport.health,
      failedProducts,
    }),
  );
});
server.listen(config.PORT, "0.0.0.0");
engine.start();
notifier.start();
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("Stopping");
  await engine.stop();
  await notifier.stop();
  if (bot.isRunning()) await bot.stop();
  await registry.providers[0].close?.();
  await new Promise<void>((r) => server.close(() => r()));
  await leader.query("select pg_advisory_unlock(729352)");
  leader.release();
  await pool.end();
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
try {
  await bot.start({
    onStart: (info) => {
      polling = true;
      log.info({ username: info.username }, "Bot polling");
    },
  });
} catch (e) {
  log.fatal({ error: safeError(e) }, "Telegram polling stopped");
  process.exitCode = 1;
  await shutdown();
} finally {
  polling = false;
}
