import type { ProviderRegistry } from "../providers/types.js";
import { log, safeError } from "../log.js";
export async function concurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
) {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const item = items[index++];
        await fn(item);
      }
    }),
  );
}
export interface MonitorRepository {
  due(): Promise<
    {
      id: number;
      store: string;
      url: string;
      externalId: string;
      failures: number;
    }[]
  >;
  apply(id: number, product: any, interval: number): Promise<void>;
  failed(
    id: number,
    failures: number,
    error: string,
    interval: number,
  ): Promise<void>;
}
export class MonitoringEngine {
  running = false;
  lastCycle: Date | null = null;
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  lastError: string | null = null;
  constructor(
    private repo: MonitorRepository,
    private providers: ProviderRegistry,
    private interval: number,
    private concurrency: number,
  ) {}
  async tick() {
    if (this.active) return this.active;
    this.active = (async () => {
      try {
        const due = await this.repo.due();
        const unique = [
          ...new Map(
            due.map((p) => [`${p.store}:${p.externalId}`, p]),
          ).values(),
        ];
        await concurrent(unique, this.concurrency, async (p) => {
          try {
            const state = await this.providers
              .forStore(p.store)
              .getProduct(p.url);
            if (state.externalId !== p.externalId)
              throw new Error("Product identity changed");
            await this.repo.apply(p.id, state, this.interval);
            log.info(
              {
                store: p.store,
                productId: p.externalId,
                price: state.currentPrice,
                availableSizes: state.variants
                  .filter((v) => v.available)
                  .map((v) => v.size),
              },
              "product checked",
            );
          } catch (e) {
            await this.repo.failed(
              p.id,
              p.failures,
              safeError(e),
              this.interval,
            );
          }
        });
        this.lastError = null;
        this.lastCycle = new Date();
      } catch (e) {
        this.lastError = safeError(e);
        log.error({ error: this.lastError }, "monitor cycle failed");
      }
    })().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }
  start() {
    this.running = true;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 1000);
  }
  async stop() {
    this.running = false;
    clearInterval(this.timer);
    await this.active;
  }
}
