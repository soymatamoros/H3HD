import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeMedia, exportMedia, probeMedia, validatePlayableMedia } from '../core/media.js';
import type { ExportOptions } from '../core/types.js';

const execute = promisify(execFile);
let directory: string, source: string, silent: string;
const options = (format: ExportOptions['format'], extras: Partial<ExportOptions> = {}): ExportOptions => ({
  asset: { filename: 'fixture.mp4', subfolder: '', type: 'output' }, format, ...extras
});

before(async () => {
  directory = await mkdtemp(join(tmpdir(),'studio media '));
  // Literal shell metacharacters in a filename must remain ordinary data.
  source = join(directory,'fixture $(unexecuted) video.mp4');
  silent = join(directory,'silent.mkv');
  await execute('ffmpeg',['-nostdin','-v','error','-filter_threads','1','-f','lavfi','-i','testsrc2=size=96x64:rate=24',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=32000','-t','1','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac',source]);
  await execute('ffmpeg',['-nostdin','-v','error','-i',source,'-an','-c:v','copy',silent]);
});
after(async () => { await rm(directory,{recursive:true,force:true}); });

test('FFprobe reads actual video/audio timestamps and native sample rate',async () => {
  const probe = await probeMedia(source);
  assert.equal(probe.video?.width,96); assert.equal(probe.video?.height,64);
  assert.equal(probe.audio?.sample_rate,'32000');
  assert.ok(probe.duration >= 1); assert.ok(probe.sync);
  assert.ok(Math.abs(probe.sync.startOffsetSeconds) <= 0.1);
});

test('real decoded samples produce waveform, levels and temporal measurements',async () => {
  const analysis = await analyzeMedia(source);
  const audio = analysis.audio as { sampleRate: number; peakDBFS: number; waveform: number[]; clippingCandidate: boolean };
  const temporal = analysis.temporal as { analyzedFrames: number; meanLaplacianVariance: number };
  assert.equal(audio.sampleRate,32000); assert.equal(audio.waveform.length,128);
  assert.ok(audio.peakDBFS < -5 && audio.peakDBFS > -30);
  assert.ok(audio.waveform.some(value => value > 0)); assert.equal(audio.clippingCandidate,false);
  assert.equal(temporal.analyzedFrames,24); assert.ok(temporal.meanLaplacianVariance > 0);
});

test('full-scale actual PCM is flagged as clipping candidate',async () => {
  const clip = join(directory,'full-scale.wav');
  await execute('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','aevalsrc=1:sample_rate=32000:duration=0.1','-c:a','pcm_s16le',clip]);
  const audio = (await analyzeMedia(clip)).audio as { clippingCandidate: boolean; samplesAtFullScale: number };
  assert.equal(audio.clippingCandidate,true); assert.ok(audio.samplesAtFullScale > 0);
});

test('MP4 export preserves aspect ratio/audio rate and yields playable H264',async () => {
  const destination = join(directory,'delivery.mp4');
  await exportMedia(source,destination,options('mp4-h264',{targetHeight:48,sharpen:true,normalize:true,denoise:true,volume:0.9}));
  const probe = await probeMedia(destination);
  assert.equal(probe.video?.width,72); assert.equal(probe.video?.height,48);
  assert.equal(probe.video?.codec_name,'h264'); assert.equal(probe.audio?.sample_rate,'32000');
  assert.ok(Math.abs(probe.sync!.startOffsetSeconds) <= 0.1);
  await execute('ffmpeg',['-nostdin','-v','error','-i',destination,'-f','null','-']);
});

test('still exports create actual PNG, JPEG and lossless WebP images',async () => {
  for (const [format,codec] of [['png','png'],['jpeg','mjpeg'],['webp','webp']] as const) {
    const destination = join(directory,`still.${format}`);
    await exportMedia(source,destination,options(format));
    const probe = await probeMedia(destination);
    assert.equal(probe.video?.codec_name,codec); assert.equal(probe.video?.width,96);
    assert.equal(probe.audio,undefined);
  }
});

test('WAV, AAC and FLAC exports contain actual audio with native rate',async () => {
  for (const [format,codec] of [['wav','pcm_s24le'],['aac','aac'],['flac','flac']] as const) {
    const destination = join(directory,`audio.${format}`);
    await exportMedia(source,destination,options(format));
    const probe = await probeMedia(destination);
    assert.equal(probe.audio?.codec_name,codec); assert.equal(probe.audio?.sample_rate,'32000');
    assert.equal(probe.video,undefined);
  }
});

test('original copy preserves bytes and never overwrites existing files',async () => {
  const destination = join(directory,'master.mp4');
  await exportMedia(source,destination,options('original'));
  assert.deepEqual(await readFile(source),await readFile(destination));
  await assert.rejects(exportMedia(source,source,options('original')),/original/);
  await assert.rejects(exportMedia(source,destination,options('original')),/existe/);
  const unrelated = join(directory,'existing.mp4'); await writeFile(unrelated,'preserve me');
  await assert.rejects(exportMedia(source,unrelated,options('mp4-h264')),/existe/);
  assert.equal(await readFile(unrelated,'utf8'),'preserve me');
});

test('silent video works and audio-only export rejects missing audio',async () => {
  const destination = join(directory,'silent-delivery.mp4');
  await exportMedia(silent,destination,options('mp4-h264'));
  assert.equal((await probeMedia(destination)).audio,undefined);
  await assert.rejects(exportMedia(silent,join(directory,'missing.wav'),options('wav')),/no contiene audio/);
  const analysis = await analyzeMedia(silent); assert.equal(analysis.audio,undefined);
});

test('unsupported FPS conversion and unsafe numeric options fail explicitly',async () => {
  await assert.rejects(exportMedia(source,join(directory,'fps.mp4'),options('mp4-h264',{fps:60})),/interpolación/);
  await assert.rejects(exportMedia(source,join(directory,'nan.mp4'),options('mp4-h264',{targetHeight:NaN})),/rango/);
  await assert.rejects(exportMedia(source,join(directory,'odd.mp4'),options('mp4-h264',{targetHeight:49})),/entero par/);
  await assert.rejects(exportMedia(source,join(directory,'volume.mp4'),options('mp4-h264',{volume:100})),/rango/);
});

test('nonempty corrupt file with a media extension is never accepted as valid video',async()=>{
  const corrupt=join(directory,'corrupt.png');await writeFile(corrupt,'Not an actual PNG');
  await assert.rejects(probeMedia(corrupt),/dimensiones|válid|FFmpeg/);
  await assert.rejects(validatePlayableMedia(corrupt),/dimensiones|válid|FFmpeg/);
});

test('full decode validates playable output and rejects a truncated payload with valid metadata',async()=>{
  const probe=await validatePlayableMedia(source);assert.equal(probe.video?.width,96);
  const full=join(directory,'faststart.mp4');
  await execute('ffmpeg',['-nostdin','-v','error','-i',source,'-c','copy','-movflags','+faststart',full]);
  const bytes=await readFile(full),truncated=join(directory,'truncated.mp4');
  // Keep the front-loaded moov metadata while cutting the latter half of mdat payload.
  await writeFile(truncated,bytes.subarray(0,Math.floor(bytes.length*0.7)));
  assert.equal((await probeMedia(truncated)).video?.width,96);
  await assert.rejects(validatePlayableMedia(truncated),/FFmpeg/);
});
