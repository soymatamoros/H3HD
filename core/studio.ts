import { EventEmitter } from 'node:events';
import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Store } from './store.js';
import { ComfyClient, historyAssets } from './comfy.js';
import { DownloadManager, resolveModel, sha256 } from './downloads.js';
import { detectHardware, discover, executableWorks } from './hardware.js';
import { localBackendUrl, fileName, readableError, existingChild } from './security.js';
import { buildWorkflow, validateWorkflow, capabilities } from './workflows.js';
import { validatePlayableMedia } from './media.js';
import type { Settings, Snapshot, GenerationRequest, Job, ModelEntry, Asset } from './types.js';

export class Studio extends EventEmitter {
  readonly store: Store;
  readonly downloads: DownloadManager;
  client: ComfyClient;
  child?: ChildProcess;
  objectInfo: Record<string,any> = {};
  connected = false;
  backendError = '';
  models: ModelEntry[] = [];
  private polling?: ReturnType<typeof setInterval>;
  private checking = false;
  private healthCheck = 0;
  private diagnostics?: {time:number;value:Promise<Pick<Snapshot,'hardware'|'discovery'>>};
  constructor(readonly root: string, readonly resources: string) {
    super(); this.store = new Store(root); this.downloads = new DownloadManager(path.join(root,'models'));
    this.client = new ComfyClient('http://127.0.0.1:8188');
    this.downloads.on('update', () => {this.diagnostics=undefined;this.emit('update');});
  }
  async open() {
    await this.store.open();
    try {
      const config = JSON.parse((await readFile(path.join(this.root,'runtime.paths.json'),'utf8')).replace(/^\uFEFF/,''));
      if (!this.store.state.settings.comfyPath) {
        this.store.state.settings.comfyPath = path.join(this.root,'comfyui','ComfyUI'); this.store.state.settings.pythonPath = path.join(this.root,'comfyui','python_embeded','python.exe');
      }
    } catch { /* No bootstrap yet. */ }
    for (const name of ['models']) {
      try {
        const content = JSON.parse(await readFile(path.join(this.resources,'manifests',name+'.json'),'utf8'));
        this.models.push(...(Array.isArray(content) ? content : content.models ?? []));
      } catch { /* A deliberately empty optional module needs no download. */ }
    }
    this.models = this.models.filter((m,i,a) => a.findIndex(x => x.id === m.id) === i);
    try {
      const lock=JSON.parse(await readFile(path.join(this.root,'config','model-lock.json'),'utf8')) as ModelEntry[];
      this.models=this.models.map(m=>lock.find(x=>x.id===m.id && x.source===m.source && /^[a-f0-9]{64}$/.test(x.sha256) && x.bytes>0) ?? m);
    }catch{ /* Metadata will be resolved online before download. */ }
    try {
      const tools=JSON.parse((await readFile(path.join(this.root,'ffmpeg.paths.json'),'utf8')).replace(/^\uFEFF/,''));
      this.store.state.settings.ffmpegPath=path.join(this.root,'ffmpeg','bin','ffmpeg.exe');this.store.state.settings.ffprobePath=path.join(this.root,'ffmpeg','bin','ffprobe.exe');
    }catch{ /* Use configured tools. */ }
    await this.reconnect();
    this.polling = setInterval(() => void this.poll(), 1500); this.polling.unref();
  }
  async reconnect() {
    this.client.close(); this.client.removeAllListeners();
    this.client = new ComfyClient(this.store.state.settings.comfyUrl);
    this.client.on('event', event => {
      const job = this.store.state.jobs.find(j => j.promptId === event.data?.prompt_id);
      if (!job || !['queued','running'].includes(job.status)) return;
      if (event.type === 'progress') { job.progress = Math.min(0.97, event.data.value / Math.max(1,event.data.max)); job.stage = 'Muestreo'; }
      if (event.type === 'executing' && event.data.node) { job.status = 'running'; job.stage = 'Nodo ' + event.data.node; }
      if (['execution_error','execution_interrupted'].includes(event.type)) {
        job.status = event.type === 'execution_interrupted' ? 'cancelled' : 'failed'; job.error = readableError(event.data.exception_message ?? 'Generación interrumpida.');
        void this.store.save();
      }
      this.emit('update');
    });
    this.client.on('connectionError', (e: Error) => { this.backendError = readableError(e); this.connected = false; this.emit('update'); });
    this.client.on('disconnected', () => { this.connected = false; this.emit('update'); });
    try { await this.client.health(); this.objectInfo = await this.client.objectInfo(); await this.client.connect(); this.connected = true; this.backendError = ''; }
    catch (e) { this.connected = false; this.objectInfo = {}; this.backendError = readableError(e); }
    this.emit('update');
  }
  async snapshot(): Promise<Snapshot> {
    const settings = this.store.state.settings;
    if(!this.diagnostics||Date.now()-this.diagnostics.time>15000) this.diagnostics={time:Date.now(),value:Promise.all([detectHardware(this.root),discover(settings,this.root)]).then(([hardware,discovery])=>({hardware,discovery}))};
    const {hardware,discovery}=await this.diagnostics.value;
    const checkpoints = this.objectInfo.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
    return { settings,hardware,discovery,capabilities: capabilities(this.objectInfo),connected: this.connected,backendError: this.backendError,checkpoints,projects:this.store.state.projects,jobs:this.store.state.jobs,models:this.models,downloads:this.downloads.downloads };
  }
  async settings(settings: Settings) {
    localBackendUrl(settings.comfyUrl);
    if (!Array.isArray(settings.modelPaths) || settings.modelPaths.length > 20 || settings.modelPaths.some(p => typeof p !== 'string')) throw new Error('Directorios de modelos inválidos.');
    if (!['es','en'].includes(settings.language)) throw new Error('Idioma inválido.');
    this.store.state.settings = { ...settings };this.diagnostics=undefined; await this.store.save(); await this.reconnect();
  }
  async start() {
    if (this.child) throw new Error('El backend iniciado por Studio ya está activo.');
    const s = this.store.state.settings;
    if (!s.comfyPath || !s.pythonPath) throw new Error('Selecciona ComfyUI y su Python portátil, o instala el backend.');
    if (!/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(path.basename(s.pythonPath))) throw new Error('Selecciona un ejecutable Python válido.');
    await stat(path.join(s.comfyPath,'main.py')); await stat(s.pythonPath);
    const origin = new URL(localBackendUrl(s.comfyUrl));
    const modelPaths = [path.join(this.root,'models'),...s.modelPaths];
    const categories = ['checkpoints','diffusion_models','text_encoders','vae','loras','upscale_models'];
    const yaml = modelPaths.map((p,i) => `studio_${i}:\n  base_path: ${JSON.stringify(p)}\n${categories.map(c => `  ${c}: ${c}`).join('\n')}`).join('\n');
    const config = path.join(this.root,'config','model-paths.yaml'); await writeFile(config,yaml);
    const args = ['-s',path.join(s.comfyPath,'main.py'),'--listen',origin.hostname === '[::1]' ? '::1' : '127.0.0.1','--port',origin.port || '80','--extra-model-paths-config',config,'--preview-method','none'];
    const log = await import('node:fs');
    const output = log.createWriteStream(path.join(this.root,'logs','comfyui.log'),{ flags:'a' });
    this.child = spawn(s.pythonPath,args,{ cwd:s.comfyPath,windowsHide:true,stdio:['ignore','pipe','pipe'] });
    this.child.stdout?.pipe(output,{end:false}); this.child.stderr?.pipe(output,{end:false});
    this.child.on('error', e => { this.backendError = readableError(e); this.emit('update'); });
    this.child.on('exit', code => { output.end(); this.child = undefined; this.connected = false; this.backendError = `ComfyUI se detuvo (${code}). Revisa logs/comfyui.log.`; this.emit('update'); });
    for (let i=0;i<90;i++) {
      await new Promise(r => setTimeout(r,1000));
      if (!this.child) throw new Error(this.backendError);
      try { await this.client.health(); await this.reconnect(); if(this.connected)return; } catch { /* Wait bounded startup. */ }
    }
    throw new Error('ComfyUI sigue arrancando. Revisa el registro y vuelve a conectar; no se lanzó otra instancia.');
  }
  stop() { if (!this.child) throw new Error('Studio solo puede detener la instancia que inició.'); this.child.kill(); }
  async generate(request: GenerationRequest): Promise<Job> {
    if (!this.connected) throw new Error('Conecta ComfyUI primero.');
    if (!request || typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 20000) throw new Error('Escribe un prompt válido (máximo 20 000 caracteres).');
    const settings=this.store.state.settings;
    if(!(await executableWorks(settings.ffmpegPath))||!(await executableWorks(settings.ffprobePath))) throw new Error('FFmpeg y FFprobe son necesarios para verificar las salidas. Instálalos o selecciónalos en Ajustes antes de generar.');
    this.objectInfo=await this.client.objectInfo();
    const graph = buildWorkflow(request);
    // Reuse externally configured model folders without assuming files live at the model root.
    for(const node of Object.values(graph)) for(const key of ['unet_name','clip_name','vae_name','ckpt_name']) {
      const name=node.inputs[key];if(typeof name!=='string')continue;
      const options=this.objectInfo[node.class_type]?.input?.required?.[key]?.[0];
      if(Array.isArray(options)&&!options.includes(name)) {
        const matches=options.filter((value:unknown)=>typeof value==='string'&&value.replaceAll('\\','/').split('/').pop()===name);
        if(matches.length===1)node.inputs[key]=matches[0];
      }
    }
    const errors = validateWorkflow(graph,this.objectInfo);
    if (errors.length) throw new Error('Dependencias o parámetros inválidos:\n' + errors.join('\n'));
    // Store the exact workflow BEFORE submitting, to retain an audit trail on crash.
    const now = new Date().toISOString(), projectId = randomUUID();
    const project = { id:projectId,name:request.prompt.trim().slice(0,60),favorite:false,createdAt:now,updatedAt:now,request:structuredClone(request),workflow:graph,outputs:[] };
    const job: Job = { id:randomUUID(),projectId,status:'queued',progress:0,stage:'En cola',outputs:[],createdAt:now };
    this.store.state.projects.unshift(project); this.store.state.jobs.unshift(job); await this.store.save();
    try { job.promptId = await this.client.submit(graph); await this.store.save(); }
    catch (e) { job.status='failed'; job.error=readableError(e); await this.store.save(); throw e; }
    this.emit('update'); return job;
  }
  private async poll() {
    if (this.checking) return; this.checking = true;
    try {
      if (Date.now()-this.healthCheck > 15000) {
        this.healthCheck=Date.now();
        if (!this.connected) await this.reconnect(); else await this.client.health();
      }
      for (const job of this.store.state.jobs.filter(j => ['queued','running'].includes(j.status) && j.promptId)) {
        const h = (await this.client.history(job.promptId!))[job.promptId!];
        if (!h) continue;
        if (h.status?.status_str === 'error') {
          job.status='failed'; job.error=readableError(JSON.stringify(h.status.messages)); await this.store.save(); this.emit('update'); continue;
        }
        if (h.status?.completed !== true) continue;
        const assets = historyAssets(h);
        if (!assets.length) { job.status='failed'; job.error='El flujo terminó sin archivos de salida verificables.'; }
        else try {
          const dir = path.join(this.root,'outputs',job.projectId); await mkdir(dir,{recursive:true});
          let hasAV=false;
          for (const asset of assets) {
            const local = path.join('outputs',job.projectId,fileName(asset.filename));
            const dest = path.join(this.root,local);
            const bytes=await this.client.output(asset);
            await writeFile(dest,bytes,{ flag:'wx' });
            const s=this.store.state.settings;
            const media=await validatePlayableMedia(dest,s.ffmpegPath,s.ffprobePath);
            if(media.video&&media.audio)hasAV=true;
            asset.local=local.split(path.sep).join('/'); asset.url='studio://asset/'+asset.local;
            const [num,den]=(media.video?.avg_frame_rate||'0/1').split('/').map(Number);
            asset.metadata={width:media.video?.width,height:media.video?.height,fps:den?num/den:0,duration:media.duration,audioSampleRate:media.audio?.sample_rate};
          }
          if(this.store.project(job.projectId).request.mode!=='image'&&!hasAV)throw new Error('La salida audiovisual no contiene las dos pistas esperadas. Se conserva para diagnóstico.');
          job.outputs=assets; job.status='completed'; job.progress=1; job.stage='Archivos recuperados';
          const project=this.store.project(job.projectId); project.outputs=assets; project.updatedAt=new Date().toISOString();
        }catch(e){ job.status='failed';job.error='No se pudo verificar la salida: '+readableError(e); }
        await this.store.save(); this.emit('update');
      }
    } catch (e) { this.backendError=readableError(e); this.emit('update'); }
    finally { this.checking=false; }
  }
  async cancel(id: string) {
    const job=this.store.state.jobs.find(j => j.id === id); if (!job?.promptId || !['queued','running'].includes(job.status)) throw new Error('Trabajo no cancelable.');
    await this.client.cancel(job.promptId); job.status='cancelled'; job.stage='Cancelado'; await this.store.save(); this.emit('update');
  }
  async modelInfo(id: string) {
    const index=this.models.findIndex(m => m.id===id); if (index<0) throw new Error('Modelo no autorizado.');
    this.models[index]=await resolveModel(this.models[index]);
    await writeFile(path.join(this.root,'config','model-lock.json'),JSON.stringify(this.models,null,2));
    this.emit('update'); return this.models[index];
  }
  async installModel(id: string) {
    const model=this.models.find(m => m.id===id); if (!model) throw new Error('Modelo no autorizado.');
    if(!model.sha256 || !model.bytes) throw new Error('Verifica los metadatos antes de instalar.');
    const found=(await discover(this.store.state.settings,this.root)).models.filter(m=>m.name===model.filename&&m.size===model.bytes);
    for(const candidate of found) if(await sha256(candidate.path)===model.sha256) {
      this.downloads.downloads=this.downloads.downloads.filter(d=>d.id!==id).concat({id,status:'completed',received:model.bytes,total:model.bytes});
      this.emit('update');return;
    }
    const hardware=await detectHardware(this.root);
    if (hardware.freeDiskGB*1024**3 < model.bytes*1.05) throw new Error('No hay espacio libre suficiente para el modelo.');
    void this.downloads.install(model).catch(e => { this.backendError=readableError(e); this.emit('update'); });
  }
  async localAsset(asset: Asset) {
    if (!asset.local || !this.store.state.projects.some(p => p.outputs.some(a => a.local===asset.local))) throw new Error('Archivo no registrado en la biblioteca.');
    return existingChild(this.root,asset.local);
  }
  async importFile(source: string, filename?: string) {
    const name=filename ?? `${randomUUID()}${path.extname(source).toLowerCase()}`;
    const dest=path.join(this.root,'inputs',fileName(name)); await copyFile(source,dest);
    const uploaded=await this.client.uploadImage(name,await readFile(dest));
    return { filename:uploaded,url:'studio://asset/inputs/'+name };
  }
  close() { if(this.polling) clearInterval(this.polling); this.client.close(); this.child?.kill(); }
}
