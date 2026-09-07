import type { MessageKey } from "./messages/es";
import type { TFunction, TranslateParams } from "./translator";
import type { CategoryScore } from "../api/types";

/**
 * 2-form plural helper (`one` for exactly 1, `other` for everything else) —
 * sufficient for both `es` and `en`. Picks `${key}.one` / `${key}.other`,
 * then runs it through `t()`. Plural selection is a presentation concern, so
 * it lives here rather than in the analyzers (which only emit a stable key +
 * raw params).
 */
export function tCount(t: TFunction, key: string, count: number, params: TranslateParams): string {
  const form = count === 1 ? "one" : "other";
  return t(`${key}.${form}` as MessageKey, params);
}

type StructuredRationale = Pick<CategoryScore, "rationale" | "rationaleKey" | "rationaleParams">;

/**
 * Renders a category's rationale in the active locale when the analyzer
 * supplied a structured `rationaleKey` (+ `rationaleParams`) — the 4
 * deterministic analyzers (security, testing, maintainability, performance).
 * Otherwise returns the raw `rationale` string verbatim: LLM categories
 * (architecture, documentation) whose rationale is the model's own verdict,
 * and any consumer/key without a matching catalog entry.
 */
export function rationaleText(t: TFunction, cs: StructuredRationale): string {
  const { rationaleKey, rationaleParams } = cs;
  if (!rationaleKey) return cs.rationale;

  const p = rationaleParams ?? {};
  const num = (v: unknown): number => Number(v ?? 0);

  switch (rationaleKey) {
    case "rationale.security":
      return tCount(t, "rationale.security", num(p.n), { n: num(p.n) });

    case "rationale.testing": {
      // Compose: pluralized count clause + "; " + the ci/noCi clause + ".".
      const count = tCount(t, "rationale.testing.count", num(p.n), { n: num(p.n) });
      const ci = t(p.ci ? "rationale.testing.ci" : "rationale.testing.noCi");
      return `${count}; ${ci}.`;
    }

    case "rationale.maintainability":
      // Only `oversized` drives .one/.other. The recognized-language-files
      // noun is ALWAYS rendered plural: a repo with exactly 1 recognized
      // file is degenerate, so a dedicated singular form isn't worth
      // carrying (explicit design call).
      return tCount(t, "rationale.maintainability", num(p.oversized), {
        oversized: num(p.oversized),
        loc: num(p.loc),
        recognized: num(p.recognized),
      });

    case "rationale.performance": {
      // Compose: pluralized files clause + "; " + pluralized matches clause
      // + ". " + the weak-signal suffix. EN renders proper singular/plural
      // here (the analyzer's canonical string still uses lazy "file(s)").
      const files = tCount(t, "rationale.performance.files", num(p.files), { files: num(p.files) });
      const matches = tCount(t, "rationale.performance.matches", num(p.matches), {
        matches: num(p.matches),
      });
      return `${files}; ${matches}. ${t("rationale.performance.suffix")}`;
    }

    default:
      return cs.rationale;
  }
}
