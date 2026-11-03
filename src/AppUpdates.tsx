import {useState} from 'react';
import {ArrowDownToLine,Check,LoaderCircle,RefreshCw} from 'lucide-react';
import {bridge} from './bridge';
import BrandMark from './BrandMark';
import type {AppState} from './types';
import type {Run} from './ui';

export default function AppUpdates({state,run}:{state:AppState;run:Run}) {
  const update=state.update,[checking,setChecking]=useState(false),[error,setError]=useState('');
  const phase=update?.phase||'unsupported',pending=checking||['checking','downloading','installing'].includes(phase);
  const blocked=Boolean(state.player||state.scan.running||state.fileTask?.running||state.accounts.trakt.sync?.pulling||state.discoveryTransfers?.some(task=>['submitting','submitted','renaming','importing'].includes(task.status)));
  const message=phase==='checking'?'正在检查更新…':phase==='downloading'?`正在下载 ${update?.version} · ${Math.floor(update?.percent||0)}%`:phase==='downloaded'?`${update?.version} 已准备就绪`:phase==='installing'?'正在准备重启…':phase==='current'?'已是最新版本':phase==='unsupported'?'安装版支持在软件内自动更新':'启动后自动检查并在后台下载';
  const check=async()=>{setChecking(true);setError('');try{await bridge.invoke('update:check');}catch{setError('暂时无法检查更新，请稍后重试。');}finally{setChecking(false);}};
  return <section className="settings-update" aria-label="软件更新">
    <div className="app-update-row"><BrandMark small/><div className="app-update-copy"><strong>CloudReel <span>{state.runtime.version}</span></strong><p role="status">{error||update?.error||message}</p></div>
      {phase==='unsupported'?<button className="button secondary compact" onClick={()=>void run('update:releases')}>查看发布页</button>:phase==='downloaded'?<button className="button primary compact" disabled={blocked} title={blocked?'请先结束当前播放或文件处理任务':undefined} onClick={()=>void run('update:install')}><RefreshCw size={14}/>重启并更新</button>:<button className="button secondary compact" disabled={pending} onClick={()=>void check()}>{pending?<LoaderCircle size={14} className="spin"/>:phase==='current'?<Check size={14}/>:<RefreshCw size={14}/>}检查更新</button>}
    </div>
    {phase==='downloading'&&<div className="app-update-progress" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(update?.percent||0)}><i style={{width:`${update?.percent||0}%`}}/></div>}
    {phase==='downloaded'&&<p className="app-update-hint">{blocked?'当前任务结束后即可重启更新。':'方便时重启即可完成更新，片库与观看记录会保留。'}</p>}
    {!!update?.notes&&<details className="app-update-notes"><summary>版本 {update.version} 的更新内容</summary><p>{update.notes}</p></details>}
  </section>;
}

export function UpdateNotice({version,onOpen,onDismiss}:{version:string;onOpen:()=>void;onDismiss:()=>void}) {
  return <div className="app-update-notice" role="status"><ArrowDownToLine size={16}/><span>CloudReel {version} 已准备就绪</span><button className="text-button" onClick={onOpen}>查看更新</button><button className="text-button" onClick={onDismiss}>稍后</button></div>;
}
