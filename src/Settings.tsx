import {useState, type ReactNode} from 'react';
import {Check, ChevronDown, Cloud, Film, Folder, Gauge, LoaderCircle, Plus, RefreshCw, Settings2, SlidersHorizontal, Trash2} from 'lucide-react';
import type {AppState, PlaybackDefaults} from './types';
import {Toggle, type Run} from './ui';
import BrandMark from './BrandMark';

function SettingsSection({title, description, status, icon, children}: {title: string; description: string; status?: string; icon: ReactNode; children: ReactNode}) {
  return <details className="settings-disclosure"><summary><span className="settings-section-icon">{icon}</span><span className="settings-section-copy"><strong>{title}</strong><small>{description}</small></span>{status && <span className="settings-section-status">{status}</span>}<ChevronDown size={17} className="disclosure-chevron" /></summary><div className="settings-disclosure-body">{children}</div></details>;
}

export default function Settings({state, run, connectBaidu, connectTrakt, metadata}: {state: AppState; run: Run; connectBaidu: () => void; connectTrakt: () => void; metadata: ReactNode}) {
  const [saving, setSaving] = useState<string | null>(null);
  const change = async (key: string, value: boolean) => {setSaving(key); try {await run('settings:save', {[key]: value});} finally {setSaving(null);}};
  return <div className="settings-page">
    <div className="page-heading"><div><h1>设置</h1><p className="heading-caption">让你的影院，更合你的习惯。</p></div><span className="settings-save-status" role="status">{saving ? <><LoaderCircle size={13} className="spin" />正在保存</> : <><Check size={13} />常用设置自动保存</>}</span></div>
    <h3 className="group-label">账号与连接</h3>
    <section className="settings-group settings-accounts" aria-label="账号连接">
      <div className="account-row"><span className="service-icon"><Cloud size={23} /></span><div className="row-copy"><h2>百度网盘</h2><p>{state.accounts.baidu.connected ? state.accounts.baidu.profile?.netdisk_name || '已连接' : '连接你的云端片库'}</p></div><button className="button secondary compact" onClick={connectBaidu}>{state.accounts.baidu.connected ? '管理登录' : '登录'}</button></div>
      <div className="account-row"><span className="service-icon trakt"><Check size={23} /></span><div className="row-copy"><h2>Trakt</h2><p>{state.accounts.trakt.connected ? state.accounts.trakt.profile?.username || '已连接' : '在不同设备间接着看'}</p></div>{state.accounts.trakt.connected ? <span className="connected-label"><i className="status-dot" />已连接</span> : <button className="button secondary compact" onClick={connectTrakt}>登录</button>}</div>
    </section>
    <h3 className="group-label">日常使用</h3>
    <section className="settings-group" aria-label="常用设置">
      {([
        ['autoNext', '自动播放下一集', '一集结束，故事继续', state.settings.autoNext],
        ['autoSync', '同步观看进度', '通过 Trakt 保存进度与已看记录', state.settings.autoSync],
        ['autoRefresh', '自动刷新片库', '启动时及每 15 分钟检查影视目录', state.settings.autoRefresh !== false]
      ] as const).map(([key, title, text, checked]) => <div className="setting-row" key={key}><div><strong>{title}</strong><p>{text}</p></div><Toggle label={title} checked={checked} disabled={saving !== null} onChange={() => void change(key, !checked)} /></div>)}
    </section>
    <h3 className="group-label">更多偏好</h3>
    <div className="settings-sections">
      <SettingsSection title="播放偏好" description="音轨、字幕与默认倍速" icon={<Gauge size={20} />} status={`${state.playbackDefaults?.speed ?? 1}×`}><PlaybackSettings state={state} run={run} /></SettingsSection>
      <SettingsSection title="海报与影片资料" description="自动识别、资料更新与 TMDB 连接" icon={<Film size={20} />} status={state.scrape.connectionError ? '连接异常' : state.scrape.tmdbConfigured ? 'TMDB 已配置' : '公开数据源'}>{metadata}</SettingsSection>
      <SettingsSection title="影视目录" description="管理扫描来源与默认网盘目录" icon={<Folder size={20} />} status={`${state.scanRoots?.length ?? 0} 个目录`}><ScanFolders state={state} run={run} /></SettingsSection>
      <SettingsSection title="高级设置" description="播放器路径与网盘接入方式" icon={<SlidersHorizontal size={20} />} status={state.runtime.mpvReady ? '播放器已就绪' : '待配置播放器'}><AdvancedSettings state={state} run={run} /></SettingsSection>
    </div>
    <div className="about-row"><BrandMark small /><span>云映 <small>CloudReel {state.runtime.version}</small></span></div>
  </div>;
}

