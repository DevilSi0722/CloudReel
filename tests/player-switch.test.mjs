import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PlayerService} from '../electron/services/player.mjs';
import {memoryStore} from './helpers.mjs';
const episode=n=>({id:'ep'+n,kind:'episode',source:'baidu',title:'Test Show',seriesTitle:'Test Show',season:1,episode:n,path:'/Test/Show.S01E0'+n+'.mkv',filename:'Show.S01E0'+n+'.mkv',addedAt:'2026-10-26'});
function setup() {
 const store=memoryStore();store.data.items=[1,2,3].map(episode);store.data.settings.autoNext=true;
 const notifications=[],sync=[],commands=[],closed=[],child=new EventEmitter();child.exitCode=null;
 const player=new PlayerService(store,{}, {},{eligible:()=>false,start:async item=>sync.push(['start',item.id]),checkpoint:async(item,event)=>sync.push([event,item.id,item.progress?.position])},{resolveMpv:()=> 'unused',notify:()=>notifications.push(player.status()?.itemId ?? null),videoHost:{hide:()=>assert.fail('must keep video host alive'),prepare:()=>assert.fail('must reuse native video host')},spawnPlayer:()=>assert.fail('must reuse mpv process')});
 const transport={child,requests:new Map()},socket={destroyed:false,write:line=>{
   const {command,request_id}=JSON.parse(line);commands.push(command);
   if(command[0]==='loadfile') queueMicrotask(()=>{
     const pending=transport.requests.get(request_id);clearTimeout(pending.timer);transport.requests.delete(request_id);pending.resolve();
     player.event(transport.current,{event:'property-change',name:'time-pos',data:400});
     player.event(transport.current,{event:'end-file',reason:'stop'});
     player.event(transport.current,{event:'start-file'});
   });
 }};
 const old=player.session={item:store.data.items[0],child,transport,socket,pipe:'same-pipe',relay:{close:()=>closed.push('old')},position:300,duration:1200,started:true,paused:false,volume:67,muted:true,tracks:[],speed:1,preferences:{},sequence:Promise.resolve(),lastSave:0};transport.current=old;
 player.subtitles.cleanup=async()=>{};
 player.prepareMedia=async item=>({media:'loopback-only-'+item.id,relay:{close:()=>closed.push(item.id)}});
 return{store,player,old,notifications,sync,commands,closed,child};
}
test('episode replacement keeps process, socket, host and player status, ignores stale file events and checkpoints old position',async()=>{
 const x=setup();await x.player.play('ep2');const s=x.player.session;
 assert.equal(s.child,x.child);assert.equal(s.socket,x.old.socket);assert.equal(s.pipe,'same-pipe');assert.ok(x.notifications.every(Boolean));
 assert.equal(s.item.id,'ep2');assert.equal(s.position,0);assert.equal(s.duration,0);assert.equal(s.volume,67);assert.equal(s.muted,true);assert.deepEqual(x.closed,['old']);
 x.player.event(s,{event:'file-loaded'});x.player.event(s,{event:'property-change',name:'duration',data:1000});x.player.event(s,{event:'property-change',name:'time-pos',data:2});await s.sequence;
 assert.deepEqual(x.sync,[['stop','ep1',300],['start','ep2']]);assert.equal(x.store.item('ep1').progress.position,300);assert.equal(x.store.item('ep2').progress.position,2);
 assert.deepEqual(x.commands.find(c=>c[0]==='loadfile').slice(2,4),['replace',-1]);
});
test('failed preparation leaves current playback, subtitle task, position and sync untouched',async()=>{
 const x=setup();x.player.prepareMedia=async()=>{throw new Error('HTTP 403');};
 await assert.rejects(x.player.play('ep2'),/403/);assert.equal(x.player.session,x.old);assert.equal(x.old.finishing,undefined);assert.equal(x.old.position,300);assert.equal(x.old.switching,null);assert.deepEqual(x.sync,[]);assert.deepEqual(x.closed,[]);
});
test('stop during preparation cannot resurrect a video or leak its prepared relay',async()=>{
 const x=setup();let ready;x.player.prepareMedia=()=>new Promise(resolve=>ready=resolve);
 const opening=x.player.play('ep2');await Promise.resolve();assert.equal(x.player.status().switching.itemId,'ep2');
 // Simulate user stop without exercising the existing child quit handshake.
 x.player.playAttempt++;x.player.session=null;ready({media:'private-loopback',relay:{close:()=>x.closed.push('unused')}});await opening;
 assert.equal(x.player.status(),null);assert.deepEqual(x.closed,['unused']);assert.deepEqual(x.commands,[]);assert.deepEqual(x.sync,[]);
});
test('prepared next episode is reused; semantic preferences and percent resume are passed to the new file',async()=>{
 const x=setup();x.store.data.playbackPreferences={'show:test show':{speed:1.5}};
 x.player.preferencesFor=()=>({speed:1.5,subtitleDelay:.5,subtitleSize:48,subtitleFont:'Microsoft YaHei'});
 x.player.resumeFor=async()=>({percent:35,source:'Trakt'});
 const prepared={media:'cached-loopback',relay:{close:()=>{}}};x.player.warm={itemId:'ep2',at:Date.now(),task:Promise.resolve(prepared)};x.player.prepareMedia=()=>assert.fail('must reuse prepared stream');
 await x.player.play('ep2');const options=x.commands.find(c=>c[0]==='loadfile')[4];assert.equal(options.start,'35%');assert.equal(options.speed,'1.5');assert.equal(options['sub-delay'],'0.5');assert.equal(options.sid,'auto');clearTimeout(x.player.session.loadTimer);
});
test('EOF auto next uses the same player and disabling automatic next discards prewarming',async()=>{
 const x=setup();x.player.event(x.old,{event:'end-file',reason:'eof'});await new Promise(resolve=>setTimeout(resolve,90));
 assert.equal(x.player.status().itemId,'ep2');assert.ok(x.notifications.every(Boolean));assert.equal(x.store.item('ep1').progress.percent,100);clearTimeout(x.player.session.loadTimer);
 x.player.warm={task:Promise.resolve({relay:{close:()=>x.closed.push('warm')}})};x.player.cancelNext();await Promise.resolve();assert.ok(x.closed.includes('warm'));assert.equal(x.player.upNext(x.player.session),null);
});
