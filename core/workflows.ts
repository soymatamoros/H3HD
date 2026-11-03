import type { Capability, GenerationRequest, Mode } from './types.js';

export interface WorkflowNode { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } }
export type Workflow = Record<string, WorkflowNode>;
export interface ReferenceInput { kind: 'image'|'video'|'audio'; filename: string; role: string; audioFilename?: string }
type Request = GenerationRequest & { lastImage?: string; references?: ReferenceInput[]; guideVideo?: string; guideAudio?: string; refImageSize?: 'match'|'max' };
export const H3_MODELS = {
  fl2va: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  ref2va: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
  encoder: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  videoVae: 'minimax_h3_video_vae_int8_convrot.safetensors',
  audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
};
export const SDXL_CHECKPOINT = 'sd_xl_base_1.0.safetensors';
export const WORKFLOW_VERSION = 'h3-base-2026-11-02.2';
export const SOURCES = {
  comfyCommit: '858fd58dcd47b1407a6778e0920f02a9b40fd538',
  workflowCommit: '60d0d2c2f5c98ab50116abd837156e4010534657',
  docsCommit: '7066cf4385164aee28581f1424bca2c586e6983b',
};

function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function file(value: string): string {
  ensure(value && !value.includes('..') && !value.includes('\\') && !value.startsWith('/') && !/[:\0]/.test(value), 'Nombre de recurso de ComfyUI no válido.');
  return value;
}
/** The actual output snaps upward to the model's 17k+5 grid at 24fps. */
export function frameCount(duration = 5): number {
  ensure(Number.isFinite(duration) && duration >= 5 && duration <= 15, 'H3: la duración validada debe estar entre 5 y 15 segundos.');
  const requested = Math.max(5, Math.round(duration * 24));
  return requested + ((5 - (requested % 17)) + 17) % 17;
}
export function nativeCanvas(aspect: string): { width: number; height: number } {
  const sizes: Record<string, { width: number; height: number }> = {
    '16:9': { width: 1344, height: 768 }, '9:16': { width: 768, height: 1344 },
    '1:1': { width: 768, height: 768 }, '4:3': { width: 1024, height: 768 },
    '3:4': { width: 768, height: 1024 },
  };
  ensure(sizes[aspect], 'Relación de aspecto no validada.'); return sizes[aspect];
}
export function referenceMapping(references: ReferenceInput[]): { reference: ReferenceInput; tag: string; audioTag?: string; input: string }[] {
  ensure(references.filter(r => r.kind === 'image').length <= 9, 'H3 admite hasta nueve imágenes de referencia.');
  ensure(references.filter(r => r.kind === 'video').length <= 3, 'H3 admite hasta tres videos de referencia.');
  ensure(references.filter(r => r.kind === 'audio').length <= 3, 'H3 admite hasta tres audios independientes.');
  const out: { reference: ReferenceInput; tag: string; audioTag?: string; input: string }[] = [];
  let image = 0, video = 0, audio = 0;
  for (const r of references.filter(r => r.kind === 'image')) out.push({ reference: r, tag: `<Picture ${++image}>`, input: `ref_images.ref_image_${image - 1}` });
  for (const r of references.filter(r => r.kind === 'video')) {
    const audioTag = r.audioFilename ? `<Audio ${++audio}>` : undefined;
    out.push({ reference: r, tag: `<Video ${++video}>`, audioTag, input: `ref_videos.ref_video_${video - 1}` });
  }
  for (const r of references.filter(r => r.kind === 'audio')) out.push({ reference: r, tag: `<Audio ${++audio}>`, input: `ref_audios.ref_audio_${out.filter(o=>o.reference.kind==='audio').length}` });
  return out;
}
export function requiredModels(request: GenerationRequest): string[] {
  if (request.mode === 'image') return [request.checkpoint || SDXL_CHECKPOINT];
  return [request.mode === 'reference-video' ? H3_MODELS.ref2va : H3_MODELS.fl2va, H3_MODELS.encoder, H3_MODELS.videoVae, H3_MODELS.audioVae];
}

