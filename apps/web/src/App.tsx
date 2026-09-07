import { useState } from "react";
import { UrlEntryForm } from "./features/url-entry/UrlEntryForm";
import { ProgressView } from "./features/progress/ProgressView";
import { ReportView } from "./features/report/ReportView";
import { viewFromStatusResponse, viewFromSubmitResponse, type View } from "./app-view";
import { useLocale, useT, type Locale } from "./i18n";

const LOCALES: readonly Locale[] = ["es", "en"];

/** Small `ES | EN` control in the header. Its own accessible name is
 * localized (`switcher.label` → "Idioma" / "Language"). */
function LocaleSwitcher() {
  const t = useT();
  const { locale, setLocale } = useLocale();

  return (
    <div
      role="group"
      aria-label={t("switcher.label")}
      className="flex items-center gap-1 text-xs font-medium text-slate-400"
    >
      {LOCALES.map((code, index) => (
        <span key={code} className="flex items-center gap-1">
          {index > 0 && <span aria-hidden="true">|</span>}
          <button
            type="button"
            aria-pressed={locale === code}
            onClick={() => setLocale(code)}
            className={
              locale === code
                ? "font-semibold text-slate-900 underline underline-offset-2"
                : "transition hover:text-slate-700"
            }
          >
            {code.toUpperCase()}
          </button>
        </span>
      ))}
    </div>
  );
}

export function App() {
  const t = useT();
  const [view, setView] = useState<View>({ kind: "entry" });

  const quotaRemaining =
    view.kind === "progress" || view.kind === "report" ? view.quotaRemaining : undefined;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
        <header className="mb-8 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">CodeBase Doctor</h1>
          <div className="flex items-center gap-4">
            {typeof quotaRemaining === "number" && (
              <p className="text-sm font-medium text-slate-500">
                {t("quota.remaining", { n: quotaRemaining })}
              </p>
            )}
            <LocaleSwitcher />
          </div>
        </header>

        {view.kind === "entry" && (
          <UrlEntryForm onSubmitted={(repoUrl, response) => setView(viewFromSubmitResponse(repoUrl, response))} />
        )}
        {view.kind === "progress" && (
          <ProgressView
            jobId={view.jobId}
            pollAfterMs={view.pollAfterMs}
            onTerminal={(response) => setView(viewFromStatusResponse(view.repoUrl, response, view.quotaRemaining))}
          />
        )}
        {view.kind === "report" && (
          <ReportView
            repoUrl={view.repoUrl}
            status={view.status}
            result={view.result}
            problem={view.problem}
            onRescanSubmitted={(repoUrl, response) => setView(viewFromSubmitResponse(repoUrl, response))}
            onStartOver={() => setView({ kind: "entry" })}
          />
        )}
      </main>
    </div>
  );
}
