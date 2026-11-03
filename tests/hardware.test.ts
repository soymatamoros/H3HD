import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseNvidiaCsv, commonComfyPaths, discover, detectHardware } from '../core/hardware.js';
import type { Settings } from '../core/types.js';

test('NVIDIA CSV parses MiB and ignores invalid/non-GPU rows', () => {
  assert.deepEqual(parseNvidiaCsv('NVIDIA GeForce RTX 4090, 24564, 20480, 572.83\r\ninvalid\nGPU, N/A, 30, 1\nGPU, 10, 20, 1'), [{ name: 'NVIDIA GeForce RTX 4090', vramMB: 24564, freeMB: 20480, driver: '572.83' }]);
});

test('common detection targets exact known locations, not volume traversal', () => {
  const paths = commonComfyPaths('/portable', '/someone');
  assert(paths.includes(path.join('/portable', 'data', 'comfyui', 'ComfyUI')));
  assert(paths.includes(path.join('/someone', 'Downloads', 'ComfyUI_windows_portable', 'ComfyUI')));
  assert(!paths.includes('/'));
});

test('discovery finds selected ComfyUI and weights without claiming integrity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-discovery-'));
  try {
    const comfy = path.join(root, 'selected', 'ComfyUI');
    await mkdir(path.join(comfy, 'comfy'), { recursive: true });
    await mkdir(path.join(comfy, 'models', 'checkpoints'), { recursive: true });
    await writeFile(path.join(comfy, 'main.py'), '# fixture');
    await writeFile(path.join(comfy, 'models', 'checkpoints', 'weights.safetensors'), 'NOT A REAL MODEL');
    await writeFile(path.join(comfy, 'models', 'checkpoints', 'empty.safetensors'), '');
    const settings: Settings = { comfyUrl: 'http://127.0.0.1:8188', comfyPath: comfy, pythonPath: '', modelPaths: [], ffmpegPath: 'missing-ffmpeg-test', ffprobePath: '', language: 'es' };
    const result = await discover(settings, root);
    assert(result.comfyPaths.includes(comfy));
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].verified, false);
    assert.equal(result.models[0].category, 'checkpoints');
    assert.equal(result.ffmpeg, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('hardware snapshot measures current machine without claiming Windows/GPU validation', async () => {
  const result = await detectHardware(os.tmpdir());
  assert(result.ramGB > 0);
  assert(result.freeDiskGB >= 0);
  assert(result.platform.includes(process.platform));
  if (process.platform !== 'win32') assert(result.warnings.some((w) => w.includes('Windows 11')));
});
