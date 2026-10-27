import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('real Chromium media shares session proxy, scoped cookies, Range, refresh and cancellation',{skip:process.platform!=='win32',timeout:25000},async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),directory=await fs.mkdtemp(path.join(os.tmpdir(),'cloudreel-media-'));
  try{
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'tests/fixtures/session-media-electron.mjs')],{cwd:root,windowsHide:true,env:{...process.env,CLOUDREEL_TEST_DIRECTORY:directory}});
      let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
      const timer=setTimeout(()=>{child.kill();reject(new Error('Hidden media regression timed out: '+output));},20000);
      child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolve({code,output});});
    });assert.equal(result.code,0,result.output);assert.match(result.output,/"sessionProxyUsed":true/);
  }finally{
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('cloudreel-media-'));
    await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
