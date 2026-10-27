import {useEffect, useRef, useState, type CSSProperties, type PointerEvent} from 'react';
import type {PlayerStatus} from './types';
import type {Run} from './ui';
import {clock} from './library';
import {bridge} from './bridge';
import {Image as ImageIcon, LoaderCircle} from 'lucide-react';

// Pointer previews are local and frame-batched. Only release sends a seek;
// keep the target visible until the player confirms a decoded position.
export default function PlayerTimeline({player, run, onDrag, onActivity, onPreview, enabled = true}: {enabled?: boolean; player: PlayerStatus; run: Run; onDrag: (active: boolean) => void; onPreview?: (active: boolean) => void; onActivity: () => void}) {
  const [draft, setDraft] = useState<number | null>(null), [pending, setPending] = useState<{id: string; target: number} | null>(null);
  const [hover, setHover] = useState<number | null>(null);
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
  useEffect(() => {cancel(); setHover(null); setPending(null); return () => cancelAnimationFrame(frame.current);}, [player.itemId]);
  const atPointer = (event: PointerEvent<HTMLInputElement>) => {const rect = event.currentTarget.getBoundingClientRect(); return Math.max(0, Math.min(1, (event.clientX - rect.left - 6) / Math.max(1, rect.width - 12))) * player.duration;};
  const shown = draft ?? pending?.target ?? (player.seek?.pending ? player.seek.target : player.position), percent = Math.max(0, Math.min(100, shown / (player.duration || 1) * 100));
  const previewSeconds = enabled ? draft ?? hover : null;
  useEffect(() => {onPreview?.(previewSeconds !== null); return () => onPreview?.(false);}, [previewSeconds !== null, onPreview]);
  return <div className={`timeline ${draft !== null ? 'is-scrubbing' : ''} ${pending || player.seek?.pending ? 'is-seeking' : ''}`}>
    <time>{clock(shown)}</time><div className="timeline-track">
      <div className="timeline-rail" aria-hidden="true">
        {(player.buffered ?? []).map((range, index) => <span className="timeline-buffered" key={index} style={{left: `${range.start / player.duration * 100}%`, width: `${(range.end - range.start) / player.duration * 100}%`}} />)}
        <span className="timeline-played" style={{width: `${percent}%`}} />
      </div>
      {(player.chapters ?? []).filter(chapter => chapter.time > 0).map(chapter => <i className="timeline-chapter-mark" key={chapter.id} style={{left: `${chapter.time / player.duration * 100}%`}} title={chapter.title} />)}
      {(['introEnd', 'creditsStart'] as const).map(field => player.markers?.[field] ? <i className={`timeline-section-mark ${field}`} key={field} style={{left: `${player.markers[field]! / player.duration * 100}%`}} title={field === 'introEnd' ? '片头结束' : '片尾开始'} /> : null)}
      <TimelinePreview itemId={player.itemId} seconds={previewSeconds} duration={player.duration} chapters={player.chapters} ready={player.ready && !player.buffering && !player.seek?.pending} />
      {previewSeconds === null && (pending || player.seek?.pending) && <span className="timeline-preview" style={{left: `clamp(38px, ${percent}%, calc(100% - 38px))`}}>跳转中 · {clock(shown)}</span>}
      <input aria-label="播放进度" aria-valuetext={`${clock(shown)} / ${clock(player.duration)}`} type="range" min={0} max={player.duration || 1} step={.1} value={shown} disabled={!player.duration} style={{'--played': `${percent}%`} as CSSProperties}
        onPointerDown={event => {if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({preventScroll: true}); pointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); onDrag(true); preview(atPointer(event)); onActivity();}}
        onPointerLeave={() => setHover(null)} onPointerEnter={event => setHover(atPointer(event))}
        onPointerMove={event => {setHover(atPointer(event)); if (pointer.current !== event.pointerId) return; event.preventDefault(); event.stopPropagation(); preview(atPointer(event));}}
        onPointerUp={event => {if (pointer.current !== event.pointerId) return; event.preventDefault(); event.stopPropagation(); const next = atPointer(event); pointer.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); void commit(next);}}
        onPointerCancel={cancel} onLostPointerCapture={() => {if (pointer.current !== null) cancel();}} onBlur={() => {if (pointer.current === null && value.current !== null) clearDraft();}}
        onChange={event => {if (pointer.current === null) {onDrag(true); preview(Number(event.target.value)); onActivity();}}}
        onKeyUp={event => {if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key) && value.current !== null) void commit(value.current);}} />
    </div><time>{clock(player.duration)}</time>
    {player.seek?.error && <span className="timeline-error" role="status">{player.seek.error}</span>}
  </div>;
}


