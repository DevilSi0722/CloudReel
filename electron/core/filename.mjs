export function parseFilename(filename) {
  const stem = filename.replace(/\.[^.]+$/, '');
  const episode = stem.match(/(?:S(\d{1,2})[ ._-]*E(\d{1,3})|(\d{1,2})x(\d{1,3}))/i);
  const yearMatch = stem.match(/(?:^|[ ._(\[])(19\d{2}|20\d{2})(?=[ ._)\]]|$)/);
  const cut = [episode?.index, yearMatch?.index, stem.search(/\b(2160p|1080p|720p|480p|WEB[ ._-]?DL|BluRay|BDRip|HDR|DV|HEVC|x26[45])\b/i)].filter(n => n !== undefined && n >= 0);
  const title = stem.slice(0, cut.length ? Math.min(...cut) : stem.length).replace(/[._]/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim() || stem;
  return { title, year: yearMatch ? Number(yearMatch[1]) : undefined, kind: episode ? 'episode' : 'movie',
    season: episode ? Number(episode[1] ?? episode[3]) : undefined, episode: episode ? Number(episode[2] ?? episode[4]) : undefined };
}
