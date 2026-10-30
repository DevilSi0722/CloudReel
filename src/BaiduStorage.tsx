import {useEffect, useRef, useState} from 'react';
import {RefreshCw} from 'lucide-react';
import {bridge} from './bridge';
import type {Account, BaiduQuota} from './types';

function capacity(value: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = value > 0 ? Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return `${(value / 1024 ** index).toLocaleString('zh-CN', {maximumFractionDigits: index > 0 ? 2 : 0})} ${units[index]}`;
}

export default function BaiduStorage({account}: {account: Account}) {
  const [requesting, setRequesting] = useState(false), [requestError, setRequestError] = useState(false);
  const active = useRef(true), pending = useRef(false);
  const refresh = async () => {
    if (pending.current) return;
    pending.current = true; setRequesting(true); setRequestError(false);
    try {await bridge.invoke<BaiduQuota>('baidu:quota');}
    catch {if (active.current) setRequestError(true);}
    finally {pending.current = false; if (active.current) setRequesting(false);}
  };
  useEffect(() => {active.current = true; return () => {active.current = false;};}, []);
  const quota = account.quota, loading = requesting || quota?.loading;
  useEffect(() => {setRequestError(false);}, [quota?.updatedAt]);
  const ready = quota?.total != null && quota.used != null && quota.available != null;
  const percent = ready ? Math.min(100, Math.max(0, quota.used! / quota.total! * 100)) : 0;
  const warning = ready && percent >= 90;
  const failed = requestError || !!quota?.error;
  const updated = quota?.updatedAt ? new Date(quota.updatedAt).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'}) : '';
  const remaining = ready ? quota.used! > quota.total! ? '已超过当前容量' : quota.available === 0 ? '空间已用满' : `${warning ? '空间即将用满 · ' : ''}剩余 ${capacity(quota.available!)}` : failed ? '可点击右侧刷新重试' : '正在读取网盘容量';
  return <section className={`baidu-storage ${warning ? 'is-near-full' : ''} ${failed ? 'is-stale' : ''}`} aria-label="网盘容量" aria-busy={!!loading}>
    <div className="storage-heading"><span>网盘容量</span><div className="storage-values">{ready ? <span>已用 <strong>{capacity(quota.used!)}</strong><span className="storage-total"> / {capacity(quota.total!)}</span></span> : <span>—</span>}<button className="icon-button" aria-label="刷新网盘容量" title="刷新容量 · 每分钟自动更新" disabled={!!loading} onClick={refresh}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div></div>
    <div className="storage-meter" role={ready ? 'meter' : undefined} aria-label="百度网盘已用空间" aria-valuemin={ready ? 0 : undefined} aria-valuemax={ready ? 100 : undefined} aria-valuenow={ready ? Number(percent.toFixed(1)) : undefined} aria-valuetext={ready ? `已用 ${capacity(quota.used!)}，总容量 ${capacity(quota.total!)}，剩余 ${capacity(quota.available!)}` : undefined}><span style={{width: `${percent}%`}} /></div>
    <div className="storage-caption"><span className="storage-remaining">{remaining}</span><span className="storage-status" title={quota?.updatedAt ? `上次成功更新：${new Date(quota.updatedAt).toLocaleString('zh-CN')}；每分钟自动刷新` : undefined}>{loading ? ready ? '正在更新…' : '' : failed ? ready ? '更新失败 · 上次读数' : '读取失败' : updated ? `${updated} 更新` : ''}</span></div>
  </section>;
}
