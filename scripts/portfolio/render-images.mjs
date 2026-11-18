// Renderiza las plantillas HTML de scripts/portfolio/ a PNG (portada, social preview, arquitectura).
//
//   node scripts/portfolio/render-images.mjs            # todas
//   node scripts/portfolio/render-images.mjs cover      # solo una
//
// Las plantillas cargan Poppins de Google Fonts, así que hace falta red. La portada usa
// docs/img/portfolio/report-es.png: generala antes con capture-screenshots.mjs.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHROME_PATH =
  process.env.CHROME_PATH ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`;
const OUT_DIR = fileURLToPath(new URL("../../docs/img/portfolio/", import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

// scale 2 = retina; GitHub limita el social preview a 1 MB, por eso ese va a 1x.
const IMAGES = {
  cover: { html: "cover.html", out: "cover.png", width: 1600, height: 900, scale: 2 },
  social: { html: "social.html", out: "social-preview.png", width: 1280, height: 640, scale: 1 },
  architecture: { html: "architecture.html", out: "architecture.png", width: 1600, height: 900, scale: 2 },
};

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(IMAGES);

const browser = await chromium.launch({ executablePath: CHROME_PATH });
for (const name of names) {
  const spec = IMAGES[name];
  if (!spec) throw new Error(`Imagen desconocida: ${name} (opciones: ${Object.keys(IMAGES).join(", ")})`);
  const context = await browser.newContext({
    viewport: { width: spec.width, height: spec.height },
    deviceScaleFactor: spec.scale,
  });
  const page = await context.newPage();
  await page.goto(pathToFileURL(fileURLToPath(new URL(spec.html, import.meta.url))).href, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT_DIR}${spec.out}`, clip: { x: 0, y: 0, width: spec.width, height: spec.height } });
  await context.close();
  console.log(`ok: ${spec.out} (${spec.width * spec.scale}x${spec.height * spec.scale})`);
}
await browser.close();
