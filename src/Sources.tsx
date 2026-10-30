import {useEffect, useRef, useState} from 'react';
import {ArrowLeft, Check, ChevronRight, Cloud, Folder, FolderOpen, Info, LoaderCircle, Plus, RefreshCw, Trash2, Unplug} from 'lucide-react';
import {bridge} from './bridge';
import {Empty, Modal, type Run} from './ui';
import type {AppState, CloudFile} from './types';
import FileManager from './FileManager';
import BaiduStorage from './BaiduStorage';

type FolderLocation = {path: string; fsId?: string};
type FolderPage = {files: CloudFile[]; hasMore: boolean; nextStart: number};

export function BaiduFolderPicker({state, run, onClose, onSelect}: {state: AppState; run: Run; onClose: () => void; onSelect?: (location: FolderLocation) => void}) {
  const [location, setLocation] = useState<FolderLocation>({path: '/'});
  const [files, setFiles] = useState<CloudFile[]>([]), [next, setNext] = useState(0), [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true), [mounting, setMounting] = useState(false), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const generation = useRef(0), pending = useRef(false), known = useRef(new Map<string, string>());
  useEffect(() => {
    const current = ++generation.current; pending.current = true;
    setFiles([]); setMore(false); setLoading(true); setError('');
    void bridge.invoke<FolderPage>('baidu:folders', {directory: location.path}).then(result => {
      if (current !== generation.current) return;
      setFiles(result.files); setNext(result.nextStart); setMore(result.hasMore);
    }).catch(reason => {if (current === generation.current) setError(reason.message);}).finally(() => {
      if (current === generation.current) {pending.current = false; setLoading(false);}
    });
    return () => {generation.current++;};
  }, [location.path, revision]);
  const open = (path: string, fsId?: string) => {
    if (fsId) known.current.set(path, fsId);
    setLocation({path, fsId: fsId ?? known.current.get(path)});
  };
  const loadMore = async () => {
    if (pending.current) return;
    const current = generation.current; pending.current = true; setLoading(true); setError('');
    try {
      const result = await bridge.invoke<FolderPage>('baidu:folders', {directory: location.path, start: next});
      if (current === generation.current) {
        setFiles(old => [...new Map([...old, ...result.files].map(file => [String(file.fs_id), file])).values()]);
        setNext(result.nextStart); setMore(result.hasMore);
      }
    } catch (reason) {if (current === generation.current) setError((reason as Error).message);}
    finally {if (current === generation.current) {pending.current = false; setLoading(false);}}
  };
  const mounted = !onSelect && state.scanRoots?.some(root => root.source === 'baidu' && root.enabled !== false && (location.fsId && root.fsId === location.fsId || root.path === location.path));
  const parts = location.path.split('/').filter(Boolean);
  return <Modal title={onSelect ? '选择保存位置' : '挂载网盘文件夹'} wide className="folder-picker" onClose={onClose}>
    <p className="modal-description">{onSelect ? '打开希望保存影片的文件夹，然后确认当前位置。' : '打开想要挂载的文件夹，确认后自动添加其中的电影与剧集。'}</p>
    <div className="folder-picker-toolbar"><nav className="directory-path" aria-label="网盘目录">
      <button className="icon-button" aria-label="上级目录" disabled={location.path === '/' || mounting} onClick={() => open(location.path.slice(0, location.path.lastIndexOf('/')) || '/')}><ArrowLeft size={17} /></button>
      <button disabled={mounting} onClick={() => open('/')}><Cloud size={16} />全部文件</button>
      {parts.map((part, index) => <span key={index}><ChevronRight size={13} /><button disabled={mounting} onClick={() => open('/' + parts.slice(0, index + 1).join('/'))}>{part}</button></span>)}
    </nav><button className="icon-button" aria-label="刷新文件夹列表" disabled={loading || mounting} onClick={() => setRevision(old => old + 1)}><RefreshCw size={16} /></button></div>
    <div className="folder-picker-list" aria-label="网盘文件夹" aria-busy={loading}>
      {files.map(file => <button className="folder-choice" key={String(file.fs_id)} disabled={mounting} onClick={() => open(file.path, String(file.fs_id))}><Folder size={25} className="folder-icon" /><span>{file.server_filename}</span>{state.scanRoots?.some(root => root.source === 'baidu' && (root.fsId === String(file.fs_id) || root.path === file.path)) && <small>已挂载</small>}<ChevronRight size={16} /></button>)}
      {loading && <div className="loading-row" role="status"><LoaderCircle size={20} className="spin" />正在读取文件夹</div>}
      {error && <div className="inline-error" role="alert"><Info size={16} /><span>{error}</span><button className="text-button" onClick={() => setRevision(old => old + 1)}>重试</button></div>}
      {!loading && !error && !files.length && !more && <Empty icon={<FolderOpen size={28} />} title="没有子文件夹" text={onSelect ? '可以将影片保存到当前文件夹。' : '可以直接挂载当前文件夹，其中的视频会自动入库。'} />}
      {more && !loading && <button className="button secondary load-more" onClick={loadMore}>加载更多文件夹</button>}
    </div>
    <div className="folder-picker-selection"><FolderOpen size={21} /><div><strong>{parts.at(-1) || '全部文件'}</strong><p title={location.path}>{location.path}</p></div></div>
    <div className="folder-picker-footer"><span>{onSelect ? location.path === '/' ? '请打开一个影视文件夹作为保存位置' : '确认位置后，仍需点击保存才能转存' : '包含子文件夹 · 原文件保留在网盘'}</span><button className="button primary" disabled={loading || !!error || mounting || mounted || (!!onSelect && !location.fsId) || (!onSelect && state.scan.running && !state.scan.background) || !state.accounts.baidu.connected} onClick={async () => {if(onSelect) {onSelect(location);return;}setMounting(true); try {if (await run('library:mountBaidu', location)) onClose();} finally {setMounting(false);}}}>{mounting ? <LoaderCircle size={16} className="spin" /> : mounted || onSelect ? <Check size={16} /> : <Plus size={16} />}{onSelect ? '保存到此文件夹' : mounting ? '正在挂载' : mounted ? '已挂载' : '挂载此文件夹'}</button></div>
  </Modal>;
}

