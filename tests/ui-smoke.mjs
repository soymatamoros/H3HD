/** Real Chromium rendering/navigation checks. No inference API is mocked or invoked. */
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.STUDIO_UI_URL || 'http://127.0.0.1:5174';
const artifacts = path.resolve('test-results/ui');
await mkdir(artifacts, { recursive: true });
let server, browser, checks = 0;
const check = (value, message) => { assert(value, message); checks++; };
try {
  if (!process.env.STUDIO_UI_URL) server = spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5174', '--strictPort'], { stdio: 'pipe' });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const response = await fetch(base); if (response.ok) { ready = true; break; } } catch { /* Wait for Vite only. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(ready, 'Vite did not become ready within 12 seconds.');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'networkidle' });
  check(await page.getByRole('heading', { name: 'Texto a video', exact: true }).isVisible(), 'Initial text-video workspace renders.');
  check(await page.getByText('Estás viendo la interfaz en un navegador.', { exact: false }).isVisible(), 'Browser-only status is explicit.');
  check(await page.getByRole('button', { name: 'Generar video', exact: false }).isDisabled(), 'No inference can run without the desktop API.');
  const prompt = 'Una escena submarina con luz suave.';
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill(prompt);
  await page.getByRole('button', { name: 'Parámetros avanzados', exact: true }).click();
  check(await page.getByText('res_multistep / simple').isVisible(), 'Verified H3 sampler is shown.');
  await page.screenshot({ path: path.join(artifacts, 'studio-desktop.png'), fullPage: true });
  for (const mode of ['Imagen a video', 'Referencias a video', 'Extender video', 'Generar imagen']) {
    await page.getByRole('navigation', { name: 'Modos de creación' }).getByRole('button', { name: mode, exact: true }).click();
    check(await page.getByRole('heading', { name: mode, exact: true }).isVisible(), `${mode} navigation renders.`);
  }
  await page.getByRole('button', { name: 'Imagen a imagen', exact: true }).click();
  check(await page.getByRole('button', { name: 'Elegir imagen', exact: true }).isDisabled(), 'Browser cannot access the native file picker.');
  for (const name of ['Biblioteca', 'Modelos', 'Ajustes']) {
    await page.getByRole('navigation', { name: 'Gestión' }).getByRole('button', { name, exact: true }).click();
    check(await page.getByRole('heading', { name, exact: true }).isVisible(), `${name} navigation renders.`);
  }
  check(await page.getByLabel('Carpeta ComfyUI', { exact: true }).evaluate(el => el.readOnly), 'Executable paths require native selection.');
  await page.screenshot({ path: path.join(artifacts, 'settings-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 760, height: 900 });
  await page.getByRole('navigation', { name: 'Modos de creación' }).getByRole('button', { name: 'Referencias a video', exact: true }).click();
  check(await page.getByRole('heading', { name: 'Referencias a video', exact: true }).isVisible(), 'Compact icon navigation remains accessible.');
  check(await page.locator('body').evaluate(el => el.scrollWidth <= window.innerWidth), 'Compact layout has no horizontal overflow.');
  await page.screenshot({ path: path.join(artifacts, 'studio-760.png'), fullPage: true });
  await page.waitForTimeout(450); // The documented autosave debounce is 350 ms.
  await page.reload({ waitUntil: 'networkidle' });
  check(await page.getByText('Borrador recuperado:', { exact: false }).isVisible(), 'Autosave recovery is disclosed.');
  check(await page.getByRole('textbox', { name: 'Prompt', exact: true }).inputValue() === prompt, 'Prompt survives a page restart.');
  check(errors.length === 0, `No uncaught renderer errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ passed: checks, pageErrors: errors, inferenceExecuted: false, screenshots: artifacts }));
} finally {
  await browser?.close();
  server?.kill();
}
