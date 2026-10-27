export function isTraktPage(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && /(^|\.)trakt\.tv$/.test(url.hostname); }
  catch { return false; }
}

export function traktRedirect(value) {
  let url; try { url = new URL(value); } catch { throw new Error('Trakt 发行配置中的 HTTPS 回调地址无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || /^(?:localhost|127\.|\[::1\])/.test(url.hostname)) throw new Error('Trakt 发行配置需要已登记的 HTTPS 回调地址。');
  return url;
}

export function isTraktCallback(value, redirect) {
  try { const url = new URL(value), expected = traktRedirect(redirect); return !url.username && !url.password && url.origin === expected.origin && url.pathname === expected.pathname; }
  catch { return false; }
}
