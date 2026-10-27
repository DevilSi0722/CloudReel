export const playbackDefaults = {audioLanguage: 'auto', subtitleLanguage: 'zh-Hans', speed: 1, subtitleDelay: 0, subtitleSize: 44, subtitleFont: 'Microsoft YaHei', rememberPlayback: true, skipIntro: 'manual'};
export function validatePlayback(input = {}) {
  const output = {};
  if (input.skipIntro !== undefined) {if (!['manual', 'auto', 'off'].includes(input.skipIntro)) throw new Error('无效的片头跳过方式。'); output.skipIntro = input.skipIntro;}
  for (const key of ['audioLanguage', 'subtitleLanguage']) if (input[key] !== undefined) {
    if (!['auto', 'zh-Hans', 'zh-Hant', 'zh', 'en', 'ja', 'ko', 'no'].includes(input[key])) throw new Error('无效的语言偏好。');
    output[key] = input[key];
  }
  for (const [key, min, max] of [['speed', .25, 4], ['subtitleDelay', -120, 120], ['subtitleSize', 20, 80]]) if (input[key] !== undefined) {
    if (!Number.isFinite(input[key]) || input[key] < min || input[key] > max) throw new Error('播放偏好超出可用范围。');
    output[key] = input[key];
  }
  if (input.subtitleFont !== undefined) {
    if (!['Microsoft YaHei', 'Microsoft YaHei UI', 'SimHei', 'SimSun', 'Arial', 'Segoe UI'].includes(input.subtitleFont)) throw new Error('请选择支持的字幕字体。');
    output.subtitleFont = input.subtitleFont;
  }
  if (input.rememberPlayback !== undefined) output.rememberPlayback = Boolean(input.rememberPlayback);
  return output;
}
export const describeTrack = track => track ? {lang: track.lang || '', title: track.title || '', codec: track.codec || ''} : 'no';
const chinese = text => /(?:zh|chi|zho|中文|简体|繁体|双语|中字)/i.test(text);
export function preferredTrack(tracks, type, preference, language = 'auto') {
  const candidates = tracks.filter(track => track.type === type);
  if (preference === 'no' || !preference && language === 'no') return 'no';
  if (preference && typeof preference === 'object') {
    const exact = candidates.find(t => (t.lang || '') === preference.lang && (t.title || '') === preference.title && (t.codec || '') === preference.codec);
    if (exact) return exact.id;
    const byLanguage = preference.lang && candidates.find(t => t.lang === preference.lang);
    if (byLanguage) return byLanguage.id;
  }
  if (language === 'auto') return null;
  const score = t => {
    const text = `${t.lang || ''} ${t.title || ''}`;
    if (language.startsWith('zh')) return chinese(text) ? 10 + (language === 'zh-Hans' && /(?:hans|chs|简体|簡體|简中)/i.test(text) || language === 'zh-Hant' && /(?:hant|cht|繁体|繁體|繁中)/i.test(text) ? 5 : 0) : -1;
    return new RegExp(language === 'en' ? 'eng|en\\b|英文' : language === 'ja' ? 'jpn|ja\\b|日语|日語' : 'kor|ko\\b|韩语|韓語', 'i').test(text) ? 10 : -1;
  };
  const ranked = candidates.map(t => ({t, score: score(t)})).sort((a,b) => b.score-a.score);
  return ranked[0]?.score >= 0 ? ranked[0].t.id : null;
}
