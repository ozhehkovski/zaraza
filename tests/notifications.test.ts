import { expect, it, vi } from "vitest";
import { GrammyError } from "grammy";
import { NotificationService } from "../src/notifications/service.js";
it("pauses all notification delivery during Telegram Retry-After", async () => {
  vi.useFakeTimers();
  try {
    const payload = {
      types: ["RESTOCK"],
      telegramId: 1,
      watchId: 1,
      name: "test",
      url: "https://www.zara.com/pl/",
      size: "M",
      currency: "PLN",
      previous: { price: 100, available: false },
      current: { price: 100, available: true },
    };
    const repo = {
      pending: vi.fn(async () => [
        { entry: { id: 1, attempts: 0, payload }, enabled: true },
        { entry: { id: 2, attempts: 0, payload }, enabled: true },
      ]),
      retry: vi.fn(),
      delivered: vi.fn(),
    };
    const api = {
      sendMessage: vi
        .fn()
        .mockRejectedValue(
          new GrammyError(
            "rate limited",
            {
              ok: false,
              error_code: 429,
              description: "Too Many Requests",
              parameters: { retry_after: 30 },
            },
            "sendMessage",
            {},
          ),
        ),
    };
    const service = new NotificationService(repo as any, api as any);
    await service.tick();
    expect(repo.retry).toHaveBeenCalledWith(1, 0, 30000);
    await vi.advanceTimersByTimeAsync(2000);
    await service.tick();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(repo.pending).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(28001);
    await service.tick();
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
