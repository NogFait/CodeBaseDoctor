import type { CategoryScore } from "../../api/types";

/**
 * Pure badge-label mapper. Deliberately dispatches on `weightCap`, not
 * category name — Performance is the only category with a reduced
 * `weightCap` (0.5, see `libs/analysis/src/domain/types.ts`), so this stays
 * correct even if a future category picks up a reduced weight without this
 * file knowing its id.
 */
export function confidenceBadgeLabel(category: Pick<CategoryScore, "confidence" | "weightCap">): string {
  if (category.weightCap < 1) {
    return "Low confidence — static estimate";
  }
  return category.confidence.charAt(0).toUpperCase() + category.confidence.slice(1);
}
