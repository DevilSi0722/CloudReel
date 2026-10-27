import { parseFilename } from './filename.mjs';

const digits = '零一二三四五六七八九';
export function mediaNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const text = String(value).replace(/两/g, '二').replace(/〇/g, '零');
  let total = 0, current = 0;
  for (const char of text) { if (digits.includes(char)) current = digits.indexOf(char); else if (char === '十') { total += (current || 1) * 10; current = 0; } else if (char === '百') { total += (current || 1) * 100; current = 0; } }
  return total + current;
}
const number = '[零〇一二两三四五六七八九十百\\d]+';
const seasonPattern = new RegExp(`(?:第\\s*(${number})\\s*季|\\bSeason[ ._-]*([0-9]{1,2})\\b|(?:^|[ ._\\[(])S([0-9]{1,2})(?=$|[ ._\\])E]))`, 'i');
const episodePattern = new RegExp(`第\\s*(${number})\\s*[集话話回]`, 'i');
export const normalizeTitle = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
export function cleanTitle(value) {
  const original = String(value ?? '').trim();
  if (/^(?:19|20)\d{2}$/.test(original)) return original;
  const numericFilm = original.match(/^((?:19|20)\d{2})\s*[（(](?:19|20)\d{2}[）)]/);
  if (numericFilm) return numericFilm[1];
  return String(value ?? '').replace(/\[[^\]]*\]|【[^】]*】/g, ' ').replace(/[._]/g, ' ')
    .replace(/\b(?:2160p|1080[pi]|720p|480p|4K|8K|WEB[ -]?DL|WEBRip|BluRay|BDRip|REMUX|HEVC|AVC|x26[45]|H[ .]?26[45]|HDR10?\+?|DV|DTS[ -]?HD|DDP?\d?(?:[ .]\d)?|Atmos|PROPER|EXTENDED|IMAX|CHS|CHT|ENG)\b.*$/i, '')
    .replace(/(?:国语|国英双语|中英双字|中英字幕|中文字幕|简繁字幕|简体字幕|高清|超清|蓝光|全集|完整版|无水印|精校版|收藏版)(?:版)?/g, ' ')
    .replace(/(?:[（(]\s*)?(?:19\d{2}|20\d{2})(?:\s*[）)])?/g, ' ').replace(/\s+/g, ' ').replace(/^[\s\-—–]+|[\s\-—–]+$/g, '').trim();
}
export function baseSeriesTitle(value) {
  return cleanTitle(String(value ?? '').replace(new RegExp(`第\\s*${number}\\s*季|\\bSeason[ ._-]*\\d{1,2}\\b|(?:^|[ ._-])S\\d{1,2}(?=$|[ ._-])`, 'gi'), ' ').replace(/(?:全|共)\s*\d+\s*集/g, ' '));
}
const generic = value => !value || /^(?:电影|電視劇|电视剧|剧集|美剧|韩剧|日剧|国产剧|综艺|动漫|动画|影视|视频|番剧|纪录片|movies?|films?|tv|tv shows?|series|shows?|videos?|media|downloads?|download|infuse电影|infuse电视剧|百度网盘|全[零一二三四五六七八九十\d]+集|[\d.]+p?|4k|8k|web[ -]?dl|hevc|hdr|中字|国语|英語|英语|1080p|2160p|disc[ -]?\d+|cd[ -]?\d+|disk[ -]?\d+)$/i.test(value.trim());

