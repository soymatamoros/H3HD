import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflow, frameCount, nativeCanvas, referenceMapping, requiredModels, capabilities, validateWorkflow, H3_MODELS } from '../core/workflows.js';
import type { GenerationRequest } from '../core/types.js';
const base: GenerationRequest = { mode:'text-video', prompt:'A bird flies across the lake; natural water sound.', negative:'', width:1344, height:768, seed:42, steps:25, cfg:1, quality:'maximum', checkpoint:'', duration:5 };
test('H3 duration grid preserves actual native timing, not nominal seconds',()=>{ assert.equal(frameCount(5),124); assert.equal(frameCount(15),362); assert.equal(frameCount(10),243); assert.throws(()=>frameCount(16)); });
test('H3 FL2VA graph uses official base res_multistep/simple sampling and synchronized latent',()=>{
 const graph=buildWorkflow(base); assert.equal(graph['1'].inputs.unet_name,H3_MODELS.fl2va); assert.equal(graph['8'].inputs.sampler_name,'res_multistep'); assert.equal(graph['9'].inputs.steps,25); assert.deepEqual(graph['11'].inputs.samples,graph['12'].inputs.samples); assert.equal(graph['13'].inputs.fps,24); assert.ok(!Object.values(graph).some(n=>n.class_type==='LoraLoaderModelOnly'));
});
test('incompatible modes/quality and oversized native resolution fail rather than silently downgrade',()=>{
 assert.throws(()=>buildWorkflow({...base,quality:'preview'}),/Turbo/); assert.throws(()=>buildWorkflow({...base,negative:'bad'}),/negativo/); assert.throws(()=>buildWorkflow({...base,width:2560,height:1440}),/nativo/); assert.throws(()=>buildWorkflow({...base,checkpoint:H3_MODELS.ref2va}),/FL2VA/);
});
test('keyframes are optional for text generation and required in image mode',()=>{
 assert.throws(()=>buildWorkflow({...base,mode:'image-video'})); const graph=buildWorkflow({...base,mode:'image-video',inputImage:'first.png',lastImage:'last.png'} as GenerationRequest); assert.deepEqual(graph['5'].inputs.first_frame,['20',0]);assert.deepEqual(graph['5'].inputs.last_frame,['21',0]);
});
test('reference indexing numbers video soundtrack before standalone audio and uses zero-based API keys',()=>{
 const refs=[{kind:'audio' as const,filename:'voice.wav',role:'Voice'}, {kind:'video' as const,filename:'motion.mp4',audioFilename:'sound.wav',role:'Motion'}, {kind:'image' as const,filename:'face.png',role:'Identity'}];
 const mapping=referenceMapping(refs); assert.equal(mapping[0].tag,'<Picture 1>');assert.equal(mapping[1].audioTag,'<Audio 1>');assert.equal(mapping[2].tag,'<Audio 2>');assert.equal(mapping[0].input,'ref_images.ref_image_0');
 const graph=buildWorkflow({...base,mode:'reference-video',references:refs} as GenerationRequest);assert.equal(graph['1'].inputs.unet_name,H3_MODELS.ref2va);assert.ok(graph['5'].inputs['ref_video_audios.ref_video_audio_0']);assert.match(String(graph['5'].inputs.prompt),/<Audio 2>: Voice/);
 assert.throws(()=>referenceMapping(Array.from({length:10},()=>({kind:'image',filename:'x.png',role:''}))));
});
test('continuation anchors a real temporal guide rather than concatenating video',()=>{
 assert.throws(()=>buildWorkflow({...base,mode:'extend-video'})); const graph=buildWorkflow({...base,mode:'extend-video',guideVideo:'clip24.mp4',guideAudio:'clip.wav'} as GenerationRequest); assert.equal(graph['35'].class_type,'MiniMaxH3AddGuide'); assert.equal(graph['32'].inputs.batch_index,-22); assert.equal(graph['34'].inputs.start_index,-22/24); assert.deepEqual(graph['6'].inputs.conditioning,['35',0]);
});
test('SDXL uses separate checkpoint and native image workflow with image-to-image encoding',()=>{
 const req={...base,mode:'image' as const,width:1024,height:1024,cfg:7};const graph=buildWorkflow(req);assert.equal(graph['1'].class_type,'CheckpointLoaderSimple');assert.equal(graph['7'].class_type,'SaveImage');assert.deepEqual(requiredModels(req),['sd_xl_base_1.0.safetensors']);const img=buildWorkflow({...req,inputImage:'ref.png',denoise:0.5});assert.equal(img['4'].class_type,'VAEEncode');assert.equal(img['5'].inputs.denoise,0.5);
});
test('node availability alone is not sufficient to enable generation',()=>{
 assert.ok(capabilities({}).every(c=>!c.supported)); const graph=buildWorkflow(base);const info=Object.fromEntries(Object.values(graph).map(n=>[n.class_type,{input:{required:{}}}]));assert.equal(capabilities(info).find(c=>c.id==='text-video')?.supported,false);
});
test('schema validator catches missing nodes, model enums, and dangling output links',()=>{
 assert.match(validateWorkflow({'1':{class_type:'Unknown',inputs:{}}},{}).join(),/no disponible/);
 const info={Loader:{input:{required:{name:[['approved.safetensors'],{}]}},output:['MODEL']},Save:{input:{required:{model:['MODEL',{}]}},output:[]}};
 const errors=validateWorkflow({'1':{class_type:'Loader',inputs:{name:'wrong.safetensors'}},'2':{class_type:'Save',inputs:{model:['1',2]}}},info);assert.equal(errors.length,2);
});
test('resource names reject traversal and absolute paths',()=>{assert.throws(()=>buildWorkflow({...base,mode:'image-video',inputImage:'../private.png'}));assert.equal(nativeCanvas('9:16').height,1344);});

