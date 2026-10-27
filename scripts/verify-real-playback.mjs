// Manual acceptance only: snapshot this app's Baidu session, never a browser
// profile, and remove the snapshot even when playback verification fails.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const packaged=process.argv.includes('--packaged');
const packageRoot=packaged ? path.join(root,'release/win-unpacked/resources/app.asar') : '';
if(packaged) await fs.access(packageRoot);
const source=process.env.CLOUDREEL_SOURCE_PROFILE || path.join(process.env.APPDATA,'CloudReel');
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cloudreel-real-playback-'));
try {
  const partition=path.join('Partitions','cloudreel-baidu-web');
  await fs.mkdir(path.join(directory,partition),{recursive:true});
  // Chromium's encrypted cookie database needs this app's Local State key.
  await fs.copyFile(path.join(source,'Local State'),path.join(directory,'Local State'));
  await fs.cp(path.join(source,partition,'Network'),path.join(directory,partition,'Network'),{recursive:true});
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'tests/fixtures/real-baidu-playback.mjs')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,CLOUDREEL_TEST_DIRECTORY:directory,CLOUDREEL_SOURCE_PROFILE:source,CLOUDREEL_PACKAGE_ROOT:packageRoot}});
    // The fixture emits only its deliberately sanitized summary. Never echo
    // Chromium diagnostics, request data, cookies, or provider error payloads.
    child.stdout.on('data',chunk=>{for(const line of chunk.toString().split('\n')) if(line.startsWith('REAL_PLAYBACK_RESULT ')) process.stdout.write(line+'\n');});
    child.stderr.resume();
    const timer=setTimeout(()=>{child.kill();resolve(1);},240000);
    child.once('error',reject);child.once('exit',result=>{clearTimeout(timer);resolve(result ?? 1);});
  });
  if(code!==0) throw new Error('Real-source acceptance did not pass; no live profile was modified.');
} finally {
  if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cloudreel-real-playback-')) throw new Error('Unexpected verification directory');
  await fs.rm(directory,{recursive:true,force:true,maxRetries:12,retryDelay:250});
}
