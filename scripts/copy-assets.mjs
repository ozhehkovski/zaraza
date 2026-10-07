import { copyFile, mkdir } from "node:fs/promises";
await mkdir("dist/src/database", { recursive: true });
await copyFile("src/database/migration.sql", "dist/src/database/migration.sql");
