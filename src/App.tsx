import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Cloud, Compass, Film, FolderOpen, Heart, Home, Info, LoaderCircle, Plus, RefreshCw, Search, Settings2, Tv, X } from 'lucide-react';
import { bridge, emptyState } from './bridge';
import type { AppState, BaiduAuth, Collection, MediaItem } from './types';
import { MatchModal, Modal, type Run } from './ui';
import Discovery from "./Discovery";
import Sources from './Sources';
import Details, { MetadataMatch } from './Details';
import MetadataSettings from './MetadataSettings';
import Settings from './Settings';
import Player from './Player';
import PlayerViewport from './PlayerViewport';
import BrandMark from './BrandMark';
import TraktConnect from './TraktConnect';
import LibraryView from './LibraryView';
import type {WatchResult} from './WatchActions';
import {transitionPage} from './motion';

type View = 'home' | 'movies' | 'shows' | 'favorites' | 'sources' | 'discovery' | 'settings';
const titles: Record<View, string> = {home: '现在观看', movies: '电影', shows: '剧集', favorites: '收藏', sources: '文件来源', discovery: '发现片源', settings: '设置'};
export default function App() {
  const [state, setState] = useState<AppState>(emptyState), [view, setView] = useState<View>('home');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(0), [toast, setToast] = useState<{text: string; error: boolean} | null>(null);
  const [selected, setSelected] = useState<{ids: string[]; itemId?: string} | null>(null), [matching, setMatching] = useState<string[] | null>(null), [traktMatch, setTraktMatch] = useState<MediaItem | null>(null);
  const [traktOpen, setTraktOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false), [baiduAuth, setBaiduAuth] = useState<BaiduAuth | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { void bridge.invoke<AppState>('state').then(setState).catch(error => setToast({text: error.message, error: true})); return bridge.onState(setState); }, []);
  useEffect(() => { if (state.accounts.baidu.connected) setBaiduAuth(null); }, [state.accounts.baidu.connected]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 6500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { const key = (event: KeyboardEvent) => {if (event.key === '/' && !(event.target instanceof HTMLInputElement) && !document.querySelector('[role="dialog"]') && !state.player) {event.preventDefault(); input.current?.focus();}}; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [!!state.player]);
  const run: Run = async <T,>(method: string, payload?: unknown) => {
    const quiet = /^(player:(pause|seek|control|bounds|fullscreen)|metadata:cancel)$/.test(method);
    if (!quiet) setBusy(n => n + 1);
    try { const result = await bridge.invoke<T>(method, payload); if (result && typeof result === 'object' && 'accounts' in result && 'items' in result) setState(result as unknown as AppState); return result; }
    catch (error) {setToast({text: (error as Error).message, error: true}); return undefined;}
    finally {if (!quiet) setBusy(n => n - 1);}
  };
  const navigate = (next: View) => {if (next === view && !selected && !query && !addOpen) return; transitionPage(() => {setView(next); setQuery(''); setSelected(null); setAddOpen(false); window.scrollTo(0, 0);}, Boolean(state.player));};
  const connectBaidu = async () => {setAddOpen(false); const result = await run<BaiduAuth>('baidu:auth'); if (result && result.mode !== 'web') setBaiduAuth(result);};
  const connectTrakt = async () => {setTraktOpen(true); if (state.accounts.trakt.configured) await run('trakt:auth');};
  const details = selected ? state.collections.find(group => group.itemIds.some(id => selected.ids.includes(id))) : null;
  const onWatch = (result: WatchResult) => setToast({text: result.pending ? '已在本机标记，等待同步到 Trakt' : result.connected ? '观看状态已同步到 Trakt' : '已在本机标记，当前未连接 Trakt', error: false});
  const open = (group: Collection, itemId?: string) => transitionPage(() => {setSelected({ids: group.itemIds, itemId}); window.scrollTo(0, 0);}, Boolean(state.player));
  const visibleScan = state.scan.running && !state.scan.background, visibleScrape = state.scrape.running && !state.scrape.background;
  return <div className={`app-shell ${state.runtime.windowChrome ? 'desktop-chrome' : ''} ${state.runtime.fullscreen ? 'is-fullscreen' : ''}`}>
    {state.runtime.windowChrome && !state.runtime.fullscreen && <div className="window-chrome"><span>CloudReel</span></div>}
    <aside className="sidebar"><button className="brand" onClick={() => navigate('home')}><BrandMark /><span>云映<small>CloudReel</small></span></button><span className="nav-label">资料库</span><nav aria-label="资料库导航">{([{id: 'home', icon: Home, name: '现在观看'}, {id: 'movies', icon: Film, name: '电影'}, {id: 'shows', icon: Tv, name: '剧集'}, {id: 'favorites', icon: Heart, name: '收藏'}, {id: 'discovery', icon: Compass, name: '发现'}] as const).map(({id, icon: Icon, name}) => <button key={id} className={`nav-item ${view === id ? 'active' : ''}`} aria-current={view === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={18} /><span>{name}</span>{(id === 'movies' || id === 'shows') && <small>{state.collections.filter(group => group.kind === (id === 'movies' ? 'movie' : 'episode')).length || ''}</small>}</button>)}</nav><span className="nav-label source-label">我的来源</span><button className={`nav-item ${view === 'sources' ? 'active' : ''}`} onClick={() => navigate('sources')}><Cloud size={18} /><span>百度网盘</span>{state.accounts.baidu.connected && <i className="status-dot" />}</button><button className="nav-item nav-add" onClick={() => setAddOpen(true)}><Plus size={17} /><span>添加媒体</span></button><div className="sidebar-bottom"><button className="nav-item" aria-label="刷新片库" title={state.scanRoots?.some(root => root.enabled !== false) ? '刷新所有已挂载的影视目录' : '请先添加影视目录'} disabled={!state.scanRoots?.some(root => root.enabled !== false) || visibleScan} onClick={() => run('library:refresh')}><RefreshCw size={17} className={visibleScan ? 'spin' : ''} /><span>刷新片库</span></button><button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}><Settings2 size={18} /><span>设置</span></button><div className="sidebar-version">CloudReel <span>{state.runtime.version}</span></div></div></aside>
    <main className="main-area"><header className="topbar"><span>{details ? details.title : ['home', 'movies', 'shows', 'favorites'].includes(view) ? '' : titles[view]}</span><div className="topbar-actions"><label className="search-box"><Search size={15} /><input ref={input} aria-label={view === 'discovery' ? '搜索片源' : '搜索片库'} placeholder={view === 'discovery' ? '搜索片源' : '搜索片库'} value={query} onChange={e => {setQuery(e.target.value); setSelected(null); if (!['home', 'movies', 'shows', 'favorites', 'discovery'].includes(view)) setView('home');}} /><kbd>/</kbd></label><button className="icon-button" aria-label="添加媒体" onClick={() => setAddOpen(true)}><Plus size={21} /></button></div></header>
    <div className={`content view-${view} ${details ? 'detail-content' : ''}`}>
      {!state.runtime.desktop && <div className="preview-note">界面预览 · 连接账号与播放请使用桌面版</div>}
      {details ? <Details key={selected?.ids[0] ?? details.id} group={details} initialItemId={selected?.itemId} state={state} run={run} onBack={() => transitionPage(() => setSelected(null), Boolean(state.player))} onMatch={setMatching} onTrakt={setTraktMatch} onWatch={onWatch} /> : <>
      {(view === 'home' || view === 'movies' || view === 'shows' || view === 'favorites') && <LibraryView state={state} view={view} query={query} run={run} open={open} connectBaidu={connectBaidu} onWatch={onWatch} />}
      {view === 'discovery' && <Discovery state={state} query={query} run={run} connect={connectBaidu} />}
      {view === 'sources' && <Sources state={state} run={run} connect={connectBaidu} busy={!!busy} />}
      {view === 'settings' && <Settings state={state} run={run} connectBaidu={connectBaidu} connectTrakt={connectTrakt} metadata={<MetadataSettings state={state} run={run} />} />}
      </>}
    </div>
    {(visibleScan || visibleScrape) && <div className="scan-strip" role="status"><LoaderCircle size={15} className="spin" /><span>{visibleScan ? `扫描中 · ${state.scan.count} 个视频` : `获取影片资料 · ${state.scrape.done} / ${state.scrape.total}`}</span><small>{visibleScan ? state.scan.directory : state.scrape.current}</small><button className="text-button" onClick={() => run(visibleScan ? 'library:cancelScan' : 'metadata:cancel')}>停止</button></div>}
    </main>
    {addOpen && <Modal title="添加媒体" onClose={() => setAddOpen(false)}><p className="modal-description">好故事，来自你熟悉的地方。</p><div className="add-options">{[{icon: Cloud, title: '百度网盘', text: '选择网盘文件夹，挂载到影视库', action: () => {navigate('sources'); if (!state.accounts.baidu.connected) void connectBaidu();}}, {icon: FolderOpen, title: '本地影视目录', text: '递归扫描文件夹，自动归纳电影与剧集', action: () => {setAddOpen(false); void run('library:importFolder');}}, {icon: Film, title: '本地视频文件', text: '选择一个或多个视频', action: () => {setAddOpen(false); void run('library:importLocal');}}].map(({icon: Icon, title, text, action}) => <button key={title} onClick={action}><span className="service-icon neutral"><Icon size={25} /></span><span><strong>{title}</strong><small>{text}</small></span><ChevronRight size={18} /></button>)}</div></Modal>}
    {baiduAuth && <Modal title="百度官方授权" onClose={() => {setBaiduAuth(null); void run('baidu:cancelAuth');}}><div className="device-code">{baiduAuth.userCode}</div><button className="button primary full" onClick={() => run('external:open', baiduAuth.verificationUrl)}>打开授权页面</button></Modal>}
    {matching && <MetadataMatch ids={matching} state={state} run={run} onClose={() => setMatching(null)} />}
    {traktOpen && <TraktConnect account={state.accounts.trakt} run={run} onClose={() => setTraktOpen(false)} />}
    {traktMatch && <MatchModal item={traktMatch} run={run} onClose={() => setTraktMatch(null)} />}
    {state.player && (state.runtime.playerOverlay ? <PlayerViewport state={state} /> : <Player state={state} run={run} />)}
    {!!busy && <div className="busy-indicator" role="status"><LoaderCircle size={15} className="spin" />正在处理</div>}
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role="alert"><Info size={17} /><span>{toast.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast(null)}><X size={16} /></button></div>}
  </div>;
}
