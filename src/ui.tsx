import { useEffect, useRef, useState, type ReactNode } from 'react';
import {ChevronRight, Film, LoaderCircle, Search, Tv, X} from 'lucide-react';
import {useDismissMotion} from './motion';
import type { AppState, MatchResult, MediaItem } from './types';

export type Run = <T = unknown>(method: string, payload?: unknown) => Promise<T | undefined>;

export function MatchModal({ item, run, onClose }: { item: MediaItem; run: Run; onClose: () => void }) {
  const [query, setQuery] = useState(item.title), [type, setType] = useState(item.kind), [season, setSeason] = useState(item.season ?? 1), [episode, setEpisode] = useState(item.episode ?? 1), [results, setResults] = useState<MatchResult[]>([]), [searched, setSearched] = useState(false), [loading, setLoading] = useState(false);
  const search = async () => { setLoading(true); const result = await run<MatchResult[]>('trakt:search', { query, type }); if (result) { setResults(result); setSearched(true); } setLoading(false); };
  const select = async (result: MatchResult) => { setLoading(true); if (await run('trakt:match', { id: item.id, selection: { traktId: result.ids.trakt, type: result.type, season, episode } })) onClose(); setLoading(false); };
  return <Modal title="匹配影片" wide onClose={onClose}><p className="modal-description">选择正确的作品，以便同步到其他设备。</p><div className="match-controls"><select aria-label="影片类型" value={type} onChange={event => { setType(event.target.value as 'movie' | 'episode'); setResults([]); setSearched(false); }}><option value="movie">电影</option><option value="episode">剧集</option></select><input aria-label="匹配片名" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void search(); }} /><button className="button primary" disabled={loading || !query.trim()} onClick={search}><Search size={16} />搜索</button></div>{type === 'episode' && <div className="episode-fields"><label className="field">季数<input type="number" min={0} value={season} onChange={event => setSeason(Number(event.target.value))} /></label><label className="field">集数<input type="number" min={1} value={episode} onChange={event => setEpisode(Number(event.target.value))} /></label></div>}<div className="match-results">{loading && <div className="loading-row"><LoaderCircle size={19} className="spin" />正在搜索</div>}{results.map(result => <button disabled={loading} className="match-result" key={result.ids.trakt} onClick={() => select(result)}><span className="result-icon">{result.type === 'show' ? <Tv size={23} /> : <Film size={23} />}</span><div><strong>{result.title} <small>{result.year}</small></strong><p>{result.overview?.slice(0, 130) || '暂无简介'}</p></div><ChevronRight size={17} /></button>)}{searched && !results.length && !loading && <Empty icon={<Search size={25} />} title="没有找到匹配结果" text="试试原名或英文片名。" />}</div></Modal>;
}

export function SectionTitle({ title, count }: { title: string; count?: number }) { return <div className="section-heading"><h2>{title}</h2>{count !== undefined && <span>{count}</span>}</div>; }
export function Empty({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) { return <div className="empty-state"><div className="empty-icon">{icon}</div><h2>{title}</h2><p>{text}</p>{action}</div>; }
export function Toggle({ checked, label, onChange, disabled = false }: { checked: boolean; label: string; onChange: () => void; disabled?: boolean }) { return <button className={`toggle ${checked ? 'on' : ''}`} role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={onChange}><span /></button>; }
export function Activity({ state }: { state: AppState }) { return <div className="activity-list">{state.logs.length ? state.logs.slice(0, 20).map(log => <div className="activity-row" key={log.id}><span className={`activity-dot ${log.level}`} /><p>{log.message}</p><time>{new Date(log.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></div>) : <p className="section-note">暂无活动记录</p>}</div>; }
export function Modal({ title, children, onClose, wide = false, className = '', dismissible = true }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; className?: string; dismissible?: boolean }) {
  const {closing, dismiss} = useDismissMotion(onClose);
  const ref = useRef<HTMLElement>(null), close = useRef(() => {}); close.current = () => {if (dismissible) dismiss();};
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = () => ref.current?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex="0"]'); first()?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
      if (event.key === 'Tab') { const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, [tabindex="0"]') ?? [])]; const start = nodes[0], end = nodes.at(-1); if (event.shiftKey && document.activeElement === start) { event.preventDefault(); end?.focus(); } else if (!event.shiftKey && document.activeElement === end) { event.preventDefault(); start?.focus(); } }
    };
    window.addEventListener('keydown', listener); return () => { window.removeEventListener('keydown', listener); previous?.focus(); };
  }, []);
  return <div className={`modal-backdrop ${closing ? 'is-dismissing' : ''}`} onMouseDown={event => { if (event.target === event.currentTarget) close.current(); }}><section ref={ref} className={`modal ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="关闭窗口" disabled={!dismissible} onClick={() => close.current()}><X size={19} /></button></div>{children}</section></div>;
}

