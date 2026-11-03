/** Exercises real main/preload/renderer IPC in an isolated copy; no ComfyUI/GPU is mocked. */
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repo = process.cwd();
const fixture = await mkdtemp(path.join(os.tmpdir(), 'h3-electron-smoke-'));
const artifacts = path.join(repo, 'test-results/electron');
let app, checks = 0;
const check = (condition, message) => { assert(condition, message); checks++; };
const args = process.platform === 'linux' ? ['--ozone-platform=x11', '--disable-gpu'] : [];
if (process.env.STUDIO_CI_NO_SANDBOX === '1') args.push('--no-sandbox');
const launch = async () => {
  const instance = await electron.launch({ args: [fixture, ...args], timeout: 20000 });
  const page = await instance.firstWindow({ timeout: 20000 });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.studio?.snapshot === 'function');
  return { instance, page };
};
try {
  await mkdir(artifacts, { recursive: true });
  for (const name of ['dist-electron', 'dist', 'manifests', 'workflows']) await cp(path.join(repo, name), path.join(fixture, name), { recursive: true });
  await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'h3-electron-smoke', version: '0.0.0', type: 'module', main: 'dist-electron/desktop/main.js' }));
  await symlink(path.join(repo, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  let run = await launch(); app = run.instance;
  check(await run.page.title() === 'MiniMax H3 Studio', 'Real Electron window has the application title.');
  check(await run.page.evaluate(() => typeof window.studio.generate === 'function' && typeof window.studio.settings === 'function'), 'Sandboxed preload exposes the fixed API.');
  const security = await app.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
  });
  check(security.sandbox === true, 'Renderer sandbox flag remains enabled.');
  check(security.contextIsolation === true, 'Context isolation remains enabled.');
  check(security.nodeIntegration === false, 'Node is unavailable to the renderer.');
  check(await run.page.evaluate(() => typeof window.require === 'undefined'), 'Renderer cannot access require.');
  const snapshot = await run.page.evaluate(() => window.studio.snapshot());
  check(typeof snapshot.hardware.platform === 'string' && snapshot.hardware.ramGB > 0, 'Real hardware diagnostics are returned through IPC.');
  check(snapshot.models.length > 0, 'Real application model catalog is loaded.');
  check(snapshot.connected === false, 'Isolated fixture correctly reports no ComfyUI connection.');
  check(snapshot.projects.length === 0 && snapshot.jobs.length === 0, 'No generated results are fabricated.');
  const updated = { ...snapshot.settings, comfyUrl: 'http://127.0.0.1:8189' };
  await run.page.evaluate(settings => window.studio.settings(settings), updated);
  check((await run.page.evaluate(() => window.studio.snapshot())).settings.comfyUrl === updated.comfyUrl, 'Settings IPC updates persistent state.');
  const blocked = await run.page.evaluate(async settings => {
    try { await window.studio.settings({ ...settings, pythonPath: '/tmp/unselected-python' }); return false; } catch (e) { return String(e).includes('selector nativo'); }
  }, updated);
  check(blocked, 'Executable path changes cannot bypass the native selector.');
  await run.page.screenshot({ path: path.join(artifacts, 'electron-desktop.png'), fullPage: true });
  await app.close(); app = undefined;
  run = await launch(); app = run.instance;
  const restored = await run.page.evaluate(() => window.studio.snapshot());
  check(restored.settings.comfyUrl === updated.comfyUrl, 'Settings survive a full Electron restart.');
  check(restored.connected === false && restored.jobs.length === 0, 'Restart does not create simulated inference.');
  console.log(JSON.stringify({ passed: checks, platform: process.platform, security, inferenceExecuted: false, hardware: snapshot.hardware.platform, modelCount: snapshot.models.length, screenshot: path.join(artifacts, 'electron-desktop.png') }));
} finally {
  await app?.close();
  await rm(fixture, { recursive: true, force: true });
}
