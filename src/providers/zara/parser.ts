import type { Product } from "../types.js";
export function zaraUrl(raw: string): URL {
  const u = new URL(raw);
  if (
    u.protocol !== "https:" ||
    !["www.zara.com", "zara.com"].includes(u.hostname) ||
    u.port ||
    u.username ||
    u.password ||
    !/^\/pl\/(?:[a-z]{2}\/)?[^/]+-p\d+\.html$/.test(u.pathname)
  )
    throw new Error(
      "Wklej link produktu Zara Polska (https://www.zara.com/pl/pl/…-p….html).",
    );
  // Share links from the app use the UI language (/pl/en/…) and carry utm_*:
  // normalize to one canonical PL URL so the same product is not tracked twice.
  const slug = u.pathname.split("/").pop()!;
  const v1 = u.searchParams.get("v1");
  const out = new URL(`https://www.zara.com/pl/pl/${slug}`);
  if (v1 && /^\d+$/.test(v1)) out.searchParams.set("v1", v1);
  return out;
}
export function parseMoney(value: string): number {
  const s = value
    .trim()
    .replace(/\s|PLN|zł/gi, "")
    .replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s))
    throw new Error("Podaj dodatnią cenę, np. 199,99.");
  const n = Math.round(Number(s) * 100);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 100000000)
    throw new Error("Nieprawidłowa cena.");
  return n;
}
export function parseProduct(raw: any, url: string, id?: string): Product {
  const list = Array.isArray(raw) ? raw : [raw.product ?? raw];
  const wanted = id ?? new URL(url).searchParams.get("v1");
  const item =
    list.find(
      (p: any) =>
        String(p.id) === wanted ||
        p.detail?.colors?.some((c: any) => String(c.productId) === wanted),
    ) ?? (list.length === 1 ? list[0] : undefined);
  if (!item?.name || !item.detail?.colors?.length)
    throw new Error("Zara API schema changed: missing product/colors");
  const color = wanted
    ? item.detail.colors.find((c: any) => String(c.productId) === wanted)
    : item.detail.colors[0];
  if (!color)
    throw new Error("Zara API schema changed: requested color missing");
  const sizes = color.sizes;
  if (!Array.isArray(sizes) || !sizes.length)
    throw new Error("Zara API schema changed: missing sizes");
  const validStatuses = new Set([
    "in_stock",
    "low_on_stock",
    "out_of_stock",
    "coming_soon",
    "back_soon",
  ]);
  const price = color.price ?? sizes[0]?.price ?? item.price;
  if (!Number.isSafeInteger(price) || price <= 0)
    throw new Error("Zara API schema changed: invalid price");
  const variants = sizes.map((s: any) => {
    if (!s.sku || !s.name || !validStatuses.has(s.availability))
      throw new Error("Zara API schema changed: invalid size/stock");
    const p = s.price ?? price;
    if (!Number.isSafeInteger(p) || p <= 0)
      throw new Error("Invalid variant price");
    return {
      id: String(s.sku),
      aliasIds: Array.isArray(s.twinnedSkus)
        ? s.twinnedSkus.map((t: any) => {
            if (!Number.isSafeInteger(t.sku) || t.sku <= 0)
              throw new Error("Zara API schema changed: invalid twinned SKU");
            return String(t.sku);
          })
        : [],
      size: String(s.name),
      available: ["in_stock", "low_on_stock"].includes(s.availability),
      price: p,
      originalPrice: s.oldPrice ?? color.oldPrice ?? item.oldPrice ?? null,
    };
  });
  const image = (color.xmedia ?? item.xmedia ?? []).find(
    (m: any) => m.type === "image",
  );
  const img =
    image?.extraInfo?.deliveryUrl ??
    image?.url?.replace("{width}", "750") ??
    null;
  const canonical = new URL(url);
  canonical.searchParams.set("v1", String(color.productId));
  return {
    store: "zara",
    externalId: String(color.productId),
    name: item.name,
    url: canonical.href,
    image: img,
    currency: "PLN",
    currentPrice: price,
    originalPrice: color.oldPrice ?? item.oldPrice ?? null,
    variants,
  };
}

/** Extract JSON data, never execute JavaScript from the shop. */
export function parsePagePayload(html: string): unknown {
  const match = /window\.zara\.viewPayload\s*=\s*/.exec(html);
  if (!match)
    throw new Error("Zara product payload missing (challenge or API change)");
  const start = match.index + match[0].length;
  if (html[start] !== "{") throw new Error("Invalid Zara product payload");
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0)
      return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error("Truncated Zara product payload");
}