/** API-format graph derived from the pinned official templates, with optional turbo branches removed. */
export function buildWorkflow(request: GenerationRequest, checkpoint?: string): Workflow {
  const r = request as Request;
  ensure(typeof r.prompt === 'string' && r.prompt.trim().length > 0 && r.prompt.length <= 20000, 'Escribe un prompt de 1 a 20.000 caracteres.');
  ensure(Number.isSafeInteger(r.seed) && r.seed >= 0, 'La semilla debe ser un entero positivo seguro.');
  ensure(Number.isInteger(r.steps) && r.steps >= 1 && r.steps <= 50, 'Número de pasos no válido.');
  ensure(Number.isInteger(r.width) && Number.isInteger(r.height) && r.width >= 256 && r.height >= 256, 'Resolución no válida.');
  if (r.mode === 'image') return buildImage(r, checkpoint);
  ensure(['text-video','image-video','reference-video','extend-video'].includes(r.mode), 'Modo no compatible.');
  ensure(r.quality !== 'preview', 'La vista previa Turbo requiere otro flujo y LoRA; no se sustituye el flujo base automáticamente.');
  ensure(!r.negative?.trim(), 'El flujo H3 base usa BasicGuider y no admite prompt negativo.');
  ensure(r.width % 32 === 0 && r.height % 32 === 0 && r.width * r.height <= 1344 * 768, 'H3: usa múltiplos de 32 dentro del lienzo nativo de 1.032.192 píxeles.');
  ensure(r.steps >= 20 && r.steps <= 25, 'El flujo H3 base validado utiliza entre 20 y 25 pasos.');
  const reference = r.mode === 'reference-video';
  const expected = reference ? H3_MODELS.ref2va : H3_MODELS.fl2va;
  const chosen = checkpoint || r.checkpoint || expected;
  ensure(chosen.split('/').pop() === expected, reference ? 'Referencias requiere el checkpoint Ref2VA validado.' : 'Este flujo requiere el checkpoint FL2VA validado.');
  const graph: Workflow = {};
  const put = (id: string, class_type: string, inputs: Record<string,unknown>): [string,number] => { graph[id] = { class_type, inputs }; return [id,0]; };
  const model = put('1','UNETLoader',{ unet_name: file(chosen), weight_dtype:'default' });
  const clip = put('2','CLIPLoader',{ clip_name:H3_MODELS.encoder, type:'minimax', device:'default' });
  const vae = put('3','VAELoader',{ vae_name:H3_MODELS.videoVae });
  const audioVae = put('4','VAELoader',{ vae_name:H3_MODELS.audioVae });
  const condition: Record<string,unknown> = { clip, vae, prompt:r.prompt, width:r.width, height:r.height, length:frameCount(r.duration) };
  if (reference) {
    condition.audio_vae = audioVae; condition.ref_image_size = r.refImageSize || 'match';
    const mapping = referenceMapping(r.references || []);
    ensure(mapping.length > 0, 'Añade al menos una referencia.');
    let id = 20;
    const roles: string[] = [];
    for (const item of mapping) {
      const ref = item.reference;
      if (ref.kind === 'image') condition[item.input] = put(String(id++),'LoadImage',{ image:file(ref.filename) });
      if (ref.kind === 'audio') condition[item.input] = put(String(id++),'LoadAudio',{ audio:file(ref.filename) });
      if (ref.kind === 'video') {
        const video = put(String(id++),'LoadVideo',{ file:file(ref.filename) });
        condition[item.input] = put(String(id++),'GetVideoComponents',{ video });
        if (ref.audioFilename) {
          const index = item.input.split('_').pop();
          condition[`ref_video_audios.ref_video_audio_${index}`] = put(String(id++),'LoadAudio',{ audio:file(ref.audioFilename) });
        }
      }
      if (ref.role.trim()) roles.push(`${item.tag}: ${ref.role.trim().slice(0,200)}.`);
      if (item.audioTag) roles.push(`${item.audioTag}: banda sonora de ${item.tag}.`);
    }
    if (roles.length) condition.prompt = `${r.prompt}\n\nReferencias:\n${roles.join('\n')}`;
  } else {
    if (r.inputImage) condition.first_frame = put('20','LoadImage',{ image:file(r.inputImage) });
    if (r.lastImage) condition.last_frame = put('21','LoadImage',{ image:file(r.lastImage) });
    if (r.mode === 'image-video') ensure(r.inputImage || r.lastImage, 'Añade el primer o el último fotograma.');
  }
  put('5',reference ? 'MiniMaxH3ReferenceToVideo' : 'MiniMaxH3ImageToVideo', condition);
  let positive: [string,number] = ['5',0];
  if (r.mode === 'extend-video') {
    ensure(r.guideVideo, 'Importa un video a 24 fps para la continuación con guía.');
    const video = put('30','LoadVideo',{ file:file(r.guideVideo) });
    const components = put('31','GetVideoComponents',{ video });
    const image = put('32','ImageFromBatch',{ image:components, batch_index:-22, length:22 });
    const guide: Record<string,unknown> = { positive, latent:['5',1], vae, image, frame_idx:0 };
    if (r.guideAudio) {
      const audio = put('33','LoadAudio',{ audio:file(r.guideAudio) });
      guide.audio = put('34','TrimAudioDuration',{ audio, start_index:-(22 / 24), duration:22 / 24 });
      guide.audio_vae = audioVae;
    }
    positive = put('35','MiniMaxH3AddGuide',guide);
  }
  const guider = put('6','BasicGuider',{ model, conditioning:positive });
  const noise = put('7','RandomNoise',{ noise_seed:r.seed });
  const sampler = put('8','KSamplerSelect',{ sampler_name:'res_multistep' });
  const sigmas = put('9','BasicScheduler',{ model, scheduler:'simple', steps:r.steps, denoise:1 });
  const samples = put('10','SamplerCustomAdvanced',{ noise, guider, sampler, sigmas, latent_image:['5',1] });
  const images = put('11','VAEDecode',{ samples, vae });
  const audio = put('12','VAEDecodeAudio',{ samples, vae:audioVae });
  put('15','SaveAudioAdvanced',{ audio, filename_prefix:'MiniMaxH3Studio/native-audio', format:'flac' });
  const video = put('13','CreateVideo',{ images, fps:24, audio, bit_depth:8 });
  put('14','SaveVideo',{ video, filename_prefix:'MiniMaxH3Studio/master', format:'mp4', 'format.codec':'auto' });
  return graph;
}

