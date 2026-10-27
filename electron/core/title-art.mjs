// TMDB commonly labels Chinese artwork simply "zh", without a script/region.
// Keep explicit Simplified/Traditional variants ordered when supplied, then
// generic Chinese, English, and unlabelled artwork. Never guess from pixels.
export function chooseTitleArt(logos = []) {
  const languages = ['zh-CN', 'zh-Hans', 'zh-SG', 'zh', 'zh-TW', 'zh-Hant', 'zh-HK', 'en', 'en-US', null];
  const rank = logo => languages.indexOf(logo.iso_639_1 ?? null);
  return logos.filter(logo => rank(logo) >= 0 && /^\/[a-zA-Z0-9]+\.png$/.test(logo.file_path ?? '') && logo.width > 0 && logo.height > 0)
    .sort((a, b) => rank(a) - rank(b) || (b.vote_average || 0) - (a.vote_average || 0) || (b.vote_count || 0) - (a.vote_count || 0) || Math.min(b.width, 1000) - Math.min(a.width, 1000))[0];
}

export function titleArtDue(catalog, now = Date.now()) {
  return catalog?.source === 'tmdb' && (!catalog.logoCheckedAt || now - Date.parse(catalog.logoCheckedAt) >= (catalog.logo ? 30 : 7) * 86400000);
}
