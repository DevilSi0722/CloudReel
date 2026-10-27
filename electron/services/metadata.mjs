import { normalizeTitle, baseSeriesTitle, catalogTitle, identifyLibrary, groupLibrary } from '../core/identification.mjs';
import { mergeLocalized, mergeLocalizedSeason, needsTranslation } from '../core/localization.mjs';
import { metadataNetworkError } from './desktop-network.mjs';
import {createHash} from 'node:crypto';
import {TaskPool, mapConcurrent, withAbort} from '../core/task-pool.mjs';
import {forgetWatchIdentity} from '../core/watch-state.mjs';
import {chooseTitleArt, titleArtDue} from '../core/title-art.mjs';

const strip = value => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const year = value => Number(String(value ?? '').slice(0, 4)) || undefined;
const image = (path, size = 'w500') => path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
const titleCandidates = query => [...new Set([query, query.match(/[\u3400-\u9fff][\u3400-\u9fff\s：:·]+/)?.[0]?.trim(), query.match(/[a-zA-Z][a-zA-Z\d\s:'&!,-]+/)?.[0]?.trim()].filter(value => value?.length >= 2))].slice(0, 3);
const matchingTitle = value => normalizeTitle(baseSeriesTitle(value).replace(/\band\b/gi, '&').replace(/\s+(?:the\s+)?movie$/i, ''));
function similarity(a, b) {
  if (Math.min(a.length, b.length) < 8) return 0;
  let row = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  const score = 1 - row[b.length] / Math.max(a.length, b.length);
  return score >= .88 ? score * .9 : 0;
}
export function matchScore(item, result) {
  const names = [item.inferredTitle ?? item.seriesTitle ?? item.title, ...(item.searchTitles ?? [])];
  const queries = names.flatMap(value => titleCandidates(baseSeriesTitle(value))).map(matchingTitle).filter(Boolean);
  const aliases = [result.title, result.originalTitle, ...(result.aliases ?? [])].map(matchingTitle).filter(Boolean);
  let score = Math.max(0, ...aliases.flatMap(title => queries.map(query => title === query ? .9 : title.includes(query) || query.includes(title) ? Math.min(title.length, query.length) / Math.max(title.length, query.length) * .85 : similarity(title, query))));
  if (item.kind !== result.kind) score -= .28;
  if (item.kind === 'movie' && item.year && result.year) score += item.year === result.year ? .1 : Math.abs(item.year - result.year) <= 1 ? -.06 : -.35;
  const region = names.some(name => /(?:\bU[. ]+S\.?$|[（(]US[）)]|美版)/i.test(name)) ? 'US' : names.some(name => /(?:\bU[. ]+K\.?$|[（(]UK[）)]|英版)/i.test(name)) ? 'GB' : undefined;
  if (item.kind === 'episode' && region && result.originCountries?.length) score += result.originCountries.includes(region) ? .1 : -.25;
  return Math.min(1, Math.max(0, score));
}
export class MetadataService {
  constructor(store, artwork, { fetcher = fetch, notify = () => {}, tmdbToken = '' } = {}) {
    Object.assign(this, { store, artwork, fetcher, notify, tmdbToken }); this.running = false; this.cancelled = false; this.searches = new Map(); this.publicRecords = new Map();
    this.requests = new Map(); this.inflight = new Map(); this.apiPool = new TaskPool(3); this.cacheEpoch = 0;
    this.progress = { running: false, done: 0, total: 0, matched: 0, failed: 0, current: '', error: null };
  }
  token() { return this.store.secret('tmdbToken') || this.tmdbToken; }
  configured() { return Boolean(this.token()); }
  status() { return { ...this.progress, tmdbConfigured: this.configured(), connectionError: this.tmdbError ?? null }; }
  clearCache() { this.cacheEpoch++; this.requests.clear(); this.inflight.clear(); this.searches.clear(); }
  async request(url, tmdb = false, {signal} = {}) {
    signal?.throwIfAborted();
    let response;
    try { response = await this.fetcher(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000), headers: { Accept: 'application/json', ...(tmdb ? { Authorization: `Bearer ${this.token()}` } : {}) } }); }
    catch (error) { signal?.throwIfAborted(); const message = metadataNetworkError(error); if (tmdb) { this.tmdbUnavailableUntil = Date.now() + 60000; this.tmdbError = message; this.notify(); } throw new Error(message); }
    if (tmdb && response.status === 429) {
      const retry = response.headers.get('retry-after');
      const delay = /^\d+$/.test(retry ?? '') ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      this.tmdbRetryAt = Date.now() + Math.min(60000, Math.max(1000, delay || 3000));
    }
    if (!response.ok) { await response.body?.cancel(); const message = tmdb && response.status === 401 ? 'TMDB Token 无效，请在设置中重新填写。' : `元数据服务暂不可用（HTTP ${response.status}）。`; if (tmdb) { this.tmdbUnavailableUntil = Date.now() + 60000; this.tmdbError = message; this.notify(); } throw new Error(message); }
    if (tmdb) { const changed = Boolean(this.tmdbError); this.tmdbUnavailableUntil = 0; this.tmdbError = null; if (changed) this.notify(); }
    try { return await response.json(); } catch { throw new Error('元数据服务未返回有效资料。'); }
  }
  async tmdb(route, params = {}, {signal, fresh = false} = {}) {
    signal?.throwIfAborted();
    const url = new URL('https://api.themoviedb.org/3' + route); url.searchParams.set('language', 'zh-CN');
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    const key = createHash('sha256').update(this.token() ?? '').digest('hex') + ':' + url;
    const cached = this.requests.get(key);
    if (!fresh && cached?.expires > Date.now()) return structuredClone(cached.value);
    const epoch = this.cacheEpoch;
    // Runs share duplicate requests only when they have the same cancellation
    // lifetime. Cancelling a background run must not abort a manual search.
    const pending = this.inflight.get(key);
    if (!fresh && pending?.signal === signal && pending?.epoch === epoch) return structuredClone(await withAbort(pending.promise, signal));
    const entry = {signal, epoch};
    entry.promise = this.apiPool.run(async () => {
      if (this.tmdbRetryAt > Date.now()) await new Promise((resolve, reject) => {
        const abort = () => {clearTimeout(timer); reject(signal.reason);};
        const timer = setTimeout(() => {signal?.removeEventListener('abort', abort); resolve();}, this.tmdbRetryAt - Date.now());
        signal?.addEventListener('abort', abort, {once: true});
      });
      signal?.throwIfAborted();
      const value = await this.request(url.toString(), true, {signal});
      if (epoch === this.cacheEpoch && !signal?.aborted) {
        this.requests.set(key, {value, expires: Date.now() + (route.startsWith('/search/') ? 10 * 60000 : 60 * 60000)});
        if (this.requests.size > 512) this.requests.delete(this.requests.keys().next().value);
      }
      return value;
    }, signal).finally(() => {if (this.inflight.get(key) === entry) this.inflight.delete(key);});
    this.inflight.set(key, entry);
    return structuredClone(await entry.promise);
  }
  async test() { if (!this.configured()) throw new Error('请先保存 TMDB Read Access Token。'); await this.tmdb('/configuration', {}, {fresh: true}); return { ok: true }; }
  async localized(route, params = {}, season = false, {signal} = {}) {
    const records = {'zh-CN': await this.tmdb(route, params, {signal})};
    const incomplete = data => season ? data.episodes?.some(episode => needsTranslation(episode, {episode: true})) : needsTranslation(data);
    if (incomplete(records['zh-CN'])) {
      try { records['zh-TW'] = await this.tmdb(route, {...params, language: 'zh-TW'}, {signal}); } catch { signal?.throwIfAborted(); /* Keep available Simplified Chinese data. */ }
      const merged = season ? mergeLocalizedSeason(records) : mergeLocalized(records);
      if (incomplete(merged)) { try { records['en-US'] = await this.tmdb(route, {...params, language: 'en-US'}, {signal}); } catch { signal?.throwIfAborted(); /* Keep available Chinese data. */ } }
    }
    return season ? mergeLocalizedSeason(records) : mergeLocalized(records);
  }
  candidates(query) {
    const names = titleCandidates(query), prefix = query.split(/\s+(?:&|and)\s+/i)[0];
    if (prefix !== query && prefix.length >= 4) names.push(prefix);
    return [...new Set(names)];
  }
  async search(query, kind = 'movie', source = 'auto', {signal} = {}) {
    signal?.throwIfAborted();
    if (typeof query !== 'string' || !query.trim() || query.length > 160) throw new Error('请输入有效片名。');
    const cacheKey = `${createHash('sha256').update(this.token() ?? '').digest('hex')}:${source}:${kind}:${query}`;
    const cached = this.searches.get(cacheKey);
    if (cached?.expires > Date.now()) return structuredClone(cached.value);
    const results = []; let failure;
    if (this.configured() && ['auto', 'tmdb'].includes(source) && (source === 'tmdb' || !(this.tmdbUnavailableUntil > Date.now()))) {
      try {
        const type = kind === 'episode' ? 'tv' : 'movie';
        for (const name of this.candidates(query)) {
          const data = await this.tmdb(`/search/${type}`, { query: name, include_adult: false }, {signal});
          results.push(...(data.results ?? []).slice(0, 8).map(result => ({ source: 'tmdb', id: String(result.id), kind, title: result.title ?? result.name, originalTitle: result.original_title ?? result.original_name, year: year(result.release_date ?? result.first_air_date), originCountries: result.origin_country, voteCount: result.vote_count, overview: result.overview, posterUrl: image(result.poster_path), backdropUrl: image(result.backdrop_path, 'w1280'), rating: result.vote_average })));
          if (results.length) break;
        }
      } catch (error) { signal?.throwIfAborted(); failure = error; if (source === 'tmdb') throw error; }
    }
    if ((!results.length || source === 'public') && source !== 'tmdb') {
      try {
        const data = await this.request('https://movie.douban.com/j/subject_suggest?q=' + encodeURIComponent(query), false, {signal});
        for (const record of data) if (/^\d+$/.test(record.id)) this.publicRecords.set(String(record.id), record);
        results.push(...data.filter(result => /^\d+$/.test(result.id) && result.img).map(result => ({ source: 'douban', id: String(result.id), kind: result.episode ? 'episode' : 'movie', title: result.title, originalTitle: result.sub_title, year: year(result.year), posterUrl: result.img, episodeCount: Number(result.episode) || undefined })));
      } catch (error) { signal?.throwIfAborted(); failure = error; }
      if (kind === 'episode') {
        try {
          const data = await this.request('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(query), false, {signal});
          results.push(...data.slice(0, 6).map(({ show }) => ({ source: 'tvmaze', id: String(show.id), kind: 'episode', title: show.name, originalTitle: show.name, year: year(show.premiered), overview: strip(show.summary), posterUrl: show.image?.original ?? show.image?.medium, rating: show.rating?.average, genres: show.genres, runtime: show.averageRuntime, imdb: show.externals?.imdb })));
        } catch (error) { signal?.throwIfAborted(); failure = error; }
      }
    }
    if (!results.length && failure) throw failure;
    const unique = [...new Map(results.map(result => [`${result.source}:${result.id}`, result])).values()];
    signal?.throwIfAborted();
    this.searches.set(cacheKey, {value: unique, expires: Date.now() + (failure ? 60000 : 10 * 60000)});
    if (this.searches.size > 256) this.searches.delete(this.searches.keys().next().value);
    return structuredClone(unique);
  }
  async detail(selection, {signal, images = true} = {}) {
    signal?.throwIfAborted();
    if (!['tmdb', 'douban', 'tvmaze'].includes(selection?.source) || !/^\d+$/.test(String(selection.id)) || !['movie', 'episode'].includes(selection.kind)) throw new Error('无效的元数据条目。');
    let catalog;
    if (selection.source === 'tmdb') {
      if (!this.configured()) throw new Error('请先在设置中填写 TMDB Token。');
      const type = selection.kind === 'episode' ? 'tv' : 'movie';
      const data = await this.localized(`/${type}/${selection.id}`, { append_to_response: 'credits,external_ids' }, false, {signal});
      catalog = { source: 'tmdb', id: String(data.id), kind: selection.kind, title: data.title ?? data.name, originalTitle: data.original_title ?? data.original_name, year: year(data.release_date ?? data.first_air_date), overview: data.overview, posterUrl: image(data.poster_path), backdropUrl: image(data.backdrop_path, 'w1280'), rating: data.vote_average, genres: data.genres?.map(genre => genre.name), runtime: data.runtime ?? data.episode_run_time?.[0], imdb: data.imdb_id ?? data.external_ids?.imdb_id, cast: data.credits?.cast?.slice(0, 10).map(person => ({ name: person.name, character: person.character })), director: data.credits?.crew?.find(person => person.job === 'Director')?.name ?? data.created_by?.map(person => person.name).join('、'), seasons: data.seasons?.map(season => ({ number: season.season_number, name: season.name, episodeCount: season.episode_count })), episodeCount: data.number_of_episodes, tagline: data.tagline, homepage: data.homepage };
    } else if (selection.source === 'tvmaze') {
      const data = await this.request(`https://api.tvmaze.com/shows/${selection.id}?embed=cast`, false, {signal});
      catalog = { source: 'tvmaze', id: String(data.id), kind: 'episode', title: data.name, originalTitle: data.name, year: year(data.premiered), overview: strip(data.summary), posterUrl: data.image?.original, rating: data.rating?.average, genres: data.genres, runtime: data.averageRuntime, imdb: data.externals?.imdb, cast: data._embedded?.cast?.slice(0, 10).map(entry => ({ name: entry.person.name, character: entry.character.name })) };
    } else {
      // Resolve the selected public ID again instead of trusting renderer URLs.
      let data = this.publicRecords.get(String(selection.id));
      if (!data) { const results = await this.request('https://movie.douban.com/j/subject_suggest?q=' + encodeURIComponent(selection.query || selection.title || ''), false, {signal}); data = results.find(result => String(result.id) === String(selection.id)); }
      if (!data) throw new Error('该公开条目已不可用，请重新搜索。');
      catalog = { source: 'douban', id: String(data.id), kind: data.episode ? 'episode' : 'movie', title: data.title, originalTitle: data.sub_title, year: year(data.year), posterUrl: data.img, episodeCount: Number(data.episode) || undefined };
      if (catalog.kind === 'episode' && /[a-zA-Z]{3}/.test(catalog.originalTitle ?? '')) {
        try { const shows = await this.request('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(baseSeriesTitle(catalog.originalTitle)), false, {signal}); const show = shows.map(entry => entry.show).find(show => normalizeTitle(show.name) === normalizeTitle(baseSeriesTitle(catalog.originalTitle))); if (show) Object.assign(catalog, { overview: strip(show.summary), rating: show.rating?.average, genres: show.genres, imdb: show.externals?.imdb, runtime: show.averageRuntime, tvmazeId: show.id }); } catch { signal?.throwIfAborted(); /* Keep the available public record. */ }
      }
    }
    catalog.cachedAt = new Date().toISOString();
    if (images) [catalog.poster, catalog.backdrop] = await Promise.all([this.artwork.cache(catalog.posterUrl, {signal}), this.artwork.cache(catalog.backdropUrl, {signal})]);
    return catalog;
  }
  publish() { clearTimeout(this.publishTimer); this.publishTimer = null; this.store.persist(); this.notify(); }
  publishLater() { if (!this.publishTimer) this.publishTimer = setTimeout(() => this.publish(), 150); }
  async titleArt(ids, {signal, refresh = false} = {}) {
    const targets = ids.map(id => this.store.item(id)), catalog = targets[0]?.catalog;
    if (!this.configured() || catalog?.source !== 'tmdb' || !/^\d+$/.test(catalog.id) || !refresh && !titleArtDue(catalog)) return;
    this.logoRetry ??= new Map();
    const key = `${catalog.kind}:${catalog.id}`;
    if (!refresh && this.logoRetry.get(key) > Date.now()) return;
    const current = item => !signal?.aborted && this.store.data.items.includes(item) && item.catalog?.source === 'tmdb' && item.catalog.id === catalog.id && item.kind === catalog.kind;
    try {
      const type = catalog.kind === 'episode' ? 'tv' : 'movie';
      const data = await this.tmdb(`/${type}/${catalog.id}/images`, {include_image_language: 'zh,en,null'}, {signal});
      if (!Array.isArray(data.logos)) throw new Error('标题图片列表暂不可用。');
      const chosen = chooseTitleArt(data.logos);
      const url = chosen && image(chosen.file_path);
      const logo = url ? await this.artwork.cache(url, {signal}) : undefined;
      signal?.throwIfAborted();
      if (chosen && !logo) throw new Error('标题图片暂未下载完成。');
      for (const item of targets.filter(current)) {
        if (logo) Object.assign(item.catalog, {logo, logoUrl: url, logoLanguage: chosen.iso_639_1 ?? null});
        else {delete item.catalog.logo; delete item.catalog.logoUrl; delete item.catalog.logoLanguage;}
        item.catalog.logoCheckedAt = new Date().toISOString();
      }
      this.logoRetry.delete(key); this.publishLater();
    } catch {
      signal?.throwIfAborted();
      this.logoRetry.set(key, Date.now() + 60000);
      if (this.logoRetry.size > 256) this.logoRetry.delete(this.logoRetry.keys().next().value);
      // Optional title artwork must never discard an otherwise complete match.
    }
  }
  async apply(ids, selection, manual = false, {signal} = {}) {
    const catalog = await this.detail(selection, {signal, images: false});
    signal?.throwIfAborted();
    if (!manual && this.cancelled) return;
    catalog.pending = true;
    const targets = ids.map(id => this.store.data.items.find(item => item.id === id)).filter(Boolean), attached = new Map();
    for (const item of targets) {
      const linkedId = item.kind === 'episode' ? item.metadata?.showIds?.tmdb : item.metadata?.ids?.tmdb;
      if (item.kind !== catalog.kind || item.catalog && (item.catalog.source !== catalog.source || item.catalog.id !== catalog.id) || catalog.source === 'tmdb' && linkedId && String(linkedId) !== catalog.id) {
        forgetWatchIdentity(this.store, [item.id]);
        delete item.metadata; delete item.remoteProgress; delete item.remoteWatching; delete item.remoteNext; delete item.episodeMetadata;
        this.store.data.pending = this.store.data.pending.filter(job => job.itemId !== item.id);
      }
      const previous = item.catalog;
      item.catalog = structuredClone(catalog);
      if (previous?.source === catalog.source && previous.id === catalog.id) {
        for (const key of ['logo', 'logoUrl', 'logoLanguage', 'logoCheckedAt']) if (previous[key] !== undefined) item.catalog[key] = previous[key];
      }
      // Keep already cached art visible while refreshed text and images arrive.
      for (const key of ['poster', 'backdrop']) if (previous?.[key] && previous[key + 'Url'] === catalog[key + 'Url']) item.catalog[key] = previous[key];
      attached.set(item, item.catalog);
      item.title = catalog.kind === 'episode' ? baseSeriesTitle(catalogTitle(item, catalog)) : catalogTitle(item, catalog); item.kind = catalog.kind;
      item.year = catalog.year ?? item.year; if (item.kind === 'episode') { item.seriesTitle = item.title; item.season ??= 1; }
      if (manual) { item.identificationLocked = true; item.metadataLocked = true; }
    }
    const current = item => !signal?.aborted && (manual || !this.cancelled) && item.catalog === attached.get(item) && this.store.data.items.includes(item);
    // Publish the match before waiting for the image CDN or every episode.
    this.publish();
    const artwork = async () => {
      await Promise.all(['poster', 'backdrop'].map(async key => {
        const value = await this.artwork.cache(catalog[key + 'Url'], {signal});
        if (value) {for (const item of targets.filter(current)) item.catalog[key] = value; catalog[key] = value; this.publishLater();}
      }));
    };
    const episodes = async () => {
      if (catalog.source !== 'tmdb' || catalog.kind !== 'episode') return;
      await mapConcurrent([...new Set(targets.map(item => item.season ?? 1))], 2, async season => {
        if (!manual && this.cancelled) return;
        try {
          const data = await this.localized(`/tv/${catalog.id}/season/${season}`, {}, true, {signal});
          const rows = [];
          for (const item of targets.filter(entry => current(entry) && (entry.season ?? 1) === season)) {
            const episode = data.episodes?.find(entry => entry.episode_number === item.episode);
            if (!episode) continue;
            const previous = item.episodeMetadata;
            const details = {title: episode.name, overview: episode.overview, airDate: episode.air_date, runtime: episode.runtime, tmdbId: episode.id,
              still: previous?.tmdbId === episode.id ? previous.still : undefined};
            item.episodeMetadata = details; rows.push({item, details, url: image(episode.still_path, 'w300')});
          }
          this.publish();
          await mapConcurrent(rows, 4, async ({item, details, url}) => {
            if (!current(item)) return;
            const still = await this.artwork.cache(url, {signal});
            if (still && current(item) && item.episodeMetadata === details) {details.still = still; this.publishLater();}
          }, signal);
        } catch { signal?.throwIfAborted(); /* A missing season must not discard the matched show. */ }
      }, signal);
    };
    try { const results = await Promise.allSettled([artwork(), episodes(), this.titleArt(ids, {signal, refresh: true})]); const failure = results.find(result => result.status === 'rejected'); if (failure) throw failure.reason; }
    finally {
      if (!signal?.aborted && (manual || !this.cancelled)) {for (const item of targets.filter(current)) delete item.catalog.pending; delete catalog.pending; this.publish();}
      else if (this.publishTimer) this.publish();
    }
    return catalog;
  }
  async run({ refresh = false } = {}) {
    if (this.running) return this.activeRun;
    this.activeRun = this.performRun({ refresh });
    return this.activeRun;
  }
  async restart() {
    const generation = this.restartGeneration = (this.restartGeneration ?? 0) + 1;
    this.cancel();
    await this.activeRun;
    if (generation !== this.restartGeneration) return this.activeRun;
    this.clearCache(); this.tmdbUnavailableUntil = 0; this.tmdbError = null;
    return this.run({ refresh: true });
  }
  async performRun({ refresh }) {
    this.running = true; this.cancelled = false;
    const controller = new AbortController(); this.controller = controller; const signal = controller.signal;
    identifyLibrary(this.store.data.items); this.store.persist();
    const groups = groupLibrary(this.store.data.items).filter(group => this.configured() && (refresh || titleArtDue(group.catalog)) && group.catalog?.source === 'tmdb'
      || !group.itemIds.some(id => this.store.item(id).metadataLocked) && (refresh || !group.catalog || group.catalog.pending || this.configured() && group.catalog.source !== 'tmdb'));
    this.progress = { running: true, done: 0, total: groups.length, matched: 0, failed: 0, current: '', error: null }; this.notify();
    const active = new Set();
    try {
      await mapConcurrent(groups, this.configured() ? 3 : 1, async group => {
        if (this.cancelled) return;
        active.add(group.title); this.progress.current = [...active].slice(0, 2).join('、'); this.notify();
        try {
          const item = this.store.item(group.itemIds[0]);
          const locked = group.itemIds.some(id => this.store.item(id).metadataLocked);
          if (group.catalog?.source === 'tmdb' && this.configured() && (locked || !refresh && !group.catalog.pending)) {
            // Upgrade existing and manually locked matches without re-searching,
            // touching their text/episodes, or altering progress and identities.
            await this.titleArt(group.itemIds, {signal, refresh}); this.progress.matched++;
          } else if (group.catalog?.source === 'tmdb' && this.configured()) {
            // A refresh already knows the identity; searching the title again
            // adds latency and can replace a previously correct match.
            await this.apply(group.itemIds, {source: 'tmdb', id: group.catalog.id, kind: group.kind}, false, {signal});
            this.progress.matched++;
          } else {
            let results = await this.search(baseSeriesTitle(item.inferredTitle ?? group.title), group.kind, 'auto', {signal});
            if (!results.some(result => matchScore(item, result) >= .82)) {
              const alternative = item.searchTitles?.find(title => title !== (item.inferredTitle ?? group.title) && /[a-zA-Z]{3}/.test(title));
              if (alternative && !this.cancelled) results = [...results, ...await this.search(alternative, group.kind, 'auto', {signal})];
            }
            const ranked = results.map(result => ({ ...result, score: matchScore(item, result) })).sort((a, b) => b.score - a.score);
            if (ranked[0]?.score >= .82 && ranked[0].voteCount !== 0 && (!ranked[1] || ranked[0].score - ranked[1].score >= .05 || normalizeTitle(ranked[0].title) === normalizeTitle(ranked[1].title) && ranked[0].year === ranked[1].year)) {
              if (!this.cancelled) { await this.apply(group.itemIds, { ...ranked[0], query: baseSeriesTitle(item.inferredTitle ?? group.title) }, false, {signal}); this.progress.matched++; }
            }
          }
        } catch (error) { if (!signal.aborted) {this.progress.failed++; this.progress.error = error.message;} }
        finally {active.delete(group.title); this.progress.current = [...active].slice(0, 2).join('、'); if (!signal.aborted) this.progress.done++; this.notify();}
        if (!this.configured() && !this.cancelled) await new Promise(resolve => setTimeout(resolve, 900));
      }, signal);
      this.store.log(`元数据${this.cancelled ? '已暂停' : '更新完成'}，已匹配 ${this.progress.matched} 部作品。`);
    } finally { this.running = false; this.progress.running = false; this.progress.current = ''; if (this.publishTimer) this.publish(); this.notify(); }
  }
  cancel() { this.cancelled = true; this.controller?.abort(new DOMException('元数据更新已停止', 'AbortError')); }
}