function buildImage(r: Request, checkpoint?: string): Workflow {
  const ckpt = checkpoint || r.checkpoint || SDXL_CHECKPOINT;
  ensure(ckpt.split('/').pop() === SDXL_CHECKPOINT, 'Solo se ha verificado el flujo de imágenes SDXL Base 1.0; elige su checkpoint.');
  ensure(r.width % 64 === 0 && r.height % 64 === 0 && r.width <= 1536 && r.height <= 1536, 'SDXL: usa múltiplos de 64, hasta 1536 por eje.');
  ensure(Number.isFinite(r.cfg) && r.cfg >= 1 && r.cfg <= 20, 'CFG fuera del intervalo admitido.');
  const graph: Workflow = {
    '1': { class_type:'CheckpointLoaderSimple', inputs:{ ckpt_name:file(ckpt) } },
    '2': { class_type:'CLIPTextEncode', inputs:{ text:r.prompt, clip:['1',1] } },
    '3': { class_type:'CLIPTextEncode', inputs:{ text:r.negative || '', clip:['1',1] } },
    '4': { class_type:'EmptyLatentImage', inputs:{ width:r.width, height:r.height, batch_size:1 } },
    '5': { class_type:'KSampler', inputs:{ model:['1',0], seed:r.seed, steps:r.steps, cfg:r.cfg, sampler_name:'dpmpp_2m', scheduler:'karras', positive:['2',0], negative:['3',0], latent_image:['4',0], denoise:r.inputImage ? r.denoise ?? 0.65 : 1 } },
    '6': { class_type:'VAEDecode', inputs:{ samples:['5',0], vae:['1',2] } },
    '7': { class_type:'SaveImage', inputs:{ images:['6',0], filename_prefix:'MiniMaxH3Studio/SDXL' } },
  };
  if (r.inputImage) {
    ensure(Number.isFinite(r.denoise ?? 0.65) && (r.denoise ?? 0.65) > 0 && (r.denoise ?? 0.65) <= 1, 'Denoise debe estar entre 0 y 1.');
    graph['8'] = { class_type:'LoadImage', inputs:{ image:file(r.inputImage) } };
    graph['4'] = { class_type:'VAEEncode', inputs:{ pixels:['8',0], vae:['1',2] } };
  }
  return graph;
}

