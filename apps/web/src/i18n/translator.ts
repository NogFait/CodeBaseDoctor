import { en } from "./messages/en";
import { es, type MessageKey, type Messages } from "./messages/es";

/** Supported UI locales. Default is `es` (see `I18nProvider`). */
export type Locale = "es" | "en";

/** Interpolation params for a message's `{name}` placeholders. */
export type TranslateParams = Record<string, string | number>;

/** The translate function handed out by `useT()` / `createTranslator()`. */
export type TFunction = (key: MessageKey, params?: TranslateParams) => string;

const CATALOGUES: Record<Locale, Messages> = { es, en };

/** True for a value that is one of the supported `Locale`s. */
export function isLocale(value: unknown): value is Locale {
  return value === "es" || value === "en";
}

/** Replace every `{name}` in `template` with `params[name]`. An unmatched
 * placeholder is left as-is (surfaces the mistake instead of hiding it). */
function interpolate(template: string, params?: TranslateParams): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * Build a translator bound to `locale`. Pure and React-free, so pure helpers
 * (`formatProblemMessage`, `confidenceBadgeLabel`) and unit tests can use it
 * without rendering. `I18nProvider` wraps this per active locale.
 *
 * Missing key → returns the key itself (and `console.warn`s in dev) rather
 * than throwing: a missing string should never blank out or crash the UI.
 */
export function createTranslator(locale: Locale): TFunction {
  const catalogue = CATALOGUES[locale];
  return (key, params) => {
    const template = catalogue[key];
    if (template === undefined) {
      if (import.meta.env?.DEV) {
        console.warn(`[i18n] missing message key "${key}" for locale "${locale}"`);
      }
      return key;
    }
    return interpolate(template, params);
  };
}

export type { MessageKey, Messages };
