import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DownloadManager, resolveModel, sha256 } from '../core/downloads.js';
import type { ModelEntry } from '../core/types.js';

// Network responses are explicitly MOCKED. Streaming, resume files, cancellation,
// SHA-256 verification and final installation use the actual local filesystem.
const bytes=Buffer.from('Verified model bytes: this is a test fixture, not neural model weights.');
const hash=createHash('sha256').update(bytes).digest('hex');
const revision='0123456789abcdef0123456789abcdef01234567';
const entry:ModelEntry={id:'fixture-model',name:'MOCKED fixture',purpose:'Downloader test only',source:'https://huggingface.co/Comfy-Org/MiniMax-H3',
  url:'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/fixture.safetensors',filename:'fixture.safetensors',category:'diffusion_models',
  bytes:bytes.length,sha256:hash,license:'Test fixture, not model weights',licenseUrl:'https://example.invalid/test-license',architecture:'test-only',optional:true};
const originalFetch=globalThis.fetch;
let directory='';
before(async()=>{directory=await mkdtemp(path.join(tmpdir(),'studio-download-mocked-'));});
after(async()=>{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});});
async function mocked<T>(implementation:typeof fetch,operation:()=>Promise<T>):Promise<T>{
  globalThis.fetch=implementation;try{return await operation();}finally{globalThis.fetch=originalFetch;}
}
function response(body:BodyInit|null,status=200,headers:HeadersInit={},url='https://huggingface.co/model/resolve/'+revision+'/fixture.safetensors'){
  const r=new Response(body,{status,headers});Object.defineProperty(r,'url',{value:url});return r;
}
const file=(root:string)=>path.join(root,entry.category,entry.filename);
const partial=(root:string)=>file(root)+'.'+hash.slice(0,12)+'.partial';
async function prepare(root:string){await mkdir(path.join(root,entry.category),{recursive:true});}

test('MOCKED HF metadata pins immutable revision, trusted LFS SHA-256 and size',async()=>{
  let requested='';
  await mocked(async(url)=>{
    requested=String(url);
    return response(JSON.stringify({sha:revision,siblings:[{rfilename:'fixture.safetensors',lfs:{sha256:hash,size:bytes.length}}]}));
  },async()=>{
    const resolved=await resolveModel({...entry,sha256:'',bytes:0});
    assert.equal(requested,'https://huggingface.co/api/models/Comfy-Org/MiniMax-H3/revision/main?blobs=true');
    assert.equal(resolved.url,`https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/${revision}/fixture.safetensors`);
    assert.equal(resolved.sha256,hash);assert.equal(resolved.bytes,bytes.length);assert.equal(resolved.license,entry.license);
  });
});

test('MOCKED metadata rejects missing hash, absent model, bad revision and untrusted origin',async()=>{
  for(const metadata of [
    {sha:revision,siblings:[{rfilename:entry.filename,lfs:{size:bytes.length}}]},
    {sha:revision,siblings:[]},
    {sha:'main',siblings:[{rfilename:entry.filename,lfs:{sha256:hash,size:bytes.length}}]},
  ])await mocked(async()=>response(JSON.stringify(metadata)),()=>assert.rejects(resolveModel(entry),/SHA-256|verificable/));
  let called=false;
  await mocked(async()=>{called=true;return response('');},async()=>{
    await assert.rejects(resolveModel({...entry,url:'https://untrusted.example/model.safetensors'}),/no autorizado/);assert.equal(called,false);
  });
});

test('MOCKED model response streams to disk and installs only after matching SHA-256',async()=>{
  const root=path.join(directory,'success'),manager=new DownloadManager(root);let requests=0;
  await mocked(async()=>{requests++;return response(bytes);},async()=>{await manager.install(entry);});
  assert.equal(requests,1);assert.equal(manager.downloads[0].status,'completed');assert.equal(manager.downloads[0].received,bytes.length);
  assert.deepEqual(await readFile(file(root)),bytes);assert.equal(await sha256(file(root)),hash);
  assert.deepEqual(await readdir(path.dirname(file(root))),[entry.filename]);
});

