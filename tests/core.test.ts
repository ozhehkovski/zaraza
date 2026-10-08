import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseProduct,
  parseMoney,
  zaraUrl,
} from "../src/providers/zara/parser.js";
import { events } from "../src/monitor/rules.js";
import { ZaraProvider } from "../src/providers/zara/ZaraProvider.js";
import { ProviderRegistry } from "../src/providers/types.js";
import { MonitoringEngine, concurrent } from "../src/monitor/engine.js";
import { notificationText } from "../src/notifications/service.js";
const url = "https://www.zara.com/pl/pl/anorak-p01255713.html?v1=545470428";
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/zara-details.json", import.meta.url),
    "utf8",
  ),
);
describe("Zara parsing", () => {
  it.each([url, "https://zara.com/pl/anorak-p01255713.html"])(
    "accepts PL product %s",
    (u) => expect(zaraUrl(u).hostname).toBe("www.zara.com"),
  );
  it.each([
    [
      "https://www.zara.com/pl/en/flare-trousers-p04745222.html?v1=600172461&utm_campaign=productShare&utm_medium=mobile_sharing_iOS&utm_source=red_social_movil",
      "https://www.zara.com/pl/pl/flare-trousers-p04745222.html?v1=600172461",
    ],
    [
      "https://zara.com/pl/anorak-p01255713.html?v2=1#top",
      "https://www.zara.com/pl/pl/anorak-p01255713.html",
    ],
    [url, url],
  ])("normalizes share/language link %s", (u, want) =>
    expect(zaraUrl(u).href).toBe(want),
  );
  it.each([
    "https://zara.com.evil.test/pl/pl/a-p123.html",
    "http://www.zara.com/pl/pl/a-p123.html",
    "https://www.zara.com/es/es/a-p123.html",
    "https://www.zara.com/pl/en/extra/a-p123.html",
    "https://www.zara.com/pl/",
    "https://u:p@www.zara.com/pl/pl/a-p123.html",
    "https://www.zara.com:4433/pl/pl/a-p123.html",
  ])("rejects invalid/unsafe URL %s", (u) =>
    expect(() => zaraUrl(u)).toThrow(),
  );
  it.each([
    ["199", 19900],
    ["199,99", 19999],
    ["1 299,95 PLN", 129995],
    ["129.50 zł", 12950],
  ])("parses money %s", (v, n) => expect(parseMoney(v as string)).toBe(n));
  it.each(["-1", "0", "1.999", "NaN", "199abc"])(
    "rejects invalid money %s",
    (v) => expect(() => parseMoney(v)).toThrow(),
  );
  it("parses real color price, photo and six SKU sizes", () => {
    const p = parseProduct(fixture, url);
    expect(p.currentPrice).toBe(21900);
    expect(p.externalId).toBe("545470428");
    expect(p.variants).toHaveLength(6);
    expect(p.variants[0]).toMatchObject({ size: "XS", available: false });
    expect(p.variants[2]).toMatchObject({
      size: "M",
      available: true,
      id: "545467254",
    });
    expect(p.image).toMatch(/^https:\/\/static.zara.net/);
  });
  it("rejects unknown stock and missing requested color instead of false alerts", () => {
    const bad = structuredClone(fixture);
    bad[0].detail.colors[0].sizes[0].availability = "unknown";
    expect(() => parseProduct(bad, url)).toThrow();
    expect(() => parseProduct(fixture, url, "123")).toThrow();
  });
  it("parses old price and low stock", () => {
    const data = structuredClone(fixture);
    data[0].detail.colors[0].oldPrice = 29900;
    data[0].detail.colors[0].sizes[0].availability = "low_on_stock";
    expect(parseProduct(data, url)).toMatchObject({ originalPrice: 29900 });
    expect(parseProduct(data, url).variants[0].available).toBe(true);
  });
});
describe("notification rules", () => {
  const all = { watchPrice: true, watchStock: true, targetPrice: null };
  const before = { price: 29900, available: false };
  it("does not notify on initial snapshot", () =>
    expect(events(undefined, before, all)).toEqual([]));
  it("detects price drop and restock together", () =>
    expect(events(before, { price: 19900, available: true }, all)).toEqual([
      "PRICE_DROP",
      "RESTOCK",
    ]));
  it("detects target crossing and suppresses repeated below-target alerts", () => {
    const rule = { ...all, watchStock: false, targetPrice: 19900 };
    expect(events(before, { price: 19900, available: false }, rule)).toEqual([
      "TARGET_PRICE_REACHED",
    ]);
    expect(
      events(
        { price: 19900, available: false },
        { price: 18900, available: false },
        rule,
      ),
    ).toEqual([]);
  });
  it("respects price-only and stock-only rules", () => {
    expect(
      events(
        before,
        { price: 19900, available: true },
        { ...all, watchStock: false },
      ),
    ).toEqual(["PRICE_DROP"]);
    expect(
      events(
        before,
        { price: 19900, available: true },
        { ...all, watchPrice: false },
      ),
    ).toEqual(["RESTOCK"]);
  });
  it("detects out of stock", () =>
    expect(
      events(
        { price: 19900, available: true },
        { price: 19900, available: false },
        all,
      ),
    ).toEqual(["OUT_OF_STOCK"]));
  it("ignores unchanged state and price increase", () => {
    expect(events(before, before, all)).toEqual([]);
    expect(events(before, { ...before, price: 39900 }, all)).toEqual([]);
  });
  it("formats discount in PLN", () =>
    expect(
      notificationText({
        types: ["PRICE_DROP"],
        telegramId: 1,
        watchId: 1,
        name: "Kurtka",
        url,
        size: "L",
        currency: "PLN",
        previous: before,
        current: { price: 19900, available: true },
      }),
    ).toContain("-33%"));
});
describe("deduplication and scheduling", () => {
  it("coalesces fifty simultaneous same-product requests", async () => {
    const json = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return fixture;
    });
    const provider = new ZaraProvider({ json });
    await Promise.all(
      Array.from({ length: 50 }, () => provider.getProduct(url)),
    );
    expect(json).toHaveBeenCalledTimes(1);
  });
  it("checks unique products once and records errors independently", async () => {
    const getProduct = vi.fn(async (u: string) => {
      if (u === "bad") throw new Error("403");
      return parseProduct(fixture, url);
    });
    const repo = {
      due: vi.fn(async () => [
        { id: 1, store: "zara", url, externalId: "545470428", failures: 0 },
        { id: 1, store: "zara", url, externalId: "545470428", failures: 0 },
        { id: 2, store: "zara", url: "bad", externalId: "2", failures: 0 },
      ]),
      apply: vi.fn(async () => {}),
      failed: vi.fn(async () => {}),
    };
    const registry = new ProviderRegistry([
      {
        store: "zara",
        getProduct,
        canHandle: () => true,
        getPrice: vi.fn(),
        getAvailability: vi.fn(),
        getSizes: vi.fn(),
      },
    ]);
    const engine = new MonitoringEngine(repo, registry, 60, 10);
    await Promise.all([engine.tick(), engine.tick()]);
    expect(getProduct).toHaveBeenCalledTimes(2);
    expect(repo.apply).toHaveBeenCalledTimes(1);
    expect(repo.failed).toHaveBeenCalledTimes(1);
  });
  it("bounds concurrency", async () => {
    let active = 0,
      max = 0;
    await concurrent(Array.from({ length: 100 }), 10, async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
    });
    expect(max).toBe(10);
  });
});
