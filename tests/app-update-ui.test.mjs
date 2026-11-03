import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
test('hidden app update UI checks, downloads, previews notes and defers installation during file operations',{skip:process.platform!=='win32',timeout:35000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cloudreel-update-ui-'));
  try{const result=await new Promise((resolve,reject)=>{const child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'tests/fixtures/app-update-ui-window.mjs')],{cwd:root,windowsHide:true,env:{...process.env,CLOUDREEL_TEST_DIRECTORY:directory}});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);const timer=setTimeout(()=>{child.kill();reject(Error('hidden update UI timeout'));},30000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolve({code,output});});});assert.equal(result.code,0,result.output);assert.match(result.output,/"passed":true/);}
  finally{assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('cloudreel-update-ui-'));await fs.rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:150});}
});
