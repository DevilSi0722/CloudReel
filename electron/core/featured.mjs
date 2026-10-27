// Entirely local: stable for a calendar day, independent of library ordering.
const stamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
function noise(value) {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967296;
}
export function featuredDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
export function selectFeatured(entries, {day = featuredDay(), round = 0, exclude = [], count = 5} = {}) {
  const seen = new Set(exclude), unique = new Map();
  for (const entry of entries) {
    if (!entry.entries.some(item => !item.unavailable) || !(entry.group.catalog?.backdrop || entry.group.catalog?.poster)) continue;
    unique.set(entry.group.id, entry);
  }
  const pool = [...unique.values()], newest = [...pool].sort((a,b)=>stamp(b.group.addedAt)-stamp(a.group.addedAt)||a.group.id.localeCompare(b.group.id)).slice(0,Math.max(1,Math.ceil(pool.length*.2)));
  const fresh = new Set(newest.map(entry=>entry.group.id)), picked = [];
  const genreCounts = new Map(), kinds = new Map();
  while (picked.length < Math.min(count,pool.length)) {
    const remaining = pool.filter(entry=>!picked.includes(entry));
    const score = entry => {
      const {group,summary} = entry, genres = group.catalog?.genres ?? [];
      const watched = summary?.complete ? 1 : 0;
      const started = summary?.watched > 0 || entry.entries.some(item => (item.progress?.percent ?? item.remoteProgress?.progress ?? 0) > 0);
      return (seen.has(group.id) ? -10000 : 0) - watched*1000 - (started && !watched ? 100 : 0)
        + noise(`${day}|${round}|${group.id}`)*34 + (fresh.has(group.id)?7:0)
        + Math.min(10,Math.max(0,group.catalog?.rating ?? 0))*1.3 + (group.catalog?.backdrop?5:0)
        - (kinds.get(group.kind) ?? 0)*9 - genres.reduce((sum,genre)=>sum+(genreCounts.get(genre)??0)*5,0)/Math.max(1,genres.length);
    };
    remaining.sort((a,b)=>score(b)-score(a)||a.group.id.localeCompare(b.group.id));
    const next=remaining[0];picked.push(next);kinds.set(next.group.kind,(kinds.get(next.group.kind)??0)+1);
    for(const genre of next.group.catalog?.genres ?? [])genreCounts.set(genre,(genreCounts.get(genre)??0)+1);
  }
  return picked;
}
