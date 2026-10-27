import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {normalizeTitle, inferMedia} from '../core/identification.mjs';
export const isSubtitle = name => /\.(srt|ass|ssa|vtt)$/i.test(name);
const stem = name => name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[ ._\[\]()【】{}-]+/g, '');
export function matchSubtitles(item, files) {
  const base = stem(item.filename);
  return files.filter(file => {
    const name = file.filename ?? file.server_filename ?? path.basename(file.path);
    if (!isSubtitle(name)) return false;
    const candidate = stem(name);
    if (candidate === base || candidate.startsWith(base) && /^(?:chs|cht|sc|tc|zh|en|eng|chi|zho|hans|hant|简|繁|中|英|双|字幕)/i.test(candidate.slice(base.length))) return true;
    if (item.kind !== 'episode') return false;
    const inferred = inferMedia({filename: name.replace(/\.(srt|ass|ssa|vtt)$/i, '.mp4'), path: file.path});
    const original=inferMedia(item);
    return inferred.kind === 'episode' && inferred.season === (item.season ?? 1) && inferred.episode === item.episode && normalizeTitle(inferred.title)===normalizeTitle(original.title);
  }).slice(0, 16);
}
export const subtitleLanguage = name => /(?:chs|zh[-_. ]?hans|简体|簡體|简中)/i.test(name) ? 'zh-Hans' : /(?:cht|zh[-_. ]?hant|繁体|繁體|繁中)/i.test(name) ? 'zh-Hant' : /(?:eng|[._ -]en[._ -]|英文)/i.test(name) ? 'en' : /(?:[._ -]zh[._ -]|中字|中文)/i.test(name) ? 'zh' : '';
export class SubtitleService {
  constructor(baidu) {this.baidu = baidu;}
  async discover(item) {
    let files = [];
    if (item.source === 'local') {
      const directory = path.dirname(item.path);
      files = (await fs.readdir(directory, {withFileTypes: true})).filter(f => f.isFile()).map(f => ({filename: f.name, path: path.join(directory, f.name), source: 'local'}));
    } else {
      const directory = path.posix.dirname(item.path); let start = 0;
      for (let page = 0; page < 100; page++) {
        const result = await this.baidu.list(directory, start);
        files.push(...result.files.filter(f => !f.isdir).map(f => ({...f, source: 'baidu', filename: f.server_filename})));
        if (!result.hasMore) break; start = result.nextStart;
      }
    }
    return matchSubtitles(item, files);
  }
  async materialize(file, session) {
    if (file.source === 'local') return file.path;
    let response;
    for(let attempt=0;attempt<2;attempt++) {
      const url = await this.baidu.streamUrl(String(file.fs_id), {path: file.path,refresh:attempt>0});
      const options={headers:{'User-Agent':'pan.baidu.com'},signal:AbortSignal.timeout(20000)};
      response = await (this.baidu.fetchMedia ? this.baidu.fetchMedia(url,options) : fetch(url,options));
      if(![401,403].includes(response.status) || attempt) break;
      await response.body?.cancel();
    }
    if (!response.ok) {await response.body?.cancel(); throw new Error('网盘字幕暂时无法读取。');}
    if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) {await response.body?.cancel(); throw new Error('字幕文件过大。');}
    const chunks = []; let length = 0;
    try {for await (const chunk of response.body) {length += chunk.length; if (length > 8 * 1024 * 1024) throw new Error('字幕文件过大。'); chunks.push(Buffer.from(chunk));}} catch (error) {await response.body?.cancel().catch(()=>{}); throw error;}
    if (session.finishing) return null;
    session.subtitleDirectory ??= await fs.mkdtemp(path.join(os.tmpdir(), 'cloudreel-subs-'));
    const location = path.join(session.subtitleDirectory, crypto.randomUUID() + path.extname(file.filename));
    // mpv detects UTF-8/UTF-16 and common Chinese encodings; no media URL is saved.
    await fs.writeFile(location, Buffer.concat(chunks)); return location;
  }
  async attach(player, session, files, select = false) {
    for (const file of files) {
      if (player.session !== session || session.finishing) break;
      const location = await this.materialize(file, session);
      if (location && player.session === session && !session.finishing) {
        const name=file.filename || path.basename(file.path);
        if(select) session.importedSubtitleName=name;
        player.command(['sub-add', location, select ? 'select' : 'auto', name, subtitleLanguage(name)]);
      }
    }
  }
  async cleanup(session) {
    if (!session.subtitleDirectory) return;
    const directory=path.resolve(session.subtitleDirectory);
    if(path.dirname(directory)!==path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cloudreel-subs-')) return;
    await fs.rm(directory, {recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});session.subtitleDirectory=null;
  }
}
