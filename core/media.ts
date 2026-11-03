import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ExportOptions } from './types.js';

export interface MediaStream {
  index: number; codec_type: string; codec_name?: string; width?: number; height?: number;
  sample_rate?: string; channels?: number; avg_frame_rate?: string; r_frame_rate?: string;
  start_time?: string; duration?: string; pix_fmt?: string;
}
export interface MediaProbe {
  streams: MediaStream[]; format: Record<string, unknown>; duration: number;
  video?: MediaStream; audio?: MediaStream;
  sync?: { startOffsetSeconds: number; durationDifferenceSeconds: number | null; assessment: string };
}

async function localFile(file: string): Promise<string> {
  if (typeof file !== 'string' || file.includes('\0')) throw new Error('Ruta de archivo inválida.');
  const absolute = resolve(file);
  if (!(await stat(absolute)).isFile()) throw new Error('El medio no es un archivo local.');
  return absolute;
}

/** Fixed subprocess invocation: never evaluates shell text or renderer arguments. */
async function run(command: string, args: string[], timeoutMs = 30_000,
  onData?: (data: Buffer) => void): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false, timedOut = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else resolvePromise({ stdout, stderr });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', error => finish(new Error(`No se pudo ejecutar ${command}: ${error.message}`)));
    child.stdout.on('data', (data: Buffer) => {
      if (onData) { try { onData(data); } catch (error) { child.kill(); finish(error as Error); } }
      else { stdout += data.toString(); if (stdout.length > 8_000_000) { child.kill(); finish(new Error('Respuesta de medios demasiado grande.')); } }
    });
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-32_000); });
    child.on('close', code => finish(code === 0 ? undefined : new Error(timedOut
      ? 'El procesamiento excedió el tiempo permitido.'
      : `FFmpeg/FFprobe terminó con código ${code}: ${stderr.trim() || 'Sin detalles.'}`)));
  });
}

function finite(value: unknown, fallback = 0): number { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function frameRate(stream: MediaStream): number {
  const [n, d] = (stream.avg_frame_rate || stream.r_frame_rate || '0/1').split('/').map(Number);
  return d > 0 ? n / d : 0;
}

export async function probeMedia(file: string, ffprobe = 'ffprobe'): Promise<MediaProbe> {
  const input = await localFile(file);
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input]);
  const parsed = JSON.parse(stdout) as { streams?: MediaStream[]; format?: Record<string, unknown> };
  const streams = parsed.streams || [];
  if (!streams.some(s => s.codec_type === 'audio' || s.codec_type === 'video')) throw new Error('No se detectaron pistas de audio o video válidas.');
  const video = streams.find(s => s.codec_type === 'video'), audio = streams.find(s => s.codec_type === 'audio');
  // FFprobe can infer a PNG/video codec from an extension even when its payload is garbage.
  // A stream declaration alone is not evidence of decodable media.
  if (video && (!Number.isInteger(video.width) || !Number.isInteger(video.height) || video.width! <= 0 || video.height! <= 0)) {
    throw new Error('El archivo declara video sin dimensiones válidas; puede estar corrupto o incompleto.');
  }
  if (audio && (!(finite(audio.sample_rate) > 0) || !Number.isInteger(audio.channels) || audio.channels! <= 0)) {
    throw new Error('El archivo declara audio sin frecuencia de muestreo o canales válidos.');
  }
  const duration = finite(parsed.format?.duration, Math.max(0, ...streams.map(s => finite(s.duration))));
  let sync: MediaProbe['sync'];
  if (video && audio) {
    const offset = finite(audio.start_time) - finite(video.start_time);
    const difference = video.duration && audio.duration ? finite(audio.duration) - finite(video.duration) : null;
    sync = { startOffsetSeconds: offset, durationDifferenceSeconds: difference,
      assessment: Math.abs(offset) > 0.1 || (difference !== null && Math.abs(difference) > 0.15)
        ? 'Revisar desfase o diferencia de duración de pistas; no mide sincronía labial.'
        : 'Marcas temporales compatibles; la sincronía perceptual requiere revisión.' };
  }
  return { streams, format: parsed.format || {}, duration, video, audio, sync };
}

/** Fully decode the selected audiovisual streams before accepting a generated output.
 * Metadata checks are insufficient for truncated containers. The bounded process timeout
 * limits work; exceeding it rejects verification rather than declaring success.
 */
export async function validatePlayableMedia(file: string, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe'): Promise<MediaProbe> {
  const input = await localFile(file), probe = await probeMedia(input,ffprobe);
  await run(ffmpeg,['-nostdin','-hide_banner','-v','error','-xerror','-threads','2','-filter_threads','2','-i',input,
    '-map','0:v:0?','-map','0:a:0?','-f','null','-'],180_000);
  return probe;
}

