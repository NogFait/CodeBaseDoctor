import { describe, expect, it, vi } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { configureHttp, resolveCorsOrigins, resolveTrustProxy } from "./http-config";

const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

describe("resolveTrustProxy", () => {
  it("is false when TRUST_PROXY is unset or blank (X-Forwarded-For is NOT honored by default)", () => {
    expect(resolveTrustProxy(env({}))).toBe(false);
    expect(resolveTrustProxy(env({ TRUST_PROXY: "  " }))).toBe(false);
  });

  it("parses booleans", () => {
    expect(resolveTrustProxy(env({ TRUST_PROXY: "true" }))).toBe(true);
    expect(resolveTrustProxy(env({ TRUST_PROXY: "false" }))).toBe(false);
  });

  it("parses a hop count as a number", () => {
    expect(resolveTrustProxy(env({ TRUST_PROXY: "1" }))).toBe(1);
    expect(resolveTrustProxy(env({ TRUST_PROXY: "2" }))).toBe(2);
  });

  it("passes any other value through as an Express subnet/keyword string", () => {
    expect(resolveTrustProxy(env({ TRUST_PROXY: "loopback" }))).toBe("loopback");
    expect(resolveTrustProxy(env({ TRUST_PROXY: "10.0.0.0/8" }))).toBe("10.0.0.0/8");
  });
});

describe("resolveCorsOrigins", () => {
  it("is an empty list (CORS disabled) when CORS_ORIGINS is unset", () => {
    expect(resolveCorsOrigins(env({}))).toEqual([]);
  });

  it("splits a comma-separated list, trimming and dropping empties", () => {
    expect(resolveCorsOrigins(env({ CORS_ORIGINS: " https://a.dev , https://b.dev ,," }))).toEqual([
      "https://a.dev",
      "https://b.dev",
    ]);
  });
});

function fakeApp() {
  const set = vi.fn();
  const enableCors = vi.fn();
  const app = {
    enableCors,
    getHttpAdapter: () => ({ getInstance: () => ({ set }) }),
  } as unknown as INestApplication;
  return { app, set, enableCors };
}

describe("configureHttp", () => {
  it("sets Express 'trust proxy' only when TRUST_PROXY is configured", () => {
    const { app, set } = fakeApp();
    configureHttp(app, env({ TRUST_PROXY: "1" }));
    expect(set).toHaveBeenCalledWith("trust proxy", 1);
  });

  it("does not touch 'trust proxy' when TRUST_PROXY is unset", () => {
    const { app, set } = fakeApp();
    configureHttp(app, env({}));
    expect(set).not.toHaveBeenCalled();
  });

  it("enables CORS for the configured origins, including Retry-After exposure", () => {
    const { app, enableCors } = fakeApp();
    configureHttp(app, env({ CORS_ORIGINS: "https://demo.dev" }));
    expect(enableCors).toHaveBeenCalledWith({
      origin: ["https://demo.dev"],
      exposedHeaders: ["Retry-After"],
    });
  });

  it("does not enable CORS when CORS_ORIGINS is unset (same-origin / dev proxy only)", () => {
    const { app, enableCors } = fakeApp();
    configureHttp(app, env({}));
    expect(enableCors).not.toHaveBeenCalled();
  });
});
