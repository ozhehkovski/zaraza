import type { Product, StoreProvider } from "../types.js";
import { parseProduct, zaraUrl, parsePagePayload } from "./parser.js";
export class ZaraProvider implements StoreProvider {
  readonly store = "zara";
  private inflight = new Map<string, Promise<Product>>();
  private urls = new Map<string, string>();
  constructor(
    private transport: {
      json(url: string): Promise<any>;
      html?(url: string): Promise<string>;
      close?(): Promise<void>;
    },
    private source: "api" | "page" = "api",
  ) {}
  canHandle(url: string) {
    try {
      zaraUrl(url);
      return true;
    } catch {
      return false;
    }
  }
  async getProduct(raw: string): Promise<Product> {
    const u = zaraUrl(raw);
    const id = u.searchParams.get("v1");
    const key = id ?? u.href;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const task = (async () => {
      const data =
        this.source === "page" && this.transport.html
          ? parsePagePayload(await this.transport.html(u.href))
          : await this.transport.json(
              id
                ? `https://www.zara.com/pl/pl/products-details?productIds=${encodeURIComponent(id)}&ajax=true`
                : `${u.href}${u.search ? "&" : "?"}ajax=true`,
            );
      const product = parseProduct(data, u.href, id ?? undefined);
      this.urls.set(product.externalId, product.url);
      return product;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }
  private async byId(id: string) {
    if (!/^\d+$/.test(id)) throw new Error("Invalid product id");
    const known = this.urls.get(id);
    if (known) return this.getProduct(known);
    const raw = await this.transport.json(
      `https://www.zara.com/pl/pl/products-details?productIds=${id}&ajax=true`,
    );
    const item = (Array.isArray(raw) ? raw : [raw.product ?? raw]).find(
      (p: any) =>
        p.detail?.colors?.some((c: any) => String(c.productId) === id),
    );
    if (!item?.seo?.keyword || !item.seo.seoProductId)
      throw new Error("Product URL unknown; resolve the product by URL first");
    const product = parseProduct(
      raw,
      `https://www.zara.com/pl/pl/${item.seo.keyword}-p${item.seo.seoProductId}.html?v1=${id}`,
      id,
    );
    this.urls.set(id, product.url);
    return product;
  }
  async getPrice(id: string) {
    const p = await this.byId(id);
    return {
      currentPrice: p.currentPrice,
      originalPrice: p.originalPrice,
      currency: p.currency,
    };
  }
  async getAvailability(id: string) {
    return { variants: (await this.byId(id)).variants };
  }
  async getSizes(id: string) {
    return (await this.byId(id)).variants;
  }
  async close() {
    await this.transport.close?.();
  }
}
