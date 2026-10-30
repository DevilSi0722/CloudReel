import {validFilename, manageable} from '../core/file-management.mjs';

// Path-based provider writes must be preceded by a fresh stable-ID check.
// Never retry the POST: a timeout can mean the provider already applied it.
export async function manageBaiduFile(service, action, file, newname, post) {
  if (!['rename', 'delete'].includes(action) || !manageable(file) || !/^\d+$/.test(String(file.fs_id))) throw new Error('请选择有效的视频或字幕文件。');
  if (action === 'rename' && !validFilename(newname)) throw new Error('无效的文件名。');
  const current = await service.fileInfo(file.fs_id);
  if (!manageable(current) || current.path !== file.path || Number(current.size) !== Number(file.size) || file.md5 && current.md5 && file.md5 !== current.md5) throw new Error('文件已变化，请刷新后重试。');
  const filelist = action === 'delete' ? [current.path] : [{path: current.path, newname, ondup: 'fail'}];
  const result = await post(action, filelist);
  if (Number(result?.errno) !== 0 || result.taskid || result.task_id || result.info?.some(value => Number(value.errno ?? value.error_code ?? 0) !== 0)) throw new Error('网盘未确认操作成功，请刷新核对。');
  if (action === 'delete') return {fs_id: current.fs_id, deleted: true};
  const updated = await service.fileInfo(file.fs_id);
  const target = current.path.slice(0, current.path.lastIndexOf('/') + 1) + newname;
  if (updated.path !== target || Number(updated.size) !== Number(current.size) || !manageable(updated)) throw new Error('重命名结果尚未确认，请刷新核对。');
  return updated;
}
