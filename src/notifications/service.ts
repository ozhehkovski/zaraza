import { InlineKeyboard, type Api, GrammyError } from "grammy";
import type { Repository } from "../database/repository.js";
import { log, safeError } from "../log.js";
export const money = (cents: number, currency = "PLN") =>
  new Intl.NumberFormat("pl-PL", { style: "currency", currency }).format(
    cents / 100,
  );
export type Notification = {
  types: string[];
  telegramId: number;
  watchId: number;
  name: string;
  url: string;
  size: string;
  currency: string;
  previous: { price: number; available: boolean };
  current: { price: number; available: boolean };
};
export function notificationText(n: Notification) {
  const labels: Record<string, string> = {
    PRICE_DROP: "🔥 CENA SPADŁA",
    TARGET_PRICE_REACHED: "🎯 CENA DOCELOWA OSIĄGNIĘTA",
    RESTOCK: "📦 ROZMIAR ZNOWU DOSTĘPNY",
    OUT_OF_STOCK: "📦 ROZMIAR NIEDOSTĘPNY",
  };
  const price =
    n.previous.price !== n.current.price
      ? `${money(n.previous.price, n.currency)} → ${money(n.current.price, n.currency)}${n.current.price < n.previous.price ? `\n-${Math.round((1 - n.current.price / n.previous.price) * 100)}%` : ""}`
      : money(n.current.price, n.currency);
  return `${n.types.map((t) => labels[t]).join("\n")}\n${n.name}\n${price}\nRozmiar: ${n.size}\nStatus: ${n.current.available ? "dostępny" : "brak"}`;
}
export class NotificationService {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private pausedUntil = 0;
  constructor(
    private repo: Repository,
    private api: Api,
  ) {}
  async tick() {
    if (this.active) return this.active;
    if (Date.now() < this.pausedUntil) return;
    this.active = (async () => {
      try {
        for (const { entry, enabled } of await this.repo.pending()) {
          if (!enabled) {
            await this.repo.delivered(entry.id);
            continue;
          }
          const n = entry.payload as Notification;
          try {
            await this.api.sendMessage(n.telegramId, notificationText(n), {
              reply_markup: new InlineKeyboard()
                .url("🛒 Otwórz Zara", n.url)
                .row()
                .text("❌ Zatrzymaj monitoring", `del:${n.watchId}`),
            });
            await this.repo.delivered(entry.id);
            await new Promise((r) => setTimeout(r, 50));
          } catch (e) {
            if (e instanceof GrammyError && [403, 400].includes(e.error_code)) {
              await this.repo.delivered(entry.id);
              log.warn(
                { notificationId: entry.id, code: e.error_code },
                "undeliverable notification",
              );
              continue;
            }
            const delay =
              e instanceof GrammyError && e.error_code === 429
                ? (e.parameters.retry_after ?? 60) * 1000
                : Math.min(3600000, 5000 * 2 ** Math.min(entry.attempts, 10));
            await this.repo.retry(entry.id, entry.attempts, delay);
            log.warn(
              { notificationId: entry.id, error: safeError(e) },
              "notification queued for retry",
            );
            if (e instanceof GrammyError && e.error_code === 429) {
              this.pausedUntil = Date.now() + delay;
              break;
            }
          }
        }
      } catch (e) {
        log.error({ error: safeError(e) }, "notification cycle failed");
      }
    })().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }
  start() {
    this.timer = setInterval(() => void this.tick(), 2000);
    void this.tick();
  }
  async stop() {
    clearInterval(this.timer);
    await this.active;
  }
}
