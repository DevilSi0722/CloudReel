import {useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {Check, Circle, EyeOff, Heart, MoreHorizontal, RefreshCw, RotateCcw} from 'lucide-react';
import type {MediaItem} from './types';
import type {Run} from './ui';
import {continueHidden, watchSummary} from './library';
import {useDismissMotion} from './motion';

export type WatchResult = {pending: boolean; connected: boolean; count: number};
export function WatchBadge({entries}: {entries: MediaItem[]}) {
  const {watched, total, complete, pending} = watchSummary(entries);
  return <>{watched > 0 && <span className={`watch-badge ${complete ? 'complete' : 'partial'}`} title={complete ? '已全部观看' : `已观看 ${watched} / ${total} 集`} aria-label={complete ? '已全部观看' : `已观看 ${watched} / ${total} 集`}>{complete ? <Check size={13} strokeWidth={2.5} /> : <><Circle size={10} />{watched}/{total}</>}</span>}{pending && <span className="watch-pending" title="观看标记等待同步到 Trakt" aria-label="等待同步 Trakt"><RefreshCw size={11} /></span>}</>;
}

type Action = {label: string; icon: ReactNode; action: () => void; separator?: boolean};
export function ActionMenu({point, title, actions, onClose}: {point: {x: number; y: number}; title: string; actions: Action[]; onClose: () => void}) {
  const {closing,dismiss}=useDismissMotion(onClose);
  const ref = useRef<HTMLDivElement>(null), close = useRef(dismiss), previous = useRef(document.activeElement as HTMLElement | null); close.current = dismiss;
  useLayoutEffect(() => {
    const element = ref.current!;
    element.style.left = `${Math.max(10, Math.min(point.x, innerWidth - element.offsetWidth - 10))}px`;
    element.style.top = `${Math.max(10, Math.min(point.y, innerHeight - element.offsetHeight - 10))}px`;
    element.querySelector<HTMLButtonElement>('button')?.focus();
  }, [point]);
  useEffect(() => {
    const outside = (event: Event) => {if (!ref.current?.contains(event.target as Node)) close.current();};
    const key = (event: KeyboardEvent) => {
      if (['Escape', 'Tab'].includes(event.key)) {event.preventDefault(); close.current();}
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const buttons = [...ref.current!.querySelectorAll('button')], current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', key); window.addEventListener('resize', dismiss); window.addEventListener('scroll', outside, true);
    return () => {window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', outside, true); if (previous.current?.isConnected && !previous.current.closest('[role="menu"]')) previous.current.focus({preventScroll: true});};
  }, []);
  return createPortal(<div ref={ref} className={`library-menu ${closing ? 'is-dismissing' : ''}`} role="menu" aria-label={title} onContextMenu={e => e.preventDefault()}><p>{title}</p>{actions.map(action => <button role="menuitem" className={action.separator ? 'menu-divider' : ''} key={action.label} onClick={() => {dismiss(); action.action();}}>{action.icon}<span>{action.label}</span></button>)}</div>, document.body);
}

export function useWatchMenu(run: Run, report?: (result: WatchResult) => void) {
  const [menu, setMenu] = useState<{point: {x: number; y: number}; entries: MediaItem[]; title: string; organize: boolean} | null>(null);
  const open = (event: MouseEvent, entries: MediaItem[], title: string, organize = true) => {event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({point: event.type === 'contextmenu' ? {x: event.clientX, y: event.clientY} : {x: rect.right - 230, y: rect.bottom + 6}, entries, title, organize});};
  const mark = async (entries: MediaItem[], watched: boolean) => {const result = await run<WatchResult>('library:watch', {ids: entries.map(item => item.id), watched}); if (result) report?.(result);};
  const entries = menu?.entries ?? [], summary = watchSummary(entries), ids = entries.map(item => item.id);
  const actions: Action[] = [
    {label: '标记为已观看', icon: <Check size={16} />, action: () => {void mark(entries, true);}},
    {label: '标记为未观看', icon: <Circle size={16} />, action: () => {void mark(entries, false);}}
  ];
  if (menu?.organize) actions.push(
    {label: summary.favorite ? '取消收藏' : '加入收藏', icon: <Heart size={16} />, separator: true, action: () => {void run('library:organize', {ids, favorite: !summary.favorite});}},
    {label: continueHidden(entries) ? '恢复到继续观看' : '从继续观看中隐藏', icon: continueHidden(entries) ? <RotateCcw size={16} /> : <EyeOff size={16} />, action: () => {void run('library:organize', {ids, hidden: !continueHidden(entries)});}}
  );
  return {open, mark, menu: menu && <ActionMenu point={menu.point} title={menu.title} actions={actions} onClose={() => setMenu(null)} />};
}

export function MoreButton({onClick, label = '更多操作'}: {onClick: (event: MouseEvent) => void; label?: string}) {return <button className="icon-button library-more" aria-label={label} title={label} onClick={onClick}><MoreHorizontal size={18} /></button>;}
