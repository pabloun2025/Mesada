// Imprime a PDF los HTML de docs/manual/ con el Chromium de Playwright.
// Uso: cd e2e && node media/pdf.mjs [manual-padres guia-rapida]
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from './lib.mjs';

const names = process.argv.slice(2).length ? process.argv.slice(2) : ['manual-padres', 'guia-rapida'];
const browser = await chromium.launch({ args: ['--no-sandbox'] });
for (const n of names) {
  const page = await browser.newPage();
  await page.goto('file://' + path.join(ROOT, `docs/manual/${n}.html`), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const manual = n === 'manual-padres';
  await page.pdf({
    path: path.join(ROOT, `docs/manual/${n}.pdf`), format: 'A4', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: manual,
    headerTemplate: '<span></span>',
    footerTemplate: '<div style="width:100%;font:9px sans-serif;color:#3b4b70;text-align:center;padding-top:6px">DiploP · Manual para padres · página <span class="pageNumber"></span> de <span class="totalPages"></span></div>',
  });
  console.log('PDF', n);
}
await browser.close();
