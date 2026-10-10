export type Size = {
  id: string;
  aliasIds?: string[];
  size: string;
  available: boolean;
  price?: number;
  originalPrice?: number | null;
};
export type Price = {
  currentPrice: number;
  originalPrice: number | null;
  currency: string;
};
export type Availability = { variants: Size[] };
export type Product = Price & {
  store: string;
  externalId: string;
  name: string;
  url: string;
  image: string | null;
  variants: Size[];
};
export type StoreSession = { cookies: string; expiresAt: Date };
export type AddToCartResult = { success: boolean };
export interface StoreProvider {
  readonly store: string;
  canHandle(url: string): boolean;
  getProduct(url: string): Promise<Product>;
  getPrice(productId: string): Promise<Price>;
  getAvailability(productId: string): Promise<Availability>;
  getSizes(productId: string): Promise<Size[]>;
  addToCart?(
    session: StoreSession,
    variantId: string,
  ): Promise<AddToCartResult>;
  close?(): Promise<void>;
}
export class ProviderRegistry {
  constructor(public providers: StoreProvider[]) {}
  forUrl(url: string) {
    const p = this.providers.find((p) => p.canHandle(url));
    if (!p)
      throw new Error("Поддерживаются только ссылки на товары Zara Польша.");
    return p;
  }
  forStore(store: string) {
    const p = this.providers.find((p) => p.store === store);
    if (!p) throw new Error("Unsupported store");
    return p;
  }
}