test('MOCKED corrupt download is removed and never promoted to installed model',async()=>{
  const root=path.join(directory,'corrupt'),manager=new DownloadManager(root),corrupt=Buffer.alloc(bytes.length,0x78);
  await mocked(async()=>response(corrupt),async()=>{await manager.install(entry);});
  assert.equal(manager.downloads[0].status,'failed');assert.match(manager.downloads[0].error!,/SHA-256/);
  await assert.rejects(stat(file(root)),{code:'ENOENT'});await assert.rejects(stat(partial(root)),{code:'ENOENT'});
});

test('MOCKED resume sends exact Range and validates the completed file hash',async()=>{
  const root=path.join(directory,'resume'),manager=new DownloadManager(root);await prepare(root);await writeFile(partial(root),bytes.subarray(0,13));
  let range:string|null=null;
  await mocked(async(_url,init)=>{range=new Headers(init?.headers).get('range');return response(bytes.subarray(13),206,{'content-range':`bytes 13-${bytes.length-1}/${bytes.length}`});},async()=>{await manager.install(entry);});
  assert.equal(range,'bytes=13-');assert.equal(manager.downloads[0].status,'completed');assert.deepEqual(await readFile(file(root)),bytes);
});

test('MOCKED server ignoring Range restarts the partial instead of appending duplicate bytes',async()=>{
  const root=path.join(directory,'range-ignored'),manager=new DownloadManager(root);await prepare(root);await writeFile(partial(root),bytes.subarray(0,9));
  await mocked(async()=>response(bytes,200),async()=>{await manager.install(entry);});
  assert.equal(manager.downloads[0].status,'completed');assert.deepEqual(await readFile(file(root)),bytes);
});

test('existing different models are never overwritten and matching files are reused offline',async()=>{
  const root=path.join(directory,'existing'),manager=new DownloadManager(root);await prepare(root);await writeFile(file(root),'user-owned model');let requested=false;
  await mocked(async()=>{requested=true;throw new Error('No network expected');},async()=>{
    await assert.rejects(manager.install(entry),/no se sobrescribirá/i);assert.equal(await readFile(file(root),'utf8'),'user-owned model');
    await writeFile(file(root),bytes);await manager.install(entry);assert.equal(requested,false);assert.deepEqual(await readFile(file(root)),bytes);
  });
});

test('unverified hashes and unknown download origins are rejected before streaming',async()=>{
  const manager=new DownloadManager(path.join(directory,'untrusted'));let called=false;
  await mocked(async()=>{called=true;return response(bytes);},async()=>{
    await assert.rejects(manager.install({...entry,sha256:''}),/metadatos/);
    await assert.rejects(manager.install({...entry,url:'https://evil.example/model'}),/no autorizada/);
    assert.equal(called,false);
  });
});

test('MOCKED cancellation keeps a resumable partial and never installs incomplete weights',async()=>{
  const root=path.join(directory,'cancel'),manager=new DownloadManager(root);
  let timer:ReturnType<typeof setTimeout>|undefined;
  await mocked(async()=>response(new ReadableStream<Uint8Array>({
    start(controller){controller.enqueue(bytes.subarray(0,16));timer=setTimeout(()=>{controller.enqueue(bytes.subarray(16));controller.close();},2000);},
    cancel(){if(timer)clearTimeout(timer);}
  })),async()=>{
    const operation=manager.install(entry);
    for(let i=0;i<100;i++){
      if(await stat(partial(root)).then(s=>s.size>=16).catch(()=>false))break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal((await stat(partial(root))).size,16);
    await assert.rejects(manager.install(entry),/ya está activa/);
    manager.cancel(entry.id);await operation;
    assert.equal(manager.downloads[0].status,'cancelled');assert.deepEqual(await readFile(partial(root)),bytes.subarray(0,16));
    await assert.rejects(stat(file(root)),{code:'ENOENT'});
  });
  if(timer)clearTimeout(timer);
});

test('MOCKED destination created during download remains untouched',async()=>{
  const root=path.join(directory,'race'),manager=new DownloadManager(root);
  await mocked(async()=>{await writeFile(file(root),'created while downloading');return response(bytes);},async()=>{await manager.install(entry);});
  assert.equal(manager.downloads[0].status,'failed');assert.equal(await readFile(file(root),'utf8'),'created while downloading');
});
