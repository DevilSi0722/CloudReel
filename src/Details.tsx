import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Circle, Film, Heart, Link2, Pencil, Play, RotateCcw, Search, Trash2 } from 'lucide-react';
import type { AppState, CatalogResult, Collection, MediaItem } from './types';
import { Empty, Modal, type Run } from './ui';
import { bytes, episodeLabel, episodesOf, progressOf, resumeItem, watchingNow, watchSummary } from './library';
import {ActionMenu, MoreButton, useWatchMenu, WatchBadge, type WatchResult} from './WatchActions';
import {episodeChoices, versionKey, versionLabel} from '../electron/core/versions.mjs';
import TitleArt from './TitleArt';

export function Artwork({ src, title, wide = false }: {src?: string; title: string; wide?: boolean}) {
  const [failed, setFailed] = useState('');
  return src && failed !== src ? <img src={src} alt={title} loading="lazy" onError={() => setFailed(src)} /> : <div className={`art-fallback ${wide ? 'wide' : ''}`}><Film size={wide ? 30 : 36} strokeWidth={1} /><span>{title}</span></div>;
}
export default function Details({ group, initialItemId, state, run, onBack, onMatch, onTrakt, onWatch }: { group: Collection; initialItemId?: string; state: AppState; run: Run; onBack: () => void; onMatch: (ids: string[]) => void; onTrakt: (item: MediaItem) => void; onWatch: (result: WatchResult) => void }) {
  const entries = episodesOf(group, state.items), catalog = group.catalog;
  // Only the continue-watching entry supplies an initial episode. Later progress
  // updates must not override the user's selection inside this detail page.
  const choices: MediaItem[] = episodeChoices(entries);
  choices.sort((a, b) => ((a.season ?? 1) === 0 ? Infinity : a.season ?? 1) - ((b.season ?? 1) === 0 ? Infinity : b.season ?? 1) || (a.episode ?? Infinity) - (b.episode ?? Infinity));
  const [selectedId, setSelectedId] = useState(() => entries.find(item => item.id === initialItemId)?.id ?? choices[0]?.id), [editing, setEditing] = useState<MediaItem | 'all' | null>(null), [more, setMore] = useState<{x: number; y: number} | null>(null);
  const [synopsis, setSynopsis] = useState<{title: string; text: string} | null>(null);
  const current = entries.find(item => item.id === selectedId);
  const selected = group.kind === 'episode' ? choices.find(item => current && versionKey(item) === versionKey(current)) ?? choices[0] : resumeItem(group, state.items);
  const season = selected?.season ?? 1;
  const selectedVersions = selected ? entries.filter(item => versionKey(item) === versionKey(selected)) : [];
  useEffect(() => {if (group.kind === 'episode' && selected && selected.id !== selectedId) setSelectedId(selected.id);}, [group.kind, selected?.id, selectedId]);
  const menu = useWatchMenu(run, onWatch), summary = watchSummary(entries), seasonEntries = entries.filter(item => (item.season ?? 1) === season), seasonSummary = watchSummary(seasonEntries);
  return <div className="title-details"><button className="back-link" onClick={onBack}><ArrowLeft size={17} />资料库</button>
    <div className={`detail-hero ${catalog?.backdrop ? 'has-backdrop' : ''}`}>
      {catalog?.backdrop && <img className="detail-backdrop" src={catalog.backdrop} alt="" />}
      <div className="detail-poster" onContextMenu={event => menu.open(event, entries, group.title)}><Artwork src={catalog?.poster} title={group.title} /><WatchBadge entries={entries} /></div>
      <div className="title-copy">
        <div className="title-heading">
          <div><span className="eyebrow">{group.kind === 'episode' ? '剧集' : '电影'}</span><h1>{group.title}</h1>{catalog?.originalTitle && catalog.originalTitle !== group.title && <p className="original-title">{catalog.originalTitle}</p>}</div>
          {catalog?.source === 'tmdb' && <div className="detail-title-slot"><TitleArt src={catalog.logo} title={`${group.title} · 标题设计`} className="detail-title-art" /></div>}
        </div>
        {selected && <MediaInfo item={selected} state={state} run={run} />}
        <div className="title-facts">{group.year && <span>{group.year}</span>}{catalog?.rating ? <span className="rating">★ {catalog.rating.toFixed(1)}</span> : null}{group.kind === 'episode' && <span>{group.seasons.length} 季 · 已收录 {group.totalEpisodes} 集</span>}{catalog?.genres?.slice(0, 3).map(genre => <span key={genre}>{genre}</span>)}</div>
        {catalog?.tagline && <p className="tagline">{catalog.tagline}</p>}
        <OverviewPreview text={catalog?.overview || (catalog ? '暂无简介' : '正在获取影片资料…')} label={group.title} hero onRead={setSynopsis} />
        <div className="detail-buttons">
          <button className="button primary" disabled={!selected || selected.unavailable} onClick={() => selected && run('player:play', {id: selected.id})}><Play size={16} fill="currentColor" />{selected && progressOf(selected) > 0 && progressOf(selected) < 95 ? '继续观看' : '立即播放'}</button>
          <button className={`icon-button watch-action ${summary.complete ? 'is-watched' : ''}`} aria-label="观看标记" title={summary.complete ? '已看完 · 观看标记' : '观看标记'} onClick={event => menu.open(event, entries, group.kind === 'episode' ? '全剧 · 已收录分集' : group.title)}>{summary.complete ? <Check size={19} /> : <Circle size={19} />}</button>
          <button className={`icon-button favorite-action ${summary.favorite ? 'selected' : ''}`} aria-label={summary.favorite ? '取消收藏' : '加入收藏'} title={summary.favorite ? '取消收藏' : '加入收藏'} onClick={() => run('library:organize', {ids: group.itemIds, favorite: !summary.favorite})}><Heart size={19} fill={summary.favorite ? 'currentColor' : 'none'} /></button>
          <MoreButton label="影片更多操作" onClick={event => {const rect = event.currentTarget.getBoundingClientRect(); setMore({x: rect.right - 250, y: rect.bottom + 6});}} />
        </div>
        {group.kind === 'episode' && selected && <><p className="resume-hint" aria-label="当前选集" aria-live="polite">{episodeLabel(selected)}{selected.episodeMetadata?.title ? ` · ${selected.episodeMetadata.title}` : ''}{selected.unavailable ? ' · 暂不可用' : watchingNow(selected) ? ' · 正在观看' : progressOf(selected) > 0 && progressOf(selected) < 95 ? ` · 已观看 ${progressOf(selected).toFixed(1)}%` : ''}</p><VersionSelect entries={selectedVersions} selected={selected} run={run} /></>}
      </div>
    </div>
    {group.kind === 'movie' && selected && <VersionSelect entries={entries} selected={selected} run={run} />}
    {group.kind === 'episode' && <section className="episodes-section"><div className="section-heading"><h2>剧集 <small className="season-watched-count">{seasonSummary.watched}/{seasonSummary.total} 已看</small></h2><div className="season-actions"><select aria-label="选择季数" value={season} onChange={event => {const first = choices.find(item => (item.season ?? 1) === Number(event.target.value)); if (first) setSelectedId(first.id);}}>{[...group.seasons].sort((a, b) => (a === 0 ? Infinity : a) - (b === 0 ? Infinity : b)).map(n => <option key={n} value={n}>{n === 0 ? '特别篇' : `第 ${n} 季`}</option>)}</select><MoreButton label="本季观看标记" onClick={event => menu.open(event, seasonEntries, season === 0 ? '特别篇 · 已收录分集' : `第 ${season} 季 · 已收录分集`, false)} /></div></div><div className="episode-grid">{choices.filter(item => (item.season ?? 1) === season).map(item => {
      const versions = seasonEntries.filter(entry => versionKey(entry) === versionKey(item)), active = versionKey(item) === versionKey(selected ?? item);
      return <article className={`episode-card ${active ? 'is-selected' : ''}`} key={versionKey(item)} onClick={() => setSelectedId(item.id)} onContextMenu={event => menu.open(event, versions, episodeLabel(item), false)}>
        <button className="episode-still" aria-label={`选择${episodeLabel(item)}`} aria-pressed={active}><Artwork wide src={item.episodeMetadata?.still ?? catalog?.backdrop} title={`第 ${item.episode ?? '?'} 集`} /><WatchBadge entries={versions} />{progressOf(item) > 0 && <span className="poster-progress"><i style={{width: `${progressOf(item)}%`}} /></span>}</button>
        <div className="episode-caption"><button className="episode-title" aria-pressed={active}><strong>{item.episode}. {item.episodeMetadata?.title || `第 ${item.episode ?? '?'} 集`}</strong></button><small>{item.episodeMetadata?.runtime ? `${item.episodeMetadata.runtime} 分钟 · ` : ''}{bytes(item.size)} · {item.source === 'baidu' ? '百度网盘' : '本地'}</small><OverviewPreview text={item.episodeMetadata?.overview} label={`${episodeLabel(item)}${item.episodeMetadata?.title ? ` · ${item.episodeMetadata.title}` : ''}`} onRead={setSynopsis} /></div>
      </article>;
    })}</div></section>}
    <section className="metadata-info"><div><h3>影片资料</h3><p>{catalog?.director ? `导演 / 主创　${catalog.director}` : group.kind === 'movie' ? selected?.filename : `${entries.length} 个视频文件`}</p>{catalog?.cast?.length ? <p>演员　{catalog.cast.map(person => person.name).join('、')}</p> : null}<p className="metadata-attribution">{catalog ? `资料来源：${{tmdb: 'TMDB', douban: '豆瓣公开条目', tvmaze: 'TVmaze'}[catalog.source]}` : '尚未匹配元数据'}</p></div></section>
    {summary.pending && <p className="watch-sync-note" role="status">观看标记已保存在本机，等待同步到 Trakt。</p>}
    {menu.menu}
    {more && <ActionMenu point={more} title="更多操作" onClose={() => setMore(null)} actions={[
      ...(selected && !selected.unavailable ? [{label: '从头播放', icon: <RotateCcw size={16} />, action: () => {void run('player:play', {id: selected.id, fromBeginning: true});}}] : []),
      {label: '匹配海报与资料', icon: <Search size={16} />, action: () => onMatch(group.itemIds)},
      {label: '修正影片识别', icon: <Pencil size={16} />, action: () => setEditing('all')},
      ...(group.kind === 'episode' && selected ? [{label: '修正所选分集', icon: <Pencil size={16} />, action: () => setEditing(selected)}] : []),
      ...(selected ? [{label: 'Trakt 匹配', icon: <Link2 size={16} />, action: () => onTrakt(selected)}] : []),
      ...(group.kind === 'movie' && selected ? [{label: '从片库移除', icon: <Trash2 size={16} />, separator: true, action: () => {void run('library:remove', selected.id).then(result => {if (result) onBack();});}}] : []),
    ]} />}
    {editing && entries[0] && <Identify ids={editing === 'all' ? group.itemIds : [editing.id]} item={editing === 'all' ? entries[0] : editing} run={run} onClose={() => setEditing(null)} />}
    {synopsis && <Modal title={synopsis.title} className="synopsis-dialog" onClose={() => setSynopsis(null)}><p className="synopsis-full" tabIndex={0}>{synopsis.text}</p></Modal>}
  </div>;
}

