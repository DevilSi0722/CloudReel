import {playbackKey} from './versions.mjs';

export function readChapters(entries, duration) {
  if (!Array.isArray(entries) || !Number.isFinite(duration) || duration <= 0) return [];
  return entries.slice(0, 500).map((entry, index) => ({id: index, time: entry?.time, title: typeof entry?.title === 'string' ? entry.title.slice(0, 180) : ''}))
    .filter(entry => Number.isFinite(entry.time) && entry.time >= 0 && entry.time < duration)
    .sort((a, b) => a.time - b.time).map((entry, index) => ({...entry, title: entry.title.trim() || `章节 ${index + 1}`}));
}

export function markerKey(item, scope) {
  if (!['episode', 'season', 'series'].includes(scope) || item.kind !== 'episode' && scope !== 'episode') throw new Error('无效的片头片尾范围。');
  // Episode overrides are tied to the actual file. Other cuts can have different timings.
  return scope === 'episode' ? `file:${item.id}` : `${playbackKey(item)}${scope === 'season' ? `:season:${item.season ?? 1}` : ''}`;
}

export function playbackMarkers(item, records = {}, duration = 0) {
  const scopes = item.kind === 'episode' ? ['episode', 'season', 'series'] : ['episode'];
  const result = {};
  for (const field of ['introEnd', 'creditsStart']) for (const scope of scopes) {
    const record = records[markerKey(item, scope)];
    if (!record || !Object.hasOwn(record, field)) continue;
    // Credits are reused as an offset from the end, so episodes with different
    // runtimes do not start skipping at another episode's absolute timestamp.
    const stored = record[field];
    const value = field === 'creditsStart' && scope !== 'episode' && Number.isFinite(stored) && Number.isFinite(record.creditsDuration) && duration > 0 ? duration - (record.creditsDuration - stored) : stored;
    if (Number.isFinite(value) && value > 0 && (duration <= 0 || value < duration)) result[field] = value;
    result[field + 'Scope'] = scope;
    break;
  }
  if (result.introEnd >= result.creditsStart) delete result.creditsStart;
  return result;
}

export function updateMarkers(item, records, input, duration) {
  if (!input || !['introEnd', 'creditsStart'].includes(input.field) || !Number.isFinite(duration) || duration <= 0) throw new Error('影片就绪后再设置片头片尾。');
  const key = markerKey(item, input.scope), record = {...records[key]};
  if (input.reset === true) {delete record[input.field]; if (input.field === 'creditsStart') delete record.creditsDuration;}
  else {
    if (input.seconds !== null && (!Number.isFinite(input.seconds) || input.seconds <= 0 || input.seconds >= duration)) throw new Error('标记必须位于影片开始与结束之间。');
    record[input.field] = input.seconds;
    if (input.field === 'creditsStart') {if (input.scope !== 'episode' && input.seconds !== null) record.creditsDuration = duration; else delete record.creditsDuration;}
    if (Number.isFinite(record.introEnd) && Number.isFinite(record.creditsStart) && record.introEnd >= record.creditsStart) throw new Error('片尾必须晚于片头结束位置。');
  }
  if (Object.keys(record).length) records[key] = record; else delete records[key];
  return playbackMarkers(item, records, duration);
}
