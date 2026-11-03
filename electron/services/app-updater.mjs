// The renderer only receives a small, plain-text status. Feed URLs, download
// locations and upstream errors stay in the main process.
const stable = value => typeof value === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value);
const newer = (a,b) => {const aa=a.split('.').map(Number),bb=b.split('.').map(Number);for(let i=0;i<3;i++)if(aa[i]!==bb[i])return aa[i]>bb[i];return false;};
const notes = value => (Array.isArray(value)?value.map(entry=>entry.note||'').join('\n'):typeof value==='string'?value:'').replace(/<[^>]*>/g,'').replace(/\r\n/g,'\n').slice(0,12000).trim();
export const UPDATE_RELEASES='https://github.com/DevilSi0722/CloudReel/releases';

function updateError(error,downloading) {
  if (['ERR_UPDATER_LATEST_VERSION_NOT_FOUND','ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'].includes(error?.code)||/404/.test(String(error?.message))) return '暂未发布支持自动更新的安装包，请稍后再试。';
  if (['ERR_UPDATER_INVALID_SIGNATURE','ERR_CHECKSUM_MISMATCH'].includes(error?.code)||/checksum|sha512/i.test(String(error?.message))) return '更新文件校验失败，请重新下载。';
  if (error?.code==='ENOSPC') return '磁盘空间不足，请清理空间后重试。';
  return downloading?'更新下载失败，请检查网络后重试。':'暂时无法检查更新，请稍后重试。';
}

export class AppUpdateService {
  constructor({engine,currentVersion,supported=true,notify=()=>{},blocked=()=>false,prepare=async()=>{},resume=()=>{},now=Date.now}) {
    Object.assign(this,{engine,currentVersion,supported,notify,blocked,prepare,resume,now});
    this.state={supported,phase:supported?'idle':'unsupported',version:null,notes:'',percent:0,transferred:0,total:0,error:null,checkedAt:null};
    this.checking=null;this.downloading=null;this.closed=false;this.installing=false;
    if(!supported)return;
    engine.autoDownload=false;engine.autoInstallOnAppQuit=false;engine.allowPrerelease=false;engine.allowDowngrade=false;engine.disableWebInstaller=true;engine.logger=null;
    // Never dump upstream errors or signed URLs to the console or a log file.
    engine.on('error',error=>{if(!this.closed)this.fail(error);});
    engine.on('download-progress',progress=>{if(this.closed||this.state.phase!=='downloading')return;this.patch({percent:Math.max(0,Math.min(100,Number(progress.percent)||0)),transferred:Math.max(0,Number(progress.transferred)||0),total:Math.max(0,Number(progress.total)||0)});});
  }
  status(){return {...this.state};}
  patch(value){Object.assign(this.state,value);this.notify();}
  valid(info){
    if(!stable(info?.version)||!stable(this.currentVersion)||!newer(info.version,this.currentVersion))return false;
    // Never turn a portable executable, web installer or arbitrary asset into
    // an update. NSIS verifies the SHA512 before making an installer available.
    return !info.packages&&Array.isArray(info.files)&&info.files.length===1&&info.files.every(file=>file.url===`CloudReel-Setup-${info.version}-win-x64.exe`&&typeof file.sha512==='string'&&/^[A-Za-z0-9+/]{86}==$/.test(file.sha512));
  }
  fail(error){if(this.installing){this.installing=false;this.resume();this.patch({phase:'downloaded',error:'暂时无法安装更新，请稍后重试。'});}else this.patch({phase:'error',error:updateError(error,!!this.downloading)});}
  check(){
    if(!this.supported||this.closed)return Promise.resolve(this.status());
    if(this.checking)return this.checking;
    if(this.downloading||['downloaded','installing'].includes(this.state.phase))return Promise.resolve(this.status());
    this.patch({phase:'checking',error:null});
    this.checking=(async()=>{
      try{
        const result=await this.engine.checkForUpdates();if(this.closed)return;
        const info=result?.updateInfo;
        this.patch({checkedAt:new Date(this.now()).toISOString()});
        if(stable(info?.version)&&!newer(info.version,this.currentVersion)){this.patch({phase:'current',version:null,notes:'',percent:0,error:null});return;}
        if(!this.valid(info))throw new Error('invalid update manifest');
        this.patch({phase:'available',version:info.version,notes:notes(info.releaseNotes),percent:0,error:null});
        // Keep a single operation across check + download. Retrying a download
        // always rechecks the feed so a withdrawn release is not installed.
        await this.download();
      }catch(error){if(!this.closed)this.fail(error);}
      finally{this.checking=null;}
    })();return this.checking.then(()=>this.status());
  }
  download(){
    if(this.downloading)return this.downloading;
    this.patch({phase:'downloading',error:null,percent:0,transferred:0,total:0});
    this.downloading=(async()=>{
      try{const files=await this.engine.downloadUpdate();if(!this.closed){if(!files?.length)throw Error('missing download');this.patch({phase:'downloaded',percent:100,error:null});}}
      catch(error){if(!this.closed)this.fail(error);}
      finally{this.downloading=null;}
    })();return this.downloading;
  }
  async install(){
    if(this.installing)return this.status();
    if(!this.supported||this.closed||this.state.phase!=='downloaded')throw Error('请先完成更新下载。');
    if(this.blocked())throw Error('请先结束播放、扫描、转存及文件处理或同步，再重启更新。');
    this.installing=true;this.patch({phase:'installing',error:null});
    try{await this.prepare();this.engine.quitAndInstall(true,true);}
    catch{this.fail(new Error('install failed'));}
    return this.status();
  }
  start(){if(!this.supported||this.closed||this.startup)return;this.startup=setTimeout(()=>{void this.check();},15000);this.startup.unref?.();this.periodic=setInterval(()=>{void this.check();},6*60*60*1000);this.periodic.unref?.();}
  stop(){this.closed=true;clearTimeout(this.startup);clearInterval(this.periodic);}
}
