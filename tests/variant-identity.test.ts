import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolveVariants } from "../src/database/variant-identity.js";
import { parseProduct } from "../src/providers/zara/parser.js";
const raw = JSON.parse(
  readFileSync(
    new URL("./fixtures/zara-twinned-product.json", import.meta.url),
    "utf8",
  ),
);
const url =
  "https://www.zara.com/pl/pl/kurtka-ze-sztucznej-skory-z-paskiem-p04341843.html?v1=545490818";
const m = parseProduct(raw, url).variants.find((v) => v.size === "M")!;
it("reads real Zara twinned SKUs", () => {
  expect(m.aliasIds).toContain("545489588");
  expect(m.id).toBe("575958850");
});
it("preserves the old watched identity when Zara rotates the primary SKU", () => {
  const incoming = { ...m, id: "545489588", aliasIds: ["575958850"] };
  expect(
    resolveVariants(
      [incoming],
      [{ id: 1, externalVariantId: "575958850", size: "M" }],
    )[0],
  ).toMatchObject({ id: "575958850", selectable: true });
});
it("refreshes previously split histories but presents only one selection", () => {
  const result = resolveVariants(
    [m],
    [
      { id: 2, externalVariantId: "545489588", size: "M" },
      { id: 1, externalVariantId: "575958850", size: "M" },
    ],
  );
  expect(result.map((v) => [v.id, v.selectable])).toEqual([
    ["575958850", true],
    ["545489588", false],
  ]);
});
it("never maps by a size label alone or across different sizes", () => {
  expect(
    resolveVariants(
      [m],
      [{ id: 1, externalVariantId: "unrelated", size: "M" }],
    )[0].id,
  ).toBe(m.id);
  expect(
    resolveVariants(
      [{ ...m, id: "new", aliasIds: [m.id] }],
      [{ id: 1, externalVariantId: m.id, size: "L" }],
    )[0].id,
  ).toBe("new");
});
it("rejects ambiguous aliases before any state is changed", () => {
  expect(() => resolveVariants([m, { ...m, id: "other" }], [])).toThrow(
    "Ambiguous",
  );
});
