import { chromium, type BrowserContext, type Page } from "playwright";
import { Agent, ProxyAgent, fetch as httpFetch } from "undici";
import { log, safeError } from "../../log.js";
export type TransportOptions = {
  mode: "http" | "browser";
  cookie: string;
  proxy: string;
  headless: boolean;
  executable: string;
  timeout: number;
  rps: number;
  browserPages?: number;
  /** Close a tab after this many navigations (frees bfcache/history/renderer heap). */
  pageMaxUses?: number;
  /** Restart Chromium after this many navigations (frees everything else). */
  browserMaxNavigations?: number;
};
export class ZaraTransport {
  private context?: BrowserContext;
  private page?: Page;
  private starting?: Promise<BrowserContext>;
  private dispatcher: Agent | ProxyAgent;
  private nextSlot = 0;
  private blockedUntil = 0;
  private limits = 0;
  private idlePages: Page[] = [];
  private activePages = 0;
  private pageWaiters: (() => void)[] = [];
  // Chromium memory grows with every navigation of a long-lived tab/browser,
  // so tabs and the whole browser are rotated after a fixed amount of work.
  private pageUses = new WeakMap<Page, number>();
  private navigations = new WeakMap<BrowserContext, number>();
  private leases = new Map<BrowserContext, number>();
  private retired = new WeakSet<BrowserContext>();
  private async acquirePage() {
    const limit = this.options.browserPages ?? 2;
    if (this.activePages >= limit)
      await new Promise<void>((resolve) => this.pageWaiters.push(resolve));
    else this.activePages++;
    const context = await this.browser(false);
    this.lease(context);
    try {
      this.idlePages = this.idlePages.filter((p) => !p.isClosed());
      const page = this.idlePages.pop() ?? (await context.newPage());
      const count = (this.navigations.get(context) ?? 0) + 1;
      this.navigations.set(context, count);
      if (count >= (this.options.browserMaxNavigations ?? 300))
        this.retire(context);
      return page;
    } catch (error) {
      this.unlease(context);
      throw error;
    }
  }
  private releasePage(page?: Page) {
    if (page) {
      const context = page.context();
      const uses = (this.pageUses.get(page) ?? 0) + 1;
      this.pageUses.set(page, uses);
      if (page.isClosed()) {
        // already gone (browser crash/close)
      } else if (
        this.retired.has(context) ||
        context !== this.context ||
        uses >= (this.options.pageMaxUses ?? 25)
      )
        this.closeQuietly(page.close(), "page close failed");
      else this.idlePages.push(page);
      this.unlease(context);
    }
    const next = this.pageWaiters.shift();
    if (next) next();
    else this.activePages--;
  }
  private lease(context: BrowserContext) {
    this.leases.set(context, (this.leases.get(context) ?? 0) + 1);
  }
  private unlease(context: BrowserContext) {
    const left = (this.leases.get(context) ?? 1) - 1;
    if (left > 0) {
      this.leases.set(context, left);
      return;
    }
    this.leases.delete(context);
    if (this.retired.has(context)) this.closeBrowser(context);
  }
  /** Stop handing out this browser; close it once in-flight requests finish. */
  private retire(context: BrowserContext) {
    if (this.retired.has(context)) return;
    this.retired.add(context);
    if (this.context === context) {
      this.context = undefined;
      this.page = undefined;
      for (const p of this.idlePages)
        this.closeQuietly(p.close(), "page close failed");
      this.idlePages = [];
    }
    log.info({ store: "zara" }, "recycling browser");
    if (!this.leases.has(context)) this.closeBrowser(context);
  }
  private closeBrowser(context: BrowserContext) {
    const browser = context.browser();
    this.closeQuietly(
      browser ? browser.close() : context.close(),
      "browser close failed",
    );
  }
  private closeQuietly(task: Promise<unknown>, message: string) {
    task.catch((e) => log.warn({ error: safeError(e) }, message));
  }
  private lastSuccessAt: Date | null = null;
  private lastError: string | null = null;
  private lastStatus: number | null = null;
  get health() {
    return {
      status: this.lastError
        ? this.blockedUntil > Date.now()
          ? "blocked"
          : "error"
        : this.lastSuccessAt
          ? "ok"
          : "unchecked",
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      lastHttpStatus: this.lastStatus,
      nextRetryAt:
        this.blockedUntil > Date.now() ? new Date(this.blockedUntil) : null,
    };
  }
  constructor(private options: TransportOptions) {
    this.dispatcher = options.proxy
      ? new ProxyAgent(options.proxy)
      : new Agent({ connections: 10, keepAliveTimeout: 60000 });
  }
  get cooldownUntil() {
    return this.blockedUntil;
  }
  private async browser(warm = true) {
    if (this.context) return this.context;
    if (!this.starting)
      this.starting = (async () => {
        const browser = await chromium.launch({
          headless: this.options.headless,
          executablePath: this.options.executable || undefined,
          proxy: this.options.proxy
            ? { server: this.options.proxy }
            : undefined,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        });
        const context = await browser.newContext({ locale: "pl-PL" });
        browser.on("disconnected", () => {
          if (this.context === context) {
            this.context = undefined;
            this.page = undefined;
            this.idlePages = [];
          }
        });
        try {
          if (this.options.cookie)
            await context.addCookies(
              this.options.cookie
                .split(";")
                .map((c) => {
                  const i = c.indexOf("=");
                  return {
                    name: c.slice(0, i).trim(),
                    value: c.slice(i + 1).trim(),
                    domain: ".zara.com",
                    path: "/",
                  };
                })
                .filter((c) => c.name),
            );
          if (warm) {
            const page = await context.newPage();
            await page.goto("https://www.zara.com/pl/", {
              waitUntil: "load",
              timeout: 30000,
            });
            this.page = page;
          }
          this.context = context;
          return context;
        } catch (e) {
          await browser.close();
          throw e;
        }
      })().finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }
  async json(url: string): Promise<any> {
    return this.request(url, "json");
  }
  async html(url: string): Promise<string> {
    return this.request(url, "html");
  }
  private async request(url: string, format: "json" | "html"): Promise<any> {
    const u = new URL(url);
    if (u.origin !== "https://www.zara.com")
      throw new Error("Invalid Zara API origin");
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Date.now() < this.blockedUntil)
        throw new Error("Zara temporarily paused after 403/429");
      const slot = Math.max(Date.now(), this.nextSlot);
      this.nextSlot = slot + 1000 / this.options.rps;
      await new Promise((r) => setTimeout(r, Math.max(0, slot - Date.now())));
      if (Date.now() < this.blockedUntil)
        throw new Error("Zara temporarily paused after 403/429");
      const start = Date.now();
      let status = 0;
      try {
        let body: string;
        let retryAfter: string | null = null;
        if (this.options.mode === "browser") {
          if (format === "html") {
            let page: Page;
            try {
              page = await this.acquirePage();
            } catch (error) {
              this.releasePage();
              throw error;
            }
            const deadline = Date.now() + this.options.timeout;
            try {
              if (Date.now() < this.blockedUntil) {
                throw new Error("Zara temporarily paused after 403/429");
              }
              const response = await page.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: this.options.timeout,
              });
              status = response?.status() ?? 0;
              if (status >= 400) {
                body = await page.content();
              } else {
                await page.waitForFunction(
                  () =>
                    Array.from(document.scripts).some((s) =>
                      s.textContent?.includes("window.zara.viewPayload"),
                    ),
                  undefined,
                  { timeout: Math.max(1, deadline - Date.now()) },
                );
                body = await page.content();
              }
            } finally {
              this.releasePage(page);
            }
          } else {
            const context = await this.browser();
            const page = this.page;
            if (!page) throw new Error("Zara browser page is not ready");
            this.lease(context);
            const response = await page
              .evaluate(
                async ({ url, timeout }) => {
                  const response = await fetch(url, {
                    credentials: "include",
                    signal: AbortSignal.timeout(timeout),
                    headers: { accept: "application/json" },
                  });
                  return {
                    status: response.status,
                    retryAfter: response.headers.get("retry-after"),
                    body: await response.text(),
                  };
                },
                { url, timeout: this.options.timeout },
              )
              .finally(() => this.unlease(context));
            status = response.status;
            retryAfter = response.retryAfter;
            body = response.body;
          }
        } else {
          const response = await httpFetch(url, {
            dispatcher: this.dispatcher,
            redirect: "error",
            signal: AbortSignal.timeout(this.options.timeout),
            headers: {
              accept:
                format === "html"
                  ? "text/html,application/xhtml+xml"
                  : "application/json",
              "accept-language": "pl-PL,pl;q=0.9",
              referer: "https://www.zara.com/pl/",
              "user-agent": "Mozilla/5.0",
              ...(this.options.cookie ? { cookie: this.options.cookie } : {}),
            },
          });
          status = response.status;
          retryAfter = response.headers.get("retry-after");
          body = await response.text();
        }
        log.info(
          {
            store: "zara",
            productId:
              u.searchParams.get("productIds") ?? u.searchParams.get("v1"),
            status,
            latency: Date.now() - start,
          },
          "store request",
        );
        if (status === 403 || status === 429) {
          this.limits++;
          const ra = retryAfter
            ? Number(retryAfter) * 1000 || Date.parse(retryAfter) - Date.now()
            : 0;
          this.blockedUntil =
            Date.now() +
            Math.max(
              ra || 0,
              status === 403
                ? 300000
                : Math.min(3600000, 60000 * 2 ** (this.limits - 1)),
            );
          throw new Error(`Zara HTTP ${status}; requests paused`);
        }
        if (status >= 400) throw new Error(`Zara HTTP ${status}`);
        let parsed;
        if (format === "html") {
          if (!body.includes("window.zara.viewPayload")) {
            this.blockedUntil = Date.now() + 300000;
            throw new Error(
              "Zara returned a challenge page instead of product data",
            );
          }
          parsed = body;
        } else {
          try {
            parsed = JSON.parse(body);
          } catch {
            if (/<html|_sec\/verify|Access Denied/i.test(body))
              this.blockedUntil = Date.now() + 300000;
            throw new Error("Zara returned invalid JSON");
          }
        }
        this.limits = 0;
        this.lastSuccessAt = new Date();
        this.lastError = null;
        this.lastStatus = status;
        return parsed;
      } catch (e) {
        this.lastError = safeError(e);
        this.lastStatus = status;

        log.warn(
          {
            store: "zara",
            productId:
              u.searchParams.get("productIds") ?? u.searchParams.get("v1"),
            status,
            latency: Date.now() - start,
            error: safeError(e),
          },
          "request failed",
        );
        if (
          status === 403 ||
          status === 429 ||
          (status > 0 && status < 500) ||
          attempt === 2
        )
          throw e;
        await new Promise((r) =>
          setTimeout(r, 500 * 2 ** attempt + Math.random() * 250),
        );
      }
    }
  }
  async close() {
    const context = this.context;
    if (context) this.retired.add(context);
    this.context = undefined;
    await context?.browser()?.close();
    await this.dispatcher.close();
  }
}
