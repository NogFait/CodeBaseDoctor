import type { MessageKey, TFunction } from "./translator";

/** Backend category id -> message key for its localized display name.
 * Shared by ProgressView (the per-category rows) and ReportView (the cards). */
export const CATEGORY_KEYS: Record<string, MessageKey> = {
  architecture: "category.architecture",
  security: "category.security",
  testing: "category.testing",
  maintainability: "category.maintainability",
  performance: "category.performance",
  documentation: "category.documentation",
};

/** Localize a known id via `table`, falling back to the raw backend value so
 * a row/card never shows a bare message key for something unmapped. */
export function labelFor(t: TFunction, table: Record<string, MessageKey>, value: string): string {
  const key = table[value];
  return key ? t(key) : value;
}