test('all five API graphs validate against schemas extracted from pinned official Python source (not GPU execution)', async()=>{
 const {readFile}=await import('node:fs/promises');
 const schema=JSON.parse(await readFile(new URL('./fixtures/comfy-source-schema.json',import.meta.url),'utf8'));
 const variants: GenerationRequest[]=[base,{...base,mode:'image-video',inputImage:'first.png',lastImage:'last.png'},{...base,mode:'reference-video',references:[{kind:'image',filename:'face.png',role:'identity'},{kind:'video',filename:'motion.mp4',audioFilename:'sound.wav',role:'motion'},{kind:'audio',filename:'voice.wav',role:'voice'}]},{...base,mode:'extend-video',guideVideo:'clip24.mp4',guideAudio:'clip.wav'},{...base,mode:'image',width:1024,height:1024,cfg:7,checkpoint:'sd_xl_base_1.0.safetensors',inputImage:'ref.png'}];
 for(const req of variants)assert.deepEqual(validateWorkflow(buildWorkflow(req),schema),[],req.mode);
 assert.ok(capabilities(schema).every(c=>c.supported));
 const graph=buildWorkflow(base);delete graph['14'].inputs['format.codec'];assert.match(validateWorkflow(graph,schema).join(),/falta format.codec/);
});
test('schema validation enforces autogrow limits, typed links, numeric bounds and acyclic execution', async()=>{
 const {readFile}=await import('node:fs/promises');const schema=JSON.parse(await readFile(new URL('./fixtures/comfy-source-schema.json',import.meta.url),'utf8'));
 const graph=buildWorkflow({...base,mode:'reference-video',references:[{kind:'image',filename:'face.png',role:'identity'}]});
 graph['5'].inputs['ref_images.ref_image_9']=['20',0];graph['5'].inputs['ref_audios.ref_audio_0']=['20',0];graph['9'].inputs.steps=-1;graph['6'].inputs.model=['6',0];
 const errors=validateWorkflow(graph,schema).join('\n');assert.match(errors,/entrada desconocida ref_images.ref_image_9/);assert.match(errors,/IMAGE incompatible con AUDIO/);assert.match(errors,/fuera de los límites/);assert.match(errors,/ciclo/);
});
test('every H3 mode preserves decoded native audio as separate FLAC before lossy delivery muxing',()=>{
 for (const req of [base,{...base,mode:'image-video' as const,inputImage:'first.png'},{...base,mode:'reference-video' as const,references:[{kind:'image' as const,filename:'face.png',role:'identity'}]},{...base,mode:'extend-video' as const,guideVideo:'clip24.mp4'}]) {
  const graph=buildWorkflow(req);assert.equal(graph['15'].class_type,'SaveAudioAdvanced');assert.equal(graph['15'].inputs.format,'flac');assert.deepEqual(graph['15'].inputs.audio,['12',0]);assert.deepEqual(graph['13'].inputs.audio,['12',0]);
 }
});
