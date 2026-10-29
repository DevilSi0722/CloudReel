// Resolve and persist only file identity fields. A rename must never reidentify
// a title or replace its watch state, metadata, or Trakt association.
export function baiduFileInfo(data, fsId) {
  if (Array.isArray(data) && data.length === 0) throw new Error('百度网盘中的文件已删除或无法访问，请确认文件仍在当前账号中。');
  const info = Array.isArray(data) ? data.find(file => String(file?.fs_id) === String(fsId)) : null;
  if (!info || typeof info.path !== 'string' || !info.path.startsWith('/') || info.path.includes('\0') || info.path.split('/').some(part => part === '.' || part === '..')) throw new Error('百度返回的文件信息与所选文件 ID 不一致。');
  return info;
}
export function rememberBaiduFile(store, info, notify = () => {}) {
  let changed = false;
  for (const item of store.data.items ?? []) {
    if (item.source !== 'baidu' || String(item.fsId) !== String(info.fs_id)) continue;
    const filename = info.server_filename || info.path.split('/').at(-1);
    if (item.path !== info.path || item.filename !== filename || item.unavailable) {
      Object.assign(item, {path: info.path, filename}); delete item.unavailable; changed = true;
    }
  }
  if (changed) {store.persist(); notify();}
}
