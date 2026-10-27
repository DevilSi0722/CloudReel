import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {playbackDefaults, preferredTrack, describeTrack, validatePlayback} from '../electron/core/playback-preferences.mjs';
import {versionKey, episodeChoices, versionLabel} from '../electron/core/versions.mjs';
import {groupLibrary,identifyLibrary} from '../electron/core/identification.mjs';
import {matchSubtitles,subtitleLanguage} from '../electron/services/subtitles.mjs';
import {LibraryScanner} from '../electron/services/scanner.mjs';
import {PlayerService} from '../electron/services/player.mjs';
import {memoryStore} from './helpers.mjs';
const video=(id,episode=1)=>({id,kind:'episode',title:'Show',seriesTitle:'Show',season:1,episode,filename:`Show.S01E0${episode}.mkv`,path:`/Show/Show.S01E0${episode}.mkv`,source:'baidu',addedAt:'2026-10-24'});
test('track preference uses semantic language/title across episodes and prioritizes Simplified Chinese',()=>{
 const first={id:2,type:'sub',lang:'zh-Hans',title:'简体'},next=[{id:4,type:'sub',lang:'en',title:'English'},{id:6,type:'sub',lang:'zh-Hant',title:'繁体'},{id:8,type:'sub',lang:'zh-Hans',title:'简体'}];
 assert.equal(preferredTrack(next,'sub',describeTrack(first),'auto'),8);
 assert.equal(preferredTrack(next,'sub',null,'zh-Hans'),8);
 assert.equal(preferredTrack(next,'sub','no','zh-Hans'),'no');
 assert.equal(preferredTrack(next,'audio',null,'en'),null);
 assert.throws(()=>validatePlayback({subtitleSize:500}),/范围/);
});
test('sidecar matching handles language tags, numeric folders and rejects other shows/episodes',()=>{
 const item=video('v',2), files=['Show.S01E02.chs.ass','Show.S01E02.[eng].srt','Other.S01E02.chs.srt','Show.S01E03.chs.ass'].map(filename=>({filename,path:'/Show/'+filename}));
 assert.deepEqual(matchSubtitles(item,files).map(f=>f.filename),files.slice(0,2).map(f=>f.filename));
 const numeric={...video('n',2),filename:'2.mp4',path:'/剧集/第一季/2.mp4',title:'剧集'};
 assert.equal(matchSubtitles(numeric,[{filename:'2.chs.srt',path:'/剧集/第一季/2.chs.srt'}]).length,1);
 assert.equal(subtitleLanguage('show.chs.ass'),'zh-Hans');assert.equal(subtitleLanguage('show.cht.ass'),'zh-Hant');
});
test('multiple encodes group before scraping, preserve remake years, and episode counts stay unique',()=>{
 const films=identifyLibrary([{...video('a'),kind:'movie',filename:'Film.2020.1080p.mkv',path:'/Film.2020.1080p.mkv'},{...video('b'),kind:'movie',filename:'Film.2020.2160p.HDR.mkv',path:'/Film.2020.2160p.HDR.mkv'},{...video('c'),kind:'movie',filename:'Film.2024.1080p.mkv',path:'/Film.2024.1080p.mkv'}]);
 assert.deepEqual(groupLibrary(films).map(g=>g.itemIds.length).sort(),[1,2]);
 const entries=[video('a'),{...video('b'),versionPreferred:true},video('c',2)];
 assert.equal(groupLibrary(entries)[0].totalEpisodes,2);assert.deepEqual(episodeChoices(entries).map(i=>i.id),['b','c']);
 assert.equal(versionKey(entries[0]),versionKey(entries[1]));assert.equal(versionLabel({filename:'Lie.2160p.DV.HEVC.mkv'}),'格式待读取');assert.match(versionLabel({filename:'Film.1080p.SDR.mkv',technical:{width:3840,height:2160,dynamicRange:'Dolby Vision',codec:'hevc',verified:true}}),/4K.*Dolby Vision.*HEVC/);
});
test('per-series preferences persist without track IDs, temporary speed never replaces them, Up Next can be cancelled',()=>{
 const store=memoryStore();store.data.settings.autoNext=true;store.data.items=[video('one'),video('two',2),{...video('two-hdr',2),versionPreferred:true}];
 const player=new PlayerService(store,{}, {},{}, {resolveMpv(){}}),commands=[];
 const session=player.session={item:store.data.items[0],socket:{write:s=>commands.push(JSON.parse(s))},preferences:{...playbackDefaults},tracks:[{id:4,type:'sub',lang:'zh-Hans',title:'简体'}],duration:1200,position:1180,speed:1};
 player.control({speed:1.5,sid:4,subtitleDelay:.5,subtitleSize:48});
 player.control({speed:3},true);
 const nextPrefs=player.preferencesFor(store.data.items[1]);assert.equal(nextPrefs.speed,1.5);assert.equal(nextPrefs.subtitleDelay,.5);assert.equal(nextPrefs.sid.lang,'zh-Hans');assert.equal(nextPrefs.sid.id,undefined);
 assert.equal(player.upNext(session).itemId,'two-hdr');assert.equal(player.upNext(session).remaining,20);
 player.cancelNext();assert.equal(player.upNext(session),null);
});
test('incremental scan preserves metadata/progress, merges additions and safely retains a failed/cancelled root',async()=>{
 const store=memoryStore();let files=[{fs_id:1,path:'/Shows/Show.S01E01.mkv',server_filename:'Show.S01E01.mkv',size:100,isdir:0}],fail=false;
 const scanner=new LibraryScanner(store,{list:async()=>{if(fail)throw new Error('offline');return{files,hasMore:false};}}),root=scanner.add('baidu','/Shows');
 scanner.refresh();await scanner.active;
 const one=store.data.items[0];one.progress={position:50};one.catalog={source:'tmdb',id:'1',title:'Show'};one.identificationLocked=true;
 files=[{...files[0],size:200},{fs_id:2,path:'/Shows/Show.S01E02.mkv',server_filename:'Show.S01E02.mkv',size:100,isdir:0}];
 scanner.refresh();await scanner.active;assert.equal(scanner.state.added,1);assert.equal(scanner.state.changed,1);assert.equal(one.progress.position,50);assert.equal(one.catalog.id,'1');
 fail=true;scanner.refresh();await scanner.active;assert.ok(root.error);assert.equal(store.data.items.length,2);assert.ok(store.data.items.every(i=>!i.unavailable));
 fail=false;files=[];scanner.refresh();scanner.cancel();await scanner.active;assert.ok(store.data.items.every(i=>!i.unavailable));
 scanner.refresh();await scanner.active;assert.ok(store.data.items.every(i=>i.unavailable));assert.equal(one.progress.position,50);
});
test('local refresh scans new nested files while a missing root cannot empty the library',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cloudreel-scan-'));
 try {
  await fs.mkdir(path.join(directory,'Show'));await fs.writeFile(path.join(directory,'Show','1.mp4'),'video');
  const store=memoryStore(),scanner=new LibraryScanner(store,{});scanner.add('local',directory);scanner.refresh();await scanner.active;
  assert.equal(store.data.items[0].episode,1);await fs.writeFile(path.join(directory,'Show','2.mp4'),'video');scanner.refresh();await scanner.active;assert.equal(scanner.state.added,1);
  scanner.roots()[0].path=path.join(directory,'missing');scanner.refresh();await scanner.active;assert.equal(store.data.items.length,2);assert.ok(scanner.state.error);
 } finally {await fs.rm(directory,{recursive:true,force:true});}
});
