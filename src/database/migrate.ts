import "dotenv/config";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { connect } from "./client.js";
export async function migrate(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(729351)");
    await client.query(
      await readFile(new URL("./migration.sql", import.meta.url), "utf8"),
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { pool } = connect(process.env.DATABASE_URL!);
  await migrate(pool);
  await pool.end();
}
