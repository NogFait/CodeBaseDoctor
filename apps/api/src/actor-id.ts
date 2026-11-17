import { createHash } from "node:crypto";

/**
 * Design decision #7 (see design "Architecture Decisions" table): anonymous
 * actor identity, no auth in scope. `actorId = sha256(clientIp +
 * dailyServerSalt)`. The salt rotates daily so a raw IP is never persisted
 * or compared directly ("Rotating salt keeps it non-PII" — design's own
 * words), which is what makes this non-reversible without the server
 * secret, unlike a plain hashed IP.
 *
 * `dailyServerSalt = sha256(serverSecret + current UTC date "YYYY-MM-DD")`,
 * recomputed on every call rather than cached/generated-once-and-stored:
 * stateless, so it survives a restart and works correctly across multiple
 * API replicas without any shared store or coordination — the simplest
 * defensible MVP approach per the task brief.
 */

const DEV_FALLBACK_SALT_SECRET = "cbd-dev-only-INSECURE-salt-do-not-use-outside-local-dev";

/** UTC date as YYYY-MM-DD — the salt's rotation boundary. */
function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Pure — same (secret, UTC day) always yields the same salt. */
export function computeDailyServerSalt(secret: string, date: Date): string {
  return createHash("sha256").update(`${secret}|${utcDateString(date)}`).digest("hex");
}

/** Pure — same (clientIp, secret, UTC day) always yields the same actorId. */
export function computeActorId(clientIp: string, secret: string, date: Date): string {
  const salt = computeDailyServerSalt(secret, date);
  return createHash("sha256").update(`${clientIp}${salt}`).digest("hex");
}

/**
 * Resolves the server secret from `ACTOR_SALT_SECRET`. Unset is a real
 * misconfiguration (every anonymous actor in every environment sharing this
 * fallback would collapse into the same daily salt, i.e. quota buckets by
 * IP alone with no per-deployment secret) — but it does NOT fail loud,
 * because quota enforcement should keep degrading gracefully rather than
 * crash the API process over a missing env var in an MVP. Instead it warns
 * loudly (twice: what's missing, and what to do) and falls back to a fixed,
 * obviously-dev-only literal — never a secret that could pass for a real
 * production value.
 */
export function resolveActorSaltSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.ACTOR_SALT_SECRET;
  if (secret) return secret;

  // In production a well-known salt makes every actorId computable by anyone
  // who knows a client IP — fail fast at boot, like the LLM judge selection.
  if (env.NODE_ENV === "production") {
    throw new Error(
      "[cbd-api] Refusing to start: ACTOR_SALT_SECRET is not set. Generate one " +
        "(e.g. `openssl rand -hex 32`) and set it in the production environment.",
    );
  }

  // eslint-disable-next-line no-console
  console.warn(
    "[cbd-api] ACTOR_SALT_SECRET is not set. Falling back to a well-known, " +
      "insecure dev-only salt — actorId-based quota isolation is NOT safe " +
      "across deployments while this fallback is in use.",
  );
  // eslint-disable-next-line no-console
  console.warn("[cbd-api] Set ACTOR_SALT_SECRET in any non-local environment.");
  return DEV_FALLBACK_SALT_SECRET;
}

/** Convenience wrapper: today's actorId for a client IP, reading the real env/clock. */
export function actorIdForRequest(clientIp: string, env: NodeJS.ProcessEnv = process.env): string {
  return computeActorId(clientIp, resolveActorSaltSecret(env), new Date());
}
