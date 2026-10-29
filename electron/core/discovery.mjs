// Provider data stays separate from the user's library and playback identity.
export const SEEDHUB_ORIGIN = 'https://sidhub.cc';

export class DiscoveryError extends Error {
  constructor(code, message) { super(message); this.name = 'DiscoveryError'; this.code = code; }
}

export function seedHubUrl(input = '/') {
  let url;
  try { url = new URL(input, SEEDHUB_ORIGIN); } catch { /* Report no raw URLs. */ }
  if (!url || url.origin !== SEEDHUB_ORIGIN || url.username || url.password) {
    throw new DiscoveryError('invalid-url', '只允许访问 SeedHub 本站页面。');
  }
  url.hash = '';
  return url.href;
}

export function baiduShare(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.origin !== 'https://pan.baidu.com' || url.username || url.password) return null;
  let shortId = url.pathname.match(/^\/s\/1([\w-]+)\/?$/)?.[1];
  if (!shortId && url.pathname === '/share/init') shortId = url.searchParams.get('surl');
  if (!shortId || !/^[\w-]+$/.test(shortId)) return null;
  const password = url.searchParams.get('pwd') || '';
  if (password && !/^[a-zA-Z0-9]{4}$/.test(password)) return null;
  const canonical = new URL('/s/1' + shortId, 'https://pan.baidu.com');
  if (password) canonical.searchParams.set('pwd', password);
  // Keep these values in memory; reports must never include this object.
  return {url: canonical.href, shortId, password};
}

export function resourceProvider(input) {
  if (baiduShare(input)) return 'baidu';
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  return ({'pan.xunlei.com': 'xunlei', 'pan.quark.cn': 'quark', 'www.alipan.com': 'alipan', 'www.aliyundrive.com': 'alipan'})[url.hostname] || null;
}

function readable(snapshot) {
  const text = `${snapshot.title || ''}\n${snapshot.text || ''}`;
  if (snapshot.challenge || /Just a moment|Checking your browser|请稍候.*验证|正在验证.*浏览器/i.test(text) || [403, 429].includes(snapshot.status)) {
    throw new DiscoveryError('verification-required', '网站要求浏览器验证，当前不能静默读取。');
  }
  if (snapshot.status && (snapshot.status < 200 || snapshot.status >= 300)) {
    throw new DiscoveryError('http-error', '网站页面暂时不可用。');
  }
}

const label = value => String(value || '').replace(/\s+/g, ' ').trim();
function internalLink(input, base) {
  try { return new URL(seedHubUrl(new URL(input, base).href)); } catch { return null; }
}

export function catalogFromSnapshot(snapshot) {
  readable(snapshot);
  const base = seedHubUrl(snapshot.url), movies = new Map();
  for (const anchor of snapshot.anchors || []) {
    const url = internalLink(anchor.href, base), id = url?.pathname.match(/^\/movies\/(\d+)\/$/)?.[1];
    if (!id || String(anchor.href).includes('#')) continue;
    const title = label(anchor.text || anchor.imageAlt);
    const movie = movies.get(id) || {id, url: url.origin + url.pathname, title: '', poster: null};
    if (title && !movie.title) movie.title = title;
    if (anchor.image) {
      try {
        const image = new URL(anchor.image, base);
        if (image.protocol === 'https:' && !image.username && !image.password) movie.poster = image.href;
      } catch { /* Broken artwork does not prevent browsing. */ }
    }
    movies.set(id, movie);
  }
  const current = new URL(base), page = Number(current.searchParams.get('page') || 1);
  const next = (snapshot.anchors || []).map(anchor => internalLink(anchor.href, base)).find(url =>
    url?.pathname === current.pathname && Number(url.searchParams.get('page')) === page + 1 &&
    url.searchParams.get('order') === current.searchParams.get('order'));
  return {movies: [...movies.values()].filter(movie => movie.title), next: next?.href || null};
}

export function detailFromSnapshot(snapshot) {
  readable(snapshot);
  const base = seedHubUrl(snapshot.url), resources = new Map();
  for (const anchor of snapshot.anchors || []) {
    const url = internalLink(anchor.href, base);
    if (url?.pathname !== '/link_start/') continue;
    const id = url.searchParams.get('redirect_to');
    if (!/^pan_id_\d+$/.test(id || '')) continue;
    if (!resources.has(id)) resources.set(id, {id, title: label(anchor.text), url: url.href});
  }
  let poster = null; try {const url = new URL(snapshot.poster); if (url.protocol === 'https:') poster = url.href;} catch {}
  return {title: label(snapshot.heading || snapshot.title).replace(/^#\s*/, ''), overview: label(snapshot.overview).slice(0,3000), poster, resources: [...resources.values()]};
}

export function resourcesFromSnapshot(snapshot) {
  readable(snapshot);
  const base = seedHubUrl(snapshot.url), resources = new Map();
  for (const anchor of [...(snapshot.anchors || []), ...(snapshot.qrLinks || []).map(href => ({href}))]) {
    let url;
    try { url = new URL(anchor.href, base); } catch { continue; }
    const provider = resourceProvider(url.href);
    if (!provider) continue;
    const share = provider === 'baidu' ? baiduShare(url.href) : null;
    const key = share ? 'baidu:' + share.shortId : url.href;
    const previous = resources.get(key);
    // An intermediate page may falsely claim the code is missing while href
    // already includes it. Prefer the actual link and retain the richer one.
    if (!previous || (share?.password && !previous.share?.password)) {
      resources.set(key, {provider, url: share?.url || url.href, share});
    }
  }
  return [...resources.values()];
}

export function sharePageState(snapshot) {
  const text = `${snapshot.title || ''}\n${snapshot.text || ''}`;
  if (/分享.*(?:已过期|已失效|被取消|不存在)|链接.*(?:不存在|已失效)|来晚了/.test(text)) return 'unavailable';
  if (/验证码|安全验证|访问过于频繁/.test(text)) return 'verification-required';
  if (/请输入提取码|提取文件/.test(text)) return 'password-required';
  // This is a page-level observation, not evidence that /share/list works.
  if (snapshot.fileRows > 0) return 'files-visible';
  if (/登录后.*(?:查看|访问)|请.*登录/.test(text)) return 'login-required';
  return 'unrecognized-page';
}
