import {useCallback, useEffect, useRef, useState} from 'react';
import {ArrowLeft, Check, ChevronRight, Cloud, Compass, Download, ExternalLink, FileVideo, Folder, FolderOpen, Info, LoaderCircle, RefreshCw, Search} from 'lucide-react';
import {bridge} from './bridge';
import {Empty, Modal, type Run} from './ui';
import {BaiduFolderPicker} from './Sources';
import type {AppState, CloudFile, DiscoveryDetail, DiscoveryMovie, DiscoveryProvider, SharePreview, TransferTask} from './types';

const size = (bytes:number) => bytes > 1024**3 ? (bytes/1024**3).toFixed(1)+' GB' : bytes > 1024**2 ? (bytes/1024**2).toFixed(0)+' MB' : bytes ? Math.ceil(bytes/1024)+' KB' : '';
const working = (status:string) => ['submitting','submitted','importing'].includes(status);
const providerNames:Record<DiscoveryProvider,string> = {baidu:'百度网盘',quark:'夸克网盘',xunlei:'迅雷云盘',alipan:'阿里云盘',unknown:'来源待识别'};

function SaveResource({resource,state,run,connect,onClose}:{resource:{id:string;title:string};state:AppState;run:Run;connect:()=>void;onClose:()=>void}) {
  const [preview,setPreview] = useState<SharePreview|null>(null), [loading,setLoading] = useState(true), [error,setError] = useState(''), [revision,setRevision] = useState(0);
  const [selected,setSelected] = useState<string[]>([]), [trail,setTrail] = useState<{path:string;name:string}[]>([]), [picking,setPicking] = useState(false), [sending,setSending] = useState(false), [saved,setSaved] = useState<TransferTask|null>(null);
  const first = state.scanRoots?.find(root => root.source === 'baidu' && root.enabled !== false && root.fsId && root.path !== '/');
  const [target,setTarget] = useState<{path:string;fsId?:string}|null>(first ? {path:first.path,fsId:first.fsId} : null), [mount,setMount] = useState(true);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;setLoading(true);setError('');setPreview(null);setSelected([]);setTrail([]);
    void bridge.invoke<SharePreview>('discovery:preview',resource).then(result => {if(current === generation.current) setPreview(result);}).catch(reason => {if(current === generation.current) setError(reason.message);}).finally(() => {if(current === generation.current) setLoading(false);});
    return () => {generation.current++;};
  }, [resource.id,revision]);
  const files = async (directory:string, append = false, nextTrail?:typeof trail, openedId?:string) => {
    if (!preview || loading) return;const current = generation.current;setLoading(true);setError('');
    try {
      const result = await bridge.invoke<Omit<SharePreview,'handle'>>('discovery:files',{handle:preview.handle,directory,page:append ? preview.page+1 : 1});
      if(current === generation.current) {
        setPreview({...result,handle:preview.handle,files:append ? [...new Map([...preview.files,...result.files].map(file => [String(file.fs_id),file])).values()] : result.files});
        if(nextTrail) setTrail(nextTrail);
        if(openedId) setSelected(old => old.filter(value => value !== openedId));
      }
    } catch(reason) {if(current === generation.current) setError((reason as Error).message);}
    finally {if(current === generation.current) setLoading(false);}
  };
  const toggle = (file:CloudFile) => setSelected(old => old.includes(String(file.fs_id)) ? old.filter(value => value !== String(file.fs_id)) : [...old,String(file.fs_id)]);
  const save = async () => {
    if (!preview || !target || sending) return;setSending(true);setError('');
    try {setSaved(await bridge.invoke<TransferTask>('discovery:transfer',{handle:preview.handle,fsIds:selected,target,mount}));}
    catch(reason) {setError((reason as Error).message);}
    finally {setSending(false);}
  };
  const task = saved && (state.discoveryTransfers?.find(value => value.id === saved.id) || saved);
  if (picking) return <BaiduFolderPicker state={state} run={run} onClose={() => setPicking(false)} onSelect={location => {setTarget(location);setPicking(false);}}/>;
  return <Modal title={task ? working(task.status) ? '已提交保存' : '保存结果' : '保存到百度网盘'} wide className="discovery-save" onClose={onClose}>
    {task ? <div className="discovery-submitted"><span>{working(task.status) ? <LoaderCircle className="spin" size={28}/> : ['complete','saved'].includes(task.status) ? <Check size={28}/> : <Info size={28}/>}</span><h3>{task.message}</h3><p>保存记录会保留在发现页，你可以继续浏览。</p><button className="button primary" onClick={onClose}>继续浏览</button></div> : <>
      <p className="modal-description discovery-resource-title">{resource.title}</p>
      <div className="share-toolbar"><nav aria-label="分享文件路径"><button disabled={loading} onClick={() => void files('/',false,[])}>分享内容</button>{trail.map((part,index) => <span key={part.path}><ChevronRight size={13}/><button disabled={loading} onClick={() => void files(part.path,false,trail.slice(0,index+1))}>{part.name}</button></span>)}</nav>{preview && <button className="text-button" disabled={loading} onClick={() => {const ids = preview.files.map(file => String(file.fs_id));setSelected(old => ids.every(value => old.includes(value)) ? old.filter(value => !ids.includes(value)) : [...new Set([...old,...ids])]);}}>全选本页</button>}</div>
      <div className="share-files" aria-label="分享文件" aria-busy={loading}>
        {preview?.files.map(file => <div className="share-file" key={String(file.fs_id)}><input type="checkbox" aria-label={`选择 ${file.server_filename}`} checked={selected.includes(String(file.fs_id))} disabled={sending || loading} onChange={() => toggle(file)}/><button disabled={!file.isdir || loading || sending} onClick={() => void files(file.path,false,[...trail,{path:file.path,name:file.server_filename}],String(file.fs_id))}>{file.isdir ? <Folder size={22}/> : <FileVideo size={21}/>}<span>{file.server_filename}<small>{file.isdir ? '文件夹' : size(file.size)}</small></span>{!!file.isdir && <ChevronRight size={15}/>}</button></div>)}
        {loading && <div className="loading-row" role="status"><LoaderCircle className="spin" size={20}/>正在读取分享文件</div>}
        {preview?.hasMore && !loading && <button className="button secondary load-more" onClick={() => void files(preview.directory,true)}>加载更多文件</button>}
        {!loading && preview && !preview.files.length && !error && <Empty icon={<FolderOpen size={25}/>} title="文件夹为空" text="返回上一级，或选择其他资源。"/>}
      </div>
      {error && <div className="inline-error" role="alert"><Info size={17}/><span>{error}</span><button className="text-button" disabled={loading || sending} onClick={() => setRevision(value => value+1)}>重新读取</button></div>}
      <div className="share-destination"><FolderOpen size={22}/><div><strong>保存位置</strong><p>{target?.path || '选择你的影视文件夹'}</p></div><button className="button secondary" disabled={!state.accounts.baidu.connected || sending} onClick={() => setPicking(true)}>选择文件夹</button></div>
      <label className="discovery-mount"><input type="checkbox" checked={mount} onChange={event => setMount(event.target.checked)} disabled={sending}/>持续挂载此目录，之后自动发现新影片</label>
      <div className="share-save-footer"><span>{selected.length ? `已选 ${selected.length} 项 · 重名文件保留副本` : '选择想保存的文件或文件夹'}</span>{state.accounts.baidu.connected ? <button className="button primary" disabled={!preview || !target || !selected.length || sending || (state.discoveryTransfers || []).some(task => working(task.status))} onClick={() => void save()}>{sending ? <LoaderCircle size={16} className="spin"/> : <Download size={16}/>}保存并加入片库</button> : <button className="button primary" onClick={connect}><Cloud size={16}/>先登录百度网盘</button>}</div>
      <button className="text-button discovery-official" onClick={() => void run('discovery:openResource',resource.id)}><ExternalLink size={14}/>在百度官方页面查看或验证</button>
    </>}
  </Modal>;
}

