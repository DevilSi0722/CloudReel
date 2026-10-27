import { createHash, randomBytes } from 'node:crypto';
import { jsonRequest, withQuery, tokenRecord } from '../core/http.mjs';
import { isTraktCallback, traktRedirect } from '../core/trakt-auth.mjs';
import {historyBody, watchTargetItem, watchTargetKey} from '../core/watch-state.mjs';
import {matchesTraktEntry} from '../core/trakt-progress.mjs';
import {mapConcurrent} from '../core/task-pool.mjs';
export class TraktService {
  constructor(store, { fetcher = fetch, apiBase = 'https://api.trakt.tv', clientId = '', redirectUri = '' } = {}) { this.store = store; this.fetcher = fetcher; this.apiBase = apiBase; this.refreshing = null; this.authorization = null; this.defaults = { clientId, redirectUri }; }
  clientId() { const id = this.store.data.settings.traktClientId || this.defaults.clientId; if (!id) throw new Error('此版本的 Trakt 登录尚未启用，请等待完成接入的版本。'); return id; }
  redirectUri() { return this.store.data.settings.traktRedirectUri || this.defaults.redirectUri; }
  configured() { try { return Boolean(this.clientId() && traktRedirect(this.redirectUri())); } catch { return false; } }
  beginAuth() {
    const clientId = this.clientId(), redirect = traktRedirect(this.redirectUri());
    const verifier = randomBytes(48).toString('base64url'), state = randomBytes(24).toString('base64url');
    this.authorization = { verifier, state, clientId, redirect: redirect.toString(), expires: Date.now() + 10 * 60000 };
    return { url: withQuery('https://auth.trakt.tv/oauth/authorize', { response_type: 'code', client_id: clientId, redirect_uri: this.authorization.redirect,
      state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString() };
  }
  async completeAuth(callback) {
    const pending = this.authorization;
    if (!pending || pending.expires < Date.now()) throw new Error('授权会话已过期，请重新连接 Trakt。');
    let url; try { url = new URL(callback); } catch { throw new Error('请粘贴授权后浏览器地址栏中的完整回调网址。'); }
    if (!isTraktCallback(callback, pending.redirect) || url.searchParams.get('state') !== pending.state) throw new Error('回调地址或授权 state 不匹配，请使用本次授权返回的网址。');
    if (url.searchParams.has('error')) { this.authorization = null; throw new Error(url.searchParams.get('error') === 'access_denied' ? '你已取消 Trakt 授权，可以随时重新登录。' : 'Trakt 未完成授权，请重新登录。'); }
    if (!url.searchParams.get('code')) throw new Error('授权未完成，回调网址中没有 code。');
    const data = await this.raw('/oauth/token', { code: url.searchParams.get('code'), client_id: pending.clientId, redirect_uri: pending.redirect, grant_type: 'authorization_code', code_verifier: pending.verifier }, pending.clientId);
    if (this.authorization !== pending) throw new Error('授权已取消，请重新连接 Trakt。');
    this.store.setSecret('traktToken', tokenRecord(data)); this.authorization = null;
    try { const profile = await this.request('/users/settings'); if (this.store.secret('traktToken')?.access_token === data.access_token) {this.store.data.traktProfile = { username: profile.user?.username, name: profile.user?.name }; this.store.persist();} } catch { /* Authorization succeeds even if optional profile retrieval fails. */ }
    return { status: 'connected' };
  }
  raw(route, body, clientId = this.clientId()) { return jsonRequest(this.apiBase + route, { method: 'POST', headers: { 'content-type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': clientId }, body: JSON.stringify(body) }, this.fetcher); }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const token = this.store.secret('traktToken'); if (!token) throw new Error('请先连接 Trakt。');
      const clientId = this.clientId();
      const data = await this.raw('/oauth/token', { refresh_token: token.refresh_token, client_id: clientId, redirect_uri: this.redirectUri(), grant_type: 'refresh_token' });
      if (this.store.secret('traktToken')?.refresh_token !== token.refresh_token || this.clientId() !== clientId) throw new Error('Trakt 连接已更改，已忽略旧的授权响应。');
      this.store.setSecret('traktToken', tokenRecord(data));
    })().finally(() => { this.refreshing = null; }); return this.refreshing;
  }
  async request(route, { body, method = body ? 'POST' : 'GET', authenticated = true, retry = true } = {}) {
    const headers = { 'content-type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': this.clientId() };
    if (authenticated) {
      let token = this.store.secret('traktToken'); if (!token) throw new Error('请先连接 Trakt。');
      if (token.expiresAt < Date.now() + 60000) { await this.refresh(); token = this.store.secret('traktToken'); }
      headers.Authorization = `Bearer ${token.access_token}`;
    }
    try { return await jsonRequest(this.apiBase + route, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }, this.fetcher); }
    catch (error) { if (authenticated && retry && error.status === 401) { await this.refresh(); return this.request(route, { body, method, authenticated, retry: false }); } throw error; }
  }
  async search(query, type) {
    if (!query?.trim()) return [];
    const url = withQuery('https://api.trakt.tv/search/' + (type === 'episode' ? 'show' : 'movie'), { query: query.trim(), extended: 'full', limit: 12 });
    const data = await this.request(url.pathname + url.search, { authenticated: false });
    return data.map(result => { const media = result.movie ?? result.show; return { type: result.type, ...media }; });
  }
  async match(selection, item) {
    if (!Number.isSafeInteger(selection?.traktId) || selection.traktId <= 0) throw new Error('请选择有效的 Trakt 搜索结果。');
    if (selection.type === 'show') {
      if (!Number.isInteger(selection.season) || selection.season < 0 || !Number.isInteger(selection.episode) || selection.episode < 1) throw new Error('请填写正确的季数和集数。');
      const show = await this.request(`/shows/${selection.traktId}?extended=full`, { authenticated: false });
      const episode = await this.request(`/shows/${selection.traktId}/seasons/${selection.season}/episodes/${selection.episode}?extended=full`, { authenticated: false });
      return { title: show.title, kind: 'episode', season: selection.season, episode: selection.episode,
        metadata: { type: 'episode', ids: episode.ids, showIds: show.ids, overview: episode.overview ?? show.overview, year: show.year, episodeTitle: episode.title } };
    }
    const movie = await this.request(`/movies/${selection.traktId}?extended=full`, { authenticated: false });
    return { title: movie.title, kind: 'movie', metadata: { type: 'movie', ids: movie.ids, year: movie.year, overview: movie.overview } };
  }
  async playback(type) {
    const items = []; let page = 1;
    while (true) {
      const batch = await this.request(`/sync/playback/${type === 'episode' ? 'episodes' : 'movies'}?page=${page}&limit=100`);
      items.push(...batch); if (batch.length < 100) break;
      if (++page > 100) throw new Error('Trakt 返回的进度页数超过预期，已停止读取。');
    }
    return items;
  }
  watching() { return this.request('/users/me/watching'); }
  watched(type) { return this.request('/sync/watched/' + (type === 'episode' ? 'shows' : 'movies')); }
  showProgress(id) { return this.request(`/shows/${encodeURIComponent(id)}/progress/watched?hidden=false&specials=true&count_specials=false&last_activity=watched`); }
  async setWatched(targets, watched, at) {
    this.historyIds ??= new Map();
    const resolve = async (ids, type) => {
      if (ids.trakt) return ids;
      const provider = ids.tmdb ? 'tmdb' : ids.imdb ? 'imdb' : 'tvdb', key = `${type}:${provider}:${ids[provider]}`;
      if (!this.historyIds.has(key)) this.historyIds.set(key, (async () => {
        const results = await this.request(`/search/${provider}/${encodeURIComponent(ids[provider])}?type=${type}`, {authenticated: false});
        const identity = results.find(result => result.type === type)?.[type]?.ids;
        if (!identity?.trakt) throw new Error('Trakt 未找到对应作品，请修正资料匹配后重试。');
        return identity;
      })().catch(error => {this.historyIds.delete(key); throw error;}));
      return {...ids, ...await this.historyIds.get(key)};
    };
    let resolved = [];
    await mapConcurrent(targets, 3, async target => resolved.push(target.ids
      ? {...target, ids: await resolve(target.ids, target.kind)}
      : {...target, showIds: await resolve(target.showIds, 'show')}));
    if (resolved.some(target => target.kind === 'episode' && target.ids) && resolved.some(target => target.showIds)) {
      // A library can contain two copies identified through different services.
      // Resolve mixed episode representations before adding history so the same
      // episode cannot produce both a direct and a nested play in one request.
      const mixed = [];
      await mapConcurrent(resolved, 3, async target => {
        if (!target.showIds) {mixed.push(target); return;}
        const key = `episode:${target.showIds.trakt}:${target.season}:${target.episode}`;
        if (!this.historyIds.has(key)) this.historyIds.set(key, this.request(`/shows/${target.showIds.trakt}/seasons/${target.season}/episodes/${target.episode}`)
          .then(episode => {if (!episode.ids?.trakt) throw new Error('Trakt 未找到对应分集，请修正匹配后重试。'); return episode.ids;})
          .catch(error => {this.historyIds.delete(key); throw error;}));
        mixed.push({...target, ids: await this.historyIds.get(key)});
      });
      resolved = mixed;
    }
    resolved = [...new Map(resolved.map(target => [watchTargetKey(target), target])).values()];
    let selected = resolved;
    if (watched) {
      // History addition has no idempotency key. Re-read before each attempt so
      // a lost success response never produces an extra play on retry.
      const movies = resolved.some(target => target.kind === 'movie') ? await this.watched('movie') : [];
      const seasons = new Map();
      selected = [];
      await mapConcurrent(resolved, 3, async target => {
        let completed;
        if (target.kind === 'movie') completed = movies.some(entry => entry.plays > 0 && matchesTraktEntry(watchTargetItem(target), entry));
        else if (target.showIds) {
          const id = target.showIds.trakt;
          if (!seasons.has(id)) seasons.set(id, this.showProgress(id));
          const progress = await seasons.get(id);
          if (!Array.isArray(progress.seasons)) throw new Error('Trakt 未返回完整分集记录，稍后重试。');
          completed = progress.seasons.find(season => season.number === target.season)?.episodes?.find(episode => episode.number === target.episode)?.completed === true;
        } else completed = (await this.request(`/users/me/history/episodes/${target.ids.trakt}?limit=1`)).length > 0;
        if (!completed) selected.push(target);
      });
    }
    if (selected.length) {
      const result = await this.request(watched ? '/sync/history' : '/sync/history/remove', {body: historyBody(selected, watched ? at : undefined)});
      if (!result || Object.values(result.not_found ?? {}).some(entries => Array.isArray(entries) && entries.length)) throw new Error('部分影片尚未匹配到 Trakt，已保留操作，请修正匹配后重试。');
    }
    // Marking unwatched also removes old paused positions; never erase a newer
    // pause created on another device while this operation was queued offline.
    for (const kind of ['movie', 'episode']) {
      const typed = resolved.filter(target => target.kind === kind); if (!typed.length) continue;
      const positions = await this.playback(kind);
      await mapConcurrent(positions.filter(entry => /^\d+$/.test(String(entry.id)) && Date.parse(entry.paused_at) <= Date.parse(at)
        && typed.some(target => matchesTraktEntry(watchTargetItem(target), entry))), 3,
      async entry => {try {await this.request(`/sync/playback/${encodeURIComponent(entry.id)}`, {method: 'DELETE'});} catch (error) {if (error.status !== 404) throw error;}});
    }
    return {updated: selected.length};
  }
  async resolveCatalog(item) {
    if (item.metadata?.ids?.trakt || !item.catalog) return item.metadata;
    const type = item.kind === 'episode' ? 'show' : 'movie';
    const provider = item.catalog.source === 'tmdb' ? 'tmdb' : item.catalog.imdb ? 'imdb' : null;
    const externalId = provider === 'tmdb' ? item.catalog.id : item.catalog.imdb;
    if (!provider || !externalId) return null;
    this.catalogIds ??= new Map(); const key = `${type}:${provider}:${externalId}`;
    let traktId = this.catalogIds.get(key);
    if (!traktId) {
      const results = await this.request(`/search/${provider}/${encodeURIComponent(externalId)}?type=${type}`, { authenticated: false });
      traktId = results.find(result => result.type === type)?.[type]?.ids?.trakt;
      if (!traktId) return null;
      this.catalogIds.set(key, traktId);
    }
    const match = await this.match({traktId, type, season:item.season, episode:item.episode}, item);
    item.metadata = match.metadata; this.store.persist(); return item.metadata;
  }
  async resume(metadata) {
    const items = await this.playback(metadata.type);
    return items.filter(entry => entry[metadata.type]?.ids?.trakt === metadata.ids.trakt).sort((a, b) => Date.parse(b.paused_at) - Date.parse(a.paused_at))[0] ?? null;
  }
  async scrobble(metadata, progress, action) {
    if (!metadata?.ids?.trakt || !Number.isFinite(progress) || progress <= 0) return null;
    if (action === 'stop' && progress < 1) return null;
    const body = { [metadata.type]: { ids: metadata.ids }, progress: Math.min(100, Math.max(0, progress)), app_version: '0.3.6' };
    try { return await this.request(`/scrobble/${action}`, { body }); }
    catch (error) {
      if (action === 'stop' && error.status === 409) return { action: 'scrobble', duplicate: true };
      // Some Trakt deployments have disabled pause. Never turn a pause above 80% into watched.
      if (action === 'pause' && [404, 405, 410].includes(error.status) && progress >= 1 && progress < 80) return this.request('/scrobble/stop', { body });
      throw error;
    }
  }
}
