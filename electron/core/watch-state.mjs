const time = value => Date.parse(value ?? '') || 0;

// Watch history is independent of a resume position (including during a rewatch).
export function isWatched(item) {
  if (item.watchState) return item.watchState.watched || item.progress?.percent >= 95 && time(item.progress.updatedAt) > time(item.watchState.updatedAt);
  if (item.watchHistory?.watched) return true;
  if (item.watchHistory && time(item.progress?.updatedAt) <= time(item.watchHistory.checkedAt)) return false;
  const local = item.progress, remote = item.remoteProgress;
  const percent = remote && time(remote.paused_at) > time(local?.updatedAt) ? remote.progress : local?.percent ?? remote?.progress ?? 0;
  return percent >= 95;
}

function cleanIds(ids) {
  const result = {};
  for (const key of ['trakt', 'tmdb', 'tvdb']) if (Number.isSafeInteger(Number(ids?.[key])) && Number(ids[key]) > 0) result[key] = Number(ids[key]);
  if (/^tt\d+$/.test(ids?.imdb ?? '')) result.imdb = ids.imdb;
  return result;
}

export function watchTarget(item) {
  const ids = cleanIds(item.metadata?.ids);
  if (ids.trakt) return {kind: item.kind, ids};
  const catalogIds = item.catalog?.source === 'tmdb' ? cleanIds({tmdb: item.catalog.id}) : cleanIds({imdb: item.catalog?.imdb});
  if (item.kind === 'movie') {
    const movieIds = Object.keys(ids).length ? ids : catalogIds;
    return Object.keys(movieIds).length ? {kind: 'movie', ids: movieIds} : null;
  }
  const showIds = cleanIds(item.metadata?.showIds);
  const identity = Object.keys(showIds).length ? showIds : catalogIds;
  const season = item.season ?? 1, episode = item.episode;
  return Object.keys(identity).length && Number.isInteger(season) && season >= 0 && Number.isInteger(episode) && episode > 0
    ? {kind: 'episode', showIds: identity, season, episode} : null;
}

const idKey = ids => ['trakt', 'tmdb', 'imdb', 'tvdb'].filter(key => ids?.[key]).map(key => `${key}:${ids[key]}`)[0];
export const watchTargetKey = target => target.ids ? `${target.kind}:${idKey(target.ids)}` : `show:${idKey(target.showIds)}:${target.season}:${target.episode}`;
export const watchTargetItem = target => ({kind: target.kind, season: target.season, episode: target.episode,
  metadata: target.ids ? {type: target.kind, ids: target.ids} : {showIds: target.showIds}});

export function historyBody(targets, watchedAt) {
  const movies = [], episodes = [], shows = new Map(), seen = new Set();
  for (const target of targets) {
    const key = watchTargetKey(target); if (seen.has(key)) continue; seen.add(key);
    const when = watchedAt ? {watched_at: watchedAt} : {};
    if (target.ids) (target.kind === 'movie' ? movies : episodes).push({ids: target.ids, ...when});
    else {
      const key = idKey(target.showIds);
      if (!shows.has(key)) shows.set(key, {ids: target.showIds, seasons: []});
      const show = shows.get(key);
      let season = show.seasons.find(entry => entry.number === target.season);
      if (!season) {season = {number: target.season, episodes: []}; show.seasons.push(season);}
      season.episodes.push({number: target.episode, ...when});
    }
  }
  return {...(movies.length ? {movies} : {}), ...(episodes.length ? {episodes} : {}), ...(shows.size ? {shows: [...shows.values()]} : {})};
}

export function setLocalWatchState(item, watched, at, jobId) {
  item.watchState = {watched, updatedAt: at, pending: Boolean(jobId), ...(jobId ? {jobId} : {})};
  const duration = item.progress?.duration ?? 0;
  item.progress = {position: watched ? duration : 0, duration, percent: watched ? 100 : 0, updatedAt: at};
  delete item.remoteProgress; delete item.remoteNext; delete item.remoteWatching;
}

export function forgetWatchIdentity(store, ids) {
  const selected = new Set(ids), keys = new Set(store.data.items.filter(item => selected.has(item.id)).map(watchTarget).filter(Boolean).map(watchTargetKey));
  for (const job of store.data.watchPending ?? []) {
    job.targets = job.targets.filter(target => !keys.has(watchTargetKey(target)));
    const remaining = new Set(job.targets.map(watchTargetKey));
    job.itemIds = job.itemIds.filter(id => {
      const item = store.data.items.find(item => item.id === id), target = item && watchTarget(item);
      return !selected.has(id) && target && remaining.has(watchTargetKey(target));
    });
  }
  store.data.watchPending = (store.data.watchPending ?? []).filter(job => job.targets.length);
  const jobs = new Map(store.data.watchPending.map(job => [job.id, new Set(job.targets.map(watchTargetKey))]));
  for (const item of store.data.items) {
    if (selected.has(item.id)) {delete item.watchHistory; delete item.watchState;}
    else if (item.watchState?.pending) {
      const target = watchTarget(item);
      if (!target || !jobs.get(item.watchState.jobId)?.has(watchTargetKey(target))) delete item.watchState;
    }
  }
}
