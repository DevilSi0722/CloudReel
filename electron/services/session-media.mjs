import { Readable } from 'node:stream';
import { isBaiduMediaUrl } from './baidu-web.mjs';

// The signed link and media share Chromium's login session and proxy/PAC.
// ClientRequest streams attachment responses without creating a download.
// requestFactory is injected by Electron; there is no Node-network fallback.
export function fetchSessionMedia(browserSession, input, options = {}, requestFactory, allowedUrl = isBaiduMediaUrl) {
  return new Promise((resolve, reject) => {
    if (!allowedUrl(input)) { reject(new Error('百度媒体跳转到了不支持的地址。')); return; }
    if (options.signal?.aborted) { reject(options.signal.reason ?? new Error('媒体请求已取消。')); return; }
    const headers = new Headers(options.headers);
    for (const name of ['Cookie', 'Authorization', 'Host']) headers.delete(name);
    if (!headers.has('User-Agent')) headers.set('User-Agent', browserSession.getUserAgent());
    const request = requestFactory({url: String(input), method: options.method ?? 'GET', session: browserSession,
      // Our Referer is a fixed public Baidu page, never a user's file URL.
      // Chromium otherwise blocks a full-path Referer on cross-origin media
      // before any network response (ERR_BLOCKED_BY_CLIENT).
      credentials: 'include', redirect: 'manual', referrerPolicy: 'unsafe-url', cache: 'no-store', headers: Object.fromEntries(headers)});
    let response, redirects = 0, ended = false, failed = false;
    const fail = error => {
      if (failed) return;
      failed = true;
      cleanup();
      reject(error);
      if (response && !response.destroyed) response.destroy(error);
      request.abort();
    };
    const abort = () => fail(options.signal.reason ?? new Error('媒体请求已取消。'));
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    options.signal?.addEventListener('abort', abort, {once: true});
    // ClientRequest can close its writable side while IncomingMessage is still
    // streaming. Keep cancellation connected until that readable side ends.
    request.on('error', error => {
      const code = /\bERR_[A-Z0-9_]+\b/.exec(String(error.message))?.[0];
      fail(new Error(`百度媒体连接失败${code ? `（${code}）` : ''}，请稍后重试。`));
    });
    request.on('redirect', (_status, _method, target) => {
      if (!allowedUrl(target)) { fail(new Error('百度媒体跳转到了不支持的地址。')); return; }
      if (++redirects > 5) { fail(new Error('百度媒体跳转次数过多，请重试。')); return; }
      // Chromium applies Set-Cookie and selects cookies for the new domain.
      request.followRedirect();
    });
    request.once('response', incoming => {
      response = incoming;
      incoming.on('error', () => {}); // HEAD/cancelled bodies still need a listener.
      incoming.once('end', () => {ended = true;cleanup();});
      incoming.once('aborted', () => incoming.destroy(new Error('百度媒体连接已中断，请重试。')));
      incoming.once('close', () => {cleanup();if (!ended) request.abort();});
      try {
        const responseHeaders = new Headers();
        // Electron can expose a Unicode attachment filename in Content-Disposition.
        // WHATWG Headers requires ByteString values: blindly copying that header
        // throws outside the request Promise and strands the serial probe queue.
        // Only media type and byte-range framing are needed by our consumers.
        // Attachment names and browser credentials stay out of the relay.
        const mediaHeaders = new Set(['content-type', 'content-length', 'content-range', 'accept-ranges']);
        for (const [name, values] of Object.entries(incoming.headers)) {
          if (mediaHeaders.has(name.toLowerCase()) && values !== undefined) responseHeaders.set(name, Array.isArray(values) ? values.join(', ') : values);
        }
        const noBody = options.method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode);
        const body = noBody ? null : Readable.toWeb(incoming, {strategy: {highWaterMark: 256 * 1024, size: chunk => chunk.byteLength}});
        const result = new Response(body, {status: incoming.statusCode, headers: responseHeaders});
        if (noBody) incoming.resume();
        resolve(result);
      } catch {
        // An invalid required header/status must reject and release the request,
        // never escape this asynchronous callback into Electron's main process.
        fail(new Error('百度媒体响应无效，请稍后重试。'));
      }
    });
    request.end();
  });
}
