import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function removeWorkerDirectory(directory) {
  const target = path.resolve(directory);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('cloudreel-preview-')) throw new Error('Unexpected preview directory');
  await fs.rm(target, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}).catch(() => {});
}
export const thumbnailTime = (seconds, duration) => Math.max(0, Math.floor(Math.min(duration - .5, Math.max(0, seconds)) / 5) * 5);
export function thumbnailKey(item, seconds) {
  return createHash('sha256').update(JSON.stringify(['v2-keyframes', item.source, item.fsId || item.path, item.size, item.fileModifiedAt, seconds])).digest('hex');
}

// A separate decoder only reads the production relay. It never seeks, captures,
// or sends commands to the viewing player, and never receives upstream URLs.
export class ThumbnailService {
  constructor(directory, player) {this.directory = path.join(directory, 'thumbnails'); this.player = player; this.sequence = 0; this.lifecycle = 0; this.closing = new Set(); this.worker = null; this.busy = false; this.frames = new Map(); this.queue = []; this.backgroundCount = 0; this.lastInteraction = 0;}
  remember(session, target, result) {
    const key = thumbnailKey(session.item, target);
    this.frames.delete(key);this.frames.set(key, {...result,target,identity:thumbnailKey(session.item,null)});
    // Data URIs stay local to the player and are bounded independently of disk.
    let bytes=0,count=0;
    for(const [entry,frame] of [...this.frames].reverse()) {bytes+=frame.image.length;if(bytes>16*1024*1024 || ++count>96)this.frames.delete(entry);}
    return {...result,target};
  }
  async cached(session, target, nearby = false) {
    const key=thumbnailKey(session.item,target),known=this.frames.get(key);
    if(known) {this.frames.delete(key);this.frames.set(key,known);return {image:known.image,seconds:known.seconds,target};}
    const [bytes,metadata]=await Promise.all([fs.readFile(path.join(this.directory,key+'.jpg')).catch(()=>null),fs.readFile(path.join(this.directory,key+'.json'),'utf8').then(JSON.parse).catch(()=>null)]);
    if(bytes && bytes.length>=100 && bytes.length<=1024*1024 && bytes[0]===0xff && bytes[1]===0xd8 && Number.isFinite(metadata?.seconds) && metadata.seconds>=0 && metadata.seconds<session.duration) {
      void fs.utimes(path.join(this.directory,key+'.jpg'),new Date(),new Date()).catch(()=>{});
      return this.remember(session,target,{image:'data:image/jpeg;base64,'+bytes.toString('base64'),seconds:metadata.seconds});
    }
    if(!nearby)return null;
    const identity=thumbnailKey(session.item,null),limit=Math.max(15,session.duration/32);
    const nearest=[...this.frames.values()].filter(frame=>frame.identity===identity && Math.abs(frame.target-target)<=limit).sort((a,b)=>Math.abs(a.target-target)-Math.abs(b.target-target))[0];
    return nearest ? {image:nearest.image,seconds:nearest.seconds,target:nearest.target,approximate:true} : null;
  }
  async request(input) {
    const session = this.player.session;
    if (!session || session.finishing || input?.itemId !== session.item.id || !Number.isFinite(input.seconds) || session.duration <= 0) return null;
    if(input.cachedOnly) {const result=await this.cached(session,thumbnailTime(input.seconds,session.duration),true);return this.player.session===session ? result : null;}
    const seconds = thumbnailTime(input.seconds, session.duration), key = thumbnailKey(session.item, seconds), sequence = ++this.sequence;
    this.lastInteraction=Date.now();clearTimeout(this.backgroundTimer);this.backgroundTimer=null;
    clearTimeout(this.idleTimer);
    await fs.mkdir(this.directory, {recursive: true});
    const cached = await this.cached(session, seconds);
    if (sequence !== this.sequence || this.player.session !== session) return null;
    if (cached) {this.neighbors(session,seconds);this.armIdle();return cached;}
    // Keep one active decode and one replaceable pending target, never a queue
    // of every intermediate mouse position.
    return new Promise(resolve => {
      this.pending?.resolve(null); this.pending = {session, seconds, key, sequence, resolve};
      // A speculative seek must never make a requested preview wait behind it.
      if(this.activeBackground && this.activeBackground.seconds!==seconds)void this.closeWorker();
      void this.drain();
    });
  }
  warm() {
    const session=this.player.session;
    if(!session || session.finishing || !session.loaded || !session.videoParams || session.duration<=0)return;
    if(this.warmSession!==session) {
      this.warmSession=session;this.warmAt=Date.now();this.backgroundCount=0;
      // A sparse storyboard gradually covers the whole file, with a fixed
      // request budget. Neighbor frames are promoted ahead of these samples.
      this.queue=Array.from({length:16},(_,index)=>({session,seconds:thumbnailTime(session.duration*(index+.5)/16,session.duration)}));
    }
    this.scheduleBackground();
  }
  neighbors(session,seconds) {
    const targets=[5,-5,10,-10].map(offset=>thumbnailTime(seconds+offset,session.duration));
    this.queue=[...targets.map(seconds=>({session,seconds})),...this.queue].filter((job,index,all)=>job.session===session && !this.frames.has(thumbnailKey(session.item,job.seconds)) && all.findIndex(other=>other.session===session && other.seconds===job.seconds)===index).slice(0,24);
    this.scheduleBackground();
  }
  canPrefetch(session) {
    if(this.player.session!==session || session.finishing || session.buffering || session.seek?.pending || !session.loaded || this.backgroundCount>=32)return false;
    const status=this.player.status?.(), ahead=status?.buffered?.find(range=>range.start<=session.position+1 && range.end>session.position)?.end-session.position;
    return Number.isFinite(ahead) && ahead>=20 && Date.now()-(this.warmAt??0)>=4000 && Date.now()-this.lastInteraction>=900;
  }
  scheduleBackground() {
    if(this.backgroundTimer || !this.queue.length || this.backgroundCount>=32)return;
    this.backgroundTimer=setTimeout(()=>{this.backgroundTimer=null;if(this.queue.length && this.canPrefetch(this.queue[0].session))void this.drain();else if(this.player.session===this.warmSession)this.scheduleBackground();},1200);
    this.backgroundTimer.unref();
  }
  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      await fs.mkdir(this.directory,{recursive:true});
      while (this.pending || this.queue.length && this.canPrefetch(this.queue[0].session)) {
        const background=!this.pending;
        const job = this.pending ?? {...this.queue.shift(),background:true,resolve:()=>{}};this.pending=null;
        if(background) {job.key=thumbnailKey(job.session.item,job.seconds);this.backgroundCount++;this.activeBackground=job;}
        try {
          if ((!background && job.sequence !== this.sequence) || this.player.session !== job.session || job.session.buffering || job.session.seek?.pending) {job.resolve(null); continue;}
          if(background && await this.cached(job.session,job.seconds))continue;
          if(background && this.pending)continue;
          const worker = await this.getWorker(job.session, job.seconds);
          if(background && this.pending)continue;
          if ((!background && job.sequence !== this.sequence) || this.player.session !== job.session) {job.resolve(null); continue;}
          if (worker.seconds !== job.seconds) await this.seek(worker, job.seconds);
          const names = (await fs.readdir(worker.directory)).filter(name => /^\d+\.jpg$/.test(name)).sort();
          if (!names.length) throw new Error('frame unavailable');
          const bytes = await fs.readFile(path.join(worker.directory, names.at(-1)));
          if (bytes.length < 100 || bytes.length > 1024 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('frame unavailable');
          if (this.player.session !== job.session || this.worker !== worker) {job.resolve(null); continue;}
          await fs.writeFile(path.join(this.directory, job.key + '.jpg'), bytes);
          const seconds=Number.isFinite(worker.position)?worker.position:job.seconds;
          await fs.writeFile(path.join(this.directory,job.key+'.json'),JSON.stringify({seconds}));
          const result=this.remember(job.session,job.seconds,{image:'data:image/jpeg;base64,'+bytes.toString('base64'),seconds});
          job.resolve(job.sequence === this.sequence ? result : null);
          if(!background && job.sequence===this.sequence)this.neighbors(job.session,job.seconds);
          // The worker's output is disposable; only bounded cached frames persist.
          for (const name of names.slice(0, -1)) await fs.unlink(path.join(worker.directory, name)).catch(() => {});
        } catch {job.resolve(null); await this.closeWorker();}
        finally {if(background)this.activeBackground=null;}
        if(background && !this.pending)break;
      }
    } catch {this.pending?.resolve(null);this.pending=null;}
    finally {this.busy = false; this.armIdle();this.scheduleBackground(); void this.prune();}
  }
  armIdle() {clearTimeout(this.idleTimer); this.idleTimer = setTimeout(() => {void this.closeWorker();}, 20000); this.idleTimer.unref();}
  cancel() {this.sequence++; this.pending?.resolve(null); this.pending = null; this.armIdle();}
  async reset() {this.lifecycle++; this.cancel();clearTimeout(this.backgroundTimer);this.backgroundTimer=null;this.queue=[];this.warmSession=null; clearTimeout(this.idleTimer); await this.closeWorker();}
  async closeWorker() {
    const worker = this.worker; this.worker = null;
    if (worker) {
      worker.closed = true; worker.socket?.destroy();
      const closing = (async () => {
        if (worker.child && worker.child.exitCode === null) {worker.child.kill(); await Promise.race([new Promise(resolve => worker.child.once('exit', resolve)), pause(1500)]);}
        worker.relay?.close(); await removeWorkerDirectory(worker.directory);
      })();
      this.closing.add(closing); void closing.finally(() => this.closing.delete(closing));
    }
    await Promise.all([...this.closing]);
  }
  async getWorker(session, seconds) {
    const lifecycle = this.lifecycle;
    if (this.worker?.session === session && !this.worker.closed && this.worker.child?.exitCode === null) return this.worker;
    await this.closeWorker();
    if (lifecycle !== this.lifecycle || this.player.session !== session || session.finishing || this.activeBackground && this.pending) throw new Error('cancelled');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudreel-preview-'));
    if (lifecycle !== this.lifecycle || this.player.session !== session || session.finishing || this.activeBackground && this.pending) {await removeWorkerDirectory(directory); throw new Error('cancelled');}
    const worker = this.worker = {session, directory, seconds, events: [], closed: false};
    try {
      const prepared = await this.player.prepareMedia(session.item, {quiet: true}); worker.relay = prepared.relay;
      if (worker.closed || this.player.session !== session) {prepared.relay?.close(); throw new Error('cancelled');}
      const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\cloudreel-preview-' + randomUUID() : path.join(directory, 'ipc');
      // Convert HDR/DV decoded colour data into an SDR BT.709 thumbnail before
      // JPEG encoding. The main HDR renderer and its output settings are untouched.
      const hdr = session.videoParams?.gamma === 'pq' || session.videoParams?.gamma === 'hlg' || session.videoParams?.primaries === 'bt.2020';
      const filter = hdr ? 'zscale=w=320:h=-2:t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=2,zscale=p=bt709:t=bt709:m=bt709:r=full,format=yuv420p' : 'scale=320:-2,format=yuv420p';
      worker.child = spawn(this.player.resolveMpv(), ['--no-config','--no-resume-playback','--save-position-on-quit=no','--force-window=no','--terminal=no','--media-controls=no','--audio=no','--sid=no','--sub-auto=no','--hwdec=no','--vo=image','--vo-image-format=jpg','--vo-image-jpeg-quality=75','--vo-image-high-bit-depth=no','--vo-image-outdir=' + directory,'--vf=' + filter,'--pause=yes','--idle=yes','--keep-open=yes','--cache=yes','--demuxer-max-bytes=4MiB','--demuxer-readahead-secs=0','--hr-seek=no','--start=' + seconds,'--input-ipc-server=' + pipe,'--', prepared.media], {windowsHide: true, stdio: 'ignore', shell: false});
      worker.child.once('error', () => {worker.closed = true;}); worker.child.once('exit', () => {worker.closed = true;});
      await this.until(worker, async () => {
        if (worker.socket) return true;
        worker.socket = await new Promise(resolve => {const socket = net.createConnection(pipe); socket.once('error', () => {socket.destroy(); resolve(null);}); socket.once('connect', () => {socket.removeAllListeners('error'); socket.on('error', () => {}); resolve(socket);});});
        return Boolean(worker.socket);
      });
      let buffer = '';
      worker.socket.on('data', data => {buffer += data.toString(); const lines = buffer.split('\n'); buffer = lines.pop(); for (const line of lines) {try {const event = JSON.parse(line); worker.events.push(event); if (worker.events.length > 60) worker.events.shift(); if (event.event === 'property-change' && event.name === 'time-pos') worker.position = event.data;} catch {}}});
      worker.socket.write(JSON.stringify({command: ['observe_property', 1, 'time-pos']}) + '\n');
      // IPC can connect after file-loaded, so inspect the actual image and time.
      await this.until(worker, async () => Number.isFinite(worker.position) && (await fs.readdir(directory)).some(name => name.endsWith('.jpg')));
      return worker;
    } catch (error) {if (this.worker === worker) await this.closeWorker(); throw error;}
  }
  async seek(worker, seconds) {
    worker.events = []; worker.position = null;
    worker.socket.write(JSON.stringify({command: ['seek', seconds, 'absolute+keyframes'], request_id: 10}) + '\n');
    await this.until(worker, () => worker.events.some(event => event.request_id === 10 && event.error === 'success') && worker.events.some(event => event.event === 'playback-restart') && Number.isFinite(worker.position));
    worker.seconds = seconds;
  }
  async until(worker, check) {
    const end = Date.now() + 22000;
    while (!worker.closed && this.worker === worker && this.player.session === worker.session && Date.now() < end) {if (await check()) return; await pause(60);}
    throw new Error('preview unavailable');
  }
  async prune() {
    if (this.pruning || Date.now() - (this.lastPrune ?? 0) < 60000) return; this.pruning = true; this.lastPrune = Date.now();
    try {
      const names = (await fs.readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.jpg$/.test(name));
      const entries = await Promise.all(names.map(async name => ({name, ...await fs.stat(path.join(this.directory, name))})));
      let total = 0;
      for (const entry of entries.sort((a, b) => b.mtimeMs - a.mtimeMs)) {total += entry.size; if (total > 256 * 1024 * 1024) {await fs.unlink(path.join(this.directory, entry.name)).catch(() => {});await fs.unlink(path.join(this.directory,entry.name.replace('.jpg','.json'))).catch(()=>{});}}
    } catch {} finally {this.pruning = false;}
  }
}
