import type { INestApplication } from "@nestjs/common";

/**
 * Edge HTTP configuration, driven by env so the same build runs behind a
 * reverse proxy in production and bare in local dev.
 *
 * `TRUST_PROXY` is opt-in ON PURPOSE: the actorId (quota + rate-limit key) is
 * derived from `req.ip`, and honoring `X-Forwarded-For` without a real proxy
 * in front would let any client spoof its own identity. Behind a proxy/PaaS
 * (where every request otherwise appears to come from the proxy's IP, so all
 * users would share ONE quota bucket) set it to the hop count (`1`), or to an
 * Express keyword/subnet (`loopback`, `10.0.0.0/8`).
 */
export function resolveTrustProxy(env: NodeJS.ProcessEnv = process.env): boolean | number | string {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw) return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

/** `CORS_ORIGINS` — comma-separated allowlist. Empty = CORS disabled. */
export function resolveCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function configureHttp(app: INestApplication, env: NodeJS.ProcessEnv = process.env): void {
  const trustProxy = resolveTrustProxy(env);
  if (trustProxy !== false) {
    // The Nest HTTP adapter wraps Express; `trust proxy` is an Express app setting.
    app.getHttpAdapter().getInstance().set("trust proxy", trustProxy);
  }

  const origins = resolveCorsOrigins(env);
  if (origins.length > 0) {
    // Retry-After must be exposed or the browser hides it from the SPA on 429s.
    app.enableCors({ origin: origins, exposedHeaders: ["Retry-After"] });
  }
}