const playbackFallback: PlaybackDefaults = {audioLanguage:'auto',subtitleLanguage:'zh-Hans',speed:1,subtitleDelay:0,subtitleSize:44,subtitleFont:'Microsoft YaHei',rememberPlayback:true};
function PlaybackSettings({state, run}: {state: AppState; run: Run}) {
  const [form, setForm] = useState({...playbackFallback, ...state.playbackDefaults}), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false);
  const update = (values: Partial<PlaybackDefaults>) => {setForm(old => ({...old, ...values})); setSaved(false);};
  const languages = [['auto','自动'],['zh-Hans','简体中文'],['zh-Hant','繁体中文'],['zh','中文'],['en','英语'],['ja','日语'],['ko','韩语'],['no','关闭']];
  return <>
    <div className="setting-row"><div><strong>按作品记忆</strong><p>同一部剧沿用音轨、字幕、倍速与字幕样式</p></div><Toggle checked={form.rememberPlayback} label="按作品记忆播放偏好" onChange={() => update({rememberPlayback: !form.rememberPlayback})} /></div>
    {(['audioLanguage', 'subtitleLanguage'] as const).map(key => <label className="setting-row" key={key}><strong>{key === 'audioLanguage' ? '首选音轨' : '首选字幕'}</strong><select aria-label={key === 'audioLanguage' ? '首选音轨语言' : '首选字幕语言'} value={form[key]} onChange={event => update({[key]: event.target.value})}>{languages.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>)}
    <label className="setting-row"><strong>默认倍速</strong><select aria-label="默认倍速" value={form.speed} onChange={event => update({speed: Number(event.target.value)})}>{[.5,.75,1,1.25,1.5,1.75,2,3,4].map(speed => <option key={speed} value={speed}>{speed}×</option>)}</select></label>
    <details className="settings-nested"><summary>字幕样式 <ChevronDown size={15} /></summary><div>
      <label className="setting-row"><strong>字幕字号</strong><input className="row-input small" aria-label="默认字幕字号" type="number" min="20" max="80" value={form.subtitleSize} onChange={event => update({subtitleSize: Number(event.target.value)})} /></label>
      <label className="setting-row"><strong>字幕字体</strong><select aria-label="默认字幕字体" value={form.subtitleFont} onChange={event => update({subtitleFont: event.target.value})}>{['Microsoft YaHei','Microsoft YaHei UI','SimHei','SimSun','Arial','Segoe UI'].map(font => <option key={font}>{font}</option>)}</select></label>
    </div></details>
    <div className="settings-section-footer"><p>用于新作品，也可在播放器中单独调整。</p><button className="button secondary compact" disabled={busy} onClick={async () => {setBusy(true); try {if (await run('playback:defaults', form)) setSaved(true);} finally {setBusy(false);}}}>{busy ? <LoaderCircle size={14} className="spin" /> : saved ? <Check size={14} /> : null}{saved ? '已保存' : '保存播放偏好'}</button></div>
  </>;
}

