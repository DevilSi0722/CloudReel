import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {playerPopoverPosition} from '../src/player-layout.ts';

test('wide-screen speed menu stays next to its button above the controls', () => {
  const anchor = {x:1710,y:1300,width:36,height:100};
  const panel = {width:250,height:440}, result = playerPopoverPosition(anchor,panel,{width:2560,height:1440});
  assert.equal(result.left + panel.width / 2, anchor.x + anchor.width / 2);
  assert.equal(result.top + panel.height, anchor.y - 10);
});
test('popover follows its own anchor, stays onscreen and limits long episode lists', () => {
  const viewport = {width:980,height:600};
  const left = playerPopoverPosition({x:10,y:480,width:36,height:100},{width:310,height:900},viewport);
  assert.equal(left.left,16); assert.equal(left.top,16); assert.equal(left.maxHeight,454);
  const right = playerPopoverPosition({x:950,y:480,width:36,height:100},{width:250,height:200},viewport);
  assert.equal(right.left + 250, 964);
  const help = playerPopoverPosition({x:200,y:20,width:36,height:58},{width:390,height:300},viewport,'below');
  assert.equal(help.top,88);
});
test('Windows overlay never activates, never blurs the entire window and keeps video mouse input', {skip:process.platform !== 'win32',timeout:20000}, async () => {
  const root = fileURLToPath(new URL('../',import.meta.url)), directory = await fs.mkdtemp(path.join(os.tmpdir(),'cloudreel-overlay-'));
  try {
    const executable = createRequire(import.meta.url)('electron');
    const result = await new Promise((resolve,reject)=>{
      const child = spawn(executable,[path.join(root,'tests/fixtures/player-overlay-window.mjs')],{cwd:root,windowsHide:true,env:{...process.env,CLOUDREEL_TEST_DIRECTORY:directory}});
      let output = ''; child.stdout.on('data',chunk=>output+=chunk); child.stderr.on('data',chunk=>output+=chunk);
      const timeout = setTimeout(()=>{child.kill();reject(new Error('Hidden overlay check timed out'));},15000);
      child.on('error',reject); child.on('exit',code=>{clearTimeout(timeout);resolve({code,output});});
    });
    assert.equal(result.code,0,result.output); assert.match(result.output,/"noWindowBackdrop":true/);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cloudreel-overlay-'));
    await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});

test('native minimize/restore preserves video bounds and keeps both renderers responsive', {skip:process.platform !== 'win32',timeout:20000}, async () => {
  const root=fileURLToPath(new URL('../',import.meta.url)),directory=await fs.mkdtemp(path.join(os.tmpdir(),'cloudreel-restore-'));
  try {
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'tests/fixtures/player-restore-window.mjs')],{cwd:root,windowsHide:true,env:{...process.env,CLOUDREEL_TEST_DIRECTORY:directory}});
      let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
      const timer=setTimeout(()=>{child.kill();reject(new Error('Hidden restore regression timed out'));},15000);
      child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolve({code,output});});
    });
    assert.equal(result.code,0,result.output);assert.match(result.output,/"mainAndControlsResponsive":true/);
  }finally{
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('cloudreel-restore-'));
    await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
