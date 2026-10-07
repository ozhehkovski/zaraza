import {
  pgTable,
  serial,
  bigint,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
export const users = pgTable("users", {
  id: serial().primaryKey(),
  telegramId: bigint("telegram_id", { mode: "number" }).notNull().unique(),
  language: text().notNull().default("pl"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
export const products = pgTable(
  "products",
  {
    id: serial().primaryKey(),
    store: text().notNull(),
    externalId: text("external_id").notNull(),
    url: text().notNull(),
    name: text().notNull(),
    imageUrl: text("image_url"),
    currency: text().notNull(),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    failures: integer().notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("product_identity").on(t.store, t.externalId),
    index("due_products").on(t.nextCheckAt),
  ],
);
export const variants = pgTable(
  "variants",
  {
    id: serial().primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id),
    externalVariantId: text("external_variant_id").notNull(),
    size: text().notNull(),
    selectable: boolean().notNull().default(true),
  },
  (t) => [uniqueIndex("variant_identity").on(t.productId, t.externalVariantId)],
);
export const watches = pgTable(
  "watches",
  {
    id: serial().primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id),
    variantId: integer("variant_id")
      .notNull()
      .references(() => variants.id),
    watchPrice: boolean("watch_price").notNull(),
    watchStock: boolean("watch_stock").notNull(),
    targetPrice: integer("target_price"),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("watch_identity").on(t.userId, t.variantId),
    index("enabled_product_watches").on(t.productId, t.enabled),
  ],
);
export const states = pgTable("product_state", {
  variantId: integer("variant_id")
    .primaryKey()
    .references(() => variants.id),
  productId: integer("product_id")
    .notNull()
    .references(() => products.id),
  price: integer().notNull(),
  originalPrice: integer("original_price"),
  available: boolean().notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const history = pgTable(
  "price_history",
  {
    id: serial().primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id),
    variantId: integer("variant_id")
      .notNull()
      .references(() => variants.id),
    price: integer().notNull(),
    available: boolean().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("history_variant").on(t.variantId, t.createdAt)],
);
export const drafts = pgTable("drafts", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id),
  productId: integer("product_id")
    .notNull()
    .references(() => products.id),
  variantId: integer("variant_id").references(() => variants.id),
  stage: text().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export const outbox = pgTable(
  "notification_outbox",
  {
    id: serial().primaryKey(),
    watchId: integer("watch_id")
      .notNull()
      .references(() => watches.id),
    payload: jsonb().notNull(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("pending_notifications").on(t.sentAt, t.nextAttemptAt)],
);
