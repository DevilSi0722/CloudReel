import {useCallback, useEffect, useRef, type PointerEvent, type ReactNode} from 'react';
import {Play} from 'lucide-react';
import {Artwork} from './Details';

// The hit target never transforms. Only its visual surface tilts, so moving
// near an edge cannot repeatedly enter/leave the card or shake its caption.
export default function PosterCard({src, title, children, onClick}: {src?: string; title: string; children?: ReactNode; onClick: () => void}) {
  const root = useRef<HTMLButtonElement>(null), frame = useRef(0), point = useRef({x: 0, y: 0});
  const preferences = useRef<{reduced: MediaQueryList; pointer: MediaQueryList} | null>(null), pressed = useRef(false);
  const reset = useCallback(() => {
    cancelAnimationFrame(frame.current); frame.current = 0; pressed.current = false;
    window.removeEventListener('blur', reset); window.removeEventListener('scroll', reset, true); window.removeEventListener('resize', reset);
    document.removeEventListener('visibilitychange', reset);
    preferences.current?.reduced.removeEventListener('change', reset); preferences.current?.pointer.removeEventListener('change', reset);
    const element = root.current; if (!element) return;
    delete element.dataset.tilting;
    for (const property of ['--tilt-x', '--tilt-y', '--poster-pan-x', '--poster-pan-y']) element.style.removeProperty(property);
  }, []);
  useEffect(() => {
    preferences.current = {reduced: matchMedia('(prefers-reduced-motion: reduce)'), pointer: matchMedia('(hover: hover) and (pointer: fine)')};
    return reset;
  }, [reset]);
  const enabled = () => preferences.current && !preferences.current.reduced.matches && preferences.current.pointer.matches;
  const track = (event: PointerEvent<HTMLButtonElement>) => {
    if (!enabled() || event.pointerType !== 'mouse' || pressed.current || event.buttons) return;
    point.current = {x: event.clientX, y: event.clientY};
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const element = root.current; if (!element || !enabled()) return;
      const rect = element.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (point.current.x - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (point.current.y - rect.top) / rect.height));
      // Four degrees at the edges, with at most two pixels of image parallax.
      element.style.setProperty('--tilt-x', `${((.5 - y) * 8).toFixed(2)}deg`);
      element.style.setProperty('--tilt-y', `${((x - .5) * 8).toFixed(2)}deg`);
      element.style.setProperty('--poster-pan-x', `${((x - .5) * 4).toFixed(2)}px`);
      element.style.setProperty('--poster-pan-y', `${((y - .5) * 4).toFixed(2)}px`);
      element.style.setProperty('--poster-light-x', `${(x * 100).toFixed(1)}%`);
      element.style.setProperty('--poster-light-y', `${(y * 100).toFixed(1)}%`);
      if (!element.dataset.tilting) {
        element.dataset.tilting = 'true';
        // Only the card under the pointer subscribes to global cancellation.
        window.addEventListener('blur', reset); window.addEventListener('scroll', reset, true); window.addEventListener('resize', reset);
        document.addEventListener('visibilitychange', reset);
        preferences.current!.reduced.addEventListener('change', reset); preferences.current!.pointer.addEventListener('change', reset);
      }
    });
  };
  return <button ref={root} className="collection-poster dimensional-poster" aria-label={`${title} 详情`} onClick={onClick}
    onPointerEnter={track} onPointerMove={track} onPointerLeave={reset} onPointerCancel={reset} onBlur={reset} onContextMenu={reset}
    onPointerDown={() => {reset(); pressed.current = true;}} onPointerUp={event => {pressed.current = false; track(event);}}>
    <span className="poster-surface">
      <span className="poster-art"><Artwork src={src} title={title} /></span>
      <span className="poster-hover"><Play size={27} fill="currentColor" /></span>
      {children}
      <span className="poster-light" aria-hidden="true" />
    </span>
  </button>;
}
