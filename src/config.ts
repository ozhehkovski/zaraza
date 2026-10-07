import "dotenv/config";
import { z } from "zod";
const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  DATABASE_URL: z.string().url(),
  CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(60),
  MAX_CONCURRENT_REQUESTS: z.coerce.number().int().min(1).max(50).default(10),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  ZARA_TRANSPORT: z.enum(["http", "browser"]).default("http"),
  ZARA_MAX_BROWSER_PAGES: z.coerce.number().int().min(1).max(10).default(2),
  ZARA_DATA_SOURCE: z.enum(["api", "page"]).default("page"),
  ZARA_COOKIE: z.string().default(""),
  ZARA_PROXY_URL: z.string().default(""),
  ZARA_BROWSER_HEADLESS: z.string().default("true"),
  ZARA_BROWSER_EXECUTABLE: z.string().default(""),
  ZARA_REQUESTS_PER_SECOND: z.coerce.number().positive().default(5),
  LOG_LEVEL: z.string().default("info"),
});
export const config = schema.parse(process.env);
