// Captura las pantallas reales de la SPA para el portafolio (Playwright + Chromium).
//
//   WEB_URL=http://localhost:5175 node scripts/portfolio/capture-screenshots.mjs
//
// Requiere la api y la web levantadas. El reporte sale del cache de scans: por defecto usa
// lukeed/clsx, que ya está analizado con un juez LLM real (si ese repo no está cacheado, el
// análisis corre de verdad y consume cuota). No necesita API key mientras el scan esté cacheado.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WEB_URL = process.env.WEB_URL;
if (!WEB_URL) {
  console.error("Falta WEB_URL (ej. http://localhost:5175)");
  process.exit(1);
}
const REPO_URL = process.env.REPO_URL ?? "https://github.com/lukeed/clsx";
const CHROME_PATH =
  process.env.CHROME_PATH ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`;
const OUT_DIR = fileURLToPath(new URL("../../docs/img/portfolio/", import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

// 820px de ancho: la SPA es una columna de ~736px, así llena el cuadro sin bandas vacías.
const VIEWPORT = { width: 820, height: 900 };

const browser = await chromium.launch({ executablePath: CHROME_PATH });

async function newPage(locale) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: "light" });
  const page = await context.newPage();
  // La SPA lee el idioma de localStorage["cbd.locale"] (ver apps/web/src/i18n/I18nProvider.tsx).
  await page.addInitScript((value) => localStorage.setItem("cbd.locale", value), locale);
  await page.goto(WEB_URL, { waitUntil: "networkidle" });
  return { page, context };
}

async function shoot(locale) {
  const { page, context } = await newPage(locale);

  // 1) pantalla de ingreso, con la URL ya escrita
  await page.locator("input").first().fill(REPO_URL);
  await page.screenshot({ path: `${OUT_DIR}entry-${locale}.png`, clip: { x: 0, y: 0, width: VIEWPORT.width, height: 330 } });

  // 2) reporte completo
  await page.locator("form button, button[type=submit]").first().click();
  await page.waitForFunction(() => /\d{2}\.\d{2}/.test(document.body.innerText), null, { timeout: 120_000 });
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${OUT_DIR}report-${locale}.png`, fullPage: true });

  await context.close();
  console.log(`ok: ${locale}`);
}

for (const locale of ["es", "en"]) await shoot(locale);
await browser.close();