export function inferMedia(item) {
  const filename = item.filename ?? String(item.path ?? '').replace(/\\/g, '/').split('/').at(-1) ?? '';
  const stem = filename.replace(/\.[^.]+$/, '');
  const base = parseFilename(filename);
  const parts = String(item.path ?? filename).replace(/\\/g, '/').split('/').filter(Boolean).slice(0, -1);
  const folders = parts.map(raw => ({ raw, season: raw.match(seasonPattern), title: baseSeriesTitle(raw) })).filter(folder => folder.title && !generic(folder.title));
  const folder = folders.at(-1);
  const folderSeason = [...parts].reverse().map(part => part.match(seasonPattern)).find(Boolean);
  const folderYear = Number([...parts].reverse().map(part => part.match(/(?:19|20)\d{2}/g)?.at(-1)).find(Boolean)) || undefined;
  const namedSeason = stem.match(seasonPattern);
  const chineseEpisode = stem.match(episodePattern);
  const episodeCode = stem.match(/(?:^|[\s._\[(-])(?:EP?|Episode)[ ._-]*(\d{1,3})(?=$|[\s._\])\-])/i);
  const trimmed = cleanTitle(stem);
  const plainNumber = trimmed.match(new RegExp(`^(?:第\\s*)?(${number})(?:\\s*集)?$`));
  const prefixNumber = trimmed.match(/^(\d{1,3})\s*[-.、_ ]\s*\D/);
  const suffixNumber = trimmed.match(/^(.+?[\u3400-\u9fff])\s*(\d{1,3})$/);
  const filmRoot = parts.some(part => /^(?:电影|movies?|films?|infuse电影)$/i.test(part));
  let season = base.season, episode = base.episode, title = base.title, confidence = base.kind === 'episode' ? .99 : .72, reason = '文件名';
  if (namedSeason) season = mediaNumber(namedSeason[1] ?? namedSeason[2] ?? namedSeason[3]);
  else if (folderSeason) season = mediaNumber(folderSeason[1] ?? folderSeason[2] ?? folderSeason[3]);
  if (parts.some(part => /^(?:specials?|特别篇|特別篇|番外|OVA|SP)$/i.test(part))) season = 0;
  if (chineseEpisode && base.episode === undefined) { episode = mediaNumber(chineseEpisode[1]); title = cleanTitle(stem.slice(0, chineseEpisode.index)); confidence = .98; reason = '中文季集'; }
  else if (episodeCode) { episode = Number(episodeCode[1]); title = cleanTitle(stem.slice(0, episodeCode.index)); confidence = .96; reason = '集数标记'; }
  else if (plainNumber && folder && (!filmRoot || folderSeason)) { episode = mediaNumber(plainNumber[1]); title = folder.title; confidence = .9; reason = '数字文件名与剧集目录'; }
  else if (prefixNumber && folder && !filmRoot) { episode = Number(prefixNumber[1]); title = folder.title; confidence = .82; reason = '目录与集数前缀'; }
  else if (suffixNumber && !filmRoot) { episode = Number(suffixNumber[2]); title = cleanTitle(suffixNumber[1]); confidence = .86; reason = '中文片名与集数后缀'; }
  if (episode !== undefined) {
    title = baseSeriesTitle(title);
    if (!title || generic(title) || /^(?:S\d+E\d+|\d+)$/i.test(title)) title = folder?.title ?? cleanTitle(stem);
    const fileTitle = title;
    // A named show folder unifies localized and original filenames in the same series.
    if (folder && (folderSeason || parts.some(part => /^(?:infuse电视剧|电视剧|剧集|tv|shows?|tv shows?|series)$/i.test(part)))) title = folder.title;
    return { title, searchTitles: [...new Set([title, fileTitle])], year: base.year ?? (Number(folder?.raw.match(/(?:19|20)\d{2}/)?.[0]) || undefined), kind: 'episode', season: season ?? 1, episode, seriesTitle: title, identification: { version: 1, confidence, reason } };
  }
  if ((!trimmed || /^\d{1,3}$/.test(trimmed) || /^(?:video|movie|film)$/i.test(trimmed)) && folder) { title = folder.title; confidence = .55; reason = '目录名称'; }
  else title = cleanTitle(base.title) || cleanTitle(stem) || filename;
  return { title, year: (stem === String(base.year) ? undefined : base.year) ?? folderYear, kind: 'movie', season: undefined, episode: undefined, seriesTitle: undefined, identification: { version: 1, confidence, reason } };
}

export const inferenceIdentity = item => `${item.kind}:${normalizeTitle(baseSeriesTitle(item.inferredTitle ?? item.seriesTitle ?? item.title))}${item.kind === 'movie' && item.year ? ':' + item.year : ''}`;
export const catalogTitle = (item, catalog) => catalog.source === 'tvmaze' && /[\u3400-\u9fff]/.test(item.inferredTitle ?? '') ? item.inferredTitle : catalog.title;
export function identifyLibrary(items) {
  const known = new Map();
  for (const item of items) {
    if (!item.identificationLocked) {
      const inferred = inferMedia(item); item.inferredTitle = inferred.title;
      Object.assign(item, inferred);
    }
    if (item.catalog) known.set(inferenceIdentity(item), item.catalog);
  }
  for (const item of items) {
    if (!item.catalog && known.has(inferenceIdentity(item))) item.catalog = structuredClone(known.get(inferenceIdentity(item)));
    if (item.catalog) item.title = item.kind === 'episode' ? baseSeriesTitle(catalogTitle(item, item.catalog)) || item.title : catalogTitle(item, item.catalog) || item.title;
    if (item.kind === 'episode') item.seriesTitle = item.title;
  }
  return items;
}

export function groupLibrary(items) {
  const groups = new Map();
  for (const item of items) {
    const title = item.kind === 'episode' ? baseSeriesTitle(item.seriesTitle ?? item.title) : item.title;
    const identity = item.catalog ? (item.kind === 'episode' && item.catalog.source !== 'tmdb' ? normalizeTitle(baseSeriesTitle(item.inferredTitle ?? title)) : `${item.catalog.source}:${item.catalog.id}`) : normalizeTitle(title);
    const key = item.kind === 'episode' ? `show:${identity}` : `movie:${item.catalog ? identity : identity + ':' + (item.year ?? 'unknown')}`;
    let group = groups.get(key);
    if (!group) { group = { id: key, kind: item.kind, title, year: item.catalog?.year ?? item.year, catalog: item.catalog, itemIds: [], seasons: [], addedAt: item.addedAt, totalEpisodes: 0 }; groups.set(key, group); }
    group.itemIds.push(item.id);
    if (!group.catalog && item.catalog) { group.catalog = item.catalog; group.title = title; }
    if (Date.parse(item.addedAt) > Date.parse(group.addedAt)) group.addedAt = item.addedAt;
    if (item.kind === 'episode' && !group.seasons.includes(item.season ?? 1)) group.seasons.push(item.season ?? 1);
  }
  const byId = new Map(items.map(item => [item.id, item]));
  for (const group of groups.values()) {
    group.seasons.sort((a, b) => a - b); group.totalEpisodes = group.kind === 'episode' ? new Set(group.itemIds.map(id => {const item=byId.get(id);return `${item.season ?? 1}:${item.episode ?? id}`;})).size : 1;
    group.itemIds.sort((a, b) => { const aa = byId.get(a), bb = byId.get(b); return (aa.season ?? 1) - (bb.season ?? 1) || (aa.episode ?? Infinity) - (bb.episode ?? Infinity) || aa.filename.localeCompare(bb.filename, 'zh-CN', { numeric: true }); });
  }
  return [...groups.values()];
}
