import {applyTraktProgress, matchesTraktShow} from '../core/trakt-progress.mjs';
import {setLocalWatchState, watchTarget, watchTargetKey} from '../core/watch-state.mjs';

export class SyncService {
  constructor(store, trakt, notify = () => {}, activeItem = () => null) { this.store = store; this.trakt = trakt; this.notify = notify; this.activeItem = activeItem; this.flushing = null; this.pulling = null; this.generation = 0; this.pullRevision = 0; this.histories = new Map(); }
  status() { return {...this.store.data.traktSync, pulling: Boolean(this.pulling)}; }
  reset() {
    this.generation++;
    this.histories.clear();
    delete this.store.data.traktSync;
    this.store.data.watchPending = [];
    for (const item of this.store.data.items) {delete item.remoteProgress; delete item.remoteWatching; delete item.remoteNext; delete item.watchHistory; if (item.watchState?.jobId) delete item.watchState;}
    this.store.persist();
  }
  async pull({manual = false} = {}) {
    if (this.pulling) return this.pulling;
    if (!this.store.data.secrets.traktToken || (!manual && !this.store.data.settings.autoSync)) return;
    const generation = this.generation, revision = this.pullRevision;
    this.pulling = (async () => {
      try {
        const warnings = [];
        const optional = async (read, label, fallback) => {try {return await read();} catch {warnings.push(label); return fallback;}};
        const [movies, episodes, watchedMovies, watchedShows, watching] = await Promise.all([
          this.trakt.playback('movie'), this.trakt.playback('episode'),
          optional(() => this.trakt.watched('movie'), '电影已看记录', null),
          optional(() => this.trakt.watched('episode'), '剧集已看记录', null),
          optional(() => this.trakt.watching(), '正在观看状态', undefined)
        ]);
        // Some Trakt responses contain only show summaries; request episode-level
        // history only for shows in this library, and reuse unchanged results.
        const relevant = (watchedShows ?? []).filter(entry => this.store.data.items.some(item => matchesTraktShow(item, entry.show)));
        let cursor = 0;
        await Promise.all(Array.from({length: Math.min(3, relevant.length)}, async () => {
          while (cursor < relevant.length) {
            const entry = relevant[cursor++], id = entry.show.ids.trakt;
            const revision = `${entry.last_updated_at}:${entry.last_watched_at}:${entry.reset_at}`;
            let cached = this.histories.get(id);
            if (!cached || cached.revision !== revision || Date.now() - cached.at > 300000) {
              const progress = await optional(() => this.trakt.showProgress(id), '部分剧集的分集记录', null);
              if (!progress) continue;
              cached = {revision, at: Date.now(), progress};
              if (generation === this.generation) this.histories.set(id, cached);
            }
            Object.assign(entry, {reset_at: cached.progress.reset_at, next_episode: cached.progress.next_episode,
              seasons: cached.progress.seasons?.map(season => ({number: season.number, episodes: season.episodes.map(episode => ({...episode, plays: episode.completed ? 1 : 0}))}))});
          }
        }));
        if (this.generation !== generation || this.pullRevision !== revision || !this.store.data.secrets.traktToken || (!manual && !this.store.data.settings.autoSync)) return;
        const summary = applyTraktProgress(this.store.data.items, {playback: [...movies, ...episodes], watchedMovies, watchedShows, watching}, {activeItemId: this.activeItem()});
        this.store.data.traktSync = {...summary, lastPulledAt: new Date().toISOString(), remotePositions: movies.length + episodes.length, error: null,
          warning: warnings.length ? `${[...new Set(warnings)].join('、')}暂未更新，稍后自动重试。` : null};
        this.store.persist();
        if (manual) this.store.log(`已读取 Trakt：${summary.positions} 个续播位置、${summary.watched} 个已看视频${summary.watching ? '，检测到正在观看的剧集或影片' : ''}。`);
        return summary;
      } catch (error) {
        if (this.generation === generation) {
          this.store.data.traktSync = {...this.store.data.traktSync, error: error.message};
          this.store.persist();
        }
        if (manual) throw error;
      }
    })().finally(() => {this.pulling = null; this.notify();});
    this.notify(); return this.pulling;
  }
  eligible(item) { return Boolean(this.store.data.settings.autoSync && this.store.data.secrets.traktToken && item.metadata?.ids?.trakt); }
  async markWatched({ids, watched}) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 20000 || ids.some(id => typeof id !== 'string') || typeof watched !== 'boolean') throw new Error('请选择有效的影片和观看状态。');
    const selected = [...new Set(ids)].map(id => this.store.item(id));
    const targets = selected.map(watchTarget), connected = Boolean(this.store.data.secrets.traktToken);
    if (connected && targets.some(target => !target)) throw new Error('请先为所选影片匹配 TMDB 或 Trakt 资料，再同步观看状态。');
    const keys = new Set(targets.filter(Boolean).map(watchTargetKey));
    const entries = this.store.data.items.filter(item => ids.includes(item.id) || (() => {const target = watchTarget(item); return target && keys.has(watchTargetKey(target));})());
    if (entries.some(item => item.id === this.activeItem())) throw new Error('请先退出该影片的播放，再修改观看状态。');
    const at = new Date().toISOString(), jobId = connected ? crypto.randomUUID() : undefined;
    this.pullRevision++; this.histories.clear();
    for (const item of entries) setLocalWatchState(item, watched, at, jobId);
    this.store.data.pending = this.store.data.pending.filter(job => !entries.some(item => item.id === job.itemId));
    if (connected) {
      this.store.data.watchPending ??= [];
      // Keep an in-flight request immutable. Later intent stays after it in the
      // queue and local acknowledgement is guarded by the operation identity.
      for (const job of this.store.data.watchPending) if (job.id !== this.sendingWatchId) {
        job.targets = job.targets.filter(target => !keys.has(watchTargetKey(target)));
        job.itemIds = job.itemIds.filter(id => !entries.some(item => item.id === id));
      }
      this.store.data.watchPending = this.store.data.watchPending.filter(job => job.targets.length);
      this.store.data.watchPending.push({id: jobId, itemIds: entries.map(item => item.id), targets: [...new Map(targets.map(target => [watchTargetKey(target), target])).values()], watched, at});
    }
    this.store.persist(); this.notify();
    if (this.flushing) await this.flushing;
    await this.flush();
    const pending = entries.some(item => item.watchState?.jobId === jobId && item.watchState.pending);
    return {pending, connected, count: entries.length};
  }
  checkpoint(item, action) {
    if (!this.eligible(item) || !(item.progress?.percent > 0) || (action === 'stop' && item.progress.percent < 1)) return Promise.resolve();
    this.store.queue({ itemId: item.id, metadata: structuredClone(item.metadata), progress: item.progress.percent, action, at: item.progress.updatedAt });
    this.notify(); return this.flush();
  }
  async start(item) {
    if (!this.eligible(item) || !(item.progress?.percent > 0)) return;
    // A delayed start clears resume points, so it must never be replayed from an outbox.
    try { await this.trakt.scrobble(item.metadata, item.progress.percent, 'start'); }
    catch { this.store.log('Trakt 实时追踪暂不可用，退出时将保存进度并重试。', 'warning'); this.notify(); }
  }
  async flush() {
    if (this.flushing) return this.flushing;
    if (!this.store.data.secrets.traktToken || !this.store.data.settings.autoSync && !this.store.data.watchPending?.length) return;
    this.flushing = (async () => {
      while (this.store.data.watchPending?.length && this.store.data.secrets.traktToken) {
        const job = this.store.data.watchPending[0], generation = this.generation;
        this.sendingWatchId = job.id;
        try {
          await this.trakt.setWatched(job.targets, job.watched, job.at);
          if (generation !== this.generation) break;
          this.store.data.watchPending = this.store.data.watchPending.filter(entry => entry.id !== job.id);
          for (const item of this.store.data.items) if (item.watchState?.jobId === job.id) Object.assign(item.watchState, {pending: false, syncedAt: new Date().toISOString(), error: undefined});
          this.histories.clear(); this.pullRevision++;
          this.store.log(`已同步 Trakt：${job.itemIds.length} 个视频标记为${job.watched ? '已观看' : '未观看'}。`);
        } catch (error) {
          if (generation !== this.generation) break;
          const superseded = new Set(this.store.data.watchPending.filter(entry => entry.id !== job.id).flatMap(entry => entry.targets.map(watchTargetKey)));
          job.targets = job.targets.filter(target => !superseded.has(watchTargetKey(target)));
          job.itemIds = job.itemIds.filter(id => this.store.data.items.find(item => item.id === id)?.watchState?.jobId === job.id);
          if (!job.targets.length) {this.store.data.watchPending = this.store.data.watchPending.filter(entry => entry.id !== job.id); continue;}
          for (const item of this.store.data.items) if (item.watchState?.jobId === job.id) item.watchState.error = error.message;
          this.store.log('观看标记已保存在本机，Trakt 尚未完成同步，可在观看同步中重试。', 'warning');
          break;
        } finally {this.sendingWatchId = null; this.store.persist(); this.notify();}
      }
      if (!this.store.data.settings.autoSync) return;
      while (this.store.data.pending.length) {
        const job = this.store.data.pending[0];
        try {
          if (Date.now() - Date.parse(job.at) > 60000) {
            const remote = await this.trakt.resume(job.metadata);
            if (remote && Date.parse(remote.paused_at) > Date.parse(job.at)) {
              this.store.data.pending = this.store.data.pending.filter(entry => entry.id !== job.id);
              this.store.log('Trakt 已有更新的观看进度，已保留其他设备的最新记录。');
              continue;
            }
          }
          await this.trakt.scrobble(job.metadata, job.progress, job.action);
          this.store.data.pending = this.store.data.pending.filter(entry => entry.id !== job.id);
          const item = this.store.data.items.find(entry => entry.id === job.itemId);
          if (item) item.syncedAt = job.at;
          this.store.log(`Trakt 已同步：${item?.title ?? '影片'} · ${job.progress.toFixed(1)}%`);
        } catch { this.store.log('Trakt 同步失败，进度已保留在本机，联网后可重试。', 'warning'); break; }
        finally { this.store.persist(); this.notify(); }
      }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }
}
