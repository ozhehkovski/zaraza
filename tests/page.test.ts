import { it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  parsePagePayload,
  parseProduct,
} from "../src/providers/zara/parser.js";
import { ZaraProvider } from "../src/providers/zara/ZaraProvider.js";
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/zara-page-product.json", import.meta.url),
    "utf8",
  ),
);
const html = `<html><script>window.zara.viewPayload = ${JSON.stringify(fixture)}; throw new Error('Do not execute');</script></html>`;
const url =
  "https://www.zara.com/pl/pl/skorzana-kurtka-bomberka-ze-stojka-p06318252.html?v1=599226858";
it("extracts a real rendered product without executing shop JavaScript", () => {
  const p = parseProduct(parsePagePayload(html), url);
  expect(p.currentPrice).toBe(55900);
  expect(p.externalId).toBe("599226858");
  expect(p.variants.length).toBeGreaterThan(0);
});
it("handles braces and escaped quotes inside strings", () => {
  expect(
    parsePagePayload(
      '<script>window.zara.viewPayload = {"name":"} brace \\" quote","nested":{"a":1}};danger()</script>',
    ),
  ).toEqual({ name: '} brace " quote', nested: { a: 1 } });
});
it.each([
  "<html>Access Denied</html>",
  '<html>window.zara.viewPayload = {"x":1',
  "window.zara.viewPayload = function(){evil()}",
])("rejects challenge, truncated or non-JSON pages", (html) =>
  expect(() => parsePagePayload(html)).toThrow(),
);
it("uses page data and reuses the real canonical URL for getPrice", async () => {
  const transport = { html: vi.fn(async () => html), json: vi.fn() };
  const p = new ZaraProvider(transport, "page");
  await p.getProduct(url);
  expect(await p.getPrice("599226858")).toMatchObject({ currentPrice: 55900 });
  expect(transport.json).not.toHaveBeenCalled();
  expect(transport.html).toHaveBeenLastCalledWith(url);
});
