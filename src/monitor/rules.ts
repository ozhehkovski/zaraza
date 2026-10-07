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
