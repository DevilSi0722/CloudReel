import path from 'node:path';
import {mediaNumber, normalizeTitle} from './identification.mjs';

const number = '[零〇一二两三四五六七八九十百\\d]+';
const seasonPattern = new RegExp(`第\\s*(${number})\\s*季|\\bSeason[ ._-]*(\\d{1,2})\\b|(?:^|[^a-z0-9])S(\\d{1,2})(?=$|[^a-z0-9]|E\\d)`, 'gi');
const normalize = value => String(value || '').normalize('NFKC').replace(/[–—−～]/g, '-');
const valid = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const seasons = value => [...normalize(value).matchAll(seasonPattern)].map(match => mediaNumber(match[1] ?? match[2] ?? match[3]));
export const namedSeason = value => seasons(value)[0];
const failure = reason => ({reason: reason + '，保留原名'});
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Remove known titles before interpreting numbers: the 2 in a title is never
// an episode. Aliases come from the provider / matched metadata, not user input.
function withoutTitle(value, work) {
  const aliases = [...new Set([work.title, work.originalTitle, ...(work.namingTitles || [])].map(normalizeTitle).filter(value => value.length >= 2 && !/^\d+$/.test(value)))].sort((a, b) => b.length - a.length);
  for (const alias of aliases) value = value.replace(new RegExp([...alias].map(escape).join('[\\s._-]*'), 'gi'), ' ');
  return value;
}

// Quality is removed before range detection. "09~4K" means episode 9 in 4K;
// "09~10" is a combined file and must never be collapsed to episode 9.
function withoutRelease(value) {
  return value.replace(/_/g, ' ').replace(/\b(?:2160p|1080[pi]|720p|480p|[248]K|10bit|8bit|HDR10\+?|HDR|DV|DOVI|HEVC|AVC|x26[45]|H[ .]?26[45]|WEB[ ._-]?(?:DL|Rip)|BluRay|BDRip|REMUX)\b/gi, ' ')
    .replace(/\b(?:DDP?|EAC3|AC3|DTS(?:[ .-]?HD)?|AAC|FLAC|TRUEHD)(?:[ ._-]?\d(?:\.\d){0,2})?(?:[ ._-]?Atmos)?\b/gi, ' ')
    .replace(/(?:国语|粤语|英语|日语|韩语|国粤双语|国英双语|中英双字|中英字幕|中文字幕|简繁字幕|简体字幕|繁体字幕|无水印|高清|超清|蓝光|精校版|修复版)/g, ' ');
}

export function discoveryEpisode(file, work, seasonOverride) {
  const stem = normalize(path.posix.basename(file.path).replace(/\.[^.]+$/, ''));
  const parts = file.path.split('/').slice(0, -1).map(normalize);
  const text = withoutRelease(withoutTitle(stem, work));
  if (/(?:花絮|预告片?|片花|抢先看|先导片|制作特辑|采访)/.test(text)) return failure('附加内容');
  if (/(?:[（(\[._ -]|^)(?:上|中|下|前|后)(?:[）)\]._ -]|$)|(?:集|话|話)[ ._-]*[上中下前后](?:[）)\]._ -]|$)|(?:Part|CD|Disc)[ ._-]*\d|[上下]篇/i.test(text)) return failure('分段剧集需确认集数');
  if (new RegExp(`(?:第\\s*)?${number}\\s*(?:集|话|話)?\\s*[-~至到&+]\\s*(?:第\\s*)?${number}\\s*(?:集|话|話)?`, 'i').test(text)
    || /E\d{1,3}[ ._-]*E\d|E\d{1,3}[ ._]*[-~至到&+][ ._]*E?\d|\d{1,2}x\d{1,3}[ ._-]*(?:\d{1,2}x|x)\d/i.test(text)) return failure('包含多集或多个集数');

  const standard = [...text.matchAll(/(?:^|[^a-z0-9])(?:S(\d{1,2})[ ._-]*E(\d{1,3})|(\d{1,2})x(\d{1,3}))(?!\d)/gi)];
  const episodes = standard.map(match => Number(match[2] ?? match[4]));
  const explicitSeasons = standard.map(match => Number(match[1] ?? match[3]));
  for (const match of text.matchAll(new RegExp(`第\\s*(${number})\\s*[集话話回]`, 'g'))) episodes.push(mediaNumber(match[1]));
  for (const match of text.matchAll(/(?:^|[^a-z0-9])(?:Episode|EP|E)[ ._-]*(\d{1,3})(?!\d)(?=$|[^a-z0-9])/gi)) episodes.push(Number(match[1]));
  if (new Set(episodes).size > 1 || new Set(explicitSeasons).size > 1) return failure('集数标记互相冲突');

  if (!episodes.length) {
    const bracketed = [...text.matchAll(/[\[【(](\d{1,3})(?:v\d+)?[\]】)]/gi)];
    const bare = text.replace(new RegExp(`第\\s*${number}\\s*季|\\bSeason[ ._-]*\\d{1,2}\\b|(?:^|[^a-z0-9])S\\d{1,2}(?=$|[^a-z0-9])`, 'gi'), ' ').trim();
    const numeric = bare.match(/^[\s._~\[【(-]*(\d{1,3})(?:\s*集)?(?=$|[\s._~\]】)\-])/);
    // Bracketed numbers are useful in anime releases, but multiple numerical
    // tags are ambiguous; release group / checksum numbers are not episodes.
    if (bracketed.length > 1 || bracketed.length && numeric && Number(bracketed[0][1]) !== Number(numeric[1])) return failure('存在多个数字标记');
    const candidate = bracketed[0]?.[1] ?? numeric?.[1];
    if (candidate !== undefined) episodes.push(Number(candidate));
    if (numeric && !bracketed.length && /(?:^|[^a-z0-9])\d{1,3}(?=$|[^a-z0-9])/i.test(bare.slice(numeric[0].length))) return failure('存在多个数字标记');
    if (candidate === undefined) {const chinese = bare.match(new RegExp(`^[\\s._~\\[【(-]*(${number})(?:集|话|話)?[\\s._~\\]】)-]*$`));if(chinese)episodes.push(mediaNumber(chinese[1]));}
  }

  const fileSeasons = [...explicitSeasons, ...seasons(stem)];
  const folderSeason = [...parts].reverse().map(seasons).find(value => value.length) || [];
  if (new Set(fileSeasons).size > 1 || new Set(folderSeason).size > 1 || fileSeasons.length && folderSeason.length && fileSeasons[0] !== folderSeason[0]) return failure('文件名与目录季数冲突');
  const explicit = fileSeasons[0] ?? folderSeason[0];
  const special = parts.some(value => /^(?:specials?|特别篇|特別篇|番外|OVA|SP)$/i.test(value));
  if (special && explicit !== undefined && explicit !== 0) return failure('特别篇与季数标记冲突');
  if (!special && explicit !== undefined && work.season !== undefined && explicit !== work.season) return failure('季数与所选作品不符');
  const season = special ? 0 : explicit ?? seasonOverride ?? work.season ?? 1;
  const episode = episodes[0];
  if (!valid(episode, 1, 999) || !valid(season, 0, 99)) return failure('无法确认季集');
  if (work.episodeCount && episode > work.episodeCount && season !== 0) return failure('集数超出作品范围');
  return {identity: {season, episode}};
}
