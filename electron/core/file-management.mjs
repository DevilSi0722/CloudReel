import path from 'node:path';
import {isVideo} from './media.mjs';
import {quality, safeName} from './discovery-naming.mjs';

export const isSubtitle = name => /\.(?:srt|ass|ssa|vtt|sub|idx)$/i.test(name);
export const manageable = file => Number(file.isdir) === 0 && (isVideo(file.server_filename) || isSubtitle(file.server_filename));
export const inside = (value, root) => value.startsWith(root.replace(/\/$/, '') + '/');
export function validFilename(name) {
  return typeof name === 'string' && name.trim().length > 0 && !/[<>:"/\\|?*\u0000-\u001f]/.test(name) && !/[. ]$/.test(name) && name.length <= 240 && Buffer.byteLength(name) <= 255 && !/^(?:CON|PRN|AUX|NUL|COM\d|LPT\d)(?:\.|$)/i.test(name);
}
export function validateRule(rule) {
  if (!rule || !['standard', 'replace', 'affix'].includes(rule.mode)) throw new Error('请选择重命名方式。');
  for (const key of ['search', 'replacement', 'prefix', 'suffix']) if (rule[key] !== undefined && (typeof rule[key] !== 'string' || rule[key].length > 240)) throw new Error('重命名内容过长或无效。');
  if (rule.mode === 'replace' && !rule.search) throw new Error('请输入要查找的文字。');
  if (rule.mode === 'affix' && !rule.prefix && !rule.suffix) throw new Error('请输入前缀或后缀。');
}
function standardName(file, item) {
  if (!item || !(item.catalog?.id || item.identificationLocked || item.metadata?.ids?.trakt)) return {reason: '尚未匹配影片资料，请先在片库中匹配'};
  const title = safeName(item.catalog?.title || item.seriesTitle || item.title);
  if (!title) return {reason: '缺少影片名称'};
  let stem = title;
  if (item.kind === 'episode') {
    if (!Number.isInteger(item.season) || item.season < 0 || item.season > 99 || !Number.isInteger(item.episode) || item.episode < 1 || item.episode > 9999) return {reason: '无法确认季集，请先修正识别'};
    stem += ` - S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`;
  } else if (Number.isInteger(item.year) && item.year >= 1800 && item.year <= 2199) stem += ` (${item.year})`;
  return {name: stem + quality(file.server_filename) + path.posix.extname(file.server_filename)};
}

// Include only unambiguous, same-stem sidecars in this directory. Never infer
// episode order or change extensions, folders, metadata or watch identities.
export function buildFilePlan(all, selectedIds, items, {action, rule, includeSubtitles = true}) {
  if (!['rename', 'delete'].includes(action)) throw new Error('不支持的文件操作。');
  if (action === 'rename') validateRule(rule);
  const ids = new Set(selectedIds.map(String)), selected = all.filter(file => ids.has(String(file.fs_id)));
  if (selected.length !== ids.size || selected.some(file => !manageable(file))) throw new Error('所选文件已变化，或包含不支持的文件，请刷新后重选。');
  const videos = all.filter(file => manageable(file) && isVideo(file.server_filename));
  const companions = new Map();
  if (includeSubtitles) for (const file of all.filter(file => manageable(file) && isSubtitle(file.server_filename))) {
    const matching = videos.filter(video => file.server_filename.toLowerCase().startsWith(video.server_filename.slice(0, -path.posix.extname(video.server_filename).length).toLowerCase() + '.'));
    if (matching.length !== 1 || !ids.has(String(matching[0].fs_id))) continue;
    companions.set(String(file.fs_id), matching[0]);
    if (!ids.has(String(file.fs_id))) {selected.push(file); ids.add(String(file.fs_id));}
  }
  selected.sort((a, b) => Number(companions.has(String(a.fs_id))) - Number(companions.has(String(b.fs_id))));
  const entries = selected.map(file => {
    const original = file.server_filename, extension = path.posix.extname(original), stem = original.slice(0, -extension.length);
    let name = original, reason = '';
    if (action === 'rename') {
      if (rule.mode === 'standard') {
        if (!companions.has(String(file.fs_id))) ({name = original, reason = ''} = isVideo(original) ? standardName(file, items.find(item => item.source === 'baidu' && String(item.fsId) === String(file.fs_id))) : {reason: '没有选中对应的视频，保留字幕原名'});
      } else if (rule.mode === 'replace') name = stem.split(rule.search).join(rule.replacement || '') + extension;
      else name = (rule.prefix || '') + stem + (rule.suffix || '') + extension;
    }
    return {fsId: String(file.fs_id), file, original, name, reason, companion: companions.has(String(file.fs_id)), parentId: companions.has(String(file.fs_id)) ? String(companions.get(String(file.fs_id)).fs_id) : undefined, status: 'ready'};
  });
  if (action === 'rename') for (const entry of entries) {
    const video = companions.get(entry.fsId);
    if (video) {
      const parent = entries.find(value => value.fsId === String(video.fs_id));
      const suffix = entry.original.slice(video.server_filename.length - path.posix.extname(video.server_filename).length);
      entry.name = parent.name.slice(0, -path.posix.extname(parent.name).length) + suffix;
      entry.reason = parent.reason;
    }
    if (!entry.reason && !validFilename(entry.name)) entry.reason = '新名称包含无效字符或过长';
    if (!entry.reason && entry.name !== entry.original && all.some(file => String(file.fs_id) !== entry.fsId && file.server_filename.toLowerCase() === entry.name.toLowerCase())) entry.reason = '目标名称已存在';
  }
  if (action === 'rename') {
    const duplicates = new Map();
    for (const entry of entries) {const key = entry.name.toLowerCase(); duplicates.set(key, (duplicates.get(key) || 0) + 1);}
    for (const entry of entries) {
      if (!entry.reason && duplicates.get(entry.name.toLowerCase()) > 1 && entry.name !== entry.original) entry.reason = '多个文件将使用同一名称';
      entry.status = entry.reason ? 'blocked' : entry.name === entry.original ? 'unchanged' : 'ready';
    }
    for (const entry of entries) if (entry.companion) {
      const parent = entries.find(value => value.fsId === String(companions.get(entry.fsId).fs_id));
      if (parent.status === 'blocked') {entry.status = 'blocked'; entry.reason = '对应视频无法重命名，保留字幕原名';}
    }
  }
  return entries;
}
