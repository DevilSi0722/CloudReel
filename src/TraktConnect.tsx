import {Check, ExternalLink, LoaderCircle, RefreshCw} from 'lucide-react';
import type {Account} from './types';
import {Modal, type Run} from './ui';

export default function TraktConnect({account, run, onClose}: {account: Account; run: Run; onClose: () => void}) {
  const close = () => {void run('trakt:cancelAuth'); onClose();};
  return <Modal title="登录 Trakt" onClose={close}>
    <div className={`trakt-connect ${account.connected ? 'is-connected' : ''}`}>
      <span className="trakt-connect-icon">{account.authorizing ? <LoaderCircle size={30} className="spin" /> : <Check size={30} strokeWidth={2.5} />}</span>
      <h3>{account.connected ? '故事，已连接' : !account.configured ? 'Trakt 连接暂不可用' : account.authorizing ? '正在完成授权' : '让故事在设备间延续'}</h3>
      <p>{account.connected ? `已连接 ${account.profile?.username || '你的 Trakt 账号'}。播放进度将按同步设置保存。` : !account.configured ? '此版本尚未开通 Trakt 登录。完成接入后的版本中，你只需登录自己的账号并同意授权。' : '在 Trakt 官方窗口登录并允许云映访问观看进度，完成后会自动返回。'}</p>
      {account.authorizationError && <p className="inline-error" role="alert">{account.authorizationError}</p>}
      {account.connected ? <button className="button primary full" onClick={close}><Check size={15} />完成</button> : account.configured ? <>
        <button className="button primary full" disabled={account.authorizing} onClick={() => run('trakt:auth')}>
          {account.loginOpen ? <ExternalLink size={15} /> : <RefreshCw size={15} />}{account.loginOpen ? '返回授权窗口' : '登录并授权'}
        </button><p className="trakt-connect-note">授权仅在 Trakt 官方页面进行，云映不接收你的密码。</p>
      </> : <button className="button secondary full" onClick={close}>知道了</button>}
    </div>
  </Modal>;
}
