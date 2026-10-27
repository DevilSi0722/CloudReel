import {useEffect, useRef, useState, type MouseEvent} from 'react';
import {ChevronLeft, ChevronRight, Pause, Play, Shuffle} from 'lucide-react';
import type {Collection, MediaItem} from './types';
import {Artwork} from './Details';
import TitleArt from './TitleArt';
import {WatchBadge} from './WatchActions';

type Feature = {group: Collection; entries: MediaItem[]};
export default function FeaturedCarousel({items, active, menuOpen, open, context, refresh}: {items: Feature[]; active: boolean; menuOpen: boolean; open: (group: Collection) => void; context: (event: MouseEvent, entries: MediaItem[], title: string) => void; refresh:()=>void}) {
  const [selected, setSelected] = useState(items[0]?.group.id), [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false), [paused, setPaused] = useState(false);
  const [inView, setInView] = useState(true), [pageVisible, setPageVisible] = useState(!document.hidden), [reduced, setReduced] = useState(matchMedia('(prefers-reduced-motion: reduce)').matches);
  const root = useRef<HTMLElement>(null), ids = items.map(item => item.group.id), identity = ids.join('|');
  const index = Math.max(0, ids.indexOf(selected)), current = items[index];
  const stopped = paused || hovered || focused || menuOpen || !active || !inView || !pageVisible || reduced;
  useEffect(() => {if (!ids.includes(selected)) setSelected(ids[0]);}, [identity, selected]);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {threshold: .15});
    if (root.current) observer.observe(root.current);
    const visibility = () => setPageVisible(!document.hidden), preference = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(preference.matches);
    document.addEventListener('visibilitychange', visibility); preference.addEventListener('change', change);
    return () => {observer.disconnect(); document.removeEventListener('visibilitychange', visibility); preference.removeEventListener('change', change);};
  }, []);
  useEffect(() => {
    if (stopped || items.length < 2) return;
    const timer = setTimeout(() => setSelected(ids[(index + 1) % ids.length]), 8000);
    return () => clearTimeout(timer);
  }, [stopped, index, identity]);
  const step = (offset: number) => setSelected(ids[(index + offset + ids.length) % ids.length]);
  if (!current) return null;
  return <section ref={root} className="featured" role="region" aria-roledescription="轮播" aria-label="精选影片"
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onPointerDownCapture={() => setFocused(false)} onFocusCapture={event => setFocused(event.target.matches(':focus-visible'))} onBlurCapture={event => {if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);}}
    onKeyDown={event => {setFocused(true); if (!event.altKey && !event.ctrlKey && !event.metaKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {event.preventDefault(); step(event.key === 'ArrowLeft' ? -1 : 1);}}}
    onContextMenu={event => context(event, current.entries, current.group.title)}>
    {items.map(({group, entries}, n) => <div key={group.id} className={`featured-slide ${n === index ? 'is-active' : ''}`} aria-hidden={n !== index} inert={n !== index} role="group" aria-roledescription="幻灯片" aria-label={`${n + 1} / ${items.length} · ${group.title}`}>
      <div className="featured-image"><Artwork src={group.catalog?.backdrop ?? group.catalog?.poster} title="" wide /></div>
      <div className="featured-copy"><span className="eyebrow">精选</span><h2 className="featured-title"><TitleArt src={group.catalog?.logo} title={group.title} fallback={group.title} /></h2><p>{group.catalog?.overview?.slice(0, 125)}</p><button className="button frosted" onClick={() => open(group)}>查看影片 <ChevronRight size={15} /></button></div>
      <WatchBadge entries={entries} />
    </div>)}
    <div className="featured-navigation">
      <button className="featured-refresh" aria-label="换一组精选" title="每日精选 · 换一组" onClick={refresh}><Shuffle size={15} /></button>
      {items.length > 1 && <>
      {!reduced && <button className="featured-toggle" aria-label={paused ? '继续轮播' : '暂停轮播'} title={paused ? '继续轮播' : '暂停轮播'} onClick={() => setPaused(value => !value)}>{paused ? <Play size={12} fill="currentColor" /> : <Pause size={12} fill="currentColor" />}</button>}
      <button className="featured-arrow" aria-label="上一部精选" onClick={() => step(-1)}><ChevronLeft size={16} /></button>
      <div className="featured-dots" aria-label="选择精选影片">{items.map(({group}, n) => <button key={group.id} aria-label={`精选 ${n + 1}：${group.title}`} aria-pressed={n === index} onClick={() => setSelected(group.id)}><span /></button>)}</div>
      <button className="featured-arrow" aria-label="下一部精选" onClick={() => step(1)}><ChevronRight size={16} /></button>
      </>}
    </div>
  </section>;
}
