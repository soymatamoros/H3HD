import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { mkdir, stat, copyFile, unlink } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Download, ModelEntry } from './types.js';
import { fileName } from './security.js';

export async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function resolveModel(entry: ModelEntry): Promise<ModelEntry> {
  const u = new URL(entry.url);
  if (u.origin !== 'https://huggingface.co') throw new Error('Origen de modelos no autorizado.');
  const [owner,repo,resolve,revision,...filename] = u.pathname.slice(1).split('/');
  if (resolve !== 'resolve' || !owner || !repo || !filename.length) throw new Error('URL de modelo inválida.');
  const r = await fetch(`https://huggingface.co/api/models/${owner}/${repo}/revision/${encodeURIComponent(revision)}?blobs=true`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Hugging Face no permite consultar el manifiesto (${r.status}). Revisa la red o la licencia del repositorio; no se descargó nada.`);
  const data = await r.json();
  const item = data.siblings?.find((s: any) => s.rfilename === filename.map(decodeURIComponent).join('/'));
  if (!/^[a-f0-9]{40}$/.test(data.sha) || !/^[a-f0-9]{64}$/.test(item?.lfs?.sha256) || !(item?.lfs?.size > 0)) throw new Error('La fuente no publica SHA-256/tamaño verificables para este archivo. Descarga bloqueada.');
  return { ...entry, url: `https://huggingface.co/${owner}/${repo}/resolve/${data.sha}/${filename.join('/')}`, sha256: item.lfs.sha256, bytes: item.lfs.size };
}
export class DownloadManager extends EventEmitter {
  downloads: Download[] = [];
  private active = new Map<string,AbortController>();
  private preparing = new Set<string>();
  constructor(readonly root: string) { super(); }
  cancel(id: string) { this.active.get(id)?.abort(); }
  async install(entry: ModelEntry) {
    if(this.active.has(entry.id)||this.preparing.has(entry.id))throw new Error('Esta descarga ya está activa.');
    this.preparing.add(entry.id);
    try { await this.performInstall(entry); } finally { this.preparing.delete(entry.id); }
  }
  private async performInstall(entry:ModelEntry) {
    if (this.active.has(entry.id)) throw new Error('Esta descarga ya está activa.');
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || entry.bytes <= 0) throw new Error('Primero verifica los metadatos del modelo.');
    const url = new URL(entry.url);
    if (url.protocol !== 'https:' || url.hostname !== 'huggingface.co') throw new Error('Fuente no autorizada.');
    const dir = path.join(this.root, fileName(entry.category)); await mkdir(dir, { recursive: true });
    const destination = path.join(dir, fileName(entry.filename));
    try {
      await stat(destination);
      if (await sha256(destination) === entry.sha256) return;
      throw new Error('Ya existe un archivo diferente con este nombre. No se sobrescribirá; revisa el modelo manualmente.');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const partial = destination + '.' + entry.sha256.slice(0,12) + '.partial';
    const control = new AbortController(); this.active.set(entry.id, control);
    const progress: Download = { id: entry.id, received: 0, total: entry.bytes, status: 'downloading' };
    this.downloads = this.downloads.filter(x => x.id !== entry.id).concat(progress);
    const update = () => this.emit('update'); update();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        let offset = await stat(partial).then(s => s.size).catch(() => 0);
        if (offset > entry.bytes) { await unlink(partial); offset = 0; }
        progress.received = offset;
        if (offset === entry.bytes) break;
        try {
          const r = await fetch(entry.url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: AbortSignal.any([control.signal, AbortSignal.timeout(3600000)]) });
          const host = new URL(r.url).hostname;
          if (!['huggingface.co','cdn-lfs.huggingface.co','cdn-lfs-us-1.hf.co','cas-bridge.xethub.hf.co'].includes(host) && !host.endsWith('.hf.co')) throw new Error('Redirección de descarga no autorizada.');
          if (!r.ok || !r.body) throw new Error(`Descarga HTTP ${r.status}.`);
          if (offset && r.status === 206 && !r.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) throw new Error('Rango de reanudación incorrecto.');
          if (offset && r.status !== 206) { offset = 0; progress.received = 0; }
          let notified = 0;
          const meter = new Transform({ transform(chunk, _encoding, done) {
            progress.received += chunk.length;
            if (progress.received > entry.bytes) { done(new Error('El archivo supera el tamaño publicado.')); return; }
            if (Date.now() - notified > 250) { notified = Date.now(); update(); }
            done(null,chunk);
          } });
          await pipeline(Readable.fromWeb(r.body as any), meter, createWriteStream(partial, { flags: offset ? 'a' : 'w' }), { signal: control.signal });
          if (progress.received !== entry.bytes) throw new Error('Descarga incompleta.');
          break;
        } catch (e) {
          if (control.signal.aborted || attempt === 2) throw e;
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
      progress.status = 'verifying'; update();
      if (await sha256(partial) !== entry.sha256) { await unlink(partial); throw new Error('SHA-256 incorrecto. El archivo corrupto se eliminó; no se instaló.'); }
      if (control.signal.aborted) throw new Error('Descarga cancelada.');
      // Exclusive destination creation: never replace a file created while downloading.
      const { link } = await import('node:fs/promises');
      try { await link(partial,destination); }
      catch(e) {
        if(!['EXDEV','EPERM','ENOTSUP','EOPNOTSUPP'].includes((e as NodeJS.ErrnoException).code??''))throw e;
        await copyFile(partial,destination,constants.COPYFILE_EXCL);
      }
      await unlink(partial);
      progress.status = 'completed';
    } catch (e) { progress.status = control.signal.aborted ? 'cancelled' : 'failed'; progress.error = e instanceof Error ? e.message : String(e); }
    finally { this.active.delete(entry.id); update(); }
  }
}
