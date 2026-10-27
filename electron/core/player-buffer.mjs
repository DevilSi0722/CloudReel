// mpv reports actual cached time ranges, including gaps after a seek. Never
// infer downloaded media from playback position or the buffering indicator.
export function bufferedRanges(cache, duration) {
  if (!Number.isFinite(duration) || duration <= 0 || !Array.isArray(cache?.['seekable-ranges'])) return [];
  const ranges = cache['seekable-ranges'].filter(range => Number.isFinite(range?.start) && Number.isFinite(range?.end))
    .map(({start, end}) => ({start: Math.max(0, start), end: Math.min(duration, end)}))
    .filter(range => range.end > range.start).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push(range);
  }
  return merged;
}