export default function Sources({state, run, connect, busy}: {state: AppState; run: Run; connect: () => void; busy: boolean}) {
  const [picking, setPicking] = useState(false), account = state.accounts.baidu;
  const [managing, setManaging] = useState<string | null>(null);
  const roots = state.scanRoots?.filter(root => root.source === 'baidu') ?? [];
  const managedRoot = roots.find(root => root.id === managing);
  if (managedRoot && account.connected) return <FileManager root={managedRoot} state={state} onBack={() => setManaging(null)} />;
  return <>
    <div className="page-heading"><div><h1>百度网盘</h1><p className="heading-caption">把影视文件夹，连接到你的影院。</p></div>{account.connected && <button className="button primary" disabled={busy || (state.scan.running && !state.scan.background)} onClick={() => setPicking(true)}><Plus size={17} />挂载文件夹</button>}</div>
    <section className="settings-group source-account"><div className="account-row"><span className="service-icon"><Cloud size={26} /></span><div className="row-copy"><h2>{account.profile?.netdisk_name || account.profile?.baidu_name || '百度网盘'}</h2><p>{account.connected ? `${account.mode === 'web' ? '网页登录' : '开放平台授权'}${account.profile?.vip ? ` · ${account.profile.vip}` : ''}` : account.loginOpen ? '请在百度官方窗口中完成登录' : '使用你的百度账号登录'}</p></div>{account.connected ? <><span className="connected-label"><i className="status-dot" />已连接</span><button className="icon-button" aria-label="断开百度网盘" disabled={busy} onClick={() => run('account:disconnect', 'baidu')}><Unplug size={17} /></button></> : <button className="button primary" disabled={busy} onClick={connect}>{account.checking && <LoaderCircle size={16} className="spin" />}{account.loginOpen ? '返回登录窗口' : '登录百度网盘'}</button>}</div>{account.connected && <BaiduStorage account={account} />}</section>
    {account.connected ? <section className="mounted-section" aria-label="已挂载文件夹"><div className="section-heading"><h2>已挂载文件夹</h2><span>{roots.length}</span>{!!roots.length && <button className="text-button" disabled={busy || (state.scan.running && !state.scan.background)} onClick={() => run('library:refresh', {ids: roots.map(root => root.id)})}><RefreshCw size={14} />全部刷新</button>}</div>
      {roots.length ? <div className="mount-grid">{roots.map(root => <article className="mount-card" key={root.id}><span className="mount-icon"><Folder size={29} /></span><div className="mount-copy"><h3>{root.path.split('/').filter(Boolean).at(-1) || '全部文件'}</h3><p title={root.path}>{root.path}</p><span className={root.error ? 'mount-error' : ''}>{root.error || (state.scan.running && !state.scan.background && state.scan.directory?.startsWith(root.path) ? '正在更新影片…' : root.lastScannedAt ? `${root.count ?? 0} 个视频 · ${new Date(root.lastScannedAt).toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'})} 更新` : '等待更新')}</span><button className="text-button mount-manage" aria-label={`管理文件 ${root.path}`} onClick={() => setManaging(root.id)}>管理文件<ChevronRight size={14} /></button></div><div className="mount-actions"><button className="icon-button" aria-label={`刷新挂载 ${root.path}`} disabled={busy || (state.scan.running && !state.scan.background)} onClick={() => run('library:refresh', {ids: [root.id]})}><RefreshCw size={16} /></button><button className="icon-button" aria-label={`取消挂载 ${root.path}`} title="取消挂载，保留已入库影片与观看记录" disabled={busy || state.scan.running} onClick={() => run('library:removeRoot', root.id)}><Trash2 size={16} /></button></div></article>)}</div> : <div className="mount-empty"><Empty icon={<FolderOpen size={34} />} title="选择你的影视文件夹" text="挂载后自动整理电影与剧集，并持续发现新增影片。" action={<button className="button secondary" disabled={busy || (state.scan.running && !state.scan.background)} onClick={() => setPicking(true)}><Plus size={16} />挂载文件夹</button>} /></div>}
    </section> : <Empty icon={<Cloud size={32} />} title={account.loginOpen ? '等待登录' : '连接你的云端片库'} text="在百度官方网页登录后，选择想要挂载的影视文件夹。" action={account.loginOpen ? <button className="button secondary" disabled={busy} onClick={() => run('baidu:checkWeb')}><RefreshCw size={15} />我已完成登录</button> : undefined} />}
    <p className="section-note">{account.mode === 'web' ? '登录会话仅保存在这台电脑。' : ''}挂载与刷新不会移动或删除网盘文件。</p>
    {picking && account.connected && <BaiduFolderPicker state={state} run={run} onClose={() => setPicking(false)} />}
  </>;
}
