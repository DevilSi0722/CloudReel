import {useState} from 'react';
import {Check, ChevronDown, ExternalLink, LoaderCircle, RefreshCw} from 'lucide-react';
import type {AppState} from './types';
import {Toggle, type Run} from './ui';

export default function MetadataSettings({state, run}: {state: AppState; run: Run}) {
  const [token, setToken] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const test = async () => {setBusy(true); setMessage(''); try {if (await run('metadata:test')) setMessage('TMDB 连接成功');} finally {setBusy(false);}};
  return <div className="metadata-settings">
    <div className="setting-row"><div><strong>自动获取海报与资料</strong><p>扫描后自动识别作品并缓存图片</p></div><Toggle label="自动刮削元数据" checked={state.settings.autoScrape} onChange={() => run('settings:save', {autoScrape: !state.settings.autoScrape})} /></div>
    <div className="setting-row"><div><strong>更新影片资料</strong><p>{state.scrape.running ? `${state.scrape.done} / ${state.scrape.total} · ${state.scrape.current}` : `${state.collections.filter(group => group.catalog).length} 部作品已匹配`}</p></div><button className="button secondary compact" onClick={() => run(state.scrape.running ? 'metadata:cancel' : 'metadata:refresh')}><RefreshCw size={14} className={state.scrape.running ? 'spin' : ''} />{state.scrape.running ? '停止更新' : '更新资料'}</button></div>
    <div className="setting-row"><div><strong>TMDB <span className="priority-badge">首选</span></strong><p>{state.scrape.tmdbConfigured ? '已配置 · 提供海报、简介与分集信息' : '配置后获取更完整的影片资料'}</p></div>{state.scrape.tmdbConfigured && <button className="button secondary compact" disabled={busy} onClick={test}>{busy ? <LoaderCircle size={14} className="spin" /> : null}测试连接</button>}</div>
    <details className="settings-nested credential-editor" open={!state.scrape.tmdbConfigured || undefined}><summary>{state.scrape.tmdbConfigured ? '管理 TMDB 连接' : '配置 TMDB'}<ChevronDown size={15} /></summary><div className="settings-credential-body">
      <label className="field">API Read Access Token<input aria-label="TMDB API Read Access Token" type="password" autoComplete="new-password" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} placeholder={state.hasTmdbToken ? '已加密保存，留空保留' : '粘贴 TMDB 的 API Read Access Token'} /></label>
      <p className="section-note">凭据加密保存在本机。影片资料优先使用简体中文，再以繁体中文和英文补全。</p>
      <div className="tmdb-actions"><button className="button primary compact" disabled={busy || !token.trim()} onClick={async () => {setBusy(true); setMessage(''); try {if (await run('settings:save', {tmdbToken: token})) {setToken(''); setMessage('已保存 TMDB 连接');}} finally {setBusy(false);}}}><Check size={14} />保存 Token</button><button className="text-button" onClick={() => run('external:open', 'https://www.themoviedb.org/settings/api')}>获取 Token <ExternalLink size={13} /></button>{state.hasTmdbToken && <button className="text-button danger" disabled={busy} onClick={async () => {setBusy(true); try {if (await run('settings:save', {clearTmdbToken: true})) {setToken(''); setMessage('已移除本机 TMDB Token');}} finally {setBusy(false);}}}>移除 Token</button>}</div>
    </div></details>
    {state.scrape.connectionError && <p className="inline-error settings-inline-message">{state.scrape.connectionError}</p>}
    {message && <p className="saved-message settings-inline-message" role="status">{message}</p>}
    <p className="section-note attribution settings-attribution">未配置或暂不可用时尝试豆瓣、TVmaze。This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
  </div>;
}
