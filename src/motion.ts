import {useCallback, useEffect, useRef, useState} from 'react';
import {flushSync} from 'react-dom';

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let pageTransition: Animation | undefined;

// Reveal the new content at its final geometry. View Transition snapshots of
// differently sized/scrolled pages stretch text and can move it twice. Never
// animate page geometry or the native video surface, and never queue navigation.
export function transitionPage(update: () => void, playing = false) {
  pageTransition?.cancel();
  pageTransition = undefined;
  if (playing || reducedMotion()) {update(); return;}
  flushSync(update);
  pageTransition = document.querySelector('.content')?.animate(
    [{opacity: .55}, {opacity: 1}],
    {duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)', id: 'cloudreel-page-reveal'},
  );
}

export function useDismissMotion(onClose: () => void) {
  const [closing, setClosing] = useState(false), close = useRef(onClose), timer = useRef(0), pending = useRef(false);
  close.current = onClose;
  useEffect(() => () => clearTimeout(timer.current), []);
  const dismiss = useCallback(() => {
    if (pending.current) return;
    pending.current = true;
    if (reducedMotion()) {close.current(); return;}
    setClosing(true);
    timer.current = window.setTimeout(() => close.current(), 140);
  }, []);
  return {closing, dismiss};
}