/** Analysis is bounded and reports its sampling window; no inference quality is fabricated. */
export async function analyzeMedia(file: string, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe'): Promise<Record<string, unknown>> {
  const input = await localFile(file), probe = await probeMedia(input, ffprobe);
  const result: Record<string, unknown> = { durationSeconds: probe.duration, streams: probe.streams, sync: probe.sync || null,
    notice: 'Las métricas son estimaciones. Una toma estática puede contener fotogramas iguales y un corte puede producir un cambio brusco. No detectan por sí solas ghosting o deformaciones.' };
  if (probe.audio) {
    const rate = finite(probe.audio.sample_rate, 32_000), channels = finite(probe.audio.channels, 1);
    const seconds = Math.min(120, probe.duration || 120), waveform = new Array<number>(128).fill(0);
    const binSamples = Math.max(1, Math.ceil(seconds * rate * channels / waveform.length));
    let count = 0, clipped = 0, peak = 0, sumSquares = 0, rest = Buffer.alloc(0);
    await run(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-threads', '2', '-filter_threads', '2', '-i', input, '-map', '0:a:0', '-t', String(seconds),
      '-vn', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], 180_000, chunk => {
      const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      let i = 0;
      for (; i + 4 <= data.length; i += 4) {
        const sample = data.readFloatLE(i); if (!Number.isFinite(sample)) continue;
        const abs = Math.abs(sample); peak = Math.max(peak, abs); sumSquares += sample * sample;
        if (abs >= 1 - 1 / 32768) clipped++;
        waveform[Math.min(127, Math.floor(count / binSamples))] = Math.max(waveform[Math.min(127, Math.floor(count / binSamples))], abs);
        count++;
      }
      rest = Buffer.from(data.subarray(i));
    });
    result.audio = { sampleRate: rate, channels, analyzedSeconds: count / (rate * channels),
      peakDBFS: peak ? 20 * Math.log10(peak) : null,
      rmsDBFS: sumSquares && count ? 10 * Math.log10(sumSquares / count) : null,
      samplesAtFullScale: clipped, clippingCandidate: clipped > 0, samples: count, waveform,
      note: 'Muestras a escala completa son candidatas a recorte, no prueba concluyente. Se conserva la frecuencia de muestreo nativa al analizar.' };
  }
  if (probe.video && frameRate(probe.video) > 0 && probe.duration > 0) {
    const width = 160, height = Math.max(2, Math.round((probe.video.height || 90) * width / (probe.video.width || 160) / 2) * 2);
    if (height > 2048) throw new Error('Proporción de video fuera del rango de análisis.');
    const frameBytes = width * height;
    let rest = Buffer.alloc(0), previous: Buffer | undefined, frames = 0, duplicates = 0, discontinuities = 0;
    const differences: number[] = [], means: number[] = [], laplacianVariance: number[] = [];
    await run(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-threads', '2', '-filter_threads', '2', '-i', input, '-map', '0:v:0', '-an', '-t', '30',
      '-frames:v', '900', '-vf', `scale=${width}:${height}:flags=area,format=gray`, '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'], 180_000, chunk => {
      const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      let offset = 0;
      for (; offset + frameBytes <= data.length; offset += frameBytes) {
        const frame = data.subarray(offset, offset + frameBytes);
        let sum = 0, difference = 0, lapSum = 0, lapSumSq = 0;
        for (let p = 0; p < frameBytes; p++) { sum += frame[p]; if (previous) difference += Math.abs(frame[p] - previous[p]); }
        for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
          const p = y * width + x, lap = 4 * frame[p] - frame[p-1] - frame[p+1] - frame[p-width] - frame[p+width];
          lapSum += lap; lapSumSq += lap * lap;
        }
        const pixels = (width - 2) * (height - 2);
        laplacianVariance.push(lapSumSq / pixels - (lapSum / pixels) ** 2); means.push(sum / frameBytes);
        if (previous) { const d = difference / frameBytes; differences.push(d); if (d < 0.5) duplicates++; if (d > 30) discontinuities++; }
        previous = Buffer.from(frame); frames++;
      }
      rest = Buffer.from(data.subarray(offset));
    });
    const deltas = means.slice(1).map((m, i) => m - means[i]), average = (a: number[]) => a.length ? a.reduce((s,v) => s+v,0) / a.length : 0;
    const deltaMean = average(deltas);
    result.temporal = { analyzedFrames: frames, maximumSeconds: 30, maximumFrames: 900, analysisSize: `${width}×${height}`,
      nearDuplicateTransitions: duplicates, abruptChangeCandidates: discontinuities, meanAbsoluteLumaDifference: average(differences),
      lumaDeltaStandardDeviation: Math.sqrt(average(deltas.map(d => (d - deltaMean) ** 2))),
      meanLaplacianVariance: average(laplacianVariance),
      note: 'Luma normalizada a 0–255; varianza del Laplaciano calculada tras reducir a 160 px de ancho. No usar para comparar nitidez nativa entre resoluciones distintas. Ghosting no evaluado.' };
  }
  return result;
}

function range(value: unknown, low: number, high: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) throw new Error(`${name} fuera de rango (${low}–${high}).`);
  return value;
}

