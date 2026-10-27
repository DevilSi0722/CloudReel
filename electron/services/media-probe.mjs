import {spawn} from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import {createStreamRelay} from './stream.mjs';
import {readMediaInfo} from '../core/media-info.mjs';
export class MediaProbeService {
  constructor(store,baidu,resolveMpv,notify=()=>{}) {Object.assign(this,{store,baidu,resolveMpv,notify});this.states={};this.queue=[];this.active=null;}
  request(id,force=false) {
    const item=this.store.item(id),info=item.technical;
    if(!force && info?.verified && info.fileSize===item.size && info.fileModifiedAt===item.fileModifiedAt) return;
    if(this.states[id]?.running) return;
    this.states[id]={running:true,error:null};this.queue.push(id);this.notify();void this.drain();
  }
  async drain() {
    if(this.active) return;
    const id=this.queue.shift();if(!id) return;
    const current={id};this.active=current;
    try {
      const item=this.store.item(id),size=item.size,modified=item.fileModifiedAt;
      const info=await this.probe(item,current);
      if(!current.cancelled && this.store.data.items.includes(item) && item.size===size && item.fileModifiedAt===modified) {item.technical={...info,fileSize:size,fileModifiedAt:modified,probedAt:new Date().toISOString()};this.store.persist();}
      this.states[id]={running:false,error:null};
    } catch {this.states[id]={running:false,error:current.cancelled ? null : '暂时无法读取媒体信息，可稍后重试或播放后查看。'};}
    finally {current.close?.();this.active=null;this.notify();void this.drain();}
  }
  cancel() {this.queue=[];for(const key of Object.keys(this.states)) if(this.states[key].running)this.states[key]={running:false,error:null};if(this.active){this.active.cancelled=true;this.active.close?.();}}
  async probe(item,current={}) {
    const executable=this.resolveMpv();if(!executable) throw new Error('播放器不可用');
    let relay,socket,child,timer, retry;const pipe=`\\\\.\\pipe\\cloudreel-probe-${crypto.randomUUID()}`;
    try {
      const media=item.source==='baidu' ? (relay=await createStreamRelay(options=>this.baidu.streamUrl(item.fsId,{...options,path:item.path}),{...(this.baidu.fetchMedia?{fetcher:this.baidu.fetchMedia.bind(this.baidu)}:{})})).url : item.path;
      if(current.cancelled) throw new Error('cancelled');
      if(item.source==='local' && !fs.existsSync(item.path)) throw new Error('本地文件不可用');
      return await new Promise((resolve,reject)=>{
        let buffer='',params,tracks=[],duration,fps,settle;
        const fail=()=>reject(new Error('媒体信息读取失败'));
        current.close=()=>{clearTimeout(timer);clearTimeout(retry);clearTimeout(settle);socket?.destroy();child?.kill();relay?.close();reject(new Error('cancelled'));};
        const complete=()=>{const info=readMediaInfo({params,tracks,duration,fps});if(info && params?.gamma && duration>0){clearTimeout(settle);settle=setTimeout(()=>resolve(readMediaInfo({params,tracks,duration,fps})),120);}};
        child=spawn(executable,['--no-config','--no-resume-playback','--save-position-on-quit=no','--force-window=no','--vo=null','--ao=null','--audio=no','--pause=yes','--idle=yes','--keep-open=yes','--hwdec=no','--sub-auto=no','--cache=yes','--demuxer-max-bytes=8MiB','--input-ipc-server='+pipe,'--',media],{windowsHide:true,stdio:'ignore',shell:false});
        child.once('error',fail);child.once('exit',fail);timer=setTimeout(fail,35000);
        const connect=()=>{
          if(current.cancelled)return fail();
          const candidate=net.createConnection(pipe);
          candidate.once('error',()=>{candidate.destroy();retry=setTimeout(connect,100);});
          candidate.once('connect',()=>{
            socket=candidate;candidate.removeAllListeners('error');candidate.on('error',fail);
            candidate.on('data',data=>{buffer+=data.toString();const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){try{const event=JSON.parse(line);if(event.event==='property-change'){if(event.name==='video-params')params=event.data;if(event.name==='track-list')tracks=event.data || [];if(event.name==='duration')duration=event.data;if(event.name==='container-fps')fps=event.data;complete();}if(event.event==='end-file' && event.reason==='error')fail();}catch{}}});
            ['video-params','track-list','duration','container-fps'].forEach((name,i)=>candidate.write(JSON.stringify({command:['observe_property',i+1,name]})+'\n'));
          });
        };connect();
      });
    } finally {current.close?.();clearTimeout(timer);clearTimeout(retry);socket?.destroy();child?.kill();relay?.close();}
  }
}
