import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {ArrowLeft, AudioLines, Check, Expand, FastForward, Gauge, Keyboard, ListVideo, ListTree, LoaderCircle, Minimize, Pause, Play, Rewind, SkipBack, SkipForward, Subtitles, Upload, Volume2, VolumeX, X} from 'lucide-react';
import {bridge} from './bridge';
import type {AppState} from './types';
import type {Run} from './ui';
import {episodeLabel, isWatched} from './library';
import {playerPopoverPosition} from './player-layout';
import {episodeChoices} from '../electron/core/versions.mjs';
import {Artwork} from './Details';
import PlayerTimeline from './PlayerTimeline';
import PlayerNavigation from './PlayerNavigation';

type Menu = 'audio' | 'sub' | 'speed' | 'help' | 'chapters' | null;
export default function Player({state, run, error = ''}: {state: AppState; run: Run; error?: string}) {
  const player = state.player!, item = state.items.find(entry => entry.id === player.itemId);
  const group = state.collections.find(entry => entry.itemIds.includes(player.itemId));
  const episodes = episodeChoices(group?.itemIds.map(id => state.items.find(entry => entry.id === id)).filter(entry => !!entry) ?? [], player.itemId);
  const next = state.items.find(entry=>entry.id===player.upNext?.itemId);
  const [list, setList] = useState(false), [menu, setMenu] = useState<Menu>(null), [visible, setVisible] = useState(true);
  const [scrubbing, setScrubbing] = useState(false), [previewing, setPreviewing] = useState(false), [season, setSeason] = useState(item?.season ?? 1), [hintVisible, setHintVisible] = useState(false);
  const root = useRef<HTMLElement>(null), latest = useRef(player), timer = useRef(0), runner = useRef(run), rightHeld = useRef(false);
  runner.current = run;
  const pinned = useRef(false), pointerPosition = useRef({x: NaN, y: NaN}), suppressVideoUntil = useRef(0), outside = useRef(false);
  latest.current = player; pinned.current = list || menu !== null || scrubbing || previewing;
  const reveal = useCallback(() => {
    if (outside.current) return;
    setVisible(true); window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {if (!pinned.current && !latest.current.paused && latest.current.ready) {setVisible(false); (document.activeElement as HTMLElement)?.blur();}}, 3000);
  }, []);
  useEffect(() => {reveal(); return () => window.clearTimeout(timer.current);}, [reveal, player.itemId, player.paused, player.ready, player.fullscreen, list, menu, scrubbing, previewing]);
  useEffect(() => bridge.onPlayerActivity?.(reveal), [reveal]);
  useEffect(() => {const old = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => {document.body.style.overflow = old;};}, []);
  useEffect(() => {setSeason(item?.season ?? 1); setScrubbing(false); setMenu(null); outside.current = false; reveal();}, [player.itemId]);
  const leave = useCallback(() => {outside.current = true; window.clearTimeout(timer.current); if (!pinned.current || !document.querySelector('.is-scrubbing')) {setMenu(null); setList(false); setVisible(false);}}, []);
  useEffect(() => bridge.onPlayerPointer?.(inside => {if (inside) {outside.current = false; reveal();} else leave();}), [leave, reveal]);
  useEffect(() => {document.documentElement.classList.toggle('player-cursor-hidden', state.runtime.playerOverlay && !visible); return () => document.documentElement.classList.remove('player-cursor-hidden');}, [visible, state.runtime.playerOverlay]);
  useEffect(() => {const remaining = (player.hint?.until ?? 0) - Date.now(); setHintVisible(remaining > 0); const id = window.setTimeout(() => setHintVisible(false), Math.max(0, remaining)); return () => clearTimeout(id);}, [player.hint?.until]);
  useLayoutEffect(() => {
    const element = root.current; if (!element || !menu && !list) return;
    const position = () => {
      const panel = element.querySelector<HTMLElement>('.player-menu,.cinema-episodes');
      const anchor = element.querySelector<HTMLElement>(`[data-player-anchor="${menu ?? 'episodes'}"]`);
      const bar = element.querySelector<HTMLElement>('.cinema-controls');
      if (!panel || !anchor || !bar) return;
      // Clear the previous height cap before measuring after a resize.
      panel.style.maxHeight = 'none'; panel.style.height = '';
      const r = element.getBoundingClientRect(), button = anchor.getBoundingClientRect();
      const panelWidth = panel.offsetWidth, panelHeight = list ? r.height : panel.offsetHeight;
      const result = playerPopoverPosition({x: button.x - r.x, y: bar.offsetTop, width: button.width, height: bar.offsetHeight}, {width: panelWidth, height: panelHeight}, {width: r.width, height: r.height}, 'above');
      Object.assign(panel.style, {left: `${result.left}px`, top: `${result.top}px`, right: 'auto', bottom: 'auto', maxHeight: `${result.maxHeight}px`, ...(list ? {height: `${Math.min(panelHeight, result.maxHeight)}px`} : {})});
    };
    position();
    const observer = new ResizeObserver(position); observer.observe(element);
    window.addEventListener('resize', position);
    return () => {observer.disconnect(); window.removeEventListener('resize', position);};
  }, [menu, list, player.fullscreen, player.itemId, player.tracks.length, player.chapters?.length]);
  useLayoutEffect(() => {
    if (!state.runtime.playerOverlay) return;
    const layout = () => {
        const elements = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-overlay-region]') ?? []);
        const persistent = elements.some(element => element.dataset.persistent === 'true');
        const opacity = Number(getComputedStyle(root.current!.querySelector('.cinema-controls')!).opacity);
        const regions = elements.filter(element => visible || opacity > 0 || element.dataset.persistent === 'true').map(element => {
          const r = element.getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height, radius: parseFloat(getComputedStyle(element).borderRadius) || 0};
        });
        const element = root.current!, bar = element.querySelector<HTMLElement>('.cinema-controls')!;
        // Use the settled layout, not the entrance transform. Only subtitles
        // move; the native video viewport never participates in control layout.
        const subtitleLayout = {itemId: player.itemId, visible: visible || opacity > 0 || Boolean(next), height: element.clientHeight,
          bottomInset: element.clientHeight - bar.offsetTop + 16};
        void bridge.invoke('player:overlayRegions', {regions, opacity: persistent ? 1 : opacity, subtitleLayout, cursorHidden: !visible}).catch(() => {});
    };
    // Report visual panel bounds after their entrance motion has settled.
    layout(); const settled = window.setTimeout(layout, 340);
    window.addEventListener('resize', layout);
    return () => {clearTimeout(settled); window.removeEventListener('resize', layout);};
  }, [visible, list, menu, player.itemId, player.fullscreen, player.ready, error, player.loadError, Boolean(player.switching), player.boosting, hintVisible, Boolean(next), state.runtime.playerOverlay]);
  useEffect(() => {
    const shortcut = (action: string) => {void runner.current('player:shortcut', action);};
    const escape = () => {if (menu) setMenu(null); else if (list) setList(false); else void runner.current(latest.current.fullscreen ? 'player:fullscreen' : 'player:stop'); reveal();};
    const key = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
      if (event.key === 'Tab') {reveal(); return;}
      if (event.key === 'Escape') {
        event.preventDefault(); if (!event.repeat) escape(); return;
      }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || (event.target as HTMLElement)?.isContentEditable) return;
      const name = event.key.toLowerCase();
      // Focused buttons retain Space/Enter activation; all other shortcuts work.
      if (event.target instanceof HTMLButtonElement && [' ', 'enter'].includes(name)) return;
      if (name === '?') {event.preventDefault(); if (!event.repeat) {setList(false); setMenu(value => value === 'help' ? null : 'help');} reveal(); return;}
      const actions: Record<string, string> = {' ': 'pause', k: 'pause', p: 'pause', arrowright: 'right-down', arrowleft: 'backward', arrowup: 'volume-up', arrowdown: 'volume-down', f: 'fullscreen', enter: 'fullscreen', m: 'mute', q: 'exit', '[': 'previous', ']': 'next'};
      const action = actions[name]; if (!action) return;
      event.preventDefault();
      if (event.repeat && !['arrowleft', 'arrowup', 'arrowdown'].includes(name)) return;
      if (name === 'arrowright') rightHeld.current = true;
      shortcut(action); reveal();
    };
    const up = (event: KeyboardEvent) => {if (event.key === 'ArrowRight' && rightHeld.current) {rightHeld.current = false; event.preventDefault(); shortcut('right-up');}};
    const blur = () => {rightHeld.current = false; shortcut('cancel');};
    const off = bridge.onPlayerAction?.(action => {if (action === 'escape') escape(); if (action === 'help') {setList(false); setMenu(value => value === 'help' ? null : 'help'); reveal();}});
    window.addEventListener('keydown', key); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    return () => {window.removeEventListener('keydown', key); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); off?.();};
  }, [menu, list, reveal]);
  useEffect(() => () => {void runner.current('player:shortcut', 'cancel');}, []);
  const index = episodes.findIndex(entry => entry.id === player.itemId);
  const seek = (value: number) => {void run('player:seek', value); reveal();};
  const toggleMenu = (next: Menu) => {setList(false); setMenu(menu === next ? null : next); reveal();};
  const skipIntro = state.playbackDefaults?.skipIntro !== 'off' && Boolean(player.markers?.introEnd) && player.position < player.markers!.introEnd!;
  const skipCredits = state.playbackDefaults?.skipIntro !== 'off' && Boolean(player.markers?.creditsStart) && player.position >= player.markers!.creditsStart! && player.duration - player.position > 1;
  const tracks = player.tracks.filter(track => track.type === menu);
  const currentTrack = menu === 'audio' ? player.aid : player.sid;
  return <section ref={root} className={`cinema ${state.runtime.playerOverlay ? 'cinema-overlay' : 'cinema-preview'} ${visible ? 'controls-visible' : 'controls-hidden'}`} aria-label="视频播放器"
    onDragOver={event=>{event.preventDefault();reveal();}} onDrop={event=>{event.preventDefault();const files=[...event.dataTransfer.files].map(file=>bridge.filePath?.(file)).filter(Boolean);if(files.length) void run('player:dropSubtitles',files);}}
    onPointerEnter={() => {outside.current = false; reveal();}} onPointerLeave={leave}
    onPointerMove={event => {const point = {x: event.screenX, y: event.screenY}; if (pointerPosition.current.x === point.x && pointerPosition.current.y === point.y) return; pointerPosition.current = point; outside.current = false; reveal();}}
    onPointerDownCapture={event => {if ((menu || list) && !(event.target as HTMLElement).closest('.player-menu,.cinema-episodes,button,input,select,a,[role="button"]')) {event.preventDefault(); suppressVideoUntil.current = Date.now() + 500; setMenu(null); setList(false); reveal();}}}
    onPointerUpCapture={() => {if (state.runtime.playerOverlay) void bridge.invoke('player:activate').catch(() => {});}}
    onClick={e => {if (e.target === e.currentTarget && Date.now() >= suppressVideoUntil.current) void run('player:shortcut', 'click');}} onDoubleClick={e => {if (e.target === e.currentTarget && Date.now() >= suppressVideoUntil.current) void run('player:shortcut', 'double-click');}}
    onWheel={e => {if (e.target === e.currentTarget && e.deltaY !== 0) void run('player:shortcut', e.deltaY < 0 ? 'volume-up' : 'volume-down');}}>
    <div className="cinema-top-shade" />
    <header className="cinema-header" data-overlay-region>
      <button className="icon-button" title="返回片库" aria-label="退出播放" onClick={() => run('player:stop')}><ArrowLeft size={21} /></button>
      <div><strong>{group?.title ?? player.title}</strong>{item?.kind === 'episode' && <span>{episodeLabel(item)}{item.episodeMetadata?.title ? ` · ${item.episodeMetadata.title}` : ''}</span>}</div>
    </header>
    {(error || player.loadError) && <div className="player-error glass-panel" data-overlay-region role="alert">{error || player.loadError}</div>}
    {player.switching && <div className="player-feedback glass-panel" data-overlay-region data-persistent="true" role="status"><LoaderCircle size={17} className="spin" />正在准备 · {player.switching.title}</div>}
    {list && <aside className="cinema-episodes glass-panel" data-overlay-region aria-label="分集选择">
      <div className="episode-panel-title"><h2>选集</h2><button className="icon-button" title="关闭选集" aria-label="关闭选集" onClick={() => setList(false)}><X size={18} /></button></div>
      <select aria-label="播放器季数" value={season} onChange={e => setSeason(Number(e.target.value))}>{group?.seasons.map(n => <option value={n} key={n}>{n === 0 ? '特别篇' : `第 ${n} 季`}</option>)}</select>
      <div className="cinema-episode-scroll">{episodes.filter(entry => (entry.season ?? 1) === season).map(entry => <button className={`cinema-episode ${entry.id === player.itemId ? 'active' : ''}`} disabled={Boolean(player.switching)} key={entry.id} onClick={() => {setList(false);void run('player:play', {id: entry.id});}}>
        <span className="episode-number">{entry.id === player.itemId ? <Play size={13} fill="currentColor" /> : String(entry.episode ?? '').padStart(2, '0')}</span><span><strong>{entry.episodeMetadata?.title || `第 ${entry.episode ?? '?'} 集`}</strong>{entry.episodeMetadata?.runtime && <small>{entry.episodeMetadata.runtime} 分钟</small>}</span>{isWatched(entry) && <Check size={14} />}
      </button>)}</div>
    </aside>}
    {menu && <div className={`player-menu glass-panel menu-${menu}`} data-overlay-region role={menu === 'help' ? 'dialog' : 'menu'} aria-label={menu === 'help' ? '快捷键说明' : menu === 'speed' ? '播放速度' : menu === 'chapters' ? '章节与片头片尾' : menu === 'audio' ? '音轨' : '字幕'}>
      <div className="player-menu-heading"><span>{menu === 'help' ? '快捷键' : menu === 'speed' ? '播放速度' : menu === 'chapters' ? '章节与片头片尾' : menu === 'audio' ? '音轨' : '字幕'}</span><button className="icon-button" aria-label="关闭菜单" onClick={() => setMenu(null)}><X size={15} /></button></div>
      <div className="player-menu-options">{menu === 'chapters' ? <PlayerNavigation player={player} item={item} run={run} onChapter={() => setMenu(null)} /> : menu === 'help' ? <dl className="shortcut-list">{[['单击画面 / 空格 / K', '播放、暂停'], ['双击画面 / F', '切换全屏'], ['← / →', '后退、前进 5 秒'], ['按住 →', '临时 3 倍速，松开恢复'], ['↑ / ↓ / 画面滚轮', '调节音量'], ['M', '静音'], ['[ / ]', '上一集、下一集'], ['Esc', '关闭浮层、退出全屏或播放'], ['?', '快捷键说明']].map(([key, label]) => <div key={key}><dt>{key}</dt><dd>{label}</dd></div>)}</dl> : menu === 'speed' ? [.25, .5, .75, 1, 1.25, 1.5, 1.75, 2, 3, 4].map(speed => <button key={speed} role="menuitemradio" aria-checked={player.speed === speed} onClick={() => {void run('player:control', {speed}); setMenu(null);}}><span>{speed === 1 ? '正常' : `${speed}×`}</span>{player.speed === speed && <Check size={15} />}</button>) : <>
        <button role="menuitemradio" aria-checked={currentTrack === 'no'} onClick={() => {void run('player:control', {[menu === 'audio' ? 'aid' : 'sid']: 'no'}); setMenu(null);}}><span>{menu === 'audio' ? '关闭音频' : '关闭字幕'}</span>{currentTrack === 'no' && <Check size={15} />}</button>
        {tracks.map(track => <button key={track.id} role="menuitemradio" aria-checked={currentTrack === track.id || track.selected} onClick={() => {void run('player:control', {[menu === 'audio' ? 'aid' : 'sid']: track.id}); setMenu(null);}}><span>{track.title || track.lang || `${menu === 'audio' ? '音轨' : '字幕'} ${track.id}`}<small>{track.title && track.lang ? track.lang : track.codec}</small></span>{(currentTrack === track.id || track.selected) && <Check size={15} />}</button>)}
        {!tracks.length && <p className="player-menu-empty">{menu === 'audio' ? '暂无音轨' : player.subtitlesLoading ? '正在匹配字幕…' : '暂无可用字幕'}</p>}
        {menu === 'sub' && <SubtitleSettings player={player} run={run} />}
      </>}</div>
    </div>}
    {next && player.upNext && <aside className="up-next glass-panel" data-overlay-region data-persistent="true" aria-label="接下来观看"><div className="up-next-art"><Artwork wide src={next.episodeMetadata?.still ?? next.catalog?.backdrop} title={next.episodeMetadata?.title || next.title} /></div><div className="up-next-copy"><small>接下来 · {player.upNext.paused ? '已暂停倒计时' : `${player.upNext.remaining} 秒后播放`}</small><strong>{next.episodeMetadata?.title || next.title}</strong><span>{episodeLabel(next)}</span><button className="button secondary compact" onClick={()=>run('player:play',{id:next.id})}><Play size={13} fill="currentColor" />立即播放</button></div><button className="icon-button" aria-label="取消自动连播" title="取消自动连播" onClick={()=>run('player:cancelNext')}><X size={15} /></button></aside>}
    {(player.boosting || hintVisible) && <div className="player-feedback glass-panel" data-overlay-region data-persistent="true" role="status">{player.boosting ? <><Gauge size={17} />{Math.max(3, player.speed)}× 快进中</> : player.hint?.text}</div>}
    {(skipIntro || skipCredits) && !player.switching && <button className="skip-section glass-panel" data-overlay-region onClick={() => run('player:skipSection', {itemId: player.itemId, section: skipIntro ? 'intro' : 'credits'})}><SkipForward size={16} />{skipIntro ? '跳过片头' : '跳过片尾'}</button>}
    <footer className="cinema-controls glass-panel" data-overlay-region>
      <PlayerTimeline enabled={visible && !menu && !list} player={player} run={run} onDrag={setScrubbing} onPreview={setPreviewing} onActivity={reveal} />
      <div className="transport"><div className="transport-left"><button className="icon-button" title={player.muted ? '取消静音' : '静音'} aria-label={player.muted ? '取消静音' : '静音'} onClick={() => run('player:control', {muted: !player.muted})}>{player.muted || !player.volume ? <VolumeX size={20} /> : <Volume2 size={20} />}</button><input className="volume-slider" aria-label="音量" type="range" min={0} max={100} value={player.volume} onChange={e => run('player:control', {volume: Number(e.target.value)})} />{player.video?.source && player.video.output && player.video.source !== 'SDR' && <span className="video-quality" title={[player.video.source + (player.video.dolbyVisionProfile ? ` P${player.video.dolbyVisionProfile}` : ''), `${player.video.output} 输出`, player.video.peakNits ? `目标峰值 ${Math.round(player.video.peakNits)} 尼特` : '', player.video.outputTransfer, player.video.pixelFormat].filter(Boolean).join(' · ')}>{player.video.source === 'Dolby Vision' ? `DV → ${player.video.output}` : player.video.output === 'SDR' ? `${player.video.source} → SDR` : player.video.source}</span>}</div>
        <div className="transport-center"><button className="icon-button" title="上一集" aria-label="上一集" disabled={item?.kind !== 'episode' || index < 1} onClick={() => run('player:adjacent', -1)}><SkipBack size={19} /></button><button className="icon-button seek-button" title="后退 10 秒" aria-label="后退 10 秒" onClick={() => seek((player.seek?.pending ? player.seek.target : player.position) - 10)}><Rewind size={21} fill="currentColor" strokeWidth={1.5} /></button><button className="play-toggle" title={player.paused ? '继续播放' : '暂停'} aria-label={player.paused ? '继续播放' : '暂停播放'} onClick={() => run('player:pause')}>{(!player.ready || player.buffering) ? <LoaderCircle size={23} className="spin playback-spinner" aria-label={player.ready ? '缓冲中' : '正在载入'} /> : player.paused ? <Play size={23} fill="currentColor" /> : <Pause size={23} fill="currentColor" />}</button><button className="icon-button seek-button" title="前进 10 秒" aria-label="前进 10 秒" onClick={() => seek((player.seek?.pending ? player.seek.target : player.position) + 10)}><FastForward size={21} fill="currentColor" strokeWidth={1.5} /></button><button className="icon-button" title="下一集" aria-label="下一集" disabled={item?.kind !== 'episode' || index === episodes.length - 1} onClick={() => run('player:adjacent', 1)}><SkipForward size={19} /></button></div>
        <div className="transport-right"><button className={`icon-button ${menu === 'chapters' ? 'selected' : ''}`} data-player-anchor="chapters" title="章节与片头片尾" aria-label="章节与片头片尾" aria-expanded={menu === 'chapters'} onClick={() => toggleMenu('chapters')}><ListTree size={21} /></button><button className="icon-button" data-player-anchor="help" title="快捷键 · ?" aria-label="快捷键说明" aria-expanded={menu === 'help'} onClick={() => toggleMenu('help')}><Keyboard size={19} /></button><button className={`icon-button speed-button ${menu === 'speed' ? 'selected' : ''}`} title={`播放速度 · ${player.speed}×`} aria-label="播放倍速" data-player-anchor="speed" aria-expanded={menu === 'speed'} onClick={() => toggleMenu('speed')}><Gauge size={21} />{player.speed !== 1 && <small>{player.speed}×</small>}</button><button className={`icon-button ${menu === 'audio' ? 'selected' : ''}`} title="音轨" aria-label="音轨" data-player-anchor="audio" aria-expanded={menu === 'audio'} onClick={() => toggleMenu('audio')}><AudioLines size={21} /></button><button className={`icon-button ${menu === 'sub' ? 'selected' : ''}`} title="字幕" aria-label="字幕" data-player-anchor="sub" aria-expanded={menu === 'sub'} onClick={() => toggleMenu('sub')}><Subtitles size={21} /></button>{item?.kind === 'episode' && <button className={`icon-button ${list ? 'selected' : ''}`} title="选集" aria-label="分集选择" data-player-anchor="episodes" aria-expanded={list} onClick={() => {setMenu(null); setList(!list); reveal();}}><ListVideo size={22} /></button>}<button className="icon-button" title={player.fullscreen ? '退出全屏' : '全屏'} aria-label={player.fullscreen ? '退出全屏' : '全屏'} onClick={() => run('player:fullscreen')}>{player.fullscreen ? <Minimize size={20} /> : <Expand size={20} />}</button></div>
      </div>
    </footer>
  </section>;
}

