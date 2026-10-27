const allowed = new Set(['api.themoviedb.org', 'movie.douban.com', 'api.tvmaze.com', 'api.trakt.tv']);
const isImage = host => /(^|\.)(image\.tmdb\.org|doubanio\.com|static\.tvmaze\.com|mzstatic\.com)$/.test(host);

// Chromium honors the Windows system proxy/PAC. Node's global fetch does not.
// Use a separate in-memory session: provider login cookies never enter this path.
export function createMetadataFetcher(browserSession) {
  return (input, options = {}) => {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || !allowed.has(url.hostname) && !isImage(url.hostname)) throw new Error('不支持的元数据服务地址。');
    return browserSession.fetch(url.toString(), { ...options, credentials: 'omit', redirect: 'error', cache: 'no-store' });
  };
}

export function metadataNetworkError(error) {
  const code = `${error?.code ?? ''} ${error?.cause?.code ?? ''} ${error?.message ?? ''}`;
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ECONNREFUSED|ERR_NO_SUPPORTED_PROXIES/i.test(code)) return '无法连接系统代理，请确认代理软件正在运行及其端口设置。';
  if (/CERT_|ERR_SSL|TLS|CERTIFICATE/i.test(code)) return '元数据服务的安全连接失败，请检查系统时间、证书和代理设置。';
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(code)) return '无法解析元数据服务地址，请检查 DNS 或系统代理。';
  if (/Timeout|TIMED_OUT|CONNECT_TIMEOUT|Abort/i.test(code) || error?.name === 'TimeoutError') return '连接元数据服务超时，请检查网络和系统代理后重试。';
  return '无法连接元数据服务，请检查网络和系统代理后重试。';
}
