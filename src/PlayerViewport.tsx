import {useEffect, useLayoutEffect, useRef} from 'react';
import {bridge} from './bridge';
import type {AppState} from './types';

export default function PlayerViewport({state}: {state: AppState}) {
  const video = useRef<HTMLDivElement>(null);
  useEffect(() => {const old = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => {document.body.style.overflow = old;};}, []);
  useLayoutEffect(() => {
    const element = video.current; if (!element) return;
    let frame = 0;
    const layout = () => {cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {const r = element.getBoundingClientRect(); void bridge.invoke('player:bounds', {x:r.x, y:r.y, width:r.width, height:r.height}).catch(() => {});});};
    const observer = new ResizeObserver(layout); observer.observe(element); window.addEventListener('resize', layout); window.addEventListener('focus', layout); document.addEventListener('visibilitychange', layout); layout();
    return () => {cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', layout); window.removeEventListener('focus', layout); document.removeEventListener('visibilitychange', layout);};
  }, [state.player?.itemId, state.runtime.fullscreen]);
  return <section className={`player-viewport ${state.runtime.windowChrome && !state.runtime.fullscreen ? 'with-chrome' : ''}`} aria-label="视频画面"><div ref={video} className="video-surface" /></section>;
}