function ScanFolders({state, run}: {state: AppState; run: Run}) {
  const [directory, setDirectory] = useState(state.settings.rootDir), [busy, setBusy] = useState(false);
  return <>
    {state.scanRoots?.length ? state.scanRoots.map(root => <div className="setting-row" key={root.id}><span className="service-icon neutral">{root.source === 'baidu' ? <Cloud size={20} /> : <Folder size={20} />}</span><div className="scan-folder-copy"><strong title={root.path}>{root.path}</strong><p>{root.error || (root.lastScannedAt ? `${root.count ?? 0} 个视频 · ${new Date(root.lastScannedAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}` : '等待扫描')}</p></div><button className="icon-button" aria-label={`刷新目录 ${root.path}`} disabled={state.scan.running} onClick={() => run('library:refresh', {ids:[root.id]})}><RefreshCw size={16} /></button><button className="icon-button" aria-label={`停止监测目录 ${root.path}`} title="停止监测，保留影片" disabled={state.scan.running} onClick={() => run('library:removeRoot', root.id)}><Trash2 size={16} /></button></div>) : <p className="settings-empty">添加影视目录后，可在这里管理自动扫描。</p>}
    <div className="setting-row"><div><strong>默认网盘目录</strong><p>添加网盘影片时的起始位置</p></div><div className="settings-directory"><input className="row-input" aria-label="默认影视目录" value={directory} onChange={event => setDirectory(event.target.value)} placeholder="/" /><button className="button secondary compact" disabled={busy || directory === state.settings.rootDir} onClick={async () => {setBusy(true); try {await run('settings:save', {rootDir: directory});} finally {setBusy(false);}}}>保存</button></div></div>
    <div className="settings-section-footer"><p>刷新时保留海报、识别与观看记录。</p><button className="button secondary compact" disabled={state.scan.running} onClick={() => run('library:importFolder')}><Plus size={14} />添加本地目录</button></div>
  </>;
}

function AdvancedSettings({state, run}: {state: AppState; run: Run}) {
  const [form, setForm] = useState({baiduMode: state.settings.baiduMode, baiduClientId: state.settings.baiduClientId, baiduSecret: '', mpvPath: state.settings.mpvPath}), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const update = (key: string, value: string) => {setForm(old => ({...old, [key]: value})); setSaved(false);};
  return <div className="settings-advanced-fields">
    <p className="section-note">通常使用内置播放器和官方网页登录即可。</p>
    <label className="field">百度网盘登录方式<select aria-label="百度网盘登录方式" value={form.baiduMode} onChange={event => update('baiduMode', event.target.value)}><option value="web">官方网页登录（推荐）</option><option value="oauth">开放平台 OAuth</option></select></label>
    {form.baiduMode === 'oauth' && <><label className="field">百度 AppKey<input autoComplete="off" value={form.baiduClientId} onChange={event => update('baiduClientId', event.target.value)} /></label><label className="field">百度 SecretKey<input type="password" autoComplete="new-password" value={form.baiduSecret} onChange={event => update('baiduSecret', event.target.value)} placeholder={state.hasBaiduSecret ? '已保存，留空保留' : ''} /></label></>}
    <label className="field">自定义 mpv 路径<div className="input-with-button"><input aria-label="自定义 mpv 路径" value={form.mpvPath} onChange={event => update('mpvPath', event.target.value)} placeholder="自动使用内置播放器" /><button className="button secondary" onClick={async () => {const selected = await run<string>('mpv:select'); if (selected) update('mpvPath', selected);}}>选择</button></div></label>
    <button className="button secondary compact" disabled={busy} onClick={async () => {setBusy(true); try {if (await run('settings:save', form)) {setForm(old => ({...old, baiduSecret:''})); setSaved(true);}} finally {setBusy(false);}}}>{busy ? <LoaderCircle size={14} className="spin" /> : saved ? <Check size={14} /> : <Settings2 size={14} />}{saved ? '已保存' : '保存高级设置'}</button>
  </div>;
}