type ObjectInfo = Record<string, { input?: { required?: Record<string,unknown[]>; optional?: Record<string,unknown[]> }; output?: unknown[] }>;
function inputSpec(info: ObjectInfo, type: string, name: string): unknown[]|undefined {
  return info[type]?.input?.required?.[name] || info[type]?.input?.optional?.[name];
}
function modelExists(info: ObjectInfo, type: string, key: string, filename: string): boolean {
  const options = inputSpec(info,type,key)?.[0];
  return Array.isArray(options) && options.some(v=>typeof v === 'string' && v.split('/').pop() === filename);
}
const commonH3 = ['UNETLoader','CLIPLoader','VAELoader','BasicGuider','RandomNoise','KSamplerSelect','BasicScheduler','SamplerCustomAdvanced','VAEDecode','VAEDecodeAudio','CreateVideo','SaveVideo','SaveAudioAdvanced'];
const modes: Mode[] = ['text-video','image-video','reference-video','extend-video','image'];
export function capabilities(objectInfo: unknown): Capability[] {
  const info = (objectInfo || {}) as ObjectInfo;
  return modes.map(id => {
    const nodes = id === 'image' ? ['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage','LoadImage','VAEEncode'] : [...commonH3, id==='reference-video'?'MiniMaxH3ReferenceToVideo':'MiniMaxH3ImageToVideo', ...(id==='image-video'?['LoadImage']:[]), ...(id==='extend-video'?['LoadVideo','GetVideoComponents','ImageFromBatch','MiniMaxH3AddGuide']:[])];
    const missing = nodes.filter(n=>!info[n]);
    const model = id === 'image' ? 'SDXL Base 1.0' : id==='reference-video' ? 'MiniMax H3 Ref2VA' : 'MiniMax H3 FL2VA';
    if (missing.length) return { id, model, supported:false, reason:`Faltan nodos: ${missing.join(', ')}. Actualiza ComfyUI.` };
    const missingModels = id === 'image' ? (modelExists(info,'CheckpointLoaderSimple','ckpt_name',SDXL_CHECKPOINT)?[]:[SDXL_CHECKPOINT]) : [
      ...(!modelExists(info,'UNETLoader','unet_name',id==='reference-video'?H3_MODELS.ref2va:H3_MODELS.fl2va)?[id==='reference-video'?H3_MODELS.ref2va:H3_MODELS.fl2va]:[]),
      ...(!modelExists(info,'CLIPLoader','clip_name',H3_MODELS.encoder)?[H3_MODELS.encoder]:[]),
      ...(!modelExists(info,'VAELoader','vae_name',H3_MODELS.videoVae)?[H3_MODELS.videoVae]:[]),
      ...(!modelExists(info,'VAELoader','vae_name',H3_MODELS.audioVae)?[H3_MODELS.audioVae]:[]),
    ];
    return { id, model, supported:missingModels.length===0, reason:missingModels.length ? `Faltan modelos: ${missingModels.join(', ')}` : id==='extend-video' ? 'Continuación generativa con guía de los últimos 22 fotogramas; no garantiza continuidad perfecta.' : 'Nodos y nombres de modelo disponibles. La inferencia requiere validación en GPU.' };
  });
}
interface DynamicOptions { template?: { prefix?: string; min?: number; max?: number; input?: { required?: Record<string,unknown[]>; optional?: Record<string,unknown[]> } }; options?: { key: string; inputs?: { required?: Record<string,unknown[]>; optional?: Record<string,unknown[]> } }[]; min?: number; max?: number }
/** Expand the current V3 dynamic combos/autogrow exactly as ComfyUI's flattened API expects. */
function expandedInputs(schema: ObjectInfo[string], live: Record<string,unknown>): { specs: Record<string,unknown[]>; required: Set<string> } {
  const specs: Record<string,unknown[]> = {}, required = new Set<string>();
  const add = (entries: Record<string,unknown[]>, prefix: string, isRequired: boolean) => {
    for (const [key,spec] of Object.entries(entries)) {
      const name = prefix + key, type = spec[0], options = (spec[1] || {}) as DynamicOptions;
      if (type === 'COMFY_DYNAMICCOMBO_V3') {
        const choices = options.options || [];
        specs[name] = [choices.map(o=>o.key),options];
        if (isRequired) required.add(name);
        const selected = choices.find(o=>o.key===live[name]);
        if (selected) { add(selected.inputs?.required || {},name+'.',true); add(selected.inputs?.optional || {},name+'.',false); }
      } else if (type === 'COMFY_AUTOGROW_V3') {
        const template = options.template;
        const inner = Object.values(template?.input?.required || template?.input?.optional || {})[0];
        if (!template?.prefix || !inner) continue;
        for (let i=0;i<(template.max || 0);i++) {
          const child = `${name}.${template.prefix}${i}`;
          if (child in live || i<(template.min || 0)) specs[child]=inner;
          if (i<(template.min || 0) && isRequired) required.add(child);
        }
      } else { specs[name]=spec; if(isRequired) required.add(name); }
    }
  };
  add(schema.input?.required || {},'',true); add(schema.input?.optional || {},'',false);
  return { specs,required };
}
/** Validate against the connected server schema before sending /prompt. Server-side validation remains authoritative. */
export function validateWorkflow(graph: Record<string,unknown>, objectInfo: unknown): string[] {
  const info = (objectInfo || {}) as ObjectInfo, workflow = graph as Workflow, errors: string[] = [];
  for (const [id,node] of Object.entries(workflow)) {
    if (!node || !node.class_type || !node.inputs) { errors.push(`Nodo ${id}: formato API no válido.`); continue; }
    const schema = info[node.class_type];
    if (!schema) { errors.push(`Nodo no disponible: ${node.class_type}`); continue; }
    const {specs,required}=expandedInputs(schema,node.inputs);
    for (const name of required) if (!(name in node.inputs)) errors.push(`${node.class_type}: falta ${name}`);
    for (const [name,value] of Object.entries(node.inputs)) {
      const spec = specs[name];
      if (!spec) { errors.push(`${node.class_type}: entrada desconocida ${name}`); continue; }
      const expected = spec[0], constraints=(spec[1] || {}) as DynamicOptions;
      const link = Array.isArray(value) && value.length===2 && typeof value[0]==='string' && Number.isInteger(value[1]);
      if (link) {
        const source = workflow[value[0] as string];
        if (!source) errors.push(`${node.class_type}.${name}: enlace a nodo inexistente.`);
        else {
          const outputs = info[source.class_type]?.output;
          const index=value[1] as number;
          if (outputs && (index<0 || index>=outputs.length)) errors.push(`${node.class_type}.${name}: índice de salida no válido.`);
          else if (outputs && typeof expected==='string' && expected!==outputs[index] && expected!=='*') errors.push(`${node.class_type}.${name}: salida ${String(outputs[index])} incompatible con ${expected}.`);
        }
        continue;
      }
      if (Array.isArray(expected) && !expected.includes(value)) errors.push(`${node.class_type}.${name}: valor no disponible (${String(value)}).`);
      if (expected==='INT' && !Number.isInteger(value)) errors.push(`${node.class_type}.${name}: se esperaba un entero.`);
      if (expected==='FLOAT' && (typeof value!=='number' || !Number.isFinite(value))) errors.push(`${node.class_type}.${name}: se esperaba un número finito.`);
      if (expected==='STRING' && typeof value!=='string') errors.push(`${node.class_type}.${name}: se esperaba texto.`);
      if (expected==='BOOLEAN' && typeof value!=='boolean') errors.push(`${node.class_type}.${name}: se esperaba un booleano.`);
      if (typeof value==='number' && ((constraints.min!==undefined && value<constraints.min) || (constraints.max!==undefined && value>constraints.max))) errors.push(`${node.class_type}.${name}: valor fuera de los límites del nodo.`);
    }
  }
  const visited=new Set<string>(), active=new Set<string>();
  const visit=(id: string): boolean => {
    if(active.has(id)) return true;
    if(visited.has(id)||!workflow[id]?.inputs) return false;
    active.add(id);
    for(const value of Object.values(workflow[id].inputs)) if(Array.isArray(value)&&value.length===2&&typeof value[0]==='string'&&typeof value[1]==='number'&&visit(value[0]))return true;
    active.delete(id);visited.add(id);return false;
  };
  if(Object.keys(workflow).some(visit))errors.push('El flujo contiene un ciclo de dependencias.');
  return errors;
}
