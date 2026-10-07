import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { connect } from "../src/database/client.js";
import { Repository } from "../src/database/repository.js";
import { sql, eq, and } from "drizzle-orm";
import * as s from "../src/database/schema.js";
const report = JSON.parse(
  await readFile("docs/live-test-results.json", "utf8"),
);
if (report.passed !== 20)
  throw new Error("First complete a successful live check of 20 products");
const { pool, db } = connect(process.env.DATABASE_URL!);
const repo = new Repository(db);
try {
  const users = await db.select().from(s.users).limit(2);
  if (users.length !== 1)
    throw new Error("Need exactly one user of this test bot");
  const ids: number[] = [];
  for (const item of report.results) {
    const externalId = new URL(item.url).searchParams.get("v1")!;
    const [p] = await db
      .select()
      .from(s.products)
      .where(
        and(
          eq(s.products.store, "zara"),
          eq(s.products.externalId, externalId),
        ),
      );
    if (!p) throw new Error("Live product missing");
    const variants = await repo.sizes(p.id);
    const selected =
      variants.find((v) => v.variant.size === "M") ??
      variants.find((v) => v.state.available) ??
      variants[0];
    if (!selected) throw new Error("Live sizes missing");
    await repo.setDraft(users[0].id, p.id, "rule", selected.variant.id);
    await repo.watch(users[0].id, {
      watchPrice: true,
      watchStock: true,
      targetPrice: null,
    });
    await db
      .update(s.products)
      .set({ nextCheckAt: new Date(), failures: 0, lastError: null })
      .where(eq(s.products.id, p.id));
    ids.push(p.id);
  }
  await writeFile(
    "docs/monitor-live-products.json",
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        products: ids,
        watchCount: ids.length,
        rule: "price + stock",
        sizePreference: "M or first available",
      },
      null,
      2,
    ),
  );
  console.log({ seeded: ids.length });
} finally {
  await pool.end();
}
