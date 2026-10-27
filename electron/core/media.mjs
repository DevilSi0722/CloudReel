import path from 'node:path';
export const isVideo = filename => /\.(mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|webm|flv|mpg|mpeg|iso)$/i.test(filename);
export {parseFilename} from './filename.mjs';
import {parseFilename} from './filename.mjs';
export function baiduItem(file) {
  return { id: `baidu:${file.fs_id}`, source: 'baidu', fsId: String(file.fs_id), path: file.path,
    filename: file.server_filename, size: file.size, ...parseFilename(file.server_filename), addedAt: new Date().toISOString() };
}
export function localItem(file, size) {
  return { id: `local:${file}`, source: 'local', path: file, filename: path.basename(file), size,
    ...parseFilename(path.basename(file)), addedAt: new Date().toISOString() };
}
export function chooseResume(local, remote) {
  const localTime = Date.parse(local?.updatedAt ?? '') || 0;
  const remoteTime = Date.parse(remote?.paused_at ?? '') || 0;
  if (remote && remoteTime > localTime) return remote.progress > 0 && remote.progress < 99 ? { percent: remote.progress, source: 'Trakt' } : null;
  if (local?.position > 0 && local.percent < 95) return { seconds: local.position, source: '本机' };
  return null;
}
export function identityKey(metadata) { return metadata ? `${metadata.type}:${metadata.ids.trakt}` : ''; }
