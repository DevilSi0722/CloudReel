import {inferenceIdentity} from './identification.mjs';
export const playbackKey = item => item.catalog ? `${item.kind}:${item.catalog.source}:${item.catalog.id}` : inferenceIdentity(item);
export const versionKey = item => `${playbackKey(item)}${item.kind === 'episode' ? `:${item.season ?? 1}:${item.episode ?? item.id}` : ''}`;
export function versionLabel(item) {
  const stored=item.technical,info=stored?.verified && (stored.fileSize===undefined || item.size===undefined || stored.fileSize===item.size) ? stored : {},tags=[];
  if(info.width && info.height) tags.push(info.width>=3800 ? '4K' : info.width>=1900 ? '1080p' : `${info.height}p`);
  if(info.dynamicRange) tags.push(info.dynamicRange);
  if(info.codec) tags.push(info.codec.toUpperCase());
  if(info.audio) tags.push(info.audio.toUpperCase());
  if(info.channels) tags.push(info.channels);
  return tags.join(' · ') || '格式待读取';
}
export function chooseVersion(entries, current) {
  const available = entries.filter(item => !item.unavailable);
  return available.find(item => item.versionPreferred) || available.find(item => item.id === current) || [...available].sort((a,b)=>(Date.parse(b.progress?.updatedAt ?? '') || 0)-(Date.parse(a.progress?.updatedAt ?? '') || 0))[0] || entries[0];
}
export function episodeChoices(entries, current) {
  const groups = new Map();
  for (const item of entries) { const key = versionKey(item); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
  return [...groups.values()].map(versions => chooseVersion(versions, current));
}
