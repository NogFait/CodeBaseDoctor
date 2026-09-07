import { useContext } from "react";
import { I18nContext, type I18nContextValue } from "./I18nProvider";
import type { Locale, TFunction } from "./translator";

function useI18nContext(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useT/useLocale must be used within an <I18nProvider>");
  }
  return ctx;
}

/**
 * `t(key, params?)` bound to the active locale. `{name}` placeholders in the
 * message are filled from `params` (e.g. `t("quota.remaining", { n: 4 })`).
 */
export function useT(): TFunction {
  return useI18nContext().t;
}

/** `{ locale, setLocale }` for the language switcher. */
export function useLocale(): { locale: Locale; setLocale: (locale: Locale) => void } {
  const { locale, setLocale } = useI18nContext();
  return { locale, setLocale };
}
