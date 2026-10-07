import { and, eq, lte, sql, desc, isNull } from "drizzle-orm";
import type { Database } from "./client.js";
import * as s from "./schema.js";
import type { Product } from "../providers/types.js";
import { events } from "../monitor/rules.js";
import { resolveVariants } from "./variant-identity.js";
export class Repository {
  constructor(public db: Database) {}
  async user(telegramId: number) {
    return (
      await this.db
        .insert(s.users)
        .values({ telegramId })
        .onConflictDoUpdate({ target: s.users.telegramId, set: { telegramId } })
        .returning()
    )[0];
  }
  async product(product: Product) {
    return this.db.transaction(async (tx) => {
      const p = (
        await tx
          .insert(s.products)
          .values({
            store: product.store,
            externalId: product.externalId,
            name: product.name,
            url: product.url,
            imageUrl: product.image,
            currency: product.currency,
          })
          .onConflictDoUpdate({
            target: [s.products.store, s.products.externalId],
            set: {
              name: product.name,
              url: product.url,
              imageUrl: product.image,
              updatedAt: new Date(),
            },
          })
          .returning()
      )[0];
      const storedVariants = await tx
        .select()
        .from(s.variants)
        .where(eq(s.variants.productId, p.id));
      const resolved = resolveVariants(product.variants, storedVariants);
      await tx
        .update(s.variants)
        .set({ selectable: false })
        .where(eq(s.variants.productId, p.id));
      for (const v of resolved) {
        const variant = (
          await tx
            .insert(s.variants)
            .values({
              productId: p.id,
              externalVariantId: v.id,
              size: v.size,
              selectable: v.selectable,
            })
            .onConflictDoUpdate({
              target: [s.variants.productId, s.variants.externalVariantId],
              set: { size: v.size, selectable: v.selectable },
            })
            .returning()
        )[0];
        const inserted = await tx
          .insert(s.states)
          .values({
            variantId: variant.id,
            productId: p.id,
            price: v.price ?? product.currentPrice,
            originalPrice: v.originalPrice ?? product.originalPrice,
            available: v.available,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted.length)
          await tx.insert(s.history).values({
            productId: p.id,
            variantId: variant.id,
            price: v.price ?? product.currentPrice,
            available: v.available,
          });
      }
      return p;
    });
  }
  async byProductId(productId: number) {
    return (
      await this.db
        .select()
        .from(s.products)
        .where(eq(s.products.id, productId))
    )[0];
  }
  async sizes(productId: number) {
    return this.db
      .select({ variant: s.variants, state: s.states })
      .from(s.variants)
      .innerJoin(s.states, eq(s.states.variantId, s.variants.id))
      .where(
        and(
          eq(s.variants.productId, productId),
          eq(s.variants.selectable, true),
        ),
      );
  }
  async draft(userId: number) {
    return (
      await this.db
        .select()
        .from(s.drafts)
        .where(
          and(eq(s.drafts.userId, userId), sql`${s.drafts.expiresAt}>now()`),
        )
    )[0];
  }
  async setDraft(
    userId: number,
    productId: number,
    stage: string,
    variantId: number | null = null,
  ) {
    await this.db
      .insert(s.drafts)
      .values({
        userId,
        productId,
        stage,
        variantId,
        expiresAt: new Date(Date.now() + 3600000),
      })
      .onConflictDoUpdate({
        target: s.drafts.userId,
        set: {
          productId,
          stage,
          variantId,
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
  }
  async watch(
    userId: number,
    rule: {
      watchPrice: boolean;
      watchStock: boolean;
      targetPrice: number | null;
    },
  ) {
    const d = await this.draft(userId);
    if (!d?.variantId) throw new Error("Wybór wygasł. Wyślij link ponownie.");
    await this.db
      .insert(s.watches)
      .values({
        userId,
        productId: d.productId,
        variantId: d.variantId,
        ...rule,
      })
      .onConflictDoUpdate({
        target: [s.watches.userId, s.watches.variantId],
        set: { ...rule, enabled: true, updatedAt: new Date() },
      });
    await this.db.delete(s.drafts).where(eq(s.drafts.userId, userId));
  }
  async list(userId: number, offset = 0) {
    return this.db
      .select({
        watch: s.watches,
        product: s.products,
        variant: s.variants,
        state: s.states,
      })
      .from(s.watches)
      .innerJoin(s.products, eq(s.products.id, s.watches.productId))
      .innerJoin(s.variants, eq(s.variants.id, s.watches.variantId))
      .innerJoin(s.states, eq(s.states.variantId, s.variants.id))
      .where(and(eq(s.watches.userId, userId), eq(s.watches.enabled, true)))
      .orderBy(s.watches.id)
      .limit(11)
      .offset(offset);
  }
  async detail(userId: number, id: number) {
    return (
      await this.db
        .select({
          watch: s.watches,
          product: s.products,
          variant: s.variants,
          state: s.states,
        })
        .from(s.watches)
        .innerJoin(s.products, eq(s.products.id, s.watches.productId))
        .innerJoin(s.variants, eq(s.variants.id, s.watches.variantId))
        .innerJoin(s.states, eq(s.states.variantId, s.variants.id))
        .where(
          and(
            eq(s.watches.userId, userId),
            eq(s.watches.id, id),
            eq(s.watches.enabled, true),
          ),
        )
    )[0];
  }
  async remove(userId: number, id: number) {
    await this.db
      .update(s.watches)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(eq(s.watches.userId, userId), eq(s.watches.id, id)));
  }
  async priceHistory(userId: number, id: number) {
    const w = await this.detail(userId, id);
    if (!w) throw new Error("Nie znaleziono obserwacji.");
    const rows = await this.db
      .select()
      .from(s.history)
      .where(eq(s.history.variantId, w.variant.id))
      .orderBy(desc(s.history.createdAt))
      .limit(30);
    const [min] = await this.db
      .select({ price: sql<number>`min(${s.history.price})` })
      .from(s.history)
      .where(eq(s.history.variantId, w.variant.id));
    return { w, rows, min: Number(min.price) };
  }
  async due() {
    return this.db
      .select()
      .from(s.products)
      .where(
        and(
          lte(s.products.nextCheckAt, new Date()),
          sql`exists(select 1 from watches w where w.product_id=${s.products.id} and w.enabled)`,
        ),
      )
      .orderBy(s.products.nextCheckAt)
      .limit(2000);
  }
  async failed(id: number, failures: number, error: string, interval: number) {
    await this.db
      .update(s.products)
      .set({
        failures: failures + 1,
        lastError: error,
        nextCheckAt: new Date(
          Date.now() +
            Math.min(3600000, interval * 1000 * 2 ** Math.min(failures + 1, 6)),
        ),
      })
      .where(eq(s.products.id, id));
  }
  async apply(id: number, product: Product, interval: number) {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select id from products where id=${id} for update`);
      const observed = await tx
        .select({ watch: s.watches, user: s.users, variant: s.variants })
        .from(s.watches)
        .innerJoin(s.users, eq(s.users.id, s.watches.userId))
        .innerJoin(s.variants, eq(s.variants.id, s.watches.variantId))
        .where(and(eq(s.watches.productId, id), eq(s.watches.enabled, true)));
      const previous = await tx
        .select()
        .from(s.states)
        .where(eq(s.states.productId, id));
      const storedVariants = await tx
        .select()
        .from(s.variants)
        .where(eq(s.variants.productId, id));
      const resolved = resolveVariants(product.variants, storedVariants);
      await tx
        .update(s.variants)
        .set({ selectable: false })
        .where(eq(s.variants.productId, id));
      for (const v of resolved) {
        const variant = (
          await tx
            .insert(s.variants)
            .values({
              productId: id,
              externalVariantId: v.id,
              size: v.size,
              selectable: v.selectable,
            })
            .onConflictDoUpdate({
              target: [s.variants.productId, s.variants.externalVariantId],
              set: { size: v.size, selectable: v.selectable },
            })
            .returning()
        )[0];
        const before = previous.find((p) => p.variantId === variant.id);
        const now = {
          price: v.price ?? product.currentPrice,
          available: v.available,
        };
        if (
          !before ||
          before.price !== now.price ||
          before.available !== now.available
        )
          await tx
            .insert(s.history)
            .values({ productId: id, variantId: variant.id, ...now });
        for (const row of observed.filter((r) => r.variant.id === variant.id)) {
          const types = events(before, now, row.watch);
          if (types.length)
            await tx.insert(s.outbox).values({
              watchId: row.watch.id,
              payload: {
                types,
                telegramId: row.user.telegramId,
                name: product.name,
                url: product.url,
                currency: product.currency,
                size: v.size,
                previous: before
                  ? { price: before.price, available: before.available }
                  : null,
                current: now,
                watchId: row.watch.id,
              },
            });
        }
        await tx
          .insert(s.states)
          .values({
            variantId: variant.id,
            productId: id,
            ...now,
            originalPrice: v.originalPrice ?? product.originalPrice,
            checkedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: s.states.variantId,
            set: {
              ...now,
              originalPrice: v.originalPrice ?? product.originalPrice,
              checkedAt: new Date(),
            },
          });
      }
      // Missing watched SKUs are unknown, never silently converted to out-of-stock.
      const missing = observed.some(
        (r) => !resolved.some((v) => v.id === r.variant.externalVariantId),
      );
      await tx
        .update(s.products)
        .set({
          name: product.name,
          imageUrl: product.image,
          failures: 0,
          lastError: missing
            ? "Watched SKU absent from response; previous state retained"
            : null,
          nextCheckAt: new Date(Date.now() + interval * 1000),
          updatedAt: new Date(),
        })
        .where(eq(s.products.id, id));
    });
  }
  async pending() {
    return this.db
      .select({ entry: s.outbox, enabled: s.watches.enabled })
      .from(s.outbox)
      .innerJoin(s.watches, eq(s.watches.id, s.outbox.watchId))
      .where(
        and(isNull(s.outbox.sentAt), lte(s.outbox.nextAttemptAt, new Date())),
      )
      .orderBy(s.outbox.id)
      .limit(100);
  }
  async delivered(id: number) {
    await this.db
      .update(s.outbox)
      .set({ sentAt: new Date() })
      .where(eq(s.outbox.id, id));
  }
  async retry(id: number, attempts: number, delay: number) {
    await this.db
      .update(s.outbox)
      .set({
        attempts: attempts + 1,
        nextAttemptAt: new Date(Date.now() + delay),
      })
      .where(eq(s.outbox.id, id));
  }
}
