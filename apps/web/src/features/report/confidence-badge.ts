import type { TFunction, MessageKey } from "../../i18n";
import type { CategoryScore, Confidence } from "../../api/types";

const CONFIDENCE_KEY: Record<Confidence, MessageKey> = {
  measured: "confidence.measured",
  estimated: "confidence.estimated",
  judged: "confidence.judged",
};

/**
 * Pure badge-label mapper, now localized via an injected translator.
 * Deliberately dispatches on `weightCap`, not category name — Performance is
 * the only category with a reduced `weightCap` (0.5, see
 * `libs/analysis/src/domain/types.ts`), so this stays correct even if a
 * future category picks up a reduced weight without this file knowing its
 * id.
 *
 * Takes `t` as an argument (not a hook) so it stays a pure function; its
 * only caller (`ReportView`) already holds a `useT()` `t`.
 */
export function confidenceBadgeLabel(
  category: Pick<CategoryScore, "confidence" | "weightCap">,
  t: TFunction,
): string {
  if (category.weightCap < 1) {
    return t("confidence.lowStatic");
  }
  return t(CONFIDENCE_KEY[category.confidence]);
}
