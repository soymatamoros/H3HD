import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { ComfyClient, historyAssets } from '../core/comfy.js';
import { Studio } from '../core/studio.js';
import type { GenerationRequest } from '../core/types.js';

// Explicitly MOCKED inference integration: real local HTTP/WebSocket transport and real
// output retrieval/persistence, but no neural model or GPU execution happens here.
const schema = {
  CheckpointLoaderSimple:{input:{required:{ckpt_name:[['sd_xl_base_1.0.safetensors']]}},output:['MODEL','CLIP','VAE']},
  CLIPTextEncode:{input:{required:{text:['STRING'],clip:['CLIP']}},output:['CONDITIONING']},
  EmptyLatentImage:{input:{required:{width:['INT'],height:['INT'],batch_size:['INT']}},output:['LATENT']},
  KSampler:{input:{required:{model:['MODEL'],seed:['INT'],steps:['INT'],cfg:['FLOAT'],sampler_name:[['dpmpp_2m']],scheduler:[['karras']],positive:['CONDITIONING'],negative:['CONDITIONING'],latent_image:['LATENT'],denoise:['FLOAT']}},output:['LATENT']},
  VAEDecode:{input:{required:{samples:['LATENT'],vae:['VAE']}},output:['IMAGE']},
  SaveImage:{input:{required:{images:['IMAGE'],filename_prefix:['STRING']}},output:[]},
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX3cAAAAASUVORK5CYII=','base64');
const http = createServer((req,res)=>{void route(req,res).catch(error=>{res.writeHead(500);res.end(String(error));});});
const websocket = new WebSocketServer({server:http,path:'/ws'});
const histories = new Map<string,unknown>();
const responses = new Map<string,{status:number;bytes:Buffer}>();
const calls:{method:string;route:string;body:any}[]=[];
let origin='', directory='', next=1, rejected=false, running:string[]=[];

async function route(req:IncomingMessage,res:ServerResponse) {
  const url=new URL(req.url!,'http://127.0.0.1');let body:any;
  if(req.method==='POST'){let content='';for await(const chunk of req)content+=chunk.toString();body=JSON.parse(content||'{}');}
  calls.push({method:req.method!,route:url.pathname,body});
  let data:unknown={};
  if(url.pathname==='/system_stats')data={system:{comfyui_version:'mocked-test'},devices:[]};
  else if(url.pathname==='/object_info')data=schema;
  else if(url.pathname==='/queue'&&req.method==='GET')data={queue_running:running.map(id=>[0,id,{},{}]),queue_pending:[]};
  else if(url.pathname==='/prompt')data=rejected?{prompt_id:'rejected',node_errors:{'1':{errors:['Missing checkpoint']}}}:{prompt_id:'mock-'+next++,node_errors:{}};
  else if(url.pathname.startsWith('/history/')){const id=decodeURIComponent(url.pathname.slice('/history/'.length));data=histories.has(id)?{[id]:histories.get(id)}:{};}
  else if(url.pathname==='/view'){
    const r=responses.get(url.searchParams.get('filename')!)??{status:404,bytes:Buffer.from('missing')};res.writeHead(r.status,{'content-type':'image/png'});res.end(r.bytes);return;
  }
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));
}
function emit(type:string,data:unknown){for(const socket of websocket.clients)socket.send(JSON.stringify({type,data}));}
before(async()=>{
  directory=await mkdtemp(path.join(tmpdir(),'studio-comfy-mocked-'));http.listen(0,'127.0.0.1');await once(http,'listening');
  origin='http://127.0.0.1:'+(http.address() as {port:number}).port;
  responses.set('master.png',{status:200,bytes:png});
});
after(async()=>{
  for(const socket of websocket.clients)socket.terminate();
  await new Promise<void>(resolve=>websocket.close(()=>resolve()));
  await new Promise<void>(resolve=>http.close(()=>resolve()));
  await rm(directory,{recursive:true,force:true});
});