function OverviewPreview({text, label, hero = false, onRead}: {text?: string; label: string; hero?: boolean; onRead: (synopsis: {title: string; text: string}) => void}) {
  const [overflowing, setOverflowing] = useState(false);
  const paragraph = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const element = paragraph.current; if (!element) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, [text]);
  if (!text) return null;
  return <div className={`overview-preview ${hero ? 'title-overview' : 'episode-overview'}`}>
    <p ref={paragraph}>{text}</p>
    {overflowing && <button className="overview-more" aria-label={`阅读${label}简介`} aria-haspopup="dialog" onClick={event => {event.stopPropagation(); onRead({title: label, text});}}>更多</button>}
  </div>;
}

function resolutionLabel(width?: number, height?: number) {
  if (!width || !height) return '—';
  // Use both decoded dimensions so widescreen crops retain their source resolution class.
  const nominalHeight = Math.max(Math.min(width, height), Math.max(width, height) * 9 / 16);
  const level = [4320, 2160, 1440, 1080, 720, 576, 480, 360, 240].find(value => nominalHeight >= value * .95);
  return `${level ?? Math.min(width, height)}P`;
}
function audioLabel(info: NonNullable<MediaItem['technical']>) {
  const track = info.audioTracks?.find(track => track.selected) || info.audioTracks?.[0];
  const codec = (track?.codec || info.audio || '').toLowerCase();
  if (!codec) return info.audioTracks?.length === 0 ? '无音轨' : '—';
  const name = ({eac3: 'DDP', 'e-ac-3': 'DDP', 'ec-3': 'DDP', ac3: 'AC3', 'ac-3': 'AC3', truehd: 'TrueHD'} as Record<string, string>)[codec] || codec.toUpperCase();
  // A channel count alone does not establish speaker layout (e.g. 6 channels ≠ necessarily 5.1).
  const layout = (track?.channels || info.channels || '').match(/\b\d+\.[0-2]\b/)?.[0];
  return `${name}${layout || ''}`;
}
function durationLabel(seconds?: number) {
  if (!seconds || !Number.isFinite(seconds) || seconds < 0) return '—';
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分钟` : ''].filter(Boolean).join(' ') || `${Math.floor(seconds)} 秒`;
}
function MediaInfo({item,state,run}: {item: MediaItem;state: AppState;run: Run}) {
  const runner=useRef(run);runner.current=run;
  useEffect(()=>{if(!item.unavailable)void runner.current('media:probe',{id:item.id});},[item.id,item.size,item.fileModifiedAt,item.unavailable]);
  const stored=item.technical, status=state.mediaProbes?.[item.id];
  const info=stored?.verified && (stored.fileSize===undefined || stored.fileSize===item.size) && stored.fileModifiedAt===item.fileModifiedAt ? stored : undefined;
  const range=info?.dolbyVisionProfile || info?.dynamicRange === 'Dolby Vision' ? '杜比视界' : info?.dynamicRange || '—';
  const facts=[['分辨率',info ? resolutionLabel(info.width,info.height) : '—'],['动态范围',range],['音频',info ? audioLabel(info) : '—'],['时长',info ? durationLabel(info.duration) : '—'],['文件大小',bytes(item.size)]];
  const hint=status?.running ? '正在读取媒体信息' : status?.error || (item.unavailable ? '此文件暂时不可用' : '等待读取媒体信息');
  return <dl className="title-media-facts" aria-label="影片媒体信息" aria-busy={Boolean(status?.running)} title={!info ? hint : undefined}>
    {facts.map(([label,value],index)=><div key={label}><dt className="sr-only">{label}</dt><dd>{!info && index===0 && !status?.running && !item.unavailable ? <button className="media-fact-retry" aria-label="重新读取媒体信息" title={`${hint} · 点击重试`} onClick={()=>run('media:probe',{id:item.id,force:true})}>{value}</button> : value}</dd></div>)}
  </dl>;
}

function VersionSelect({entries,selected,run}: {entries: MediaItem[];selected: MediaItem;run: Run}) {
  if(entries.length<2) return null;
  return <label className="version-select"><span>{entries.length} 个版本</span><select aria-label={`选择${selected.kind==='episode' ? `第${selected.episode}集` : ''}播放版本`} value={selected.id} onChange={event=>run('library:version',event.target.value)}>{entries.map(item=><option key={item.id} value={item.id} disabled={item.unavailable}>{versionLabel(item)} · {bytes(item.size)}{!item.technical?.verified ? ` · ${item.filename}` : ''} · {item.source==='baidu'?'网盘':'本地'}{item.unavailable?' · 暂不可用':''}</option>)}</select><small title={selected.path}>{selected.filename}</small></label>;
}

function Identify({ids, item, run, onClose}: {ids: string[]; item: MediaItem; run: Run; onClose: () => void}) {
  const [title, setTitle] = useState(item.seriesTitle ?? item.title), [kind, setKind] = useState(item.kind), [season, setSeason] = useState(item.season ?? 1), [episode, setEpisode] = useState(item.episode ?? 1), [busy, setBusy] = useState(false);
  return <Modal title="修正影片识别" onClose={onClose}><p className="modal-description">相同剧名会自动归为一部剧。修改后保留手动识别结果。</p><label className="field">影片或剧集名称<input value={title} onChange={e => setTitle(e.target.value)} /></label><label className="field">类型<select value={kind} onChange={e => setKind(e.target.value as 'movie' | 'episode')}><option value="movie">电影</option><option value="episode">剧集</option></select></label>{kind === 'episode' && <div className="episode-fields"><label className="field">季数<input type="number" min={0} max={99} value={season} onChange={e => setSeason(Number(e.target.value))} /></label>{ids.length === 1 && <label className="field">集数<input type="number" min={1} max={9999} value={episode} onChange={e => setEpisode(Number(e.target.value))} /></label>}</div>}<p className="section-note">应用到 {ids.length} 个文件{ids.length > 1 ? '，集数保持原值。' : '。'}</p><button className="button primary full" disabled={busy || !title.trim()} onClick={async () => { setBusy(true); if (await run('library:identify', {ids, title, kind, season: kind === 'episode' ? season : undefined, episode: kind === 'episode' && ids.length === 1 ? episode : undefined})) onClose(); setBusy(false); }}>保存识别</button></Modal>;
}

export function MetadataMatch({ids, state, run, onClose}: {ids: string[]; state: AppState; run: Run; onClose: () => void}) {
  const first = state.items.find(item => item.id === ids[0])!;
  const [query, setQuery] = useState(first.title), [kind, setKind] = useState(first.kind), [source, setSource] = useState('auto'), [results, setResults] = useState<CatalogResult[]>([]), [busy, setBusy] = useState(false), [searched, setSearched] = useState(false);
  const search = async () => { setBusy(true); const data = await run<CatalogResult[]>('metadata:search', {query, kind, source}); if (data) {setResults(data); setSearched(true);} setBusy(false); };
  return <Modal title="匹配海报与资料" wide onClose={onClose}><p className="modal-description">{state.scrape.tmdbConfigured ? '优先搜索 TMDB，选择正确的作品以更新全部分集。' : '当前使用公开数据源。在设置中添加 TMDB Token 可获取更完整的资料。'}</p><div className="match-controls"><select aria-label="元数据类型" value={kind} onChange={e => setKind(e.target.value as 'movie' | 'episode')}><option value="movie">电影</option><option value="episode">剧集</option></select><input aria-label="元数据片名" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void search(); }} /><button className="button primary" disabled={busy || !query.trim()} onClick={search}><Search size={15} />{busy ? '处理中' : '搜索'}</button></div><select className="metadata-source" aria-label="元数据来源" value={source} onChange={e => setSource(e.target.value)}><option value="auto">自动 · TMDB 优先</option><option value="tmdb" disabled={!state.scrape.tmdbConfigured}>TMDB</option><option value="public">公开数据源</option></select><div className="match-results">{results.map(result => <button className="match-result" key={`${result.source}:${result.id}`} disabled={busy} onClick={async () => { setBusy(true); if (await run('metadata:match', {ids, selection: result})) onClose(); setBusy(false); }}><span className="result-poster"><Artwork src={result.poster} title={result.title} /></span><div><strong>{result.title} <small>{result.year}</small></strong><small>{result.originalTitle} · {result.source.toUpperCase()} · {result.kind === 'episode' ? '剧集' : '电影'}</small><p>{result.overview?.slice(0, 140)}</p></div><ChevronRight size={17} /></button>)}{searched && !results.length && <Empty icon={<Search size={25} />} title="暂无匹配" text="试试其他片名、原名或年份。" />}</div></Modal>;
}
