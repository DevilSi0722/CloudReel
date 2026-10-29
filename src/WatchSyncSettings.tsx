import {Check, LoaderCircle, RefreshCw} from 'lucide-react';
import {useState} from 'react';
import type {AppState} from './types';
import {Activity, Toggle, type Run} from './ui';
import TraktSyncStatus from './TraktSyncStatus';

export default function WatchSyncSettings({state, run, connect}: {state: AppState; run: Run; connect: () => void}) {
  const [saving, setSaving] = useState(false), [pending, setPending] = useState('');
  const account = state.accounts.trakt;
  const action = async (method: string) => {setPending(method);try {await run(method, method === 'account:disconnect' ? 'trakt' : undefined);} finally {setPending('');}};
  return <div className="watch-sync-settings">
    <div className="setting-row"><div><strong>{account.connected ? account.profile?.username || 'Trakt 已连接' : '连接 Trakt'}</strong><p>{account.connected ? '在不同设备间接着看' : '同步续播位置与已观看记录'}</p></div><button className="button secondary compact" disabled={!!pending || account.sync?.pulling} onClick={() => account.connected ? void action('trakt:pull') : connect()}>{account.sync?.pulling ? <LoaderCircle size={14} className="spin" /> : account.connected ? <RefreshCw size={14} /> : <Check size={14} />}{account.sync?.pulling ? '正在读取' : account.connected ? '读取进度' : '登录 Trakt'}</button></div>
    <div className="setting-row"><div><strong>自动同步观看进度</strong><p>自动读取其他设备的记录，暂停或退出播放时上传</p></div><Toggle label="自动同步观看进度" checked={state.settings.autoSync} disabled={saving} onChange={async () => {setSaving(true);try {await run('settings:save', {autoSync: !state.settings.autoSync});} finally {setSaving(false);}}} /></div>
    <div className="setting-row"><div><strong>待同步记录</strong><p>{state.pendingCount ? `${state.pendingCount} 条，网络恢复后自动重试` : '暂无待同步记录'}</p></div><button className="button secondary compact" disabled={!!pending || !account.connected} onClick={() => void action('sync:retry')}>{pending === 'sync:retry' && <LoaderCircle size={14} className="spin" />}重试同步</button></div>
    <div className="watch-sync-details"><TraktSyncStatus account={account} /><p className="section-note">按影片与季集匹配观看记录。准确续播位置在暂停或退出后更新，其他设备读取时可能有短暂延迟。</p>{!account.configured && <p className="section-note">此版本尚未启用 Trakt 登录。</p>}<details className="activity-details"><summary>最近活动</summary><Activity state={state} /></details>{account.connected && <button className="text-button danger" disabled={!!pending} onClick={() => void action('account:disconnect')}>断开 Trakt</button>}</div>
  </div>;
}