test('MOCKED Comfy transport validates submission and receives real WebSocket progress',async()=>{
  const client=new ComfyClient(origin);
  try{
    assert.equal((await client.health()).system.comfyui_version,'mocked-test');
    await client.connect();
    const id=await client.submit({'1':{class_type:'SaveImage',inputs:{}}});assert.match(id,/mock-/);
    const posted=calls.filter(c=>c.route==='/prompt').at(-1)!;assert.equal(posted.body.client_id,client.clientId);assert.ok(posted.body.prompt['1']);
    const event=once(client,'event');emit('progress',{prompt_id:id,value:5,max:25});
    assert.deepEqual((await event)[0],{type:'progress',data:{prompt_id:id,value:5,max:25}});
    assert.deepEqual(await client.history(id),{});
    const bytes=await client.output({filename:'master.png',subfolder:'test folder',type:'output'});assert.deepEqual(Buffer.from(bytes),png);
  }finally{client.close();}
});

test('MOCKED Comfy errors, empty outputs and node validation errors are not success',async()=>{
  const client=new ComfyClient(origin);rejected=true;
  try{await assert.rejects(client.submit({}),/Flujo rechazado/);}finally{rejected=false;}
  await assert.rejects(client.output({filename:'missing.png',subfolder:'',type:'output'}),/recuperar/);
  responses.set('empty.png',{status:200,bytes:Buffer.alloc(0)});
  await assert.rejects(client.output({filename:'empty.png',subfolder:'',type:'output'}),/vacío/);
});

test('MOCKED cancellation removes pending prompt or interrupts active execution',async()=>{
  const client=new ComfyClient(origin);running=[];await client.cancel('pending-id');
  assert.deepEqual(calls.filter(c=>c.method==='POST'&&c.route==='/queue').at(-1)?.body,{delete:['pending-id']});
  running=['running-id'];await client.cancel('running-id');
  assert.deepEqual(calls.filter(c=>c.method==='POST'&&c.route==='/interrupt').at(-1)?.body,{});running=[];
});

test('history extraction retains real outputs, deduplicates and excludes temporary previews',()=>{
  const assets=historyAssets({outputs:{a:{images:[{filename:'master.png',subfolder:'',type:'output'},{filename:'preview.png',type:'temp'}]},b:{videos:[{filename:'master.mp4',type:'output'}],gifs:[{filename:'master.mp4',type:'output'}]}}});
  assert.deepEqual(assets,[{filename:'master.png',subfolder:'',type:'output'},{filename:'master.mp4',subfolder:'',type:'output'}]);
});

const generation:GenerationRequest={mode:'image',prompt:'Transport fixture, no GPU inference',negative:'',width:1024,height:1024,seed:123,steps:25,cfg:7,quality:'maximum',checkpoint:'sd_xl_base_1.0.safetensors'};
async function studioFixture(name:string){
  const root=path.join(directory,name),studio=new Studio(root,root);await studio.store.open();studio.store.state.settings.comfyUrl=origin;await studio.store.save();await studio.open();assert.equal(studio.connected,true);return studio;
}
async function poll(studio:Studio){await (studio as unknown as {poll():Promise<void>}).poll();}

test('MOCKED Studio completion requires completed history and retrieved local output bytes',async()=>{
  const studio=await studioFixture('success');
  try{
    const job=await studio.generate(generation);assert.equal(job.status,'queued');assert.equal(job.outputs.length,0);
    await poll(studio);assert.equal(job.status,'queued');
    const progress=once(studio,'update');emit('progress',{prompt_id:job.promptId,value:10,max:25});await progress;
    assert.equal(job.progress,0.4);assert.notEqual(job.status,'completed');
    histories.set(job.promptId!,{status:{completed:true,status_str:'success'},outputs:{'7':{images:[{filename:'master.png',subfolder:'',type:'output'}]}}});
    await poll(studio);assert.equal(job.status,'completed');assert.equal(job.progress,1);assert.equal(job.outputs.length,1);
    assert.deepEqual(await readFile(path.join(studio.root,job.outputs[0].local!)),png);
    assert.equal(studio.store.project(job.projectId).request.seed,123);assert.ok(studio.store.project(job.projectId).outputs[0].local);
  }finally{studio.close();}
});

test('missing media dependencies block submission before a costly generation is queued',async()=>{
  const studio=await studioFixture('missing-tools');
  try{
    studio.store.state.settings.ffprobePath=path.join(directory,'missing-ffprobe');
    const submissions=calls.filter(c=>c.route==='/prompt').length;
    await assert.rejects(studio.generate(generation),/FFmpeg y FFprobe/);
    assert.equal(calls.filter(c=>c.route==='/prompt').length,submissions);
    assert.equal(studio.store.state.projects.length,0);
  }finally{studio.close();}
});

