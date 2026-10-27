export class ApiError extends Error {
  constructor(message, status = 0, code = '') { super(message); this.status = status; this.code = code; }
}

export async function jsonRequest(url, options = {}, fetcher = fetch) {
  let response;
  try { response = await fetcher(url, { ...options, signal: options.signal ?? AbortSignal.timeout(25000) }); }
  catch (error) { throw new ApiError(error.name === 'TimeoutError' ? '请求超时，请检查网络后重试。' : '无法连接服务，请检查网络或代理设置。'); }
  if (response.status === 204) return null;
  let data;
  try {
    data = JSON.parse(await response.text(), (key, value, context) => {
      // Baidu file IDs are int64 and can exceed JavaScript's safe integer range.
      if (['fs_id', 'fsid'].includes(key) && typeof value === 'number') return context?.source ?? String(value);
      return value;
    });
  }
  catch { throw new ApiError(`服务返回了非 JSON 响应（HTTP ${response.status}）。`, response.status); }
  if (!response.ok || data.error || (data.errno !== undefined && data.errno !== 0)) {
    const code = data.error ?? data.errno ?? response.status;
    const hints = { '-6': '百度授权已失效，请重新登录。', '31066': '目录或文件不存在。', '31034': '应用暂无此接口权限，请检查百度开放平台配置。', authorization_pending: '等待授权', slow_down: '请稍后重试', invalid_grant: '授权已过期，请重新登录。' };
    throw new ApiError(hints[code] ?? `服务请求失败（${code}，HTTP ${response.status}）。`, response.status, code);
  }
  return data;
}

export function withQuery(base, values) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(key, String(value));
  return url;
}

export function tokenRecord(data, now = Date.now()) {
  if (!data.access_token || !data.refresh_token) throw new Error('授权响应缺少访问令牌或刷新令牌。');
  return { access_token: data.access_token, refresh_token: data.refresh_token, expiresAt: now + Number(data.expires_in ?? 604800) * 1000 };
}
