import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readdir, statfs, realpath, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Discovery, Hardware, Settings } from './types.js';

const run = promisify(execFile);
const GIB = 1024 ** 3;

/** nvidia-smi reports MiB, not bytes. Invalid/incomplete rows are rejected. */
export function parseNvidiaCsv(text: string): Hardware['gpu'] {
  return text.trim().split(/\r?\n/).flatMap((line) => {
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 4) return [];
    const [name, total, free, driver] = parts;
    const vramMB = Number(total), freeMB = Number(free);
    if (!name || !driver || !Number.isFinite(vramMB) || !Number.isFinite(freeMB) || vramMB <= 0 || freeMB < 0 || freeMB > vramMB) return [];
    return [{ name, vramMB, freeMB, driver }];
  });
}

export async function detectHardware(root: string): Promise<Hardware> {
  const result: Hardware = { platform: `${process.platform} ${os.release()} ${process.arch}`, ramGB: os.totalmem() / GIB, freeDiskGB: 0, gpu: [], cuda: '', warnings: [] };
  try { const disk = await statfs(root); result.freeDiskGB = Number(disk.bavail) * Number(disk.bsize) / GIB; }
  catch { result.warnings.push('No se pudo medir el espacio libre del directorio portátil.'); }
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.free,driver_version', '--format=csv,noheader,nounits'], { timeout: 8000, windowsHide: true, maxBuffer: 128 * 1024 });
    result.gpu = parseNvidiaCsv(stdout);
    try {
      const summary = await run('nvidia-smi', [], { timeout: 8000, windowsHide: true, maxBuffer: 128 * 1024 });
      const match = summary.stdout.match(/CUDA Version:\s*([\d.]+)/);
      if (match) result.cuda = `${match[1]} (máximo del controlador; no confirma el runtime PyTorch)`;
    } catch { /* GPU memory and driver query remains useful. */ }
  } catch { result.warnings.push('NVIDIA no detectada por nvidia-smi. Instala un controlador NVIDIA compatible o comprueba el acceso a la GPU.'); }
  if (result.gpu.length === 0 && !result.warnings.some((w) => w.includes('NVIDIA'))) result.warnings.push('nvidia-smi no devolvió una GPU NVIDIA compatible.');
  if (result.gpu.length > 0) result.warnings.push('La compatibilidad CUDA efectiva se comprueba con el PyTorch de ComfyUI; la detección del controlador no valida la inferencia.');
  if (result.ramGB < 32) result.warnings.push('Menos de 32 GB de RAM: H3 puede necesitar más memoria del sistema y offloading; no se garantiza que quepa en VRAM.');
  if (process.platform !== 'win32') result.warnings.push('Esta máquina no ejecuta Windows 11. El lanzamiento del paquete Windows y la inferencia CUDA no están verificados aquí.');
  return result;
}

async function isFile(file: string): Promise<boolean> { try { return (await stat(file)).isFile(); } catch { return false; } }
async function isDirectory(file: string): Promise<boolean> { try { return (await stat(file)).isDirectory(); } catch { return false; } }

export async function executableWorks(executable: string, args = ['-version']): Promise<boolean> {
  try { await run(executable, args, { timeout: 8000, windowsHide: true, maxBuffer: 256 * 1024 }); return true; } catch { return false; }
}

/** Only familiar locations and explicitly selected paths. Never enumerate volumes. */
export function commonComfyPaths(root: string, home = os.homedir()): string[] {
  return [...new Set([
    path.join(root, 'comfyui', 'ComfyUI'), path.join(root, 'comfyui'),
    path.join(root, 'data', 'comfyui', 'ComfyUI'),
    path.join(root, 'ComfyUI'), path.join(root, 'ComfyUI_windows_portable', 'ComfyUI'),
    path.join(home, 'ComfyUI'), path.join(home, 'ComfyUI_windows_portable', 'ComfyUI'),
    path.join(home, 'Downloads', 'ComfyUI_windows_portable', 'ComfyUI'),
    path.join(home, 'Desktop', 'ComfyUI_windows_portable', 'ComfyUI'),
    ...(process.platform === 'win32' ? ['C:\\ComfyUI', 'C:\\ComfyUI_windows_portable\\ComfyUI'] : []),
  ])];
}

const MODEL_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf']);

/** Bounded metadata discovery. Presence is explicitly NOT architecture/hash verification. */
export async function discover(settings: Settings, root: string): Promise<Discovery> {
  const comfyPaths: string[] = [];
  const candidates = [...new Set([settings.comfyPath, ...commonComfyPaths(root)].filter(Boolean))];
  for (const candidate of candidates) {
    if (await isFile(path.join(candidate, 'main.py')) && await isDirectory(path.join(candidate, 'comfy'))) {
      const resolved = await realpath(candidate);
      if (!comfyPaths.includes(resolved)) comfyPaths.push(resolved);
    }
  }
  const roots = [...new Set([path.join(root, 'models'), path.join(root, 'data', 'models'), ...comfyPaths.map((p) => path.join(p, 'models')), ...settings.modelPaths])];
  const models: Discovery['models'] = [];
  const seen = new Set<string>();
  const limit = 5000;
  async function walk(directory: string, modelRoot: string, depth: number): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (models.length >= limit) return;
      const file = path.join(directory, entry.name);
      // Symlinks are deliberately excluded: no escape into an unrelated disk/tree.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && depth < 3 && !entry.name.startsWith('.')) await walk(file, modelRoot, depth + 1);
      else if (entry.isFile() && MODEL_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        try {
          const resolved = await realpath(file);
          if (seen.has(resolved)) continue;
          const info = await stat(file);
          if (info.size <= 0) continue;
          seen.add(resolved);
          const relative = path.relative(modelRoot, file).split(path.sep);
          models.push({ path: resolved, name: entry.name, size: info.size, category: relative.length > 1 ? relative[0] : 'unknown', verified: false });
        } catch { /* A disappeared file is not a usable model. */ }
      }
    }
  }
  for (const modelRoot of roots) await walk(modelRoot, modelRoot, 0);
  const ffmpeg = await executableWorks(settings.ffmpegPath || 'ffmpeg');
  return { comfyPaths, models, ffmpeg };
}
