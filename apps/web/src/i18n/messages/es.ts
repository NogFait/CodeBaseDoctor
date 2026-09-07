/**
 * Spanish message catalogue — the source of truth for the key set. `en.ts`
 * is typed as `Messages` (derived from this object's keys) so a missing or
 * misspelled English key is a compile error.
 *
 * Flat dot-namespaced keys. `{name}` placeholders are filled by
 * `createTranslator`'s interpolation (see `../translator.ts`).
 *
 * Scope note: only UI chrome lives here. Analyzer/LLM rationale text and
 * numeric scores are rendered verbatim as the backend produced them and are
 * deliberately NOT translated.
 */
export const es = {
  // Language switcher (App.tsx header) — its own aria-label is localized.
  "switcher.label": "Idioma",

  // Daily free-tier quota indicator (App.tsx header).
  "quota.remaining": "{n} análisis restantes hoy",

  // features/url-entry/UrlEntryForm.tsx
  "urlEntry.label": "URL del repo de GitHub",
  "urlEntry.submit": "Analizar repo",
  "urlEntry.submitting": "Analizando…",

  // features/progress/ProgressView.tsx
  "progress.ariaLabel": "Progreso del análisis",
  "progress.heading": "Analizando el repositorio…",
  "progress.starting": "Iniciando el análisis…",
  "progress.status.pending": "pendiente",
  "progress.status.running": "en curso",
  "progress.status.scored": "evaluado",
  "progress.status.failed": "fallido",
  "progress.status.skipped": "omitido",

  // features/report/ReportView.tsx
  "report.ariaLabelReport": "Informe del análisis",
  "report.ariaLabelFailed": "El análisis falló",
  "report.heading": "Informe",
  "report.headingPartial": "Informe parcial",
  "report.compositeScore": "Puntuación compuesta",
  "report.partialNotice": "Algunas categorías no pudieron evaluarse.",
  "report.categoryUnscored": "No pudo evaluarse",
  "report.failedHeading": "El análisis falló",
  "report.failedBody":
    "No pudimos completar este análisis. Tu cuota fue reembolsada — no cuenta contra tu límite diario.",
  "report.rescan": "Volver a analizar",
  "report.rescanning": "Analizando de nuevo…",
  "report.tryAgain": "Reintentar",
  "report.retry": "Reintentar",
  "report.analyzeAnother": "Analizar otro repo",

  // features/report/confidence-badge.ts
  "confidence.lowStatic": "Confianza baja — estimación estática",
  "confidence.measured": "Medido",
  "confidence.estimated": "Estimado",
  "confidence.judged": "Evaluado",

  // Category display names (used by ProgressView rows).
  "category.architecture": "Arquitectura",
  "category.security": "Seguridad",
  "category.testing": "Testing",
  "category.maintainability": "Mantenibilidad",
  "category.performance": "Rendimiento",
  "category.documentation": "Documentación",

  // api/problem-details.ts — the 6 RFC 9457 problem types + unknown fallback.
  "problem.invalidRepoUrl": "Eso no parece una URL válida de repo de GitHub.",
  "problem.invalidRepoUrlNamed": 'Eso no parece una URL válida de repo de GitHub: "{repoUrl}".',
  "problem.repoNotAccessiblePrivate": "Este repo es privado o no tenemos acceso.",
  "problem.repoNotAccessibleNotFound": "No pudimos encontrar ese repo.",
  "problem.repoTooLarge": "Este repo es demasiado grande para analizar en este momento.",
  "problem.quotaExceeded": "Cuota diaria de análisis superada ({remaining} restantes). Probá más tarde.",
  "problem.scanTimeout": "El análisis expiró. Probá de nuevo.",
  "problem.rateLimited": "Demasiados intentos muy rápido. Esperá un momento y probá de nuevo.",
  "problem.unknown": "Algo salió mal. Probá de nuevo.",

  // Shared generic fallback (features/submit-analysis/use-submit-analysis.ts).
  "error.generic": "Algo salió mal. Probá de nuevo.",
} as const;

/** Every message key, each mapped to `string` — `en.ts` is checked against
 * this so it must define exactly the same key set. */
export type Messages = Record<keyof typeof es, string>;

/** A message key. */
export type MessageKey = keyof typeof es;
