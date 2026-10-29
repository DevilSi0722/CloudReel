import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function mediaRejection(upstream) {
  // Baidu returns JSON errors as text/plain. Read a bounded error body rather
  // than throwing away the provider code or logging its signed URL/body.
  let code;
  if (upstream.body) {
    const reader = upstream.body.getReader(), chunks = []; let bytes = 0;
    try {
      while (bytes < 16384) {
        const next = await reader.read(); if (next.done) break;
        const chunk = next.value.subarray(0, 16384 - bytes); chunks.push(chunk); bytes += chunk.byteLength;
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (Number.isSafeInteger(Number(data.error_code ?? data.errno))) code = Number(data.error_code ?? data.errno);
    } catch { /* A proxy may return HTML, or cancellation may close the body. */ }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  const hints = {31360: '百度返回的原文件地址已过期', 31362: '百度未接受原文件地址的下载签名', 31326: '百度拒绝了下载请求的客户端身份或授权', 31329: '百度限制了此下载方式', 31045: '百度媒体端没有接受当前登录身份'};
  return new Error(`媒体服务器拒绝访问（HTTP ${upstream.status}${code !== undefined ? `，百度错误 ${code}` : ''}），${hints[code] ?? '百度未允许读取此原文件'}。已重新获取地址；请在官方网页确认文件可下载。`);
}

// A loopback-only relay keeps Baidu credentials out of mpv's process arguments.
// It forwards byte ranges without buffering the movie into memory or disk.
export async function createStreamRelay(resolveUrl, { fetcher = fetch, onError = () => {} } = {}) {
  const key = randomBytes(32).toString('hex'); let cachedUrl = null, cachedAt = 0;
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/' + key || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404).end(); return; }
    const controller = new AbortController();
    response.on('close', () => controller.abort());
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      let upstream, rejection;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!cachedUrl || Date.now() - cachedAt > 10 * 60000 || attempt) { cachedUrl = await resolveUrl({refresh: attempt > 0}); cachedAt = Date.now(); }
        upstream = await fetcher(cachedUrl, { method: request.method, signal: controller.signal,
          headers: { 'User-Agent': 'pan.baidu.com', 'Accept-Encoding': 'identity', ...(request.headers.range ? { Range: request.headers.range } : {}) } });
        if (![401, 403].includes(upstream.status)) break;
        rejection = await mediaRejection(upstream);
        if (attempt) break;
      }
      clearTimeout(timeout);
      if ([401, 403].includes(upstream.status)) {
        cachedUrl = null;
        onError(rejection);
        response.writeHead(upstream.status, {'Cache-Control': 'no-store'}).end('Media access denied.');
        return;
      }
      const headers = { 'Cache-Control': 'no-store', 'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream' };
      for (const name of ['content-length', 'content-range', 'accept-ranges']) if (upstream.headers.has(name)) headers[name] = upstream.headers.get(name);
      response.writeHead(upstream.status, headers);
      if (request.method === 'HEAD' || !upstream.body) response.end();
      else await pipeline(Readable.fromWeb(upstream.body), response);
    } catch (error) { if (!controller.signal.aborted) onError(error); if (!response.headersSent) response.writeHead(502).end('Unable to read media.'); else response.destroy(); }
    finally { clearTimeout(timeout); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/${key}`, close: () => { server.closeAllConnections(); server.close(); } };
}
