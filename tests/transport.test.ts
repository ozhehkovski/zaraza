import { it, expect, vi, afterEach } from "vitest";
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("undici", () => ({
  Agent: class {
    close = vi.fn();
  },
  ProxyAgent: class {
    close = vi.fn();
  },
  fetch: fetchMock,
}));
import { ZaraTransport } from "../src/providers/zara/transport.js";
const url =
  "https://www.zara.com/pl/pl/products-details?productIds=123&ajax=true";
const make = () =>
  new ZaraTransport({
    mode: "http",
    cookie: "",
    proxy: "",
    headless: true,
    executable: "",
    timeout: 1000,
    rps: 10,
  });
const response = (
  status: number,
  body = "{}",
  retryAfter: string | null = null,
) => ({ status, headers: { get: () => retryAfter }, text: async () => body });
afterEach(() => {
  fetchMock.mockReset();
  vi.useRealTimers();
});
it.each([403, 429])("pauses all requests after %s", async (status) => {
  fetchMock.mockResolvedValue(
    response(status, "", status === 429 ? "600" : null),
  );
  const t = make();
  await expect(t.json(url)).rejects.toThrow(String(status));
  await expect(t.json(url)).rejects.toThrow("paused");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(t.cooldownUntil - Date.now()).toBeGreaterThan(
    status === 429 ? 590000 : 290000,
  );
  await t.close();
});
it("retries 5xx with backoff then succeeds", async () => {
  vi.useFakeTimers();
  fetchMock
    .mockResolvedValueOnce(response(503))
    .mockResolvedValueOnce(response(502))
    .mockResolvedValueOnce(response(200, '{"ok":true}'));
  const task = make().json(url);
  await vi.runAllTimersAsync();
  await expect(task).resolves.toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
it("rejects invalid JSON without changing stock", async () => {
  fetchMock.mockResolvedValue(response(200, "<html>changed</html>"));
  await expect(make().json(url)).rejects.toThrow("invalid JSON");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("does not request arbitrary origins", async () => {
  await expect(make().json("https://evil.test/")).rejects.toThrow("origin");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("does not retry permanent 404", async () => {
  fetchMock.mockResolvedValue(response(404));
  await expect(make().json(url)).rejects.toThrow("404");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("marks an HTTP 200 challenge as blocked and does not issue another request", async () => {
  fetchMock.mockResolvedValue(
    response(200, "<html>_sec/verify challenge</html>"),
  );
  const t = make();
  expect(t.health.status).toBe("unchecked");
  await expect(t.html(url)).rejects.toThrow("challenge");
  expect(t.health.status).toBe("blocked");
  await expect(t.html(url)).rejects.toThrow("paused");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
