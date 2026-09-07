import { useState } from "react";
import { UrlEntryForm } from "./features/url-entry/UrlEntryForm";
import { ProgressView } from "./features/progress/ProgressView";
import { ReportView } from "./features/report/ReportView";
import { viewFromStatusResponse, viewFromSubmitResponse, type View } from "./app-view";

export function App() {
  const [view, setView] = useState<View>({ kind: "entry" });

  const quotaRemaining =
    view.kind === "progress" || view.kind === "report" ? view.quotaRemaining : undefined;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
        <header className="mb-8 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">CodeBase Doctor</h1>
          {typeof quotaRemaining === "number" && (
            <p className="text-sm font-medium text-slate-500">{quotaRemaining} analyses left today</p>
          )}
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