test('MOCKED audiovisual completion accepts separate decoded native audio masters alongside AV media',async()=>{
  const studio=await studioFixture('native-audio-master');
  try{
    const av=path.join(directory,'fixture-av.mp4'),audio=path.join(directory,'fixture-audio.flac');
    execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=96x64:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=32000','-t','0.3','-c:v','libx264','-threads','1','-c:a','aac',av]);
    execFileSync('ffmpeg',['-nostdin','-v','error','-i',av,'-vn','-c:a','flac',audio]);
    responses.set('fixture-av.mp4',{status:200,bytes:await readFile(av)});responses.set('fixture-audio.flac',{status:200,bytes:await readFile(audio)});
    const job=await studio.generate(generation);
    // Exercise audiovisual OUTPUT validation using real synthetic A/V. Inference remains mocked.
    studio.store.project(job.projectId).request.mode='text-video';
    histories.set(job.promptId!,{status:{completed:true,status_str:'success'},outputs:{video:{videos:[{filename:'fixture-av.mp4',type:'output'}]},audio:{audio:[{filename:'fixture-audio.flac',type:'output'}]}}});
    await poll(studio);assert.equal(job.status,'completed');assert.equal(job.outputs.length,2);
    assert.equal(job.outputs.find(a=>a.filename.endsWith('.flac'))?.metadata?.audioSampleRate,'32000');
  }finally{studio.close();}
});

test('MOCKED completed history with missing output fails instead of fabricating a result',async()=>{
  const studio=await studioFixture('missing-output');
  try{
    const job=await studio.generate(generation);
    histories.set(job.promptId!,{status:{completed:true,status_str:'success'},outputs:{'7':{images:[{filename:'missing.png',subfolder:'',type:'output'}]}}});
    await poll(studio);assert.equal(job.status,'failed');assert.equal(job.outputs.length,0);assert.ok(job.error);
  }finally{studio.close();}
});

test('MOCKED nonempty corrupt output is not accepted as verified media',async()=>{
  const studio=await studioFixture('corrupt-output');responses.set('corrupt.png',{status:200,bytes:Buffer.from('Not a media file')});
  try{
    const job=await studio.generate(generation);
    histories.set(job.promptId!,{status:{completed:true,status_str:'success'},outputs:{'7':{images:[{filename:'corrupt.png',subfolder:'',type:'output'}]}}});
    await poll(studio);assert.equal(job.status,'failed');assert.equal(job.outputs.length,0);assert.match(job.error!,/verificar/);
  }finally{studio.close();}
});

test('MOCKED partial retrieval failure reaches a terminal state without retry-overwrite loops',async()=>{
  const studio=await studioFixture('partial-output');
  try{
    const job=await studio.generate(generation);
    histories.set(job.promptId!,{status:{completed:true,status_str:'success'},outputs:{'7':{images:[{filename:'master.png',subfolder:'',type:'output'},{filename:'missing.png',subfolder:'',type:'output'}]}}});
    await poll(studio);assert.equal(job.status,'failed');assert.equal(job.outputs.length,0);
    const downloads=calls.filter(c=>c.route==='/view').length;await poll(studio);
    assert.equal(calls.filter(c=>c.route==='/view').length,downloads);assert.equal(job.status,'failed');
  }finally{studio.close();}
});

test('MOCKED completion without assets fails and CUDA error retains selected quality',async()=>{
  const studio=await studioFixture('errors');
  try{
    const empty=await studio.generate(generation);histories.set(empty.promptId!,{status:{completed:true,status_str:'success'},outputs:{}});
    await poll(studio);assert.equal(empty.status,'failed');assert.match(empty.error!,/sin archivos/);
    const job=await studio.generate(generation),error=once(studio,'update');emit('execution_error',{prompt_id:job.promptId,exception_message:'CUDA out of memory'});await error;
    assert.equal(job.status,'failed');assert.match(job.error!,/no se ha reducido la calidad/);assert.equal(studio.store.project(job.projectId).request.quality,'maximum');
  }finally{studio.close();}
});

test('MOCKED Studio cancellation persists explicit cancelled state',async()=>{
  const studio=await studioFixture('cancel');
  try{const job=await studio.generate(generation);await studio.cancel(job.id);assert.equal(job.status,'cancelled');const state=JSON.parse(await readFile(studio.store.file,'utf8'));assert.equal(state.jobs[0].status,'cancelled');}
  finally{studio.close();}
});
