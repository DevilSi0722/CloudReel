import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {TaskPool, withAbort} from '../core/task-pool.mjs';

export function isArtworkUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && /(^|\.)(image\.tmdb\.org|doubanio\.com|static\.tvmaze\.com|mzstatic\.com)$/.test(url.hostname); } catch { return false; }
}
export class ArtworkCache {
  constructor(directory, fetcher = fetch) { this.directory = path.join(directory, 'artwork'); this.fetcher = fetcher; this.pending = new Map(); this.pool = new TaskPool(4); this.failed = new Map(); fs.mkdirSync(this.directory, { recursive: true }); }
  async cache(url, {signal} = {}) {
    signal?.throwIfAborted();
    if (!url || !isArtworkUrl(url)) return undefined;
    const key = createHash('sha256').update(url).digest('hex'), target = path.join(this.directory, key);
    if (fs.existsSync(target)) return `cloudreel-art://cache/${key}`;
    if (this.failed.get(key) > Date.now()) return undefined;
    if (this.pending.has(key) && !this.pending.get(key).controller.signal.aborted) return this.subscribe(this.pending.get(key), signal);
    const entry = {controller: new AbortController(), users: 0, settled: false};
    const work = this.pool.run(async () => {
      try {
        const response = await this.fetcher(url, { signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(18000)]), headers: { Referer: new URL(url).hostname.includes('doubanio') ? 'https://movie.douban.com/' : new URL(url).origin }, redirect: 'error' });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/') || Number(response.headers.get('content-length')) > 12 * 1024 * 1024) { await response.body?.cancel(); return undefined; }
        const reader = response.body.getReader(), chunks = []; let length = 0;
        while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 12 * 1024 * 1024) { await reader.cancel(); return undefined; } chunks.push(Buffer.from(value)); }
        const image = Buffer.concat(chunks); if (!image.length) return undefined;
        fs.writeFileSync(target + '.tmp', image); fs.renameSync(target + '.tmp', target);
        return `cloudreel-art://cache/${key}`;
      } catch { return undefined; }
    }, entry.controller.signal).catch(() => undefined).then(result => {
      if (!result && !entry.controller.signal.aborted) {this.failed.set(key, Date.now() + 60000); if (this.failed.size > 256) this.failed.delete(this.failed.keys().next().value);}
      return result;
    }).finally(() => {entry.settled = true; if (this.pending.get(key) === entry) this.pending.delete(key);});
    entry.promise = work; this.pending.set(key, entry); return this.subscribe(entry, signal);
  }
  async subscribe(entry, signal) {
    entry.users++;
    try { return await withAbort(entry.promise, signal); }
    finally { if (--entry.users === 0 && !entry.settled) entry.controller.abort(); }
  }
  response(url) {
    const parsed = new URL(url), key = parsed.pathname.slice(1);
    if (parsed.hostname !== 'cache' || !/^[a-f0-9]{64}$/.test(key)) return new Response(null, { status: 404 });
    try {
      const bytes = fs.readFileSync(path.join(this.directory, key));
      const type = bytes[0] === 0x89 ? 'image/png' : bytes.subarray(0, 4).toString() === 'RIFF' ? 'image/webp' : 'image/jpeg';
      return new Response(bytes, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
    } catch { return new Response(null, { status: 404 }); }
  }
}
