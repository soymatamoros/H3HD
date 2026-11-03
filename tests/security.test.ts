import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existingChild, fileName, localBackendUrl, readableError, safeChild } from '../core/security.js';
import { sha256 } from '../core/downloads.js';

let fixture: string, root: string;
before(async () => { fixture=await mkdtemp(path.join(tmpdir(),'studio-security-'));root=path.join(fixture,'data');await mkdir(root); });
after(async () => { await rm(fixture,{recursive:true,force:true}); });

test('backend requests are restricted to literal loopback HTTP origins',()=>{
  assert.equal(localBackendUrl('http://127.0.0.1:8188'),'http://127.0.0.1:8188');
  assert.equal(localBackendUrl('http://[::1]:8188/'),'http://[::1]:8188');
  for(const url of ['https://127.0.0.1:8188','http://localhost:8188','http://192.168.0.1:8188',
    'http://127.0.0.1.example.com','http://user:password@127.0.0.1:8188','http://127.0.0.1:8188/prompt',
    'http://127.0.0.1:8188/?x=1','http://127.0.0.1:8188/#unsafe','file:///etc/passwd']) {
    assert.throws(()=>localBackendUrl(url),url);
  }
});

test('relative assets cannot escape through traversal, drive paths or separators',()=>{
  assert.equal(safeChild(root,'outputs/project/file.png'),path.join(root,'outputs','project','file.png'));
  for(const name of ['../secret','outputs/../../secret','/etc/passwd','C:/Windows/system.ini','C:\\Windows\\system.ini',
    '\\\\server\\share','outputs\\..\\secret','file:stream','.', '..', '', 'bad\0name']) assert.throws(()=>safeChild(root,name),name);
});

test('real filesystem resolution rejects an escaping symlink while allowing internal files',async()=>{
  await mkdir(path.join(root,'outputs'));await writeFile(path.join(root,'outputs','valid.png'),'bytes');
  const outside=path.join(fixture,'outside');await mkdir(outside);await writeFile(path.join(outside,'secret'),'private');
  // A directory junction also works on Windows without the file-symlink privilege.
  await symlink(outside,path.join(root,'outputs','escape'),'junction');
  assert.equal(await existingChild(root,'outputs/valid.png'),path.join(root,'outputs','valid.png'));
  await assert.rejects(existingChild(root,'outputs/escape/secret'),/fuera/);
});

test('portable filenames reject Windows devices, normalized collisions and separators',()=>{
  assert.equal(fileName('minimax_h3_vae.safetensors'),'minimax_h3_vae.safetensors');
  for(const name of ['../file','a/b','a\\b','a:stream','.','..','CON','nul.txt','COM1.safetensors','LPT9.bin','trailing.','trailing ']) {
    assert.throws(()=>fileName(name),name);
  }
});

test('integrity helper hashes actual bytes and errors do not silently lower quality',async()=>{
  const file=path.join(root,'hash.bin');await writeFile(file,'abc');
  assert.equal(await sha256(file),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.match(readableError(new Error('CUDA out of memory')),/no se ha reducido la calidad/);
});
