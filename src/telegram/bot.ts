import { Bot, InlineKeyboard } from "grammy";
import type { Repository } from "../database/repository.js";
import type { ProviderRegistry } from "../providers/types.js";
import { money } from "../notifications/service.js";
import { parseMoney } from "../providers/zara/parser.js";
import { log, safeError } from "../log.js";
export function createBot(
  token: string,
  repo: Repository,
  registry: ProviderRegistry,
  interval: number,
) {
  const bot = new Bot(token);
  const help =
    "Wyślij link produktu Zara Polska. Wybierz rozmiar i warunek.\n/start — start\n/watch — dodaj produkt\n/list — obserwowane produkty\n/history — historia ceny\n/settings — ustawienia\n/help — pomoc";
  // Private chats only: watches cannot be controlled by other members of a group.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private") return;
    if (!ctx.from) return;
    try {
      await next();
    } catch (e) {
      log.warn({ error: safeError(e) }, "telegram action failed");
      await ctx.reply(
        "Nie udało się wykonać operacji. Zara może chwilowo blokować dostęp. Spróbuj ponownie później.",
      );
    }
  });
  bot.command(["start", "help"], (ctx) => ctx.reply(help));
  bot.command("watch", (ctx) =>
    ctx.reply("Wklej link produktu z https://www.zara.com/pl/pl/"),
  );
  async function showList(ctx: any, page = 0, historyOnly = false) {
    const u = await repo.user(ctx.from.id);
    const rows = await repo.list(u.id, page * 10);
    if (!rows.length) {
      await ctx.reply(
        "Nie obserwujesz jeszcze produktów. Wyślij link Zara PL.",
      );
      return;
    }
    await ctx.reply(
      historyOnly
        ? "Wybierz historię produktu:"
        : `Obserwowane produkty — strona ${page + 1}`,
    );
    for (const r of rows.slice(0, 10)) {
      const keyboard = new InlineKeyboard()
        .text(
          historyOnly ? "Historia ceny" : "Szczegóły",
          `${historyOnly ? "hist" : "detail"}:${r.watch.id}`,
        )
        .text("Usuń", `del:${r.watch.id}`);
      await ctx.reply(
        `${r.product.name}\nRozmiar: ${r.variant.size}\n${money(r.state.price, r.product.currency)}\n${r.state.available ? "🟢 dostępny" : "🔴 brak"}${r.product.lastError ? "\n⚠️ Ostatnia kontrola nie powiodła się." : ""}`,
        { reply_markup: keyboard },
      );
    }
    const nav = new InlineKeyboard();
    if (page > 0)
      nav.text("← Poprzednia", `page:${historyOnly ? "h" : "l"}:${page - 1}`);
    if (rows.length > 10)
      nav.text("Następna →", `page:${historyOnly ? "h" : "l"}:${page + 1}`);
    if (nav.inline_keyboard[0]?.length)
      await ctx.reply("Strony:", { reply_markup: nav });
  }
  bot.command("list", (ctx) => showList(ctx));
  bot.command("history", (ctx) => showList(ctx, 0, true));
  bot.command("settings", async (ctx) => {
    const u = await repo.user(ctx.from!.id);
    await ctx.reply(
      `Język: ${u.language}\nCzęstotliwość: ${interval} s\nWaluta: PLN\nZmiana częstotliwości: CHECK_INTERVAL_SECONDS w .env.\n/list — zarządzaj obserwacjami.`,
      {
        reply_markup: new InlineKeyboard().text(
          "Anuluj bieżący wybór",
          "cancel",
        ),
      },
    );
  });
  bot.callbackQuery("cancel", async (ctx) => {
    const u = await repo.user(ctx.from.id);
    await repo.db.execute(
      (await import("drizzle-orm"))
        .sql`delete from drafts where user_id=${u.id}`,
    );
    await ctx.answerCallbackQuery("Anulowano");
  });
  bot.callbackQuery(/^page:([hl]):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showList(ctx, Number(ctx.match[2]), ctx.match[1] === "h");
  });
  bot.callbackQuery(/^(del|detail|hist):(\d+)$/, async (ctx) => {
    const u = await repo.user(ctx.from.id);
    const id = Number(ctx.match[2]);
    const r = await repo.detail(u.id, id);
    if (!r) {
      await ctx.answerCallbackQuery("Nie znaleziono obserwacji.");
      return;
    }
    await ctx.answerCallbackQuery();
    if (ctx.match[1] === "del") {
      await repo.remove(u.id, id);
      await ctx
        .editMessageReplyMarkup({ reply_markup: new InlineKeyboard() })
        .catch(() => {});
      await ctx.reply("✅ Monitoring zatrzymany");
      return;
    }
    if (ctx.match[1] === "hist") {
      const h = await repo.priceHistory(u.id, id);
      await ctx.reply(
        `Historia ceny — ${r.product.name} (${r.variant.size})\n${h.rows
          .reverse()
          .map(
            (row) =>
              `${row.createdAt.toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" })} — ${money(row.price)} ${row.available ? "🟢" : "🔴"}`,
          )
          .join("\n")}\nNajniższa cena: ${money(h.min)}`,
      );
      return;
    }
    await ctx.reply(
      `${r.product.name}\nRozmiar: ${r.variant.size}\nCena: ${money(r.state.price)}\n${r.state.available ? "Dostępny" : "Brak"}\nCel: ${r.watch.targetPrice ? money(r.watch.targetPrice) : r.watch.watchPrice ? "każda obniżka" : "tylko dostępność"}\nOstatnia kontrola: ${r.state.checkedAt.toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" })}${r.product.lastError ? "\n⚠️ Zara chwilowo niedostępna." : ""}`,
      {
        reply_markup: new InlineKeyboard()
          .url("Otwórz Zara", r.product.url)
          .row()
          .text("Historia ceny", `hist:${id}`)
          .text("Usuń", `del:${id}`),
      },
    );
  });
  bot.callbackQuery(/^size:(\d+):(\d+)$/, async (ctx) => {
    const u = await repo.user(ctx.from.id);
    const productId = Number(ctx.match[1]);
    const variantId = Number(ctx.match[2]);
    const d = await repo.draft(u.id);
    if (
      !d ||
      d.productId !== productId ||
      !(await repo.sizes(productId)).some((v) => v.variant.id === variantId)
    ) {
      await ctx.answerCallbackQuery("Wybór wygasł. Wyślij link ponownie.");
      return;
    }
    await repo.setDraft(u.id, productId, "rule", variantId);
    await ctx.answerCallbackQuery();
    await ctx.reply("Co monitorować?", {
      reply_markup: new InlineKeyboard()
        .text("🔥 Każda obniżka ceny", `rule:${variantId}:price`)
        .row()
        .text("🎯 Cena poniżej…", `rule:${variantId}:target`)
        .row()
        .text("📦 Dostępność", `rule:${variantId}:stock`)
        .row()
        .text("💰 Cena + dostępność", `rule:${variantId}:both`),
    });
  });
  async function activate(
    ctx: any,
    userId: number,
    mode: string,
    targetPrice: number | null = null,
  ) {
    const d = await repo.draft(userId);
    if (!d?.variantId) throw new Error("expired");
    const product = await repo.byProductId(d.productId);
    const sizes = await repo.sizes(d.productId);
    const selected = sizes.find((s) => s.variant.id === d.variantId)!;
    await repo.watch(userId, {
      watchPrice: mode !== "stock",
      watchStock: ["stock", "both"].includes(mode),
      targetPrice,
    });
    await ctx.reply(
      `✅ Monitoring uruchomiony\n${product.name}\nRozmiar: ${selected.variant.size}\nAktualna cena: ${money(selected.state.price)}${targetPrice ? `\nCena docelowa: ${money(targetPrice)}${selected.state.price <= targetPrice ? "\nCena jest już na poziomie celu. Kolejne powiadomienie przy ponownym przekroczeniu progu." : ""}` : ""}\nSprawdzę cenę i dostępność automatycznie. /list`,
    );
  }
  bot.callbackQuery(/^rule:(\d+):(price|target|stock|both)$/, async (ctx) => {
    const u = await repo.user(ctx.from.id);
    const d = await repo.draft(u.id);
    if (!d || d.stage !== "rule" || d.variantId !== Number(ctx.match[1])) {
      await ctx.answerCallbackQuery("Wybór wygasł. Wyślij link ponownie.");
      return;
    }
    await ctx.answerCallbackQuery();
    if (ctx.match[2] === "target") {
      await repo.setDraft(u.id, d.productId, "target", d.variantId);
      await ctx.reply("Podaj cenę docelową w zł, np. 199 lub 199,99.");
    } else await activate(ctx, u.id, ctx.match[2]);
  });
  bot.on("message:text", async (ctx) => {
    const u = await repo.user(ctx.from.id);
    const text = ctx.message.text.trim();
    const d = await repo.draft(u.id);
    if (d?.stage === "target" && !text.includes("https://")) {
      try {
        const price = parseMoney(text);
        await activate(ctx, u.id, "target", price);
      } catch (e) {
        await ctx.reply("Podaj poprawną cenę w zł, np. 199,99.");
      }
      return;
    }
    const url = text.match(/https:\/\/[^\s<>]+/)?.[0];
    if (!url) {
      await ctx.reply("Wyślij link produktu Zara Polska. /help");
      return;
    }
    const provider = registry.forUrl(url);
    await ctx.reply("Pobieram produkt…");
    const p = await provider.getProduct(url);
    const stored = await repo.product(p);
    await repo.apply(stored.id, p, interval);
    await repo.setDraft(u.id, stored.id, "size");
    const sizes = await repo.sizes(stored.id);
    const keyboard = new InlineKeyboard();
    sizes
      .filter((r) =>
        p.variants.some((v) => v.id === r.variant.externalVariantId),
      )
      .forEach((r, i) => {
        const fresh = p.variants.find(
          (v) => v.id === r.variant.externalVariantId,
        )!;
        keyboard.text(
          `${r.variant.size}${fresh.available ? " 🟢" : " 🔴"}`,
          `size:${stored.id}:${r.variant.id}`,
        );
        if (i % 3 === 2) keyboard.row();
      });
    const caption = `${p.name}\nCena: ${money(p.currentPrice)}${p.originalPrice ? `\nPoprzednia cena: ${money(p.originalPrice)}` : ""}\nWybierz rozmiar:`;
    if (p.image) {
      try {
        await ctx.replyWithPhoto(p.image, {
          caption: caption.slice(0, 1000),
          reply_markup: keyboard,
        });
        return;
      } catch {}
    }
    await ctx.reply(caption, { reply_markup: keyboard });
  });
  bot.catch((e) =>
    log.error({ error: safeError(e.error) }, "bot update failed"),
  );
  return bot;
}
