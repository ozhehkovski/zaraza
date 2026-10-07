import { it, expect, vi, beforeEach } from "vitest";
const mock = vi.hoisted(() => ({ active: 0, peak: 0, pages: 0, launches: 0 }));
vi.mock("playwright", () => ({
  chromium: {
    launch: async () => {
      mock.launches++;
      const browser = {
        on: vi.fn(),
        close: vi.fn(),
        newContext: async () => context,
      };
      const context = {
        addCookies: vi.fn(),
        browser: () => browser,
        newPage: async () => {
          mock.pages++;
          return {
            isClosed: () => false,
            goto: async () => {
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
        },
      };
      return browser;
    },
  },
}));
import { ZaraTransport } from "../src/providers/zara/transport.js";
beforeEach(() =>
  Object.assign(mock, { active: 0, peak: 0, pages: 0, launches: 0 }),
);
it("reuses two browser pages for ten concurrent jobs without starting extra browsers", async () => {
  const t = new ZaraTransport({
    mode: "browser",
    cookie: "",
    proxy: "",
    headless: true,
    executable: "",
    timeout: 1000,
    rps: 10000,
    browserPages: 2,
  });
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      t.html(`https://www.zara.com/pl/pl/test-p123.html?v1=${i}`),
    ),
  );
  expect(mock.launches).toBe(1);
  expect(mock.pages).toBe(2);
  expect(mock.peak).toBe(2);
  expect(mock.active).toBe(0);
  expect(t.health.status).toBe("ok");
  await t.close();
});