function TimelinePreview({itemId, seconds, duration, chapters, ready}: {itemId: string; seconds: number | null; duration: number; chapters: PlayerStatus['chapters']; ready: boolean}) {
  type Frame = {image: string; seconds: number; target?: number; approximate?: boolean};
  const [frame, setFrame] = useState<(Frame & {requested: number; itemId: string}) | null>(null), [loading, setLoading] = useState(false);
  const cache=useRef(new Map<number,Frame>()),identity=useRef(itemId);
  if(identity.current!==itemId) {identity.current=itemId;cache.current.clear();}
  const target = seconds === null ? null : Math.max(0, Math.floor(Math.min(duration - .5, Math.max(0, seconds)) / 5) * 5);
  useEffect(() => {
    let stale = false, resolved = false;
    if (target === null) {setLoading(false); void bridge.invoke('player:cancelThumbnail').catch(() => {}); return;}
    const local=cache.current.get(target);
    if(local) {setFrame({...local,requested:target,itemId});setLoading(false);return;}
    setLoading(true);
    const accept=(result:Frame) => {
      const sample=result.target??target;
      cache.current.set(sample,{...result,target:sample,approximate:false});
      while(cache.current.size>80)cache.current.delete(cache.current.keys().next().value!);
      setFrame({...result,requested:target,itemId});
    };
    const timer = ready ? window.setTimeout(() => {
      void bridge.invoke<Frame | null>('player:thumbnail', {itemId, seconds: target}).then(result => {
        if (!stale && result) {resolved=true;accept(result);}
      }).catch(() => {}).finally(() => {if (!stale) setLoading(false);});
    }, 60) : 0;
    // Serve a cached storyboard image immediately while the requested sample
    // is fetched. Its actual timestamp stays visible, so a nearby frame is
    // never presented as an exact frame at the pointer position.
    void bridge.invoke<Frame | null>('player:thumbnail',{itemId,seconds:target,cachedOnly:true}).then(result=>{
      if(stale || resolved || !result)return;
      accept(result);
      if(!result.approximate) {clearTimeout(timer);setLoading(false);}
    }).catch(()=>{});
    return () => {stale = true; clearTimeout(timer);};
  }, [target, itemId, ready]);
  useEffect(() => () => {void bridge.invoke('player:cancelThumbnail').catch(() => {});}, []);
  if (seconds === null || target === null) return null;
  const nearby=[...cache.current.values()].filter(entry=>Math.abs((entry.target??entry.seconds)-target)<=Math.max(15,duration/32)).sort((a,b)=>Math.abs((a.target??a.seconds)-target)-Math.abs((b.target??b.seconds)-target))[0];
  const current = frame?.requested === target && frame.itemId === itemId ? frame : nearby;
  const approximate=current && (current.approximate || Math.abs(current.seconds-target)>=5);
  const chapter = [...(chapters ?? [])].reverse().find(entry => entry.time <= (current?.seconds??target));
  return <div className="timeline-preview timeline-picture" data-overlay-region style={{left: `clamp(clamp(130px, 9vw, 162px), ${seconds / (duration || 1) * 100}%, calc(100% - clamp(130px, 9vw, 162px)))`}}>
    <div className="timeline-picture-image">{current ? <><img src={current.image} alt="目标位置画面预览" />{loading && <LoaderCircle className="spin preview-refresh" aria-label="正在细化预览" />}</> : loading ? <LoaderCircle size={20} className="spin" /> : <ImageIcon size={22} />}</div>
    <div className="timeline-picture-caption"><time>{approximate?'≈ ':''}{clock(current?.seconds ?? target)}</time>{chapter && <span>{chapter.title}</span>}</div>
  </div>;
}