function SubtitleSettings({player,run}: {player: AppState['player'] & {};run: Run}) {
  const style=player.subtitleStyle ?? {delay:0,size:44,font:'Microsoft YaHei'};
  return <div className="subtitle-settings"><button className="subtitle-import" onClick={()=>run('player:importSubtitle')}><Upload size={15} />添加字幕文件</button><label>字幕延迟<div className="subtitle-stepper"><button aria-label="字幕提前半秒" onClick={()=>run('player:control',{subtitleDelay:Math.max(-120,style.delay-.5)})}>−</button><output>{style.delay>0?'+':''}{style.delay.toFixed(1)} 秒</output><button aria-label="字幕延后半秒" onClick={()=>run('player:control',{subtitleDelay:Math.min(120,style.delay+.5)})}>＋</button><button aria-label="重置字幕延迟" onClick={()=>run('player:control',{subtitleDelay:0})}>重置</button></div></label><label>字号<input aria-label="字幕字号" type="range" min="20" max="80" value={style.size} onChange={event=>run('player:control',{subtitleSize:Number(event.target.value)})}/><output>{style.size}</output></label><label>字体<select aria-label="字幕字体" value={style.font} onChange={event=>run('player:control',{subtitleFont:event.target.value})}>{['Microsoft YaHei','Microsoft YaHei UI','SimHei','SimSun','Arial','Segoe UI'].map(font=><option key={font}>{font}</option>)}</select></label><p>可直接拖入字幕文件。ASS 保留原有排版；字体与字号主要用于纯文本字幕。</p><button className="text-button" onClick={()=>run('player:resetPreferences')}>重置此作品的播放偏好</button></div>;
}