export default function Discovery({state,query,run,connect}:{state:AppState;query:string;run:Run;connect:()=>void}) {
  const [category,setCategory] = useState('all'), [order,setOrder] = useState('hot'), [movies,setMovies] = useState<DiscoveryMovie[]>([]), [page,setPage] = useState(1), [more,setMore] = useState(false), [loading,setLoading] = useState(true), [error,setError] = useState(''), [revision,setRevision] = useState(0);
  const [detail,setDetail] = useState<DiscoveryDetail|null>(null), [movie,setMovie] = useState<DiscoveryMovie|null>(null), [detailLoading,setDetailLoading] = useState(false), [detailError,setDetailError] = useState(''), [limit,setLimit] = useState(12), [resource,setResource] = useState<{id:string;title:string}|null>(null);
  const [provider,setProvider] = useState<'all'|DiscoveryProvider>('baidu');
  const generation = useRef(0), detailGeneration = useRef(0), pending = useRef(false), forceFresh = useRef(false), pageEnd = useRef<HTMLDivElement>(null);
  const refresh = () => {forceFresh.current = true;setRevision(value => value+1);};
  useEffect(() => {
    const current = ++generation.current;setMovies([]);setPage(1);setMore(false);setLoading(true);setError('');setMovie(null);setDetail(null);detailGeneration.current++;
    const fresh = forceFresh.current;forceFresh.current = false;
    const timer = setTimeout(() => {pending.current = true;void bridge.invoke<{movies:DiscoveryMovie[];next:string|null}>('discovery:catalog',{category,order,query,page:1,fresh}).then(result => {if(current === generation.current) {setMovies(result.movies);setMore(!!result.next);}}).catch(reason => {if(current === generation.current) setError(reason.message);}).finally(() => {if(current === generation.current) {setLoading(false);pending.current = false;}});},query ? 350 : 0);
    return () => {clearTimeout(timer);generation.current++;};
  },[category,order,query,revision]);
  const loadMore = useCallback(async () => {
    if(pending.current || loading || !more || movie) return;const current = generation.current;pending.current = true;setLoading(true);setError('');
    try {const result = await bridge.invoke<{movies:DiscoveryMovie[];next:string|null}>('discovery:catalog',{category,order,query,page:page+1});if(current === generation.current) {const known=new Set(movies.map(value=>value.id));setMovies(old => [...new Map([...old,...result.movies].map(value => [value.id,value])).values()]);setPage(page+1);setMore(!!result.next && result.movies.some(value=>!known.has(value.id)));}}
    catch(reason) {if(current === generation.current) setError((reason as Error).message);}
    finally {if(current === generation.current) {pending.current = false;setLoading(false);}}
  },[category,order,query,page,movies,loading,more,movie]);
  useEffect(() => {
    const target = pageEnd.current;
    if (!target || !more || loading || error || movie) return;
    const observer = new IntersectionObserver(entries => {if(entries.some(entry => entry.isIntersecting)) void loadMore();},{rootMargin:'0px 0px 280px 0px'});
    observer.observe(target);return () => observer.disconnect();
  },[more,loading,error,movie,loadMore]);
  const open = async (value:DiscoveryMovie) => {
    const current = ++detailGeneration.current;setMovie(value);setDetail(null);setDetailLoading(true);setDetailError('');setLimit(12);
    try {const result = await bridge.invoke<DiscoveryDetail>('discovery:detail',value.id);if(current === detailGeneration.current) {setDetail(result);setProvider(result.resources.some(resource=>resource.provider==='baidu')?'baidu':'all');}}
    catch(reason) {if(current === detailGeneration.current) setDetailError((reason as Error).message);}
    finally {if(current === detailGeneration.current) setDetailLoading(false);}
  };
  const tasks = state.discoveryTransfers || [];
  const resources = detail?.resources.filter(value => provider === 'all' || value.provider === provider) || [];
  return <div className="discovery-page">
    <div className="page-heading"><div><h1>发现片源</h1><p className="heading-caption">发现想看的故事，保存到你的云端影院。</p></div><span className="discovery-credit"><Compass size={16}/>来自 SeedHub</span></div>
    {!!tasks.length && <details className="discovery-tasks" open={tasks.some(task => working(task.status)) || undefined}><summary><Download size={16}/><span>保存记录</span><small>{tasks.filter(task => working(task.status)).length ? '正在处理' : `${tasks.length} 项`}</small></summary><div>{tasks.slice(0,5).map(task => <article key={task.id} className={`discovery-task task-${task.status}`}>{working(task.status) ? <LoaderCircle className="spin" size={18}/> : task.status === 'complete' ? <Check size={18}/> : <Info size={18}/>}<div><strong>{task.title}</strong><p>{task.message}</p><small>{task.target}</small></div>{task.canCheck && !working(task.status) && task.status !== 'complete' && <button className="text-button" onClick={() => void run('discovery:check',task.id)}>检查状态</button>}</article>)}</div></details>}
    {movie ? <>
      <button className="text-button discovery-back" onClick={() => {detailGeneration.current++;setMovie(null);setDetail(null);}}><ArrowLeft size={16}/>返回发现</button>
      <section className="discovery-detail"><div className="discovery-detail-poster">{(detail?.poster || movie.poster) ? <img src={detail?.poster || movie.poster || ''} alt="" referrerPolicy="no-referrer"/> : <Compass size={40}/>}</div><div><span className="eyebrow">片源详情</span><h2>{detail?.title || movie.title}</h2><p>{detail?.overview || '选择下方资源，查看文件后保存到自己的百度网盘。'}</p><small>影片资料与版本标注来自资源网站，实际格式以入库后的媒体检测为准。</small></div></section>
      {detailLoading && <div className="loading-row" role="status"><LoaderCircle className="spin" size={20}/>正在读取资源</div>}
      {detailError && <div className="inline-error" role="alert"><Info size={17}/><span>{detailError}</span><button className="text-button" onClick={() => void open(movie)}>重试</button></div>}
      {detail && <section className="discovery-resources"><div className="section-heading"><h2>可选资源</h2><span>{resources.length}</span></div><p className="section-note">按来源选择资源，目前支持保存百度网盘内容。</p>
        <div className="discovery-provider-tabs" aria-label="片源来源">{(['baidu','all','quark','xunlei','alipan','unknown'] as const).map(value => {const count=value==='all'?detail.resources.length:detail.resources.filter(resource=>resource.provider===value).length;return (count>0 || value==='baidu') && <button key={value} data-provider={value} aria-pressed={provider===value} onClick={()=>{setProvider(value);setLimit(12);}}>{value==='all'?'全部来源':providerNames[value]}<span>{count}</span></button>;})}</div>
        {resources.slice(0,limit).map((value,index) => <button key={value.id} className="discovery-resource" disabled={value.provider !== 'baidu' && value.provider !== 'unknown'} onClick={() => setResource({id:value.id,title:detail.title})}><span className="discovery-resource-number">{String(index+1).padStart(2,'0')}</span><span><strong>{value.title || '网盘资源'}</strong><small>{value.provider === 'baidu' ? '查看分享内容' : value.provider === 'unknown' ? '打开后识别网盘来源' : '暂不支持保存此网盘'}</small></span><span className={`discovery-provider provider-${value.provider}`}>{providerNames[value.provider]}</span><ChevronRight size={18}/></button>)}
        {!resources.length && <Empty icon={<Search size={28}/>} title={provider==='all'?'暂时没有网盘资源':`暂无${providerNames[provider]}资源`} text="试试其他来源，或搜索其他版本。"/>}{limit < resources.length && <button className="button secondary load-more" onClick={() => setLimit(value => value+12)}>显示更多资源</button>}</section>}
    </> : <>
      <div className="discovery-toolbar"><div className="discovery-tabs" aria-label="片源分类">{[['all','全部'],['movies','电影'],['shows','剧集'],['anime','动漫']].map(([value,title]) => <button key={value} aria-pressed={category === value} onClick={() => setCategory(value)}>{title}</button>)}</div><div className="discovery-sort" aria-label="片源排序">{[['hot','近期热门'],['update','最近更新'],['date','最新上映'],['score','评分优先']].map(([value,title]) => <button key={value} aria-pressed={order === value} onClick={() => setOrder(value)}>{title}</button>)}</div><button className="icon-button" aria-label="刷新发现页" disabled={loading} onClick={refresh}><RefreshCw size={17}/></button></div>
      {query && <p className="discovery-query">“{query}”的搜索结果</p>}
      <div className="discovery-grid">{movies.map(value => <button className="discovery-card" key={value.id} onClick={() => void open(value)}><span className="discovery-cover">{value.poster ? <img loading="lazy" src={value.poster} referrerPolicy="no-referrer" alt="" onError={event => {event.currentTarget.style.visibility='hidden';}}/> : <Compass size={35}/>}<span className="discovery-cover-action"><Search size={18}/>查看资源</span></span><strong>{value.title}</strong></button>)}{loading && !movies.length && Array.from({length:10},(_,index) => <div className="discovery-skeleton" key={index}><span/><i/></div>)}</div>
      {loading && <div className="loading-row" role="status"><LoaderCircle className="spin" size={20}/>正在发现影片</div>}
      {error && (movies.length ? <div className="inline-error discovery-page-error" role="alert"><Info size={17}/><span>{error}</span><button className="text-button" onClick={()=>void loadMore()}>重试加载</button></div> : <div className="discovery-error" role="alert"><Info size={24}/><h3>暂时无法读取片源</h3><p>{error}</p><div><button className="button secondary" onClick={refresh}>重试</button><button className="text-button" onClick={() => void run('discovery:verifySite')}>在网站完成验证<ExternalLink size={14}/></button></div></div>)}
      {!loading && !error && !movies.length && <Empty icon={<Search size={30}/>} title="没有找到影片" text="试试更短的片名、原名或英文名称。"/>}
      <div ref={pageEnd} className="discovery-pagination" aria-live="polite">{!loading && !error && movies.length>0 && (more?'继续下滑，自动加载更多影片':'已经浏览完全部影片')}</div>
    </>}
    {resource && <SaveResource resource={resource} state={state} run={run} connect={connect} onClose={() => setResource(null)}/>}
  </div>;
}
