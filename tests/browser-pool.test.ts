import { it, expect, vi, beforeEach } from "vitest";
const mock = vi.hoisted(() => ({
  active: 0,
  peak: 0,
  pages: 0,
  launches: 0,
  pageCloses: 0,
  browserCloses: 0,
  openBrowsers: 0,
}));
vi.mock("playwright", () => ({
  chromium: {
    launch: async () => {
      mock.launches++;
      mock.openBrowsers++;
      let closed = false;
      const browser = {
        on: vi.fn(),
        close: vi.fn(async () => {
          if (closed) return;
          closed = true;
          mock.browserCloses++;
          mock.openBrowsers--;
        }),
        newContext: async () => context,
      };
      const context = {
        addCookies: vi.fn(),
        browser: () => browser,
        close: vi.fn(),
        newPage: async () => {
          if (closed) throw new Error("browser closed");
          mock.pages++;
          let pageClosed = false;
          const page = {
            context: () => context,
            isClosed: () => pageClosed || closed,
            close: vi.fn(async () => {
              pageClosed = true;
              mock.pageCloses++;
            }),
            goto: async () => {
              if (page.isClosed()) throw new Error("page closed");
              mock.active++;
              mock.peak = Math.max(mock.peak, mock.active);
              await new Promise((r) => setTimeout(r, 5));
              return { status: () => 200 };
            },
            waitForFunction: async () => {
              await new Promise((r) => setTimeout(r, 5));
              mock.active--;
            },
            content: async () =>
              '<script>window.zara.viewPayload = {"product":{}};</script>',
          };
          return page;
        },
      };
      return browser;
    },
  },
}));
import { ZaraTransport } from "../src/providers/zara/transport.js";
beforeEach(() =>
  Object.assign(mock, {
    active: 0,
    peak: 0,
    pages: 0,
    launches: 0,
    pageCloses: 0,
    browserCloses: 0,
    openBrowsers: 0,
  }),
);
const make = (extra: Partial<ConstructorParameters<typeof ZaraTransport>[0]>) =>
  new ZaraTransport({
    mode: "browser",
    cookie: "",
    proxy: "",
    headless: true,
    executable: "",
    timeout: 1000,
    rps: 10000,
    browserPages: 2,
    ...extra,
  });
const run = (t: ZaraTransport, n: number) =>
  Promise.all(
    Array.from({ length: n }, (_, i) =>
      t.html(`https://www.zara.com/pl/pl/test-p123.html?v1=${i}`),
    ),
  );
it("reuses two browser pages for ten concurrent jobs without starting extra browsers", async () => {
  const t = make({});
  await run(t, 10);
  expect(mock.launches).toBe(1);
  expect(mock.pages).toBe(2);
  expect(mock.peak).toBe(2);
  expect(mock.active).toBe(0);
  expect(t.health.status).toBe("ok");
  await t.close();
});
it("closes a tab after pageMaxUses navigations instead of reusing it forever", async () => {
  const t = make({ browserPages: 1, pageMaxUses: 3 });
  for (let i = 0; i < 9; i++)
    await t.html(`https://www.zara.com/pl/pl/test-p123.html?v1=${i}`);
  expect(mock.pages).toBe(3);
  expect(mock.pageCloses).toBe(3);
  expect(mock.launches).toBe(1);
  await t.close();
});
it("restarts Chromium after browserMaxNavigations and closes the old one once idle", async () => {
  const t = make({ browserMaxNavigations: 4 });
  await run(t, 12);
  expect(mock.launches).toBe(3);
  // Every retired browser is closed; only the current one stays open.
  expect(mock.openBrowsers).toBe(0);
  expect(mock.browserCloses).toBe(3);
  expect(mock.peak).toBe(2);
  expect(mock.active).toBe(0);
  await t.close();
  expect(mock.openBrowsers).toBe(0);
});
it("does not close a retired browser while its requests are still running", async () => {
  const t = make({ browserMaxNavigations: 2 });
  const first = run(t, 2);
  await new Promise((r) => setTimeout(r, 1));
  // Browser hit the limit and was retired, but both navigations are in flight.
  expect(mock.browserCloses).toBe(0);
  await first;
  expect(mock.browserCloses).toBe(1);
  await t.close();
});
