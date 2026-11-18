// Captura los estados "difíciles" de la SPA: progreso en vivo, reporte parcial y scan fallido.
// Los estados se fuerzan de verdad (nada se falsifica en el DOM), pero necesitan preparar el entorno:
//
//   STATE=partial  Worker corriendo con  LLM_JUDGE=stub STUB_JUDGE_FAIL_CATEGORIES=architecture
//                  -> Architecture falla, las otras 5 puntúan: "reporte parcial". También saca el progreso.
//   STATE=failed   api SIN worker: el job queda en cola y el script lo marca `failed` en Postgres
//                  (docker exec cbd-postgres ...) mientras la SPA hace polling.
//
//   STATE=partial WEB_URL=http://localhost:5173 node scripts/portfolio/capture-states.mjs
//
// REPO_URL tiene que ser un repo que NO esté en el cache (un cache hit devuelve el reporte al
// instante y no hay job que mostrar). Nota: el juez stub marca Documentation como "[stub verdict]";
// por eso estas capturas son de estados de error, no del reporte principal (ese sale de un juez real).
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STATE = process.env.STATE;
const WEB_URL = process.env.WEB_URL;
if (!["partial", "failed"].includes(STATE) || !WEB_URL) {
  console.error("Uso: STATE=partial|failed WEB_URL=http://localhost:5173 node scripts/portfolio/capture-states.mjs");
  process.exit(1);
}
const REPO_URL =
  process.env.REPO_URL ?? (STATE === "partial" ? "https://github.com/lukeed/dequal" : "https://github.com/lukeed/polka");
if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(REPO_URL)) throw new Error(`REPO_URL inválida: ${REPO_URL}`);

const CHROME_PATH =
  process.env.CHROME_PATH ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`;
const OUT_DIR = fileURLToPath(new URL("../../docs/img/portfolio/", import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });
const VIEWPORT = { width: 820, height: 900 };

const browser = await chromium.launch({ executablePath: CHROME_PATH });
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: "light" });
const page = await context.newPage();
await page.addInitScript(() => localStorage.setItem("cbd.locale", "es"));
await page.goto(WEB_URL, { waitUntil: "networkidle" });

await page.locator("input").first().fill(REPO_URL);
await page.locator("form button, button[type=submit]").first().click();

// Vista de progreso (si aparece directamente el reporte, el repo estaba en cache).
await page.waitForFunction(() => /Analizando|Analyzing/i.test(document.body.innerText), null, { timeout: 30_000 }).catch(() => {
  throw new Error(`No apareció la vista de progreso: ¿${REPO_URL} ya estaba en el cache? Probá con otro REPO_URL.`);
});

if (STATE === "partial") {
  // "Analizando…" también es el texto del botón, que aparece al instante: el POST /analyses todavía
  // tarda unos segundos (git ls-remote en un contenedor). La tarjeta de progreso es la que lista las
  // categorías con su estado ("Arquitectura: pendiente"), así que se espera a eso.
  await page.waitForFunction(() => /pendiente|pending/i.test(document.body.innerText), null, { timeout: 60_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT_DIR}progress-es.png`, clip: { x: 0, y: 0, width: VIEWPORT.width, height: 520 } });
  await page
    .waitForFunction(() => /parcial|partial/i.test(document.body.innerText), null, { timeout: 150_000 })
    .catch(async (err) => {
      const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 500));
      throw new Error(`No apareció el reporte parcial. La página mostraba: "${text}"\n${err.message}`);
    });
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${OUT_DIR}report-partial-es.png`, fullPage: true });
  console.log("ok: progress-es.png, report-partial-es.png");
} else {
  // Sin worker, el job queda `queued`: lo pasamos a `failed` como lo haría el watchdog de jobs colgados.
  // La vista de progreso aparece ANTES de que termine el POST /analyses (que primero hace un
  // `git ls-remote` en un contenedor, unos segundos): el job todavía no existe, así que se reintenta
  // hasta marcar uno creado en el último minuto.
  let flipped = 0;
  for (let attempt = 0; attempt < 40 && flipped === 0; attempt++) {
    await page.waitForTimeout(1000);
    const out = execFileSync("docker", [
      "exec", "cbd-postgres", "psql", "-U", "cbd", "-d", "codebase_doctor", "-c",
      `update analysis_job set status = 'failed' where repo_url = '${REPO_URL}' ` +
        `and created_at > now() - interval '1 minute' ` +
        `and status in ('queued','resolving','cloning','analyzing','aggregating')`,
    ], { stdio: "pipe" }).toString();
    flipped = Number(/UPDATE (\d+)/.exec(out)?.[1] ?? 0);
  }
  if (flipped === 0) throw new Error("No apareció ningún job para marcar como fallido.");
  // Títulos reales: es "El análisis falló", en "Scan failed" (apps/web/src/i18n/messages).
  await page.waitForFunction(() => /El análisis falló|Scan failed/i.test(document.body.innerText), null, { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${OUT_DIR}report-failed-es.png`, clip: { x: 0, y: 0, width: VIEWPORT.width, height: 400 } });
  console.log("ok: report-failed-es.png");
}

await browser.close();
