import { createContext, useCallback, useMemo, useState, type ReactNode } from "react";
import { createTranslator, isLocale, type Locale, type TFunction } from "./translator";

/** `localStorage` key holding the user's chosen locale. */
export const LOCALE_STORAGE_KEY = "cbd.locale";

/** Default locale when nothing valid is stored. */
export const DEFAULT_LOCALE: Locale = "es";

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TFunction;
}

export const I18nContext = createContext<I18nContextValue | undefined>(undefined);

/**
 * Read the persisted locale. `localStorage` can throw (private mode /
 * disabled storage / SSR-ish environments) — any failure falls back to the
 * default without crashing.
 *
 * TODO: before defaulting, honour `navigator.language` (`es*` → `es`, else
 * `en`) for a first-time visitor with no stored preference — an easy add.
 */
export function readStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) {
      return stored;
    }
  } catch {
    // Storage unavailable — fall through to the default.
  }
  return DEFAULT_LOCALE;
}

/** Persist the locale, swallowing any `localStorage` failure. */
function writeStoredLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage unavailable — the in-memory locale still updates.
  }
}

export interface I18nProviderProps {
  children: ReactNode;
  /** Force the initial locale, bypassing the stored value. Used by the test
   * helper (`renderWithI18n`) and available for stories/embeds. */
  initialLocale?: Locale;
}

export function I18nProvider({ children, initialLocale }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? readStoredLocale());

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    writeStoredLocale(next);
  }, []);

  const t = useMemo<TFunction>(() => createTranslator(locale), [locale]);

  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
