import { app, BrowserWindow, dialog, ipcMain, protocol, net, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile, stat, copyFile, mkdir } from 'node:fs/promises';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { Studio } from '../core/studio.js';
import { existingChild, readableError } from '../core/security.js';
import { exportMedia, analyzeMedia, probeMedia } from '../core/media.js';
import type { ExportOptions, Settings, Asset, GenerationRequest } from '../core/types.js';

protocol.registerSchemesAsPrivileged([{ scheme:'studio', privileges:{ standard:true,secure:true,supportFetchAPI:true,stream:true } }]);
const here=path.dirname(fileURLToPath(import.meta.url));
const portableRoot=app.isPackaged?path.join(path.dirname(app.getPath('exe')),'data'):path.resolve(here,'../../data');
mkdirSync(path.join(portableRoot,'electron'),{recursive:true});app.setPath('userData',path.join(portableRoot,'electron'));
if(!app.requestSingleInstanceLock())app.quit();
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
let window: BrowserWindow | undefined, studio: Studio;
let bootstrapProcess: ChildProcess | undefined;
const chosen = new Set<string>();

function handle(name: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle('studio:'+name, async (event,...args) => {
    if (!window || event.senderFrame !== window.webContents.mainFrame) throw new Error('Origen IPC no autorizado.');
    try { return await fn(...args); } catch(e) { throw new Error(readableError(e)); }
  });
}
async function pickFile(kind:'image'|'video'|'audio') {
  if(!studio.connected) throw new Error('Conecta ComfyUI antes de importar referencias.');
  const extensions = kind==='image' ? ['png','jpg','jpeg','webp'] : kind==='video' ? ['mp4','mov','mkv','webm'] : ['wav','flac','mp3','m4a','ogg'];
  const selected=await dialog.showOpenDialog(window!,{properties:['openFile'],filters:[{name:kind,extensions}]});
  if(selected.canceled) return null;
  let file=selected.filePaths[0];
  const original=file;
  if(!extensions.includes(path.extname(file).slice(1).toLowerCase())) throw new Error('Tipo de referencia no permitido.');
  if((await stat(file)).size > 512*1024*1024) throw new Error('Referencia mayor de 512 MiB. Recorta el archivo antes de importarlo.');
  if(kind==='video') {
    const s=studio.store.state.settings;
    const info=await probeMedia(file,s.ffprobePath);
    if(!info.video) throw new Error('El archivo no contiene video.');
    const normalized=path.join(studio.root,'inputs',randomUUID()+'.mp4');
    // References and continuation guides must be 24fps, preserving duration, ratio and audio.
    await new Promise<void>((resolve,reject) => {
      const proc=spawn(s.ffmpegPath,['-nostdin','-v','error','-n','-i',file,'-map','0:v:0','-vf','fps=24,scale=trunc(iw/2)*2:trunc(ih/2)*2','-c:v','libx264','-crf','16','-preset','slow','-an',normalized],{windowsHide:true});
      let err='';proc.stderr?.on('data',d=>err=(err+String(d)).slice(-4000));proc.on('error',reject);proc.on('exit',code=>code===0?resolve():reject(new Error('No se pudo normalizar la referencia: '+err)));
    });
    file=normalized;
  }
  const imported: {filename:string;url:string;audioFilename?:string}=await studio.importFile(file);
  if(kind==='video') {
    const s=studio.store.state.settings,info=await probeMedia(original,s.ffprobePath);
    if(info.audio) {
      const audio=path.join(studio.root,'inputs',randomUUID()+'.wav');
      await exportMedia(original,audio,{asset:{filename:'',subfolder:'',type:'input'},format:'wav'},s.ffmpegPath,s.ffprobePath);
      imported.audioFilename=(await studio.importFile(audio)).filename;
    }
  }
  return imported;
}
async function setupIPC() {
  handle('snapshot',async()=> {const snapshot=await studio.snapshot();for(const p of snapshot.discovery.comfyPaths)chosen.add(p);return snapshot;});
  handle('settings',async(s:Settings)=> {
    // Executables/directories must originate in a native picker or an existing saved configuration.
    const old=studio.store.state.settings;
    for(const key of ['comfyPath','pythonPath','ffmpegPath','ffprobePath'] as const) if(s[key]!==old[key] && !chosen.has(s[key])) throw new Error('Usa el selector nativo para cambiar rutas.');
    if(s.modelPaths.some(p=>!old.modelPaths.includes(p)&&!chosen.has(p))) throw new Error('Selecciona el directorio de modelos con el selector nativo.');
    await studio.settings(s);
  });
  handle('choosePath',async(kind:string)=> {
    if(!['comfy','python','models','ffmpeg','ffprobe'].includes(kind)) throw new Error('Selector desconocido.');
    const result=await dialog.showOpenDialog(window!,{properties:[kind==='comfy'||kind==='models'?'openDirectory':'openFile']});
    if(result.canceled) return null; chosen.add(result.filePaths[0]);return result.filePaths[0];
  });
  handle('backend',async(action:string)=> {
    if(action==='start') await studio.start(); else if(action==='stop') studio.stop(); else if(action==='reconnect') await studio.reconnect(); else if(action==='free') await studio.client.free(); else throw new Error('Acción desconocida.');
  });
  handle('generate',async(r:GenerationRequest)=> {
    const warnings:string[]=[];
    for(const [file,behavior] of [[r.inputImage,'El primer fotograma se estirará al lienzo H3.'],[r.lastImage,'El último fotograma se recortará al centro para llenar el lienzo H3.']] as const) {
      if(file&&r.mode==='image-video') {
        const local=await existingChild(studio.root,'inputs/'+path.basename(file));
        const info=await probeMedia(local,studio.store.state.settings.ffprobePath);
        if(info.video&&Math.abs((info.video.width!/info.video.height!)/(r.width/r.height)-1)>0.005) warnings.push(behavior);
      }
    }
    if(r.mode==='reference-video'&&r.references?.some(ref=>ref.kind!=='audio')) warnings.push('El flujo oficial adapta las referencias visuales al lienzo; los videos pueden cambiar de proporción. Revisa la composición.');
    if(r.mode==='extend-video') warnings.push('La continuación condiciona los últimos 22 fotogramas del clip a 24 FPS y puede recortar al centro si cambia el formato. El resultado incluye el tramo condicionado; no se concatena automáticamente ni se garantiza continuidad perfecta.');
    if(warnings.length) {
      const result=await dialog.showMessageBox(window!,{type:'warning',buttons:['Cancelar','Generar con estos cambios'],defaultId:0,cancelId:0,message:warnings.join('\n\n')});
      if(result.response!==1) throw new Error('Generación cancelada antes de enviar el flujo.');
    }
    return studio.generate(r);
  });
  handle('cancel',(id:string)=>studio.cancel(id));
  handle('importImage',async()=> (await pickFile('image'))?.filename ?? null);
  handle('importReference',(kind:'image'|'video'|'audio')=> { if(!['image','video','audio'].includes(kind)) throw new Error('Referencia inválida.'); return pickFile(kind); });
  handle('modelInfo',(id:string)=>studio.modelInfo(id));
  handle('installModel',async(id:string)=> {
    const m=studio.models.find(x=>x.id===id);if(!m) throw new Error('Modelo no autorizado.');
    if(!m.sha256||!m.bytes) throw new Error('Consulta los metadatos del modelo antes de instalar.');
    const result=await dialog.showMessageBox(window!,{type:'question',buttons:['Cancelar','Acepto la licencia e instalar'],defaultId:0,cancelId:0,title:m.name,message:`${m.name}\n${m.purpose}\n${(m.bytes/1024**3).toFixed(2)} GiB\n${m.source}\n${m.license}\n${m.licenseUrl}\nSHA-256: ${m.sha256}`,detail:'No se sobrescribirán archivos existentes. Revisa la licencia en la fuente antes de aceptar.'});
    if(result.response===1) await studio.installModel(id);
  });
  handle('cancelDownload',(id:string)=>studio.downloads.cancel(id));
  handle('bootstrap',async()=> {
    if(process.platform!=='win32') throw new Error('El instalador portátil solo puede ejecutarse en Windows 11 x64.');
    if(bootstrapProcess) throw new Error('La instalación ya está activa.');
    const confirmation=await dialog.showMessageBox(window!,{type:'question',buttons:['Cancelar','Instalar backend oficial'],defaultId:0,cancelId:0,message:'Instalar ComfyUI NVIDIA portátil (≈1,8 GB), Python, PyTorch CUDA y FFmpeg portátil.',detail:'Fuentes: github.com/Comfy-Org/ComfyUI (GPL-3.0) y github.com/BtbN/FFmpeg-Builds (GPL-3.0+). Se verifican los SHA-256 oficiales antes de extraer. No incluye pesos H3; su uso comercial requiere licencia de MiniMax.'});
    if(confirmation.response!==1) return;
    const resources=app.isPackaged?process.resourcesPath:path.resolve(here,'../../');
    const script=path.join(resources,'scripts','bootstrap-comfy.ps1');
    const sevenZip=app.isPackaged?path.join(resources,'tools','7za.exe'):path.join(resources,'node_modules','7zip-bin','win','x64','7za.exe');
    const fs=await import('node:fs'); const log=fs.createWriteStream(path.join(studio.root,'logs','bootstrap.log'),{flags:'a'});
    await new Promise<void>((resolve,reject)=> {
      bootstrapProcess=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Root',studio.root,'-SevenZip',sevenZip],{windowsHide:true});
      bootstrapProcess.stdout?.pipe(log,{end:false});bootstrapProcess.stderr?.pipe(log,{end:false});
      bootstrapProcess.on('error',reject);bootstrapProcess.on('exit',code=>code===0?resolve():reject(new Error('La instalación falló. Consulta logs/bootstrap.log.')));
    }).finally(()=>{bootstrapProcess=undefined;log.end();});
    const paths=JSON.parse((await readFile(path.join(studio.root,'runtime.paths.json'),'utf8')).replace(/^\uFEFF/,''));
    await new Promise<void>((resolve,reject)=> {
      bootstrapProcess=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(resources,'scripts','bootstrap-ffmpeg.ps1'),'-Root',studio.root],{windowsHide:true});
      const mediaLog=fs.createWriteStream(path.join(studio.root,'logs','bootstrap-ffmpeg.log'),{flags:'a'});
      bootstrapProcess.stdout?.pipe(mediaLog,{end:false});bootstrapProcess.stderr?.pipe(mediaLog,{end:false});
      bootstrapProcess.on('error',reject);bootstrapProcess.on('exit',code=>{mediaLog.end();code===0?resolve():reject(new Error('FFmpeg no se instaló; revisa logs/bootstrap-ffmpeg.log.'));});
    }).finally(()=>{bootstrapProcess=undefined;});
    const tools=JSON.parse((await readFile(path.join(studio.root,'ffmpeg.paths.json'),'utf8')).replace(/^\uFEFF/,''));
    await studio.settings({...studio.store.state.settings,comfyPath:paths.comfyPath,pythonPath:paths.pythonPath,ffmpegPath:tools.ffmpegPath,ffprobePath:tools.ffprobePath}); await studio.start();
  });
  handle('project',async(action:string,id:string,value?:string)=> {
    const project=studio.store.project(id);
    if(action==='rename') { if(!value?.trim()) throw new Error('Nombre vacío.'); project.name=value.trim().slice(0,120); }
    else if(action==='favorite') project.favorite=!project.favorite;
    else if(action==='duplicate') { const copy=structuredClone(project);copy.id=randomUUID();copy.name+=' · copia';copy.createdAt=copy.updatedAt=new Date().toISOString();studio.store.state.projects.unshift(copy); }
    else if(action==='delete') {
      if(studio.store.state.jobs.some(j=>j.projectId===id&&['queued','running'].includes(j.status))) throw new Error('Cancela el trabajo antes de eliminar el proyecto.');
      const result=await dialog.showMessageBox(window!,{type:'warning',buttons:['Cancelar','Eliminar de biblioteca'],defaultId:0,cancelId:0,message:'¿Eliminar este proyecto de la biblioteca?',detail:'Los archivos maestros se conservarán en outputs. La operación no elimina modelos.'});
      if(result.response!==1)return;studio.store.state.projects=studio.store.state.projects.filter(p=>p.id!==id);
    } else if(action==='workflow') {
      const result=await dialog.showSaveDialog(window!,{defaultPath:'workflow-'+id+'.json',filters:[{name:'ComfyUI API JSON',extensions:['json']}]});
      if(!result.canceled&&result.filePath) await writeFile(result.filePath,JSON.stringify({prompt:project.workflow,studio:project.request},null,2),{flag:'w'});
    } else throw new Error('Acción desconocida.');
    await studio.store.save();studio.emit('update');
  });
  handle('export',async(options:ExportOptions)=> {
    const input=await studio.localAsset(options.asset),s=studio.store.state.settings;
    const extension=options.format==='original'?path.extname(input):'.'+({ 'mp4-h264':'mp4','mp4-h265':'mp4',png:'png',jpeg:'jpg',webp:'webp',wav:'wav',aac:'aac',flac:'flac' }[options.format]??'');
    const target=await dialog.showSaveDialog(window!,{defaultPath:path.basename(input,path.extname(input))+'-export'+extension});
    if(target.canceled||!target.filePath)return null;
    // FFmpeg module always refuses overwrite, even after the native dialog confirms one.
    const output=await exportMedia(input,target.filePath,options,s.ffmpegPath,s.ffprobePath);
    if(options.format!=='original') {
      const project=studio.store.state.projects.find(p=>p.outputs.some(a=>a.local===options.asset.local));
      if(project) {
        const filename='processed-'+randomUUID()+extension;
        const local=`outputs/${project.id}/${filename}`;
        await mkdir(path.join(studio.root,'outputs',project.id),{recursive:true});
        await copyFile(output,path.join(studio.root,local));
        const info=await probeMedia(output,s.ffprobePath),[num,den]=(info.video?.avg_frame_rate||'0/1').split('/').map(Number);
        project.outputs.push({filename,subfolder:'',type:'output',local,url:'studio://asset/'+local,processed:true,metadata:{width:info.video?.width,height:info.video?.height,fps:den?num/den:0,exportOptions:options}});
        project.updatedAt=new Date().toISOString();await studio.store.save();studio.emit('update');
      }
    }
    return output;
  });
  handle('analyze',async(asset:Asset)=> {const s=studio.store.state.settings;return analyzeMedia(await studio.localAsset(asset),s.ffmpegPath,s.ffprobePath);});
  handle('reveal',async(asset:Asset)=>shell.showItemInFolder(await studio.localAsset(asset)));
}
app.whenReady().then(async()=> {
  const root=portableRoot;
  const resources=app.isPackaged?app.getAppPath():path.resolve(here,'../../');
  studio=new Studio(root,resources);await studio.open();
  protocol.handle('studio',async request=> {
    try {
      const url=new URL(request.url),relative=decodeURIComponent(url.pathname.slice(1));
      if(url.hostname!=='asset'||!['outputs/','inputs/'].some(prefix=>relative.startsWith(prefix)))return new Response(null,{status:403});
      const category=relative.startsWith('outputs/')?'outputs':'inputs';
      const local=await existingChild(path.join(root,category),relative.slice(category.length+1));return net.fetch(pathToFileURL(local).href);
    }catch{return new Response(null,{status:404});}
  });
  await setupIPC();
  window=new BrowserWindow({width:1512,height:1000,minWidth:1000,minHeight:720,backgroundColor:'#101113',title:'MiniMax H3 Studio',autoHideMenuBar:true,webPreferences:{preload:path.join(here,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  window.webContents.setWindowOpenHandler(({url})=>{
    try {const target=new URL(url);if(target.protocol==='https:'&&!target.username&&!target.password&&['huggingface.co','github.com','comfy.org','docs.comfy.org'].includes(target.hostname))void shell.openExternal(target.href);}catch{/* Block every other protocol and destination. */}
    return {action:'deny'};
  });
  window.webContents.on('will-navigate',event=>event.preventDefault());
  studio.on('update',()=>window?.webContents.send('studio:update'));
  await window.loadFile(path.resolve(here,'../../dist/index.html'));
  if(studio.store.state.settings.comfyPath&&!studio.connected) void studio.start().catch(e=>{studio.backendError=readableError(e);studio.emit('update');});
}).catch(async e=>{await dialog.showMessageBox({type:'error',message:readableError(e)});app.quit();});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=> {studio?.close();if(bootstrapProcess?.pid) { if(process.platform==='win32') execFile('taskkill',['/PID',String(bootstrapProcess.pid),'/T','/F']);else bootstrapProcess.kill(); } });
