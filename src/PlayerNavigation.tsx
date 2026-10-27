import {useEffect, useState} from 'react';
import {BookmarkPlus, Check, RotateCcw} from 'lucide-react';
import type {MediaItem, PlayerStatus} from './types';
import type {Run} from './ui';
import {clock} from './library';

export default function PlayerNavigation({player, item, run, onChapter}: {player: PlayerStatus; item?: MediaItem; run: Run; onChapter: () => void}) {
  const [scope, setScope] = useState('episode'), [busy, setBusy] = useState(false);
  useEffect(() => setScope('episode'), [player.itemId]);
  const mark = async (field: string, options: object) => {
    setBusy(true);
    try {await run('player:marker', {itemId: player.itemId, scope, field, ...options});} finally {setBusy(false);}
  };
  const chapters = player.chapters ?? [], markers = player.markers ?? {};
  return <div className="player-navigation">
    <div className="marker-settings">
      <label>应用范围<select aria-label="片头片尾应用范围" value={scope} onChange={event => setScope(event.target.value)}><option value="episode">{item?.kind === 'episode' ? '仅此集 / 此版本' : '仅此影片 / 此版本'}</option>{item?.kind === 'episode' && <><option value="season">本季</option><option value="series">整部剧</option></>}</select></label>
      {(['introEnd', 'creditsStart'] as const).map(field => <div className="marker-row" key={field}>
        <div><strong>{field === 'introEnd' ? '片头结束' : '片尾开始'}</strong><small>{markers[field] ? `${clock(markers[field]!)} · ${{episode: '本集', season: '本季', series: '整部剧'}[markers[`${field}Scope`] ?? 'episode']}` : '未设置'}</small></div>
        <button className="icon-button" title="使用当前位置" aria-label={field === 'introEnd' ? '将当前位置设为片头结束' : '将当前位置设为片尾开始'} disabled={busy || !player.ready || player.seek?.pending} onClick={() => mark(field, {current: true})}><BookmarkPlus size={17} /></button>
        <button className="icon-button" title="在所选范围禁用此标记" aria-label={field === 'introEnd' ? '禁用片头标记' : '禁用片尾标记'} disabled={busy} onClick={() => mark(field, {seconds: null})}><span>−</span></button>
        <button className="icon-button" title="清除所选范围的覆盖，沿用上级设置" aria-label={field === 'introEnd' ? '重置片头标记' : '重置片尾标记'} disabled={busy} onClick={() => mark(field, {reset: true})}><RotateCcw size={14} /></button>
      </div>)}
      <p>在片头结束或片尾开始处点击书签。不同剪辑版本可单独覆盖。</p>
    </div>
    <div className="chapter-heading">章节 <span>{chapters.length || ''}</span></div>
    {chapters.length ? chapters.map((chapter, index) => {
      const active = player.position >= chapter.time && (index === chapters.length - 1 || player.position < chapters[index + 1].time);
      return <button className={`chapter-choice ${active ? 'active' : ''}`} key={chapter.id} onClick={() => {void run('player:seek', {seconds: chapter.time, itemId: player.itemId}); onChapter();}}><time>{clock(chapter.time)}</time><span>{chapter.title}</span>{active && <Check size={14} />}</button>;
    }) : <p className="player-menu-empty">此片源没有内嵌章节</p>}
  </div>;
}
