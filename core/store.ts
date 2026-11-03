import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Settings, Project, Job } from './types.js';

export const defaultSettings: Settings = { comfyUrl: 'http://127.0.0.1:8188', comfyPath: '', pythonPath: '', modelPaths: [], ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', language: 'es' };
interface State { version: 1; settings: Settings; projects: Project[]; jobs: Job[]; }
export class Store {
  state: State = { version: 1, settings: { ...defaultSettings }, projects: [], jobs: [] };
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly root: string) {}
  get file() { return path.join(this.root, 'config', 'studio.json'); }
  async open() {
    for (const dir of ['config','projects','outputs','models','logs','runtime','inputs']) await mkdir(path.join(this.root, dir), { recursive: true });
    try { this.state = this.parse(await readFile(this.file, 'utf8')); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        try { this.state = this.parse(await readFile(this.file + '.bak', 'utf8')); await rename(this.file,this.file+'.corrupt-'+Date.now()); }
        catch { throw new Error('No se pudo recuperar la biblioteca. Conserva config/studio.json y su copia .bak antes de reparar.'); }
      }
    }
    const s=this.state.settings;
    for(const key of ['comfyPath','pythonPath','ffmpegPath','ffprobePath'] as const) if(s[key]?.startsWith('./')) s[key]=path.resolve(this.root,s[key]);
    s.modelPaths=s.modelPaths.map(p=>p.startsWith('./')?path.resolve(this.root,p):p);
    // An interrupted submission is never silently resubmitted: it may already exist in ComfyUI.
    for (const job of this.state.jobs) if (['queued','running'].includes(job.status)) { job.status = 'failed'; job.error = 'Sesión interrumpida. Comprueba el historial de ComfyUI antes de regenerar.'; }
    await this.save();
  }
  private parse(raw: string): State {
    const s = JSON.parse(raw);
    if (s.version !== 1 || !s.settings || !['comfyUrl','comfyPath','pythonPath','ffmpegPath','ffprobePath'].every(k=>typeof s.settings[k]==='string') || !Array.isArray(s.settings.modelPaths) || s.settings.modelPaths.some((p:unknown)=>typeof p!=='string') || !Array.isArray(s.projects) || !Array.isArray(s.jobs)
      || s.jobs.some((j: any)=>!j || typeof j.id!=='string' || typeof j.status!=='string' || !Array.isArray(j.outputs))
      || s.projects.some((p: any)=>!p || typeof p.id!=='string' || !p.request || !Array.isArray(p.outputs))) throw new Error('Biblioteca inválida.');
    return s;
  }
  async save() {
    const saved=structuredClone(this.state),s=saved.settings;
    const portable=(p:string)=>p.startsWith(path.resolve(this.root)+path.sep)?'./'+path.relative(this.root,p).split(path.sep).join('/'):p;
    for(const key of ['comfyPath','pythonPath','ffmpegPath','ffprobePath'] as const) s[key]=portable(s[key]);
    s.modelPaths=s.modelPaths.map(portable);
    const content = JSON.stringify(saved, null, 2);
    const work = this.writes.then(async () => {
      const tmp = this.file + '.' + randomUUID() + '.tmp';
      await writeFile(tmp, content, { flag: 'wx' });
      try { await copyFile(this.file, this.file + '.bak'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      await rename(tmp, this.file);
    });
    this.writes = work.catch(() => {});
    return work;
  }
  project(id: string) { const p = this.state.projects.find(p => p.id === id); if (!p) throw new Error('Proyecto no encontrado.'); return p; }
}
