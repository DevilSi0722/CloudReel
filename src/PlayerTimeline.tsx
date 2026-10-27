import {useEffect, useRef, useState, type CSSProperties, type PointerEvent} from 'react';
import type {PlayerStatus} from './types';
import type {Run} from './ui';
import {clock} from './library';

// Pointer previews are local and frame-batched. Only release sends a seek;
// keep the target visible until the player confirms a decoded position.
export default function PlayerTimeline({player, run, onDrag, onActivity}: {player: PlayerStatus; run: Run; onDrag: (active: boolean) => void; onActivity: () => void}) {
  const [draft, setDraft] = useState<number | null>(null), [pending, setPending] = useState<{id: string; target: number} | null>(null);
  const pointer = useRef<number | null>(null), value = useRef<number | null>(null), frame = useRef(0), sequence = useRef(0), current = useRef(player.itemId);
  current.current = player.itemId;
  const preview = (next: number) => {value.current = next; if (!frame.current) frame.current = requestAnimationFrame(() => {frame.current = 0; setDraft(value.current);});};
  const clearDraft = () => {cancelAnimationFrame(frame.current); frame.current = 0; value.current = null; setDraft(null); onDrag(false);};
  const cancel = () => {pointer.current = null; clearDraft();};
  const commit = async (next: number) => {
    const itemId = player.itemId, id = `timeline-${Date.now()}-${++sequence.current}`, target = Math.max(0, Math.min(player.duration - .1, next));
    setPending({id, target}); clearDraft(); onActivity();
    const result = await run<{id: string; target: number}>('player:seek', {seconds: target, itemId, requestId: id});
    if (current.current !== itemId) return;
    if (!result) setPending(old => old?.id === id ? null : old);
  };
  useEffect(() => {if (pending && player.seek?.id === pending.id && !player.seek.pending) setPending(null);}, [pending?.id, player.seek?.id, player.seek?.pending]);
  useEffect(() => {if (!pending) return; const id = setTimeout(() => setPending(old => old?.id === pending.id ? null : old), 21000); return () => clearTimeout(id);}, [pending?.id]);
  useEffect(() => {cancel(); setPending(null); return () => cancelAnimationFrame(frame.current);}, [player.itemId]);
  const atPointer = (event: PointerEvent<HTMLInputElement>) => {const rect = event.currentTarget.getBoundingClientRect(); return Math.max(0, Math.min(1, (event.clientX - rect.left - 6) / Math.max(1, rect.width - 12))) * player.duration;};
  const shown = draft ?? pending?.target ?? (player.seek?.pending ? player.seek.target : player.position), percent = Math.max(0, Math.min(100, shown / (player.duration || 1) * 100));
  return <div className={`timeline ${draft !== null ? 'is-scrubbing' : ''} ${pending || player.seek?.pending ? 'is-seeking' : ''}`}>
    <time>{clock(shown)}</time><div className="timeline-track">
      {(draft !== null || pending || player.seek?.pending) && <span className="timeline-preview" style={{left: `clamp(38px, ${percent}%, calc(100% - 38px))`}}>{draft === null ? '跳转中 · ' : ''}{clock(shown)}</span>}
      <input aria-label="播放进度" aria-valuetext={`${clock(shown)} / ${clock(player.duration)}`} type="range" min={0} max={player.duration || 1} step={.1} value={shown} disabled={!player.duration} style={{'--played': `${percent}%`} as CSSProperties}
        onPointerDown={event => {if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({preventScroll: true}); pointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); onDrag(true); preview(atPointer(event)); onActivity();}}
        onPointerMove={event => {if (pointer.current !== event.pointerId) return; event.preventDefault(); event.stopPropagation(); preview(atPointer(event));}}
        onPointerUp={event => {if (pointer.current !== event.pointerId) return; event.preventDefault(); event.stopPropagation(); const next = atPointer(event); pointer.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); void commit(next);}}
        onPointerCancel={cancel} onLostPointerCapture={() => {if (pointer.current !== null) cancel();}} onBlur={() => {if (pointer.current === null && value.current !== null) clearDraft();}}
        onChange={event => {if (pointer.current === null) {onDrag(true); preview(Number(event.target.value)); onActivity();}}}
        onKeyUp={event => {if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key) && value.current !== null) void commit(value.current);}} />
    </div><time>{clock(player.duration)}</time>
    {player.seek?.error && <span className="timeline-error" role="status">{player.seek.error}</span>}
  </div>;
}
