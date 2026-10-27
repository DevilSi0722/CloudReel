const time = value => Date.parse(value ?? '') || 0;
const sameId = (a, b) => a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);
const sharedId = (a, b, providers) => providers.some(provider => sameId(a?.[provider], b?.[provider]));

// A TMDB series ID identifies the show, never a particular episode.
// Match unplayed files by show identity plus season/episode, without title guessing.
export function matchesTraktEntry(item, entry) {
  if (item.kind === 'episode') {
    if (!entry.episode) return false;
    if (item.metadata?.ids?.trakt) return sameId(item.metadata.ids.trakt, entry.episode.ids?.trakt);
    if (Number(item.season ?? 1) !== Number(entry.episode.season) || Number(item.episode) !== Number(entry.episode.number)) return false;
    const showIds = item.metadata?.showIds;
    if (showIds?.trakt) return sameId(showIds.trakt, entry.show?.ids?.trakt);
    if (sharedId(showIds, entry.show?.ids, ['tmdb', 'tvdb', 'imdb'])) return true;
    return catalogMatches(item.catalog, entry.show?.ids);
  }
  if (!entry.movie) return false;
  if (item.metadata?.ids?.trakt) return sameId(item.metadata.ids.trakt, entry.movie.ids?.trakt);
  return catalogMatches(item.catalog, entry.movie.ids);
}

function catalogMatches(catalog, ids) {
  if (!catalog) return false;
  return catalog.source === 'tmdb' ? sameId(catalog.id, ids?.tmdb) : sameId(catalog.imdb, ids?.imdb);
}

export function matchesTraktShow(item, show) {
  if (item.kind !== 'episode') return false;
  const ids = item.metadata?.showIds;
  if (ids?.trakt) return sameId(ids.trakt, show?.ids?.trakt);
  return sharedId(ids, show?.ids, ['tmdb', 'tvdb', 'imdb']) || catalogMatches(item.catalog, show?.ids);
}

function attachIdentity(item, entry) {
  const media = item.kind === 'episode' ? entry.episode : entry.movie;
  if (!media?.ids?.trakt || item.metadata?.ids?.trakt) return;
  item.metadata = {type: item.kind === 'episode' ? 'episode' : 'movie', ids: media.ids,
    ...(entry.show ? {showIds: entry.show.ids} : {}), year: entry.show?.year ?? media.year, episodeTitle: entry.episode?.title};
}

export function applyTraktProgress(items, {playback, watchedMovies = null, watchedShows = null, watching = undefined}, {activeItemId = null, now = Date.now()} = {}) {
  let positions = 0, watched = 0, watchingItem = null;
  for (const item of items) {
    if (item.id === activeItemId || item.watchState?.pending) continue;
    const candidates = playback.filter(entry => matchesTraktEntry(item, entry) && Number.isFinite(entry.progress) && entry.progress >= 0 && entry.progress <= 100 && time(entry.paused_at));
    const paused = candidates.sort((a, b) => time(b.paused_at) - time(a.paused_at))[0];
    if (paused) {attachIdentity(item, paused); positions++;}
    let completed = null, historyAvailable = Boolean(item.kind === 'episode' ? watchedShows : watchedMovies);
    if (item.kind === 'episode' && watchedShows) {
      const show = watchedShows.find(entry => matchesTraktShow(item, entry.show));
      if (show && !Array.isArray(show.seasons)) historyAvailable = false;
      const episode = show?.seasons?.find(season => season.number === (item.season ?? 1))?.episodes?.find(episode => episode.number === item.episode);
      if (episode?.plays > 0 && time(episode.last_watched_at) > time(show.reset_at)) completed = {progress: 100, paused_at: episode.last_watched_at, source: 'history'};
      if (historyAvailable) delete item.remoteNext;
      if (show?.next_episode?.season === (item.season ?? 1) && show.next_episode.number === item.episode && time(show.last_watched_at) > time(show.reset_at)) item.remoteNext = {watchedAt: show.last_watched_at};
    } else if (item.kind !== 'episode' && watchedMovies) {
      const movie = watchedMovies.find(entry => matchesTraktEntry(item, entry));
      if (movie?.plays > 0 && time(movie.last_watched_at)) {completed = {progress: 100, paused_at: movie.last_watched_at, source: 'history'}; attachIdentity(item, movie);}
    }
    if (historyAvailable) {
      const state = item.watchState;
      // Trakt can briefly return an older history immediately after a write.
      if (state?.syncedAt && state.watched !== Boolean(completed) && now - time(state.syncedAt) < 60000) continue;
      item.watchHistory = {watched: Boolean(completed), checkedAt: new Date(now).toISOString(), ...(completed ? {lastWatchedAt: completed.paused_at} : {})};
      if (state?.syncedAt) delete item.watchState;
    }
    const saved = paused ? {progress: paused.progress, paused_at: paused.paused_at, source: 'playback'} : null;
    // A newer rewatch may intentionally be behind a previously completed watch.
    const latest = completed && (!saved || time(completed.paused_at) > time(saved.paused_at)) ? completed : saved;
    if (completed) watched++;
    if (latest) item.remoteProgress = latest;
    else if (item.remoteProgress?.source !== 'history' || historyAvailable) delete item.remoteProgress;
    if (watching !== undefined) {
      delete item.remoteWatching;
      if (watching && time(watching.expires_at) > now && matchesTraktEntry(item, watching)) {
        attachIdentity(item, watching);
        item.remoteWatching = {startedAt: watching.started_at, expiresAt: watching.expires_at};
        watchingItem ??= {itemId: item.id, title: item.title, season: item.season, episode: item.episode, expiresAt: watching.expires_at};
      }
    }
  }
  return {positions, watched, watching: watchingItem};
}
