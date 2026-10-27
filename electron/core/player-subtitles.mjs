// mpv sub-pos raises bottom dialogue (including ASS and bitmap subtitles)
// without changing the video rectangle or stripping authored subtitle styles.
export function subtitlePosition(layout) {
  if (!layout || typeof layout.visible !== 'boolean' || !Number.isFinite(layout.height) || layout.height < 1 || layout.height > 32768 ||
      !Number.isFinite(layout.bottomInset) || layout.bottomInset < 0 || layout.bottomInset > layout.height) {
    throw new Error('无效的字幕避让区域。');
  }
  return layout.visible ? Math.max(50, Math.round((100 - layout.bottomInset / layout.height * 100) * 100) / 100) : 100;
}
