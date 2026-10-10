export type State = { price: number; available: boolean };
export type Rule = {
  watchPrice: boolean;
  watchStock: boolean;
  targetPrice: number | null;
};
export type EventType =
  "PRICE_DROP" | "TARGET_PRICE_REACHED" | "RESTOCK" | "OUT_OF_STOCK";
export function events(
  previous: State | undefined,
  current: State,
  rule: Rule,
): EventType[] {
  if (!previous) return [];
  const result: EventType[] = [];
  if (rule.watchPrice) {
    if (rule.targetPrice !== null) {
      if (
        previous.price > rule.targetPrice &&
        current.price <= rule.targetPrice
      )
        result.push("TARGET_PRICE_REACHED");
    } else if (current.price < previous.price) result.push("PRICE_DROP");
  }
  if (rule.watchStock && previous.available !== current.available)
    result.push(current.available ? "RESTOCK" : "OUT_OF_STOCK");
  return result;
}
export type SizeChange = {
  size: string;
  previous: State | undefined;
  current: State;
};
export type AllSizesEvent = {
  types: EventType[];
  previous: State;
  current: State;
  restocked: string[];
  soldOut: string[];
  availableSizes: string[];
};
/** One combined event per check for a watch on every size of a product. */
export function allSizesEvents(
  changes: SizeChange[],
  rule: Rule,
): AllSizesEvent | null {
  const known = changes.filter(
    (c): c is SizeChange & { previous: State } => !!c.previous,
  );
  if (!known.length) return null;
  const previous = {
    price: Math.min(...known.map((c) => c.previous.price)),
    available: known.some((c) => c.previous.available),
  };
  const current = {
    price: Math.min(...known.map((c) => c.current.price)),
    available: known.some((c) => c.current.available),
  };
  const types = events(previous, current, { ...rule, watchStock: false });
  const restocked = rule.watchStock
    ? known
        .filter((c) => !c.previous.available && c.current.available)
        .map((c) => c.size)
    : [];
  const soldOut = rule.watchStock
    ? known
        .filter((c) => c.previous.available && !c.current.available)
        .map((c) => c.size)
    : [];
  if (restocked.length) types.push("RESTOCK");
  if (soldOut.length) types.push("OUT_OF_STOCK");
  if (!types.length) return null;
  return {
    types,
    previous,
    current,
    restocked,
    soldOut,
    availableSizes: changes
      .filter((c) => c.current.available)
      .map((c) => c.size),
  };
}
