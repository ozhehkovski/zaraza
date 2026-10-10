import { Bot, InlineKeyboard } from "grammy";
import type { Repository } from "../database/repository.js";
import type { ProviderRegistry } from "../providers/types.js";
import { money } from "../notifications/service.js";
import { parseMoney } from "../providers/zara/parser.js";
import { log, safeError } from "../log.js";
import { ALL_SIZES, type WatchView } from "../database/repository.js";
const expired = "Выбор устарел. Отправьте ссылку ещё раз.";
const time = (d: Date) =>
  d.toLocaleString("ru-RU", { timeZone: "Europe/Warsaw" });
function availability(r: WatchView) {
  if (!r.availableSizes)
    return r.state.available ? "🟢 в наличии" : "🔴 нет в наличии";
  return r.availableSizes.length
    ? `🟢 в наличии: ${r.availableSizes.join(", ")}`
    : "🔴 нет в наличии";
}
function ruleLabel(w: WatchView["watch"]) {
  const price = w.targetPrice
    ? `цена ≤ ${money(w.targetPrice)}`
    : w.watchPrice
      ? "любое снижение цены"
      : null;
  return [price, w.watchStock ? "наличие" : null].filter(Boolean).join(" + ");
}
export function createBot(
  token: string,
  repo: Repository,
  registry: ProviderRegistry,
  interval: number,
) {
  const bot = new Bot(token);
  const help =
    "Отправьте ссылку на товар Zara Польша. Выберите размер (или все размеры) и условие.\n/start — начать\n/watch — добавить товар\n/list — отслеживаемые товары\n/history — история цены\n/settings — настройки\n/help — помощь";
  // Private chats only: watches cannot be controlled by other members of a group.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private") return;
    if (!ctx.from) return;
    try {
      await next();
    } catch (e) {
      log.warn({ error: safeError(e) }, "telegram action failed");
      await ctx.reply(
        "Не удалось выполнить операцию. Zara может временно блокировать доступ. Попробуйте позже.",
      );
    }
  });
  bot.command(["start", "help"], (ctx) => ctx.reply(help));
  bot.command("watch", (ctx) =>
    ctx.reply("Вставьте ссылку на товар с https://www.zara.com/pl/"),
  );
  async function showList(ctx: any, page = 0, historyOnly = false) {
    const u = await repo.user(ctx.from.id);
    const rows = await repo.list(u.id, page * 10);
    if (!rows.length) {
      await ctx.reply(
        "Вы пока не отслеживаете товары. Отправьте ссылку Zara PL.",
      );
      return;
    }
    await ctx.reply(
      historyOnly
        ? "Выберите товар для истории цены:"
        : `Отслеживаемые товары — страница ${page + 1}`,
    );
    for (const r of rows.slice(0, 10)) {
      const keyboard = new InlineKeyboard()
        .text(
          historyOnly ? "История цены" : "Подробнее",
          `${historyOnly ? "hist" : "detail"}:${r.watch.id}`,
        )
        .text("Удалить", `del:${r.watch.id}`);
      await ctx.reply(
        `${r.product.name}\nРазмер: ${r.size}\n${money(r.state.price, r.product.currency)}\n${availability(r)}${r.product.lastError ? "\n⚠️ Последняя проверка не удалась." : ""}`,
        { reply_markup: keyboard },
      );
    }
    const nav = new InlineKeyboard();
    if (page > 0)
      nav.text("← Назад", `page:${historyOnly ? "h" : "l"}:${page - 1}`);
    if (rows.length > 10)
      nav.text("Далее →", `page:${historyOnly ? "h" : "l"}:${page + 1}`);
    if (nav.inline_keyboard[0]?.length)
      await ctx.reply("Страницы:", { reply_markup: nav });
  }
  bot.command("list", (ctx) => showList(ctx));
  bot.command("history", (ctx) => showList(ctx, 0, true));
  bot.command("settings", async (ctx) => {
    await ctx.reply(
      `Язык: русский\nЧастота проверки: ${interval} с\nВалюта: PLN\nЧастота меняется через CHECK_INTERVAL_SECONDS в .env.\n/list — управление подписками.`,
      {
        reply_markup: new InlineKeyboard().text(
          "Отменить текущий выбор",
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
    await ctx.answerCallbackQuery("Отменено");
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
      await ctx.answerCallbackQuery("Подписка не найдена.");
      return;
    }
    await ctx.answerCallbackQuery();
    if (ctx.match[1] === "del") {
      await repo.remove(u.id, id);
      await ctx
        .editMessageReplyMarkup({ reply_markup: new InlineKeyboard() })
        .catch(() => {});
      await ctx.reply("✅ Отслеживание остановлено");
      return;
    }
    if (ctx.match[1] === "hist") {
      const h = await repo.priceHistory(u.id, id);
      await ctx.reply(
        `История цены — ${r.product.name} (${r.size})\n${h.rows
          .reverse()
          .map(
            (row) =>
              `${time(row.createdAt)} — ${money(row.price)} ${row.available ? "🟢" : "🔴"}${r.variant ? "" : ` ${row.size}`}`,
          )
          .join("\n")}\nМинимальная цена: ${money(h.min)}`,
      );
      return;
    }
    await ctx.reply(
      `${r.product.name}\nРазмер: ${r.size}\nЦена: ${money(r.state.price)}${r.variant ? "" : " (минимальная)"}\n${availability(r)}\nУсловие: ${ruleLabel(r.watch)}\nПоследняя проверка: ${time(r.state.checkedAt)}${r.product.lastError ? "\n⚠️ Zara временно недоступна." : ""}`,
      {
        reply_markup: new InlineKeyboard()
          .url("Открыть Zara", r.product.url)
          .row()
          .text("История цены", `hist:${id}`)
          .text("Удалить", `del:${id}`),
      },
    );
  });
  bot.callbackQuery(/^size:(\d+):(\d+|all)$/, async (ctx) => {
    const u = await repo.user(ctx.from.id);
    const productId = Number(ctx.match[1]);
    const variantId = ctx.match[2] === "all" ? null : Number(ctx.match[2]);
    const d = await repo.draft(u.id);
    const sizes = d?.productId === productId ? await repo.sizes(productId) : [];
    if (
      !sizes.length ||
      (variantId !== null && !sizes.some((v) => v.variant.id === variantId))
    ) {
      await ctx.answerCallbackQuery(expired);
      return;
    }
    await repo.setDraft(u.id, productId, "rule", variantId);
    await ctx.answerCallbackQuery();
    const key = variantId ?? "all";
    await ctx.reply(
      variantId === null ? "Все размеры. Что отслеживать?" : "Что отслеживать?",
      {
        reply_markup: new InlineKeyboard()
          .text("🔥 Любое снижение цены", `rule:${key}:price`)
          .row()
          .text("🎯 Цена ниже…", `rule:${key}:target`)
          .row()
          .text("📦 Наличие", `rule:${key}:stock`)
          .row()
          .text("💰 Цена + наличие", `rule:${key}:both`),
      },
    );
  });
  async function activate(
    ctx: any,
    userId: number,
    mode: string,
    targetPrice: number | null = null,
  ) {
    const d = await repo.draft(userId);
    if (!d || d.stage === "size") throw new Error("expired");
    const product = await repo.byProductId(d.productId);
    const sizes = await repo.sizes(d.productId);
    const selected = d.variantId
      ? sizes.find((s) => s.variant.id === d.variantId)
      : null;
    if (d.variantId && !selected) throw new Error("expired");
    const price = selected
      ? selected.state.price
      : Math.min(...sizes.map((s) => s.state.price));
    await repo.watch(userId, {
      watchPrice: mode !== "stock",
      watchStock: ["stock", "both"].includes(mode),
      targetPrice,
    });
    await ctx.reply(
      `✅ Отслеживание запущено\n${product.name}\nРазмер: ${selected ? selected.variant.size : ALL_SIZES}\nТекущая цена: ${money(price)}${targetPrice ? `\nЦелевая цена: ${money(targetPrice)}${price <= targetPrice ? "\nЦена уже на уровне цели. Следующее уведомление — при повторном пересечении порога." : ""}` : ""}\nЦена и наличие проверяются автоматически. /list`,
    );
  }
  bot.callbackQuery(
    /^rule:(\d+|all):(price|target|stock|both)$/,
    async (ctx) => {
      const u = await repo.user(ctx.from.id);
      const d = await repo.draft(u.id);
      const variantId = ctx.match[1] === "all" ? null : Number(ctx.match[1]);
      if (!d || d.stage !== "rule" || d.variantId !== variantId) {
        await ctx.answerCallbackQuery(expired);
        return;
      }
      await ctx.answerCallbackQuery();
      if (ctx.match[2] === "target") {
        await repo.setDraft(u.id, d.productId, "target", d.variantId);
        await ctx.reply(
          "Укажите целевую цену в злотых, например 199 или 199,99.",
        );
      } else await activate(ctx, u.id, ctx.match[2]);
    },
  );
  bot.on("message:text", async (ctx) => {
    const u = await repo.user(ctx.from.id);
    const text = ctx.message.text.trim();
    const d = await repo.draft(u.id);
    if (d?.stage === "target" && !text.includes("https://")) {
      try {
        const price = parseMoney(text);
        await activate(ctx, u.id, "target", price);
      } catch (e) {
        await ctx.reply("Укажите корректную цену в злотых, например 199,99.");
      }
      return;
    }
    const url = text.match(/https:\/\/[^\s<>]+/)?.[0];
    if (!url) {
      await ctx.reply("Отправьте ссылку на товар Zara Польша. /help");
      return;
    }
    let provider;
    try {
      provider = registry.forUrl(url);
    } catch {
      await ctx.reply("Поддерживаются только ссылки на товары Zara Польша.");
      return;
    }
    await ctx.reply("Загружаю товар…");
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
    keyboard.row().text("👕 Все размеры", `size:${stored.id}:all`);
    const caption = `${p.name}\nЦена: ${money(p.currentPrice)}${p.originalPrice ? `\nПрежняя цена: ${money(p.originalPrice)}` : ""}\nВыберите размер:`;
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
