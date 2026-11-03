import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../core/store.js';
import type { GenerationRequest, Project } from '../core/types.js';

let directory: string;
before(async()=>{directory=await mkdtemp(path.join(tmpdir(),'studio-store-'));});
after(async()=>{await rm(directory,{recursive:true,force:true});});
const request:GenerationRequest={mode:'image',prompt:'A test scene',negative:'',width:1024,height:1024,seed:42,steps:25,cfg:7,quality:'maximum',checkpoint:'sd_xl_base_1.0.safetensors'};
function project(id='project-1'):Project{return {id,name:'Conservar proyecto',favorite:true,createdAt:'2026-11-02T00:00:00Z',updatedAt:'2026-11-02T00:00:00Z',request:{...request},workflow:{'1':{class_type:'SaveImage',inputs:{}}},outputs:[{filename:'master.png',subfolder:'',type:'output',local:'outputs/master.png'}]};}

test('project metadata, seed, workflow and outputs survive reopening',async()=>{
  const root=path.join(directory,'persist'),store=new Store(root);await store.open();
  store.state.projects.push(project());await store.save();
  const reopened=new Store(root);await reopened.open();
  assert.deepEqual(reopened.project('project-1'),project());
  assert.throws(()=>reopened.project('missing'),/no encontrado/);
});

test('interrupted queued/running jobs become explicit failures without resubmission',async()=>{
  const root=path.join(directory,'recovery'),store=new Store(root);await store.open();store.state.projects.push(project());
  for(const status of ['queued','running','completed'] as const)store.state.jobs.push({id:status,projectId:'project-1',promptId:'remote-'+status,status,progress:0.3,stage:'sampling',outputs:[],createdAt:'2026-11-02T00:00:00Z'});
  await store.save();const reopened=new Store(root);await reopened.open();
  for(const id of ['queued','running']){const job=reopened.state.jobs.find(j=>j.id===id)!;assert.equal(job.status,'failed');assert.match(job.error!,/interrumpida/);assert.equal(job.promptId,'remote-'+id);}
  assert.equal(reopened.state.jobs.find(j=>j.id==='completed')?.status,'completed');
  const state=JSON.parse(await readFile(reopened.file,'utf8'));assert.equal(state.jobs[0].status,'failed');
});

test('serialized atomic saves preserve the final version and valid JSON backup',async()=>{
  const store=new Store(path.join(directory,'atomic'));await store.open();store.state.projects.push(project());
  const saves:Promise<void>[]=[];
  for(let i=0;i<8;i++){store.state.projects[0].name='Version '+i;saves.push(store.save());}
  await Promise.all(saves);
  const current=JSON.parse(await readFile(store.file,'utf8')),backup=JSON.parse(await readFile(store.file+'.bak','utf8'));
  assert.equal(current.projects[0].name,'Version 7');assert.equal(backup.projects[0].name,'Version 6');
});

test('valid backup restores a corrupted primary and remains a valid recovery copy',async()=>{
  const store=new Store(path.join(directory,'backup'));await store.open();store.state.projects.push(project());await store.save();await store.save();
  await writeFile(store.file,'{ interrupted write');
  const recovered=new Store(store.root);await recovered.open();assert.equal(recovered.project('project-1').request.seed,42);
  assert.equal(JSON.parse(await readFile(recovered.file,'utf8')).projects[0].id,'project-1');
  assert.equal(JSON.parse(await readFile(recovered.file+'.bak','utf8')).projects[0].id,'project-1');
});

test('invalid job entries trigger backup recovery instead of an uncontrolled crash',async()=>{
  const store=new Store(path.join(directory,'shape'));await store.open();store.state.projects.push(project());await store.save();await store.save();
  await writeFile(store.file,JSON.stringify({...store.state,jobs:[null]}));
  const recovered=new Store(store.root);await recovered.open();assert.equal(recovered.state.jobs.length,0);assert.equal(recovered.project('project-1').name,'Conservar proyecto');
});

test('unrecoverable state reports a repair action and preserves both files',async()=>{
  const store=new Store(path.join(directory,'bad'));await store.open();await store.save();
  await writeFile(store.file,'broken primary');await writeFile(store.file+'.bak','broken backup');
  await assert.rejects(new Store(store.root).open(),/recuperar|Conserva/);
  assert.equal(await readFile(store.file,'utf8'),'broken primary');assert.equal(await readFile(store.file+'.bak','utf8'),'broken backup');
});

test('internal executable and model paths relocate with the portable data directory',async()=>{
  const oldRoot=path.join(directory,'before-move'),store=new Store(oldRoot);await store.open();
  store.state.settings.comfyPath=path.join(oldRoot,'runtime','ComfyUI');
  store.state.settings.pythonPath=path.join(oldRoot,'runtime','python_embeded','python.exe');
  store.state.settings.modelPaths=[path.join(oldRoot,'models'),path.join(directory,'external-models')];
  await store.save();
  const raw=JSON.parse(await readFile(store.file,'utf8'));
  assert.equal(raw.settings.comfyPath,'./runtime/ComfyUI');
  const movedRoot=path.join(directory,'after-move');
  const {rename}=await import('node:fs/promises');await rename(oldRoot,movedRoot);
  const moved=new Store(movedRoot);await moved.open();
  assert.equal(moved.state.settings.comfyPath,path.join(movedRoot,'runtime','ComfyUI'));
  assert.equal(moved.state.settings.pythonPath,path.join(movedRoot,'runtime','python_embeded','python.exe'));
  assert.equal(moved.state.settings.modelPaths[0],path.join(movedRoot,'models'));
  assert.equal(moved.state.settings.modelPaths[1],path.join(directory,'external-models'));
});
