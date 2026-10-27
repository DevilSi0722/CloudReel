import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createStreamRelay } from './stream.mjs';
import { chooseResume } from '../core/media.mjs';
import { groupLibrary } from '../core/identification.mjs';
import { PlayerGestures } from '../core/player-gestures.mjs';
import { videoOutputArguments, videoPlaybackStatus } from '../core/player-video.mjs';
import {readMediaInfo} from '../core/media-info.mjs';
import {SubtitleService, isSubtitle} from './subtitles.mjs';
import {playbackDefaults, validatePlayback, preferredTrack, describeTrack} from '../core/playback-preferences.mjs';
import {playbackKey, versionKey, episodeChoices} from '../core/versions.mjs';
import { subtitlePosition } from '../core/player-subtitles.mjs';

export function discoverMpv(configured, resourceDirectory, projectDirectory) {
  const executable = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
  const candidates = [configured, path.join(resourceDirectory, 'mpv', executable), path.join(projectDirectory, '.runtime', 'mpv', executable),
    ...(process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, executable))];
  return candidates.find(candidate => candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

export class PlayerService {
  constructor(store, baidu, trakt, sync, { resolveMpv, notify = () => {}, videoHost, inputConfig, fullscreen = () => false, toggleFullscreen = () => {}, onAction = () => false, spawnPlayer = spawn }) {
    Object.assign(this, { store, baidu, trakt, sync, resolveMpv, notify, videoHost, inputConfig, fullscreen, toggleFullscreen, onAction, spawnPlayer }); this.session = null; this.opening = false; this.subtitles = new SubtitleService(baidu);
    this.gestures = new PlayerGestures({session: () => this.session, control: input => this.control(input, true), seek: value => this.seek(value), pause: () => this.togglePause(), notify});
  }
  status() { const session = this.session; return session ? { switching: session.switching ?? null, loadError: session.loadError ?? null, itemId: session.item.id, title: session.item.title, paused: session.paused, position: session.position, duration: session.duration, speed: session.speed, volume: session.volume, muted: session.muted, buffering: session.buffering, tracks: session.tracks, aid: session.aid || 'no', sid: session.sid || 'no', fullscreen: this.fullscreen(), embedded: Boolean(this.videoHost), ready: session.duration > 0, boosting: Boolean(session.boosting), hint: session.hint, subtitleStyle: {delay: session.preferences?.subtitleDelay ?? 0, size: session.preferences?.subtitleSize ?? 44, font: session.preferences?.subtitleFont ?? 'Microsoft YaHei'}, subtitlesLoading: Boolean(session.subtitlesLoading), upNext: this.upNext(session), seek: session.seek && {id: session.seek.id, target: session.seek.target, pending: session.seek.pending, error: session.seek.error}, video: videoPlaybackStatus(session) } : null; }
  async prepareMedia(item, {quiet = false, signal} = {}) {
    if (item.source !== 'baidu') {
      if (!fs.existsSync(item.path)) throw new Error('本地视频已移动或不存在。');
      return {media:item.path,relay:null};
    }
    let lastError='';
    const relay=await createStreamRelay(options=>this.baidu.streamUrl(item.fsId,{...options,path:item.path}), {
      ...(this.baidu.fetchMedia ? {fetcher:this.baidu.fetchMedia.bind(this.baidu)} : {}),
      onError:error=>{
        const message=error.code!==undefined || /^(百度|请|无效|媒体服务器)/.test(error.message) ? error.message : '百度媒体连接失败，请检查网络或稍后重试。';
        if(message!==lastError) {lastError=message;if(!quiet){this.store.log('网盘播放失败：'+message,'error');this.notify();}}
      }
    });
    try {
      const probe=await fetch(relay.url,{headers:{Range:'bytes=0-0'},signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)});
      await probe.body?.cancel();
      if(![200,206].includes(probe.status)) throw new Error(lastError || '百度原文件暂时无法读取（HTTP '+probe.status+'），请稍后重试。');
      return {media:relay.url,relay,activate:()=>{quiet=false;}};
    } catch(error) {
      relay.close();throw new Error(lastError || (error.message.startsWith('百度原文件') ? error.message : '百度媒体连接失败，请检查网络、系统代理或稍后重试。'));
    }
  }
  async resumeFor(item,fromBeginning) {
    if(fromBeginning) return null;
    const versions=this.store.data.items.filter(other=>versionKey(other)===versionKey(item));
    const local=versions.map(other=>other.progress).filter(Boolean).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt))[0];
    let remote=null;
    if(this.store.data.settings.autoSync && this.store.data.secrets.traktToken && item.catalog && !item.metadata?.ids?.trakt) {
      try {await this.trakt.resolveCatalog(item);} catch {this.store.log('未能自动关联 Trakt，本次仍保存本机进度。','warning');}
    }
    if(this.sync.eligible(item)) {
      await this.sync.flush();
      try {remote=await this.trakt.resume(item.metadata);} catch {this.store.log('未能读取 Trakt 进度，本次使用本机续播位置。','warning');}
      if(item.remoteProgress?.source==='history' && (!remote || Date.parse(item.remoteProgress.paused_at)>Date.parse(remote.paused_at))) remote=item.remoteProgress;
    }
    return chooseResume(local,remote);
  }
  async play(itemId, fromBeginning = false) {
    if(this.opening) throw new Error('正在准备影片，请稍候。');
    if(this.session?.loaded===false && !this.session.loadError) throw new Error('影片正在载入，请稍候再切换。');
    if(this.session?.item.id===itemId && !fromBeginning && !this.session.loadError && !this.session.eof) return this.status();
    this.opening=true;
    const attempt=this.playAttempt=(this.playAttempt??0)+1,controller=new AbortController();this.openController=controller;
    let prepared=null,adopted=false;
    const previous=this.session;
    try {
      const executable=this.resolveMpv();if(!executable) throw new Error('未找到 mpv，请运行 npm run setup:mpv，或在设置中选择 mpv.exe。');
      const item=this.store.item(itemId);if(item.unavailable) throw new Error('此版本暂时不可用，请刷新目录或选择其他版本。');
      if(previous) {previous.switching={itemId,title:item.episodeMetadata?.title || item.title};this.notify();}
      // Resolve the original file and remote resume position concurrently while
      // the current video and its controls remain alive.
      const mediaTask=(async()=>{
        if(this.warm?.itemId===itemId && Date.now()-this.warm.at<90000) {
          const warm=this.warm;this.warm=null;
          const abort=()=>warm.controller?.abort();controller.signal.addEventListener('abort',abort,{once:true});
          try {prepared=await warm.task;} finally {controller.signal.removeEventListener('abort',abort);}
          if(prepared) return prepared;
        }
        this.clearWarm();return prepared=await this.prepareMedia(item,{signal:controller.signal});
      })();
      let resume;
      try {[prepared,resume]=await Promise.all([mediaTask,this.resumeFor(item,fromBeginning)]);}
      catch(error) {controller.abort();await mediaTask.catch(()=>{});throw error;}
      if(attempt!==this.playAttempt) return this.status();
      prepared.activate?.();
      const preferences=this.preferencesFor(item),key=versionKey(item);
      for(const other of this.store.data.items.filter(other=>versionKey(other)===key)) other.versionPreferred=other.id===item.id;
      const reusable=previous && this.session===previous && previous.socket && !previous.socket.destroyed && previous.child.exitCode===null && !previous.finishing;
      const session={item,relay:prepared.relay,position:0,duration:0,loaded:false,paused:false,speed:preferences.speed,preferences,volume:previous?.volume??100,muted:previous?.muted??false,buffering:true,tracks:[],aid:'auto',sid:'auto',ready:false,started:false,socket:null,finishing:null,lastSave:0,sequence:Promise.resolve(),eof:false,intentional:false,acceptProperties:!reusable};
      this.gestures.cancel();
      if(reusable) {
        clearTimeout(previous.seekTimer);
        const transport=previous.transport;
        session.child=previous.child;session.pipe=previous.pipe;session.socket=previous.socket;session.transport=transport;
        session.sequence=this.retireFile(previous,false);
        // Keep the old relay until mpv confirms start-file for its replacement.
        session.previousRelay=previous.relay;previous.relay=null;
        transport.current=session;this.session=session;adopted=true;this.notify();
        const options={start:resume ? resume.percent!==undefined ? resume.percent+'%' : String(resume.seconds) : '0',speed:String(preferences.speed),pause:'no',aid:'auto',sid:'auto','sub-delay':String(preferences.subtitleDelay),'sub-font-size':String(preferences.subtitleSize),'sub-font':preferences.subtitleFont};
        try {await this.request(session,['loadfile',prepared.media,'replace',-1,options]);}
        catch(error) {session.loadError='切换未完成，请重新选择剧集。';session.buffering=false;this.notify();throw error;}
      } else {
        if(this.session) await this.stop(true);
        if(attempt!==this.playAttempt) return this.status();
        const pipe=process.platform==='win32' ? '\\\\.\\pipe\\cloudreel-'+crypto.randomUUID() : '/tmp/cloudreel-'+crypto.randomUUID()+'.sock';
        const hostId=this.videoHost?.prepare();
        const args=['--no-config','--no-resume-playback','--save-position-on-quit=no','--force-window=yes','--idle=yes','--keep-open=no','--input-ipc-server='+pipe,'--title=云映 · '+item.title,
          ...(hostId ? ['--wid='+hostId,'--osc=no','--osd-level=0','--input-default-bindings=no','--input-vo-keyboard=yes','--input-conf='+this.inputConfig,'--script='+path.join(path.dirname(this.inputConfig),'player-shortcuts.lua'),'--input-doubleclick-time=300','--cursor-autohide=3000'] : []),
          ...videoOutputArguments(),'--speed='+preferences.speed,'--sub-delay='+preferences.subtitleDelay,'--sub-font-size='+preferences.subtitleSize,'--sub-font='+preferences.subtitleFont,'--sub-codepage=auto','--sub-auto=no','--cache=yes','--demuxer-max-bytes=128MiB','--hwdec=auto-safe',...(resume?['--start='+(resume.percent!==undefined?resume.percent+'%':resume.seconds)]:[]),'--',prepared.media];
        const child=this.spawnPlayer(executable,args,{windowsHide:true,stdio:'ignore',shell:false});
        Object.assign(session,{child,pipe,transport:{child,current:session,requests:new Map()}});this.session=session;adopted=true;this.notify();
        child.once('error',()=>{this.store.log('mpv 启动失败，请检查播放器路径。','error');void this.finish(session.transport.current);});
        child.once('exit',code=>{if(code)this.store.log('播放器退出（'+code+'），请检查媒体地址、格式和网盘权限。','warning');void this.finish(session.transport.current);});
        try {await this.connect(session);} catch(error) {child.kill();await this.finish(session);throw error;}
      }
      this.armLoadTimeout(session);
      this.store.log('开始播放：'+item.title+(resume?' · 从 '+resume.source+' 续播':''));this.notify();return this.status();
    } catch(error) {
      if(attempt!==this.playAttempt) return this.status();
      throw error;
    } finally {
      if(!adopted) prepared?.relay?.close();
      if(previous && this.session===previous) {previous.switching=null;this.notify();}
      if(this.openController===controller) this.openController=null;
      this.opening=false;
    }
  }
  armLoadTimeout(session) {
    if(session.loaded) return;
    session.loadTimer=setTimeout(()=>{if(this.session===session && !session.loaded){session.loadError='影片载入超时，可重新选择剧集或退出后重试。';session.buffering=false;this.notify();}},60000);session.loadTimer.unref();
  }
  request(session,command) {
    return new Promise((resolve,reject)=>{
      const id=this.commandSequence=(this.commandSequence??200000)+1,requests=session.transport.requests;
      const timer=setTimeout(()=>{requests.delete(id);reject(new Error('播放器响应超时，请重试。'));},8000);timer.unref();
      requests.set(id,{resolve,reject,timer});session.socket.write(JSON.stringify({command,request_id:id})+'\n');
    });
  }
  retireFile(session,closeRelay=true) {
    if(session.retirement) return session.retirement;
    clearTimeout(session.seekTimer);clearTimeout(session.loadTimer);this.saveProgress(session);
    session.retired=true;session.finishing=Promise.resolve();
    const snapshot=structuredClone(session.item);
    session.retirement=(async()=>{
      if(closeRelay) session.relay?.close();
      await this.subtitles.cleanup(session);await session.sequence;
      if(session.started) await this.sync.checkpoint(snapshot,'stop');
    })().catch(()=>{this.store.log('播放进度已保存，观看同步将在稍后重试。','warning');});
    return session.retirement;
  }
  clearWarm() {const warm=this.warm;this.warm=null;if(warm) {warm.controller?.abort();void warm.task.then(prepared=>prepared?.relay?.close()).catch(()=>{});}}
  warmNext(session) {
    if(!this.store.data.settings.autoNext) {this.clearWarm();return;}
    if(this.opening || session.nextCancelled || session.eof || !this.store.data.settings.autoNext || session.duration<60 || session.duration-session.position>45) return;
    const item=this.nextItem(session.item);if(!item || this.warm?.itemId===item.id || session.warmedId===item.id) return;
    this.clearWarm();session.warmedId=item.id;
    const warm={itemId:item.id,at:Date.now(),task:null,controller:new AbortController()};
    warm.task=this.prepareMedia(item,{quiet:true,signal:warm.controller.signal}).catch(()=>null);this.warm=warm;
  }
  async connect(session) {
    const deadline = Date.now() + 12000;
    while (this.session === session && !session.finishing) {
      try {
        const socket = await new Promise((resolve, reject) => {
          const candidate = net.createConnection(session.pipe);
          const error = () => { candidate.destroy(); reject(new Error('播放器通信连接尚未建立。')); };
          candidate.once('error', error);
          candidate.once('connect', () => { candidate.off('error', error); resolve(candidate); });
        });
        session.socket = socket; socket.on('error', () => {}); let buffer = '';
        socket.on('data', data => {
          buffer += data.toString(); const messages = buffer.split('\n'); buffer = messages.pop();
          for (const message of messages) { try {
            const event=JSON.parse(message),pending=session.transport.requests.get(event.request_id);
            if(pending) {clearTimeout(pending.timer);session.transport.requests.delete(event.request_id);if(event.error==='success')pending.resolve(event.data);else pending.reject(new Error('播放器未能载入影片，请重试。'));}
            this.event(session.transport.current,event);
          } catch { /* Ignore unrelated malformed IPC messages. */ } }
        });
        ['time-pos', 'duration', 'pause', 'speed', 'volume', 'mute', 'paused-for-cache', 'track-list', 'aid', 'sid', 'video-params', 'video-target-params', 'hwdec-current', 'current-vo', 'sub-delay', 'container-fps'].forEach((property, index) => socket.write(JSON.stringify({ command: ['observe_property', index + 1, property] }) + '\n'));
        session.ready = true;
        if (session.subtitleLayout) this.subtitleLayout(session.subtitleLayout);
        return;
      } catch {
        if (Date.now() > deadline) throw new Error('连接 mpv 超时，请确认使用支持 JSON IPC 的 mpv 版本。');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    throw new Error('播放器在建立通信前退出。');
  }
  enqueue(session, action) { session.sequence = session.sequence.then(action).catch(() => { this.store.log('播放状态处理失败，本机进度会继续保存。', 'warning'); }); }
  event(session, event) {
    if (this.session !== session || session.finishing) return;
    if(event.event==='start-file') {
      session.acceptProperties=true;session.previousRelay?.close();session.previousRelay=null;
    }
    if(event.event==='file-loaded' && session.acceptProperties!==false) {
      session.loaded=true;session.loadError=null;clearTimeout(session.loadTimer);this.notify();
    }
    if (session.seek?.pending) {
      if (event.request_id === session.seek.nativeId) {
        if (event.error !== 'success') {this.finishSeek(session, '播放器未能完成跳转，已恢复实际位置。'); return;}
        session.seek.accepted = true;
      }
      if (event.event === 'seek') session.seek.begun = true;
      if (event.event === 'playback-restart' && session.seek.begun) session.seek.restarted = true;
      if (event.event !== 'property-change') this.settleSeek(session);
    }
    if (event.event === 'client-message' && event.args?.[0] === 'cloudreel') {
      void this.shortcut(event.args[1]).catch(() => {});
      return;
    }
    // Replacement end-file and queued properties still belong to the old file
    // until mpv announces start-file for the new one on this same IPC stream.
    if(session.acceptProperties===false) return;
    if(event.event==='end-file') {
      if(event.reason==='eof' && session.duration>0) {
        session.position=session.duration;session.eof=true;this.saveProgress(session);this.notify();
        setTimeout(()=>{
          if(this.session!==session || this.opening || session.finishing) return;
          const next=!session.nextCancelled && this.store.data.settings.autoNext && this.nextItem(session.item);
          if(next) void this.play(next.id).catch(error=>{if(this.session===session){session.loadError=error.message;session.buffering=false;}this.store.log(error.message,'error');this.notify();});
          else void this.stop();
        },50);
      } else if(event.reason==='error') {
        session.loadError='影片无法载入，请重试或选择其他剧集。';session.buffering=false;clearTimeout(session.loadTimer);this.notify();
      }
    }
    if (event.event !== 'property-change') return;
    const videoProperty = {'video-params': 'videoParams', 'video-target-params': 'videoTarget', 'hwdec-current': 'hwdec', 'current-vo': 'vo'}[event.name];
    if (videoProperty) { session[videoProperty] = event.data ?? null; this.recordTechnical(session); this.notify(); return; }
    if (event.data === undefined || event.data === null) return;
    if (event.name === 'time-pos' && Number.isFinite(Number(event.data)) && Number(event.data) >= 0) {session.position = Number(event.data); this.settleSeek(session);}
    if (event.name === 'duration') session.duration = Number(event.data);
    if (event.name === 'container-fps') {session.fps=Number(event.data);this.recordTechnical(session);}
    if (event.name === 'speed') session.speed = Number(event.data);
    if (event.name === 'sub-delay') {session.preferences ??= {...playbackDefaults};session.preferences.subtitleDelay = Number(event.data);}
    if (event.name === 'volume') session.volume = Number(event.data);
    if (event.name === 'mute') session.muted = Boolean(event.data);
    if (event.name === 'paused-for-cache') session.buffering = Boolean(event.data);
    if (event.name === 'track-list') {
      session.rawTracks=event.data;
      session.tracks = event.data.filter(track => ['audio', 'sub'].includes(track.type)).map(track => ({ id: track.id, type: track.type, title: track.title, lang: track.lang, codec: track.codec, selected: track.selected, external: Boolean(track.external), channels: track['audio-channels'] }));
      session.videoCodec = event.data.find(track=>track.type==='video' && track.selected)?.codec;
      this.applyTrackPreferences(session);
      if (!session.subtitlesStarted && session.tracks.length) {session.subtitlesStarted=true;session.subtitlesLoading=true;
        session.subtitleTask=(async()=>{const saved=(session.item.externalSubtitles || []).filter(file=>typeof file==='string' && isSubtitle(file) && fs.existsSync(file)).map(file=>({path:file,filename:path.basename(file),source:'local'}));await this.subtitles.attach(this,session,saved);const files=await this.subtitles.discover(session.item);await this.subtitles.attach(this,session,files);})().catch(()=>{if(this.session===session && !session.finishing) {this.store.log('自动字幕暂时不可用，可在字幕菜单中手动添加。','warning');}}).finally(()=>{session.subtitlesLoading=false;if(session.finishing) void this.subtitles.cleanup(session);this.notify();});
      }
      session.dolbyVisionProfile = event.data.find(track => track.type === 'video' && track.selected)?.['dolby-vision-profile'];this.recordTechnical(session);
    }
    if (event.name === 'aid' || event.name === 'sid') session[event.name] = event.data;
    if(session.importedSubtitleName) {
      const imported=session.tracks.find(track=>track.type==='sub' && track.id===session.sid && track.title===session.importedSubtitleName);
      if(imported) {this.remember(session,{sid:describeTrack(imported)});session.importedSubtitleName=null;}
    }
    if (event.name === 'pause' && session.paused !== Boolean(event.data)) {
      session.paused = Boolean(event.data); this.saveProgress(session);
      if (session.started) {
        const paused = session.paused, snapshot = structuredClone(session.item);
        this.enqueue(session, () => paused ? this.sync.checkpoint(snapshot, 'pause') : this.sync.start(snapshot));
      }
    }
    if (session.position > 0 && session.duration > 0 && !session.started) {
      session.loaded=true;clearTimeout(session.loadTimer);
      session.started = true; this.saveProgress(session);
      this.enqueue(session, () => this.sync.start(session.item));
    }
    if (Date.now() - session.lastSave > 5000) this.saveProgress(session);
    this.warmNext(session);
    this.notify();
  }
  saveProgress(session) {
    if (session.seek?.pending || !(session.duration > 0) || !(session.position > 0)) return;
    session.item.progress = { position: session.position, duration: session.duration, percent: Math.min(100, session.position / session.duration * 100), updatedAt: new Date().toISOString() };
    session.lastSave = Date.now(); this.store.persist();
  }
  async finish(session) {
    if (session.finishing) return session.finishing;
    session.finishing = (async () => {
      this.gestures.cancel();
      clearTimeout(session.seekTimer);clearTimeout(session.loadTimer);
      this.saveProgress(session); session.socket?.destroy(); session.relay?.close();session.previousRelay?.close();await this.subtitles.cleanup(session);
      for(const pending of session.transport?.requests.values() ?? []) {clearTimeout(pending.timer);pending.reject(new Error('播放已结束。'));}session.transport?.requests.clear();
      if (this.session === session) {this.clearWarm(); this.session = null; this.videoHost?.hide(); }
      // Snapshot this session before a new playback can alter the library object.
      const snapshot = structuredClone(session.item);
      await session.sequence;
      if (session.started) await this.sync.checkpoint(snapshot, 'stop');
      this.notify();
      if (!this.session && !this.opening && this.fullscreen()) this.toggleFullscreen();
    })(); return session.finishing;
  }
  async stop(preserveOpening=false) {
    if(!preserveOpening) {this.playAttempt=(this.playAttempt??0)+1;this.openController?.abort();}
    this.clearWarm();
    const session = this.session; if (!session) return;
    this.gestures.cancel();
    session.intentional = true;
    session.socket?.write(JSON.stringify({ command: ['quit'] }) + '\n');
    const timeout = setTimeout(() => session.child.kill(), 1500);
    await new Promise(resolve => { if (session.child.exitCode !== null) resolve(); else session.child.once('exit', resolve); });
    clearTimeout(timeout); await this.finish(session);
  }
  togglePause() { if (this.session?.socket) this.session.socket.write(JSON.stringify({ command: ['cycle', 'pause'] }) + '\n'); }
  command(command) { if (!this.session?.socket) throw new Error('播放器尚未就绪。'); this.session.socket.write(JSON.stringify({ command }) + '\n'); }
  subtitleLayout(layout) {
    const session = this.session;
    // A late animation/resize report from the previous episode must never
    // reposition the replacement episode's subtitles.
    if (!session || session.finishing || layout?.itemId !== session.item.id) return;
    const position = subtitlePosition(layout);
    session.subtitleLayout = layout;
    if (!session.socket || session.subtitlePosition === position) return;
    this.command(['set_property', 'sub-pos', position]);
    session.subtitlePosition = position;
  }
  settleSeek(session) {
    const seek = session.seek;
    if (seek?.pending && seek.accepted && seek.restarted && Math.abs(session.position - seek.target) <= Math.max(1.5, session.speed || 1)) this.finishSeek(session);
  }
  finishSeek(session, error) {
    if (!session.seek) return;
    clearTimeout(session.seekTimer); session.seek.pending = false; session.seek.error = error;
    this.notify();
  }
  seek(input) {
    const position = typeof input === 'number' ? input : input?.seconds, session = this.session;
    if (!Number.isFinite(position)) throw new Error('无效的播放位置。');
    if (!session?.socket || session.finishing) throw new Error('播放器尚未就绪。');
    if (typeof input === 'object' && input.itemId !== session.item.id) throw new Error('影片已切换，请在当前影片上重试。');
    const target = Math.max(0, Math.min(session.duration > 0 ? session.duration : position, position));
    const nativeId = this.seekSequence = (this.seekSequence ?? 100000) + 1;
    const id = typeof input?.requestId === 'string' && input.requestId.length <= 80 ? input.requestId : String(nativeId);
    clearTimeout(session.seekTimer);
    session.seek = {id, target, nativeId, pending: true, accepted: false, begun: false, restarted: false};
    session.socket.write(JSON.stringify({command: ['seek', target, 'absolute+exact'], request_id: nativeId}) + '\n');
    session.seekTimer = setTimeout(() => {if (this.session === session && session.seek?.id === id && session.seek.pending) this.finishSeek(session, '跳转等待超时，已恢复实际位置，可重试。');}, 20000);
    session.seekTimer.unref(); this.notify(); return {id, target};
  }
  control(input, temporary = false) {
    if (!input || typeof input !== 'object') throw new Error('无效的播放设置。');
    const session = this.session; if(!session?.socket || session.finishing) throw new Error('播放器尚未就绪。');
    const save = {};
    if (input.speed !== undefined) { if (!Number.isFinite(input.speed) || input.speed < .25 || input.speed > 4) throw new Error('倍速范围为 0.25–4。'); if (!temporary) this.gestures.rightUp(true); this.command(['set_property', 'speed', input.speed]); if(!temporary) save.speed=input.speed; }
    if (input.volume !== undefined) { if (!Number.isFinite(input.volume)) throw new Error('无效音量。'); const value = Math.min(100, Math.max(0, input.volume)); this.command(['set_property', 'volume', value]); this.session.volume = value; }
    if (input.muted !== undefined) {this.command(['set_property', 'mute', Boolean(input.muted)]); this.session.muted = Boolean(input.muted);}
    for (const [key, type] of [['aid', 'audio'], ['sid', 'sub']]) if (input[key] !== undefined) {
      if (input[key] !== 'no' && !this.session?.tracks.some(track => track.type === type && track.id === input[key])) throw new Error('音轨或字幕不存在。');
      this.command(['set_property', key, input[key]]);
      session.trackTouched ??= {};session.trackTouched[key]=true;
      save[key]=input[key]==='no' ? 'no' : describeTrack(session.tracks.find(t=>t.type===type && t.id===input[key]));
    }
    const style=validatePlayback(input);
    for(const [key,property] of [['subtitleDelay','sub-delay'],['subtitleSize','sub-font-size'],['subtitleFont','sub-font']]) if(style[key]!==undefined) {this.command(['set_property',property,style[key]]);save[key]=style[key];}
    if(!temporary && Object.keys(save).length) this.remember(session,save);
    this.notify();
  }
  preferencesFor(item) {
    const defaults={...playbackDefaults,...this.store.data.playbackDefaults};
    return {...defaults,...(defaults.rememberPlayback ? this.store.data.playbackPreferences?.[playbackKey(item)] : {})};
  }
  remember(session,values) {
    session.preferences ??= {...playbackDefaults};Object.assign(session.preferences,values);
    if(!session.item) return;
    if(({...playbackDefaults,...this.store.data.playbackDefaults}).rememberPlayback) {
      this.store.data.playbackPreferences ??= {};
      this.store.data.playbackPreferences[playbackKey(session.item)]={...this.store.data.playbackPreferences[playbackKey(session.item)],...values};this.store.persist();
    }
  }
  applyTrackPreferences(session) {
    for(const [key,type,language] of [['aid','audio','audioLanguage'],['sid','sub','subtitleLanguage']]) {
      if(session.trackTouched?.[key]) continue;
      const id=preferredTrack(session.tracks,type,session.preferences[key],session.preferences[language]);
      if(id!==null && id!==session[key]) {session[key]=id;this.command(['set_property',key,id]);}
    }
  }
  resetPreferences() {
    const session=this.session;if(!session) return;
    if(this.store.data.playbackPreferences) delete this.store.data.playbackPreferences[playbackKey(session.item)];
    session.preferences={...playbackDefaults,...this.store.data.playbackDefaults};session.trackTouched={};
    this.command(['set_property','aid','auto']);this.command(['set_property','sid','auto']);
    for(const [key,prop] of [['speed','speed'],['subtitleDelay','sub-delay'],['subtitleSize','sub-font-size'],['subtitleFont','sub-font']]) this.command(['set_property',prop,session.preferences[key]]);
    this.applyTrackPreferences(session);this.store.persist();this.notify();
  }
  async importSubtitles(files) {
    const session=this.session;
    if(!session || !Array.isArray(files) || !files.length || files.length>16 || files.some(file=>typeof file!=='string' || !isSubtitle(file) || !path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size>8*1024*1024)) throw new Error('请选择有效的字幕文件（每个不超过 8 MB）。');
    session.trackTouched ??= {};session.trackTouched.sid=true;
    session.item.externalSubtitles=[...new Set([...(session.item.externalSubtitles || []),...files])].slice(-16);this.store.persist();
    await this.subtitles.attach(this,session,files.map(file=>({path:file,filename:path.basename(file),source:'local'})),true);
  }
  recordTechnical(session) {
    const info=readMediaInfo({params:session.videoParams,tracks:session.rawTracks,duration:session.duration,fps:session.fps,dolbyVisionProfile:session.dolbyVisionProfile});
    if(info && session.item) session.item.technical={...info,fileSize:session.item.size,fileModifiedAt:session.item.fileModifiedAt,probedAt:new Date().toISOString()};
  }
  upNext(session) {
    const remaining=session.duration-session.position;
    if(session.nextCancelled || !this.store.data.settings.autoNext || session.duration<60 || remaining>30 || remaining<0 || session.seek?.pending) return null;
    const next=this.nextItem(session.item);return next ? {itemId:next.id,remaining:Math.ceil(remaining),paused:session.paused || session.buffering} : null;
  }
  cancelNext() {this.clearWarm();if(this.session) {this.session.nextCancelled=true;this.notify();}}
  async shortcut(action) {
    const s = this.session; if (!s?.socket || s.finishing) return;
    const hint = text => {s.hint = {text, until: Date.now() + 1300}; this.notify();};
    switch (action) {
      case 'right-down': this.gestures.rightDown(); break;
      case 'right-up': this.gestures.rightUp(); break;
      case 'cancel': this.gestures.cancel(); break;
      case 'click': this.gestures.singleClick(); break;
      case 'double-click': this.gestures.doubleClick(); this.toggleFullscreen(); break;
      case 'pause': this.togglePause(); break;
      case 'forward': case 'backward': this.seek((s.seek?.pending ? s.seek.target : s.position) + (action === 'forward' ? 5 : -5)); hint(action === 'forward' ? '前进 5 秒' : '后退 5 秒'); break;
      case 'volume-up': case 'volume-down': {const volume = Math.max(0, Math.min(100, s.volume + (action === 'volume-up' ? 10 : -10))); this.control({volume, muted: false}); hint(`音量 ${volume}%`); break;}
      case 'mute': this.control({muted: !s.muted}); hint(s.muted ? '已静音' : '已取消静音'); break;
      case 'fullscreen': this.toggleFullscreen(); break;
      case 'escape': if (!this.onAction('escape')) {if (this.fullscreen()) this.toggleFullscreen(); else await this.stop();} break;
      case 'help': this.onAction('help'); break;
      case 'previous': await this.adjacent(-1); break;
      case 'next': await this.adjacent(1); break;
      case 'exit': await this.stop(); break;
      default: throw new Error('不支持的播放器快捷操作。');
    }
  }
  nextItem(item, direction = 1) {
    if (item.kind !== 'episode') return null;
    const group = groupLibrary(this.store.data.items).find(group => group.itemIds.includes(item.id)); if (!group) return null;
    const entries=episodeChoices(group.itemIds.map(id=>this.store.item(id)),item.id).filter(entry=>!entry.unavailable);
    const current=entries.findIndex(entry=>(entry.season ?? 1)===(item.season ?? 1) && entry.episode===item.episode);
    return entries[current+direction] ?? null;
  }
  adjacent(direction) { const next = this.session && this.nextItem(this.session.item, direction); if (!next) throw new Error(direction > 0 ? '已经是最后一集。' : '已经是第一集。'); return this.play(next.id); }
}
