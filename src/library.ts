import type { Collection, MediaItem } from './types';
import {episodeChoices, versionKey, chooseVersion} from '../electron/core/versions.mjs';
import {isWatched} from '../electron/core/watch-state.mjs';
export {isWatched};
export const progressOf = (item: MediaItem) => {
  const local = item.progress, remote = item.remoteProgress;
  return remote && Date.parse(remote.paused_at) > (Date.parse(local?.updatedAt ?? '') || 0) ? remote.progress : local?.percent ?? remote?.progress ?? 0;
};
export const watchingNow = (item: MediaItem) => Date.parse(item.remoteWatching?.expiresAt ?? '') > Date.now();
export const latestTime = (item: MediaItem) => Math.max(Date.parse(item.progress?.updatedAt ?? '') || 0, Date.parse(item.remoteProgress?.paused_at ?? '') || 0, Date.parse(item.remoteNext?.watchedAt ?? '') || 0, watchingNow(item) ? Date.parse(item.remoteWatching!.startedAt) || 0 : 0);
export const episodesOf = (group: Collection, items: MediaItem[]) => group.itemIds.map(id => items.find(item => item.id === id)).filter((item): item is MediaItem => Boolean(item));
export function watchSummary(entries: MediaItem[]) {
  const unique = new Map<string, boolean>();
  for (const item of entries) {const key = item.kind === 'episode' ? `${item.season ?? 1}:${item.episode ?? item.id}` : 'movie'; unique.set(key, Boolean(unique.get(key)) || isWatched(item));}
  const watched = [...unique.values()].filter(Boolean).length, total = unique.size;
  return {watched, total, complete: total > 0 && watched === total, favorite: entries.some(item => item.favorite), pending: entries.some(item => item.watchState?.pending)};
}
export const continueHidden = (entries: MediaItem[]) => Math.max(...entries.map(item => Date.parse(item.continueHiddenAt ?? '') || 0)) >= Math.max(1, ...entries.map(latestTime));
export function resumeItem(group: Collection, items: MediaItem[]) {
  const all = episodesOf(group, items), entries = episodeChoices(all);
  if (group.kind === 'movie') return chooseVersion(all);
  const active = entries.find(watchingNow); if (active) return active;
  const watched = all.filter(item => progressOf(item) > 0 || item.remoteNext || isWatched(item)).sort((a, b) => latestTime(b) - latestTime(a) || Number(Boolean(b.remoteNext)) - Number(Boolean(a.remoteNext)))[0];
  if (!watched) return entries.find(item=>!item.unavailable) ?? entries[0];
  const logicalWatched=(item: MediaItem)=>all.some(other=>versionKey(other)===versionKey(item) && isWatched(other));
  if (progressOf(watched) > 0 && progressOf(watched) < 95 || !isWatched(watched)) return chooseVersion(all.filter(item => versionKey(item)===versionKey(watched)),watched.id);
  return entries.find(item => !logicalWatched(item) && ((item.season ?? 1) > (watched.season ?? 1) || item.season === watched.season && (item.episode ?? 0) > (watched.episode ?? 0))) ?? entries.find(item => !logicalWatched(item)) ?? watched;
}
export const episodeLabel = (item: MediaItem) => item.kind === 'episode' ? `${item.season === 0 ? '特别篇' : `第 ${item.season ?? 1} 季`} · 第 ${item.episode ?? '?'} 集` : String(item.catalog?.year ?? item.year ?? '电影');
export const clock = (seconds: number) => { const n = Math.max(0, Math.floor(seconds || 0)); return `${n >= 3600 ? Math.floor(n / 3600) + ':' : ''}${n >= 3600 ? String(Math.floor(n / 60) % 60).padStart(2, '0') : Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; };
export const bytes = (n: number) => n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${(n / 1048576).toFixed(1)} MB`;
