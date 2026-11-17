import { describe, expect, it, vi } from "vitest";
import { computeActorId, computeDailyServerSalt, resolveActorSaltSecret } from "./actor-id";

describe("computeDailyServerSalt", () => {
  it("is the same for the same secret and the same UTC day", () => {
    const day = new Date("2026-08-14T23:59:59Z");
    const a = computeDailyServerSalt("secret-a", day);
    const b = computeDailyServerSalt("secret-a", day);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the UTC day changes (rotation)", () => {
    const day1 = computeDailyServerSalt("secret-a", new Date("2026-08-14T12:00:00Z"));
    const day2 = computeDailyServerSalt("secret-a", new Date("2026-08-15T12:00:00Z"));
    expect(day1).not.toBe(day2);
  });
});

describe("computeActorId", () => {
  const day = new Date("2026-08-14T10:00:00Z");

  it("is the same for the same IP + secret + day", () => {
    const first = computeActorId("203.0.113.5", "s3cr3t", day);
    const second = computeActorId("203.0.113.5", "s3cr3t", day);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when the day changes (same IP, same secret)", () => {
    const today = computeActorId("203.0.113.5", "s3cr3t", new Date("2026-08-14T10:00:00Z"));
    const tomorrow = computeActorId("203.0.113.5", "s3cr3t", new Date("2026-08-15T10:00:00Z"));
    expect(today).not.toBe(tomorrow);
  });

  it("differs for a different client IP (same secret, same day)", () => {
    const a = computeActorId("203.0.113.5", "s3cr3t", day);
    const b = computeActorId("198.51.100.9", "s3cr3t", day);
    expect(a).not.toBe(b);
  });
});

describe("resolveActorSaltSecret", () => {
  it("returns ACTOR_SALT_SECRET when set, without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secret = resolveActorSaltSecret({ ACTOR_SALT_SECRET: "prod-secret-value" } as NodeJS.ProcessEnv);
    expect(secret).toBe("prod-secret-value");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back to a fixed dev-only literal and warns loudly when unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = resolveActorSaltSecret({} as NodeJS.ProcessEnv);
    warn.mockClear();
    const second = resolveActorSaltSecret({} as NodeJS.ProcessEnv);
    expect(first).toBe(second); // stable literal, not randomly generated per call
    expect(first.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toMatch(/ACTOR_SALT_SECRET/);
    warn.mockRestore();
  });

  it("THROWS in production when unset — a well-known salt would make actorIds guessable", () => {
    expect(() => resolveActorSaltSecret({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/ACTOR_SALT_SECRET/);
  });

  it("still returns the real secret in production when it is set", () => {
    expect(
      resolveActorSaltSecret({ NODE_ENV: "production", ACTOR_SALT_SECRET: "prod-secret-value" } as NodeJS.ProcessEnv),
    ).toBe("prod-secret-value");
  });
});
