import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { ZaraTransport } from "../src/providers/zara/transport.js";
import { ZaraProvider } from "../src/providers/zara/ZaraProvider.js";
import { connect } from "../src/database/client.js";
import { migrate } from "../src/database/migrate.js";
import { Repository } from "../src/database/repository.js";
import { sql } from "drizzle-orm";
const transport = new ZaraTransport({
  mode: (process.env.ZARA_TRANSPORT ?? "http") as "http" | "browser",
  cookie: process.env.ZARA_COOKIE ?? "",
  proxy: process.env.ZARA_PROXY_URL ?? "",
  headless: process.env.ZARA_BROWSER_HEADLESS !== "false",
  executable: process.env.ZARA_BROWSER_EXECUTABLE ?? "",
  timeout: 10000,
  rps: 2,
});
const provider = new ZaraProvider(
  transport,
  (process.env.ZARA_DATA_SOURCE ?? "page") as "api" | "page",
);
const file = process.argv[2] ?? "tests/fixtures/live-products.json";
const urls: string[] = JSON.parse(await readFile(file, "utf8"));
const { db, pool } = connect(process.env.DATABASE_URL!);
await migrate(pool);
const repo = new Repository(db);
const report: {
  url: string;
  success: boolean;
  name?: string;
  price?: number;
  sizes?: number;
  error?: string;
}[] = [];
try {
  for (const url of urls) {
    try {
      const p = await provider.getProduct(url);
      const stored = await repo.product(p);
      await repo.apply(stored.id, p, 60);
      report.push({
        url,
        success: true,
        name: p.name,
        price: p.currentPrice,
        sizes: p.variants.length,
      });
      console.log(
        `OK ${p.externalId}: ${p.currentPrice / 100} PLN, ${p.variants.length} sizes`,
      );
    } catch (e) {
      report.push({
        url,
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
      console.log("FAIL", report.at(-1));
      if (transport.cooldownUntil > Date.now()) break;
    }
  }
  await mkdir("docs", { recursive: true }).catch(() => {});
  await writeFile(
    process.env.LIVE_REPORT_PATH ?? "docs/live-test-results.json",
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        mode: process.env.ZARA_TRANSPORT,
        dataSource: process.env.ZARA_DATA_SOURCE ?? "page",
        requested: urls.length,
        passed: report.filter((r) => r.success).length,
        results: report,
      },
      null,
      2,
    ),
  );
  if (report.filter((r) => r.success).length < 20) process.exitCode = 1;
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await transport.close();
  await pool.end();
}
