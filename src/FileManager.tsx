import {useEffect, useRef, useState} from 'react';
import {ArrowLeft, ArrowRight, Check, ChevronRight, FileText, Film, Folder, Info, LoaderCircle, Pencil, RefreshCw, Search, Trash2, X} from 'lucide-react';
import {bridge} from './bridge';
import {Empty, Modal} from './ui';
import type {AppState, CloudFile, FilePlan, FileReport, RenameRule, ScanRoot} from './types';

type Location = {path: string; fsId?: string};
type Page = {directory: Location; mountPath: string; files: CloudFile[]; hasMore: boolean; nextStart: number};
const isSubtitle = (name: string) => /\.(srt|ass|ssa|vtt|sub|idx)$/i.test(name);
const fileSize = (size: number) => size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(2)} GB` : size >= 1024 ** 2 ? `${(size / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;

export default function FileManager({root, state, onBack}: {root: ScanRoot; state: AppState; onBack: () => void}) {
  const [trail, setTrail] = useState<Location[]>([{path: root.path}]);
  const [files, setFiles] = useState<CloudFile[]>([]), [more, setMore] = useState(false), [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set()), [query, setQuery] = useState('');
  const [action, setAction] = useState<'rename' | 'delete' | null>(null), [report, setReport] = useState<FileReport | null>(null), [working, setWorking] = useState(false);
  const generation = useRef(0), pending = useRef(false), location = trail.at(-1)!;
  useEffect(() => {
    if (state.fileTask?.running) return;
    let active = true;
    void bridge.invoke<FileReport | null>('files:report').then(value => {if (active && value?.rootId === root.id && value.directory === location.path) setReport(value);}).catch(() => {});
    return () => {active = false;};
  }, [root.id, location.path, state.fileTask?.running]);
  useEffect(() => {
    const current = ++generation.current; pending.current = true;
    setFiles([]); setSelected(new Set()); setMore(false); setLoading(true); setError('');
    void bridge.invoke<Page>('files:browse', {rootId: root.id, directoryId: location.fsId}).then(page => {
      if (current !== generation.current) return;
      setFiles(page.files); setMore(page.hasMore); setCursor(page.nextStart);
      setTrail(old => old.map((entry, index) => index === old.length - 1 ? {path: page.directory.path, fsId: index ? page.directory.fsId : undefined} : index === 0 ? {path: page.mountPath} : entry));
    }).catch(reason => {if (current === generation.current) setError(reason.message);}).finally(() => {
      if (current === generation.current) {pending.current = false; setLoading(false);}
    });
    return () => {generation.current++;};
  }, [root.id, location.fsId, revision]);
  const loadMore = async () => {
    if (pending.current || !more) return;
    const current = generation.current; pending.current = true; setLoading(true); setError('');
    try {
      const page = await bridge.invoke<Page>('files:browse', {rootId: root.id, directoryId: location.fsId, start: cursor});
      if (current !== generation.current) return;
      setFiles(old => [...new Map([...old, ...page.files].map(file => [String(file.fs_id), file])).values()]); setMore(page.hasMore); setCursor(page.nextStart);
    } catch (reason) {if (current === generation.current) setError((reason as Error).message);}
    finally {if (current === generation.current) {pending.current = false; setLoading(false);}}
  };
  const visible = files.filter(file => file.server_filename.toLowerCase().includes(query.toLowerCase()));
  const selectable = visible.filter(file => !file.isdir), allChecked = selectable.length > 0 && selectable.every(file => selected.has(String(file.fs_id)));
  const toggle = (id: string, range = false) => {
    const values = [...selected];
    if (range && values.length) {
      const start = selectable.findIndex(file => String(file.fs_id) === values.at(-1)), end = selectable.findIndex(file => String(file.fs_id) === id);
      if (start >= 0 && end >= 0) {setSelected(new Set([...values, ...selectable.slice(Math.min(start, end), Math.max(start, end) + 1).map(file => String(file.fs_id))].slice(0, 500))); return;}
    }
    setSelected(old => {const next = new Set(old); if (next.has(id)) next.delete(id); else if (next.size < 500) next.add(id); return next;});
  };
  const blocked = working || state.fileTask?.running || !!state.player || state.scan.running || state.discoveryTransfers?.some(task => ['submitting', 'submitted', 'renaming', 'importing'].includes(task.status));
  const navigate = (next: Location[]) => {setTrail(next); setQuery(''); setSelected(new Set()); setReport(null);};
  return <section className="file-manager" aria-label="管理挂载文件">
    <div className="page-heading"><div><button className="text-button file-back" disabled={working} onClick={onBack}><ArrowLeft size={15} />已挂载文件夹</button><h1>{trail[0].path.split('/').filter(Boolean).at(-1) || '全部文件'}</h1><p className="heading-caption">管理网盘中的视频与字幕，修改会同步到百度网盘。</p></div></div>
    <div className="file-browser-toolbar"><nav className="directory-path" aria-label="挂载目录"><button className="icon-button" aria-label="返回上级文件夹" disabled={trail.length === 1 || working} onClick={() => navigate(trail.slice(0, -1))}><ArrowLeft size={17} /></button>{trail.map((entry, index) => <span key={index}>{index > 0 && <ChevronRight size={13} />}<button disabled={working || index === trail.length - 1} onClick={() => navigate(trail.slice(0, index + 1))}>{entry.path.split('/').filter(Boolean).at(-1) || '全部文件'}</button></span>)}</nav><button className="icon-button" aria-label="刷新文件列表" disabled={loading || working} onClick={() => {setRevision(value => value + 1); setReport(null);}}><RefreshCw size={16} /></button></div>
    <div className="file-selection-bar"><label className="file-check"><input type="checkbox" aria-label="全选已显示文件" checked={allChecked} disabled={!selectable.length || working} onChange={() => setSelected(old => {const next = new Set(old); for (const file of selectable) {if (allChecked) next.delete(String(file.fs_id)); else if (next.size < 500) next.add(String(file.fs_id));} return next;})} /><span>{selected.size ? `已选 ${selected.size} 个` : '全选已显示'}</span></label>{selected.size > 0 ? <><button className="button secondary compact" disabled={blocked} onClick={() => {setReport(null); setAction('rename');}}><Pencil size={15} />重命名</button><button className="button secondary compact file-delete" disabled={blocked} onClick={() => {setReport(null); setAction('delete');}}><Trash2 size={15} />删除</button><button className="icon-button" aria-label="取消文件选择" disabled={working} onClick={() => setSelected(new Set())}><X size={16} /></button></> : <label className="file-search"><Search size={15} /><input aria-label="筛选当前文件夹" placeholder="筛选当前文件夹" value={query} onChange={event => setQuery(event.target.value)} /></label>}</div>
    {!!selected.size && blocked && <p className="section-note" role="status">请先停止播放，并等待扫描或转存完成，再处理文件。</p>}
    {report && <div className={`file-report ${report.failed ? 'has-failures' : ''}`} role="status"><Info size={18} /><span>{report.action === 'rename' ? '重命名' : '删除'}完成 · 成功 {report.success}{report.failed ? `，${report.failed} 个需核对` : ''}</span><button className="text-button" onClick={() => setAction(report.action)}>查看结果</button><button className="icon-button" aria-label="关闭处理结果" onClick={() => setReport(null)}><X size={15} /></button></div>}
    <div className="file-list" aria-busy={loading}>
      {visible.map(file => file.isdir ? <button key={String(file.fs_id)} className="file-row file-directory" disabled={working} onClick={() => navigate([...trail, {path: file.path, fsId: String(file.fs_id)}])}><Folder size={23} /><span className="file-row-copy"><strong>{file.server_filename}</strong><small>文件夹</small></span><ChevronRight size={17} /></button> : <label key={String(file.fs_id)} className={`file-row ${selected.has(String(file.fs_id)) ? 'is-selected' : ''}`}><input type="checkbox" aria-label={`选择 ${file.server_filename}`} checked={selected.has(String(file.fs_id))} disabled={working || selected.size >= 500 && !selected.has(String(file.fs_id))} onChange={event => toggle(String(file.fs_id), (event.nativeEvent as MouseEvent).shiftKey)} />{isSubtitle(file.server_filename) ? <FileText size={21} /> : <Film size={21} />}<span className="file-row-copy"><strong>{file.server_filename}</strong><small>{isSubtitle(file.server_filename) ? '字幕' : '视频'}{state.items.some(item => item.source === 'baidu' && item.fsId === String(file.fs_id)) ? ' · 已入库' : ''}</small></span><span className="file-size">{fileSize(file.size)}</span></label>)}
      {loading && <div className="loading-row" role="status"><LoaderCircle size={19} className="spin" />正在读取文件</div>}
      {error && <div className="inline-error" role="alert"><Info size={17} /><span>{error}</span><button className="text-button" onClick={() => setRevision(value => value + 1)}>重试</button></div>}
      {!visible.length && !loading && !error && <Empty icon={<Folder size={29} />} title={query ? '没有匹配的文件' : '没有视频或字幕'} text={query ? '试试其他文件名。筛选只针对当前已加载的文件。' : '可以打开子文件夹继续查找。'} />}
      {more && !loading && <button className="button secondary load-more" onClick={loadMore}>加载更多文件</button>}
    </div>
    <p className="section-note">仅显示文件夹、视频与字幕。全选仅包含当前已显示的文件，每次最多 500 个。</p>
    {action && <FileOperation rootId={root.id} directoryId={location.fsId} ids={[...selected]} action={action} report={report?.action === action ? report : null} progress={state.fileTask} onClose={() => setAction(null)} onWorking={setWorking} onComplete={value => {setReport(value); setSelected(new Set()); setRevision(old => old + 1);}} />}
  </section>;
}

function FileOperation({rootId, directoryId, ids, action, report, progress, onClose, onWorking, onComplete}: {rootId: string; directoryId?: string; ids: string[]; action: 'rename' | 'delete'; report: FileReport | null; progress?: AppState['fileTask']; onClose: () => void; onWorking: (value: boolean) => void; onComplete: (value: FileReport) => void}) {
  const [rule, setRule] = useState<RenameRule>({mode: 'standard', search: '', replacement: '', prefix: '', suffix: ''}), [includeSubtitles, setIncludeSubtitles] = useState(true);
  const [plan, setPlan] = useState<FilePlan | null>(null), [result, setResult] = useState(report), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const revision = useRef(0), inFlight = useRef(false), attempted = useRef(false);
  const invalidate = () => {revision.current++; setPlan(null); setError('');};
  const preview = async () => {
    if (inFlight.current) return; const current = ++revision.current; inFlight.current = true; setBusy(true); setError('');
    try {const value = await bridge.invoke<FilePlan>('files:preview', {rootId, directoryId, ids, action, rule, includeSubtitles}); if (current === revision.current) setPlan(value);}
    catch (reason) {if (current === revision.current) setError((reason as Error).message);}
    finally {inFlight.current = false; setBusy(false);}
  };
  const execute = async () => {
    if (!plan || inFlight.current) return; inFlight.current = true; attempted.current = true; setBusy(true); onWorking(true); setError('');
    try {const value = await bridge.invoke<FileReport>('files:commit', {id: plan.id}); setResult(value); onComplete(value);}
    catch {setError('操作结果未能确认。请关闭窗口，刷新文件列表核对后重新选择。'); setPlan(null);}
    finally {inFlight.current = false; setBusy(false); onWorking(false);}
  };
  const close = () => {if (!inFlight.current) onClose();};
  return <Modal title={result ? '文件处理结果' : action === 'rename' ? '重命名文件' : '从百度网盘删除'} wide className="file-operation" dismissible={!busy} onClose={close}>
    {result ? <><p className="modal-description">成功 {result.success} 个{result.failed ? ` · ${result.failed} 个未确认成功，请刷新文件夹核对后重试。` : ' · 片库已同步更新。'}</p><div className="file-plan-list">{result.results.map(entry => <div className={`file-plan-entry status-${entry.status}`} key={entry.fsId}>{entry.status === 'success' ? <Check size={17} /> : <Info size={17} />}<div><strong>{entry.original}</strong><p>{entry.message}</p></div></div>)}</div><div className="file-operation-footer"><button className="button primary" onClick={close}>完成</button></div></> : <>
      {action === 'rename' ? <><p className="modal-description">先预览新名称，再应用到网盘。扩展名、影片资料与观看记录会保留。</p><label className="field">命名方式<select aria-label="重命名方式" value={rule.mode} disabled={busy || attempted.current} onChange={event => {invalidate(); setRule({...rule, mode: event.target.value as RenameRule['mode']});}}><option value="standard">按影片资料规范命名</option><option value="replace">替换文字</option><option value="affix">添加前缀 / 后缀</option></select></label>{rule.mode === 'standard' ? <p className="section-note">电影使用「片名 (年份)」，剧集使用「剧名 - S01E01」，保留画质信息。尚未匹配或季集不明确的文件会跳过。</p> : <div className="file-rule-fields">{(rule.mode === 'replace' ? [['search', '查找文字'], ['replacement', '替换为（留空则删除）']] : [['prefix', '前缀'], ['suffix', '后缀']]).map(([key, label]) => <label className="field" key={key}>{label}<input aria-label={label} disabled={busy || attempted.current} maxLength={240} value={rule[key as keyof RenameRule]} onChange={event => {invalidate(); setRule({...rule, [key]: event.target.value});}} /></label>)}</div>}</> : <p className="file-delete-explanation">将删除百度网盘中的原文件，可前往网盘回收站查看。本机保留影片资料与观看记录，片源将标记为不可用。</p>}
      <label className="file-check file-sidecars"><input type="checkbox" checked={includeSubtitles} disabled={busy || attempted.current} onChange={event => {invalidate(); setIncludeSubtitles(event.target.checked);}} /><span>一并{action === 'rename' ? '重命名' : '删除'}同名字幕</span></label>
      {plan ? <><div className="file-plan-heading"><span>{plan.ready} 个文件将{action === 'rename' ? '重命名' : '删除'}</span>{plan.files.length > plan.ready && <small>{plan.files.length - plan.ready} 个跳过</small>}</div><div className="file-plan-list" aria-label="文件操作预览">{plan.files.map(entry => <div className={`file-plan-entry status-${entry.status}`} key={entry.fsId}>{entry.status === 'ready' ? action === 'rename' ? <ArrowRight size={17} /> : <Trash2 size={17} /> : <Info size={17} />}<div><strong>{entry.original}{entry.companion && <small>字幕</small>}</strong>{action === 'rename' && entry.status === 'ready' && <p className="file-new-name">{entry.name}</p>}{entry.reason && <p>{entry.reason}</p>}{entry.status === 'unchanged' && <p>名称无需更改</p>}</div></div>)}</div></> : !attempted.current && <div className="file-preview-placeholder">已选择 {ids.length} 个文件 · 预览时检查同名冲突与关联字幕</div>}
      {error && <p className="inline-error" role="alert"><Info size={17} />{error}</p>}
      <div className="file-operation-footer"><button className="button secondary" disabled={busy && (!attempted.current || !!progress?.cancelling)} onClick={() => {if (busy) void bridge.invoke('files:cancel').catch(() => setError('暂时无法停止，请等待当前操作完成。')); else close();}}>{busy && attempted.current ? progress?.cancelling ? '正在停止…' : '停止后续操作' : '取消'}</button>{plan ? <button className={`button ${action === 'delete' ? 'destructive' : 'primary'}`} disabled={busy || !plan.ready || attempted.current} onClick={execute}>{busy && <LoaderCircle size={16} className="spin" />}{busy ? `正在处理 ${progress?.done ?? 0} / ${progress?.total ?? plan.ready}` : action === 'rename' ? `应用 ${plan.ready} 项更改` : `从网盘删除 ${plan.ready} 个文件`}</button> : !attempted.current && <button className="button primary" disabled={busy || !ids.length || action === 'rename' && (rule.mode === 'replace' && !rule.search || rule.mode === 'affix' && !rule.prefix && !rule.suffix)} onClick={preview}>{busy && <LoaderCircle size={16} className="spin" />}预览{action === 'rename' ? '更改' : '删除文件'}</button>}</div>
    </>}
  </Modal>;
}
