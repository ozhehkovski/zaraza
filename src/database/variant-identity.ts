import type { Size } from "../providers/types.js";

/** Preserve existing history and watches only for explicit, unambiguous SKU aliases. */
export function resolveVariants(
  incoming: Size[],
  stored: { id: number; externalVariantId: string; size: string }[],
) {
  const claims = new Map<string, number>();
  for (const v of incoming)
    for (const id of new Set([v.id, ...(v.aliasIds ?? [])]))
      claims.set(id, (claims.get(id) ?? 0) + 1);
  if ([...claims.values()].some((n) => n > 1))
    throw new Error("Ambiguous SKU aliases in store response");
  return incoming.flatMap((v) => {
    const ids = new Set([v.id, ...(v.aliasIds ?? [])]);
    const matches = stored
      .filter((s) => ids.has(s.externalVariantId) && s.size === v.size)
      .sort((a, b) => a.id - b.id);
    // Known aliases may already have separate rows from earlier snapshots.
    // Update them all, but offer one selection so existing watches remain valid.
    if (!matches.length) return [{ ...v, selectable: true }];
    return matches.map((s, index) => ({
      ...v,
      id: s.externalVariantId,
      selectable: index === 0,
    }));
  });
}
