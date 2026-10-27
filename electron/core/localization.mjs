export const metadataLanguages = ['zh-CN', 'zh-TW', 'en-US'];
const hasHan = value => /[\u3400-\u9fff]/.test(value ?? '');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

// A zh-CN request may return an untranslated English title. Prefer an available
// Chinese translation before accepting that server fallback.
export function preferredText(records, key, { title = false } = {}) {
  const values = metadataLanguages.map(language => ({ language, text: records[language]?.[key] })).filter(entry => nonempty(entry.text));
  const named = values.filter(entry => !title || !/^(?:第\s*\d+\s*集|Episode\s*\d+)$/i.test(entry.text));
  return named.find(entry => entry.language.startsWith('zh') && hasHan(entry.text)) ?? named[0] ?? values[0];
}
export function mergeLocalized(records, keys = ['title', 'name', 'overview', 'tagline']) {
  const merged = structuredClone(records['zh-CN'] ?? records['zh-TW'] ?? records['en-US'] ?? {});
  const languages = {};
  for (const key of keys) {
    const chosen = preferredText(records, key, {title: key === 'name' || key === 'title'});
    if (chosen) { merged[key] = chosen.text; languages[key] = chosen.language; }
  }
  for (const key of ['poster_path', 'backdrop_path', 'still_path']) if (!merged[key]) merged[key] = metadataLanguages.map(language => records[language]?.[key]).find(Boolean);
  merged.metadataLanguages = languages;
  return merged;
}
export function needsTranslation(data, { episode = false } = {}) {
  const title = data.title ?? data.name;
  return !data.overview?.trim() || !hasHan(title) || !hasHan(data.overview) ||
    Object.hasOwn(data, 'tagline') && (!data.tagline?.trim() || !hasHan(data.tagline)) ||
    episode && /^(?:第\s*\d+\s*集|Episode\s*\d+)$/i.test(title ?? '');
}
export function mergeLocalizedSeason(records) {
  const merged = mergeLocalized(records);
  const episodes = [...new Map(metadataLanguages.flatMap(language => records[language]?.episodes ?? []).map(episode => [episode.episode_number, episode])).values()].sort((a, b) => a.episode_number - b.episode_number);
  merged.episodes = episodes.map(episode => {
    const variants = {};
    for (const language of metadataLanguages) {
      const match = records[language]?.episodes?.find(entry => entry.episode_number === episode.episode_number);
      if (match) variants[language] = match;
    }
    return mergeLocalized(variants, ['name', 'overview']);
  });
  return merged;
}
