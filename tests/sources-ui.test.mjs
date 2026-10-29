import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
test('hidden folder picker mounts lazily, preserves cursors and ignores stale directory replies',{skip:process.platform!=='win32'||!await fs.access(path.join(root,'dist/index.html')).then(()=>true,()=>false),timeout:30000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cloudreel-sources-'));
  try {
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'tests/fixtures/sources-ui-window.mjs')],{cwd:root,windowsHide:true,env:{...process.env,CLOUDREEL_TEST_DIRECTORY:directory}});
      let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
      const timer=setTimeout(()=>{child.kill();reject(new Error('Hidden source UI timed out'));},25000);
      child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve({code,output});});
    });assert.equal(result.code,0,result.output);assert.match(result.output,/"lazyMounts":true/);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('cloudreel-sources-'));
    await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