export async function exportMedia(inputFile: string, outputFile: string, options: ExportOptions,
  ffmpeg = 'ffmpeg', ffprobe = 'ffprobe'): Promise<string> {
  const input = await localFile(inputFile), output = resolve(outputFile);
  if (input === output || output.includes('\0')) throw new Error('El archivo original debe conservarse. Elige un destino distinto.');
  try { await stat(output); throw new Error('El destino ya existe; elige otro nombre para conservarlo.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(dirname(output), { recursive: true });
  const formats = ['original','mp4-h264','mp4-h265','png','jpeg','webp','wav','aac','flac'];
  if (!formats.includes(options.format)) throw new Error('Formato de exportación no admitido.');
  if (options.format === 'original') {
    if (options.targetHeight || options.fps || options.sharpen || options.normalize || options.denoise || (options.volume !== undefined && options.volume !== 1)) {
      throw new Error('La copia original no admite procesamiento.');
    }
    await copyFile(input, output, constants.COPYFILE_EXCL); return output;
  }
  const probe = await probeMedia(input, ffprobe), image = ['png','jpeg','webp'].includes(options.format);
  const audioOnly = ['wav','aac','flac'].includes(options.format);
  if (audioOnly && !probe.audio) throw new Error('El archivo no contiene audio para exportar.');
  if (!audioOnly && !probe.video) throw new Error('El archivo no contiene imagen o video para exportar.');
  if (options.fps !== undefined) {
    range(options.fps, 1, 120, 'FPS');
    if (!probe.video || Math.abs(frameRate(probe.video) - options.fps) > 0.01) throw new Error('La interpolación no está validada. Conserva los FPS nativos.');
  }
  if (audioOnly && (options.targetHeight || options.sharpen)) throw new Error('Las opciones de imagen no se aplican a una exportación de audio.');
  if ((image || !probe.audio) && (options.normalize || options.denoise || (options.volume !== undefined && options.volume !== 1))) throw new Error('Estas opciones requieren una pista de audio en la salida.');
  const videoFilters: string[] = [], audioFilters: string[] = [];
  if (!audioOnly && options.targetHeight !== undefined) {
    const h = range(options.targetHeight, 32, 4320, 'Altura');
    if (h % 2 !== 0 || !Number.isInteger(h)) throw new Error('La altura debe ser un entero par.');
    videoFilters.push(`scale=-2:${h}:flags=lanczos`);
  }
  if (!image && !audioOnly && options.targetHeight === undefined) videoFilters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  if (options.sharpen) videoFilters.push('unsharp=5:5:0.25:5:5:0');
  if (options.denoise) audioFilters.push('afftdn=nf=-25');
  if (options.normalize) audioFilters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  if (options.volume !== undefined) audioFilters.push(`volume=${range(options.volume, 0, 4, 'Volumen')}`);
  const args = ['-nostdin','-hide_banner','-v','error','-n','-threads','2','-filter_threads','2','-i',input];
  if (audioOnly) args.push('-vn','-map','0:a:0');
  else { args.push('-map','0:v:0'); if (!image) args.push('-map','0:a:0?'); }
  if (videoFilters.length) args.push('-vf',videoFilters.join(','));
  if (audioFilters.length) args.push('-af',audioFilters.join(','));
  switch (options.format) {
    case 'mp4-h264': case 'mp4-h265': {
      const crf = range(options.crf ?? 16, 0, 51, 'CRF'), codec = options.format === 'mp4-h264' ? 'libx264' : 'libx265';
      const { stdout } = await run(ffmpeg, ['-hide_banner','-encoders']);
      if (!new RegExp(`\\b${codec}\\b`).test(stdout)) throw new Error(`Este FFmpeg no incluye el codificador ${codec}.`);
      args.push('-c:v',codec,'-preset','slow','-crf',String(crf),'-pix_fmt','yuv420p');
      if (codec === 'libx265') args.push('-tag:v','hvc1');
      if (probe.audio) args.push('-c:a','aac','-b:a','320k');
      args.push('-movflags','+faststart','-f','mp4'); break;
    }
    case 'png': args.push('-frames:v','1','-c:v','png','-compression_level','9','-f','image2'); break;
    case 'jpeg': args.push('-frames:v','1','-c:v','mjpeg','-q:v','2','-f','image2'); break;
    case 'webp': args.push('-frames:v','1','-c:v','libwebp','-lossless','1','-f','image2'); break;
    case 'wav': args.push('-c:a','pcm_s24le','-f','wav'); break;
    case 'aac': args.push('-c:a','aac','-b:a','320k','-f','adts'); break;
    case 'flac': args.push('-c:a','flac','-compression_level','8','-f','flac'); break;
  }
  // Do not let loudnorm's internal oversampling silently change the exported native rate.
  if (probe.audio && !image) args.push('-ar',String(range(Number(probe.audio.sample_rate),8000,384000,'Frecuencia de muestreo')));
  const temporary = `${output}.${randomUUID()}.partial`;
  args.push('-threads','2',temporary);
  try {
    await run(ffmpeg,args,15*60_000);
    const exported = await probeMedia(temporary,ffprobe);
    if ((audioOnly && !exported.audio) || (!audioOnly && !exported.video)) throw new Error('La salida no contiene las pistas esperadas.');
    // COPYFILE_EXCL also protects against a destination created after the initial existence check.
    await copyFile(temporary,output,constants.COPYFILE_EXCL);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return output;
}
