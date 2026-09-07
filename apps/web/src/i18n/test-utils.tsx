import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "./I18nProvider";
import type { Locale } from "./translator";

export interface RenderWithI18nOptions extends Omit<RenderOptions, "wrapper"> {
  /** Locale to force on the provider. Defaults to `"en"` so the suite of
   * pre-i18n English-asserting tests keeps passing with only a wrapper
   * added. New Spanish-path tests pass `{ locale: "es" }` explicitly. */
  locale?: Locale;
}

/**
 * `render` from `@testing-library/react` with `ui` wrapped in an
 * `<I18nProvider>` pinned to `opts.locale ?? "en"`. Uses the `wrapper`
 * option so `rerender` keeps the provider.
 */
export function renderWithI18n(ui: ReactElement, opts: RenderWithI18nOptions = {}): RenderResult {
  const { locale = "en", ...rest } = opts;
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <I18nProvider initialLocale={locale}>{children}</I18nProvider>
    ),
    ...rest,
  });
}
