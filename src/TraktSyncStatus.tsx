import type {Account} from './types';

export default function TraktSyncStatus({account}: {account: Account}) {
  const sync = account.sync;
  if (!account.connected || !sync) return null;
  const watching = sync.watching && Date.parse(sync.watching.expiresAt) > Date.now() ? sync.watching : null;
  return <div className="trakt-sync-status" aria-live="polite">
    <p>{sync.pulling ? '正在读取其他设备的观看记录…' : sync.lastPulledAt ? `上次读取 ${new Date(sync.lastPulledAt).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit', second: '2-digit'})} · ${sync.positions ?? 0} 个续播位置 · ${sync.watched ?? 0} 个已看视频` : '等待首次读取'}</p>
    {watching && <p>正在观看 · {watching.title}{watching.season !== undefined ? ` · 第 ${watching.season} 季 第 ${watching.episode} 集` : ''}<small>准确位置会在暂停或退出后更新。</small></p>}
    {sync.error && <p className="inline-error">{sync.error}</p>}
    {sync.warning && <p>{sync.warning}</p>}
  </div>;
}
