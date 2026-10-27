export function overlayRegions(input, size) {
  if (!Array.isArray(input) || input.length > 24) throw new Error('无效的播放器控件区域。');
  return input.map(rect => {
    if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))) throw new Error('无效的播放器控件区域。');
    const x = Math.max(0, Math.floor(rect.x)), y = Math.max(0, Math.floor(rect.y));
    const width = Math.max(0, Math.min(Math.ceil(rect.x + rect.width), size.width) - x), height = Math.max(0, Math.min(Math.ceil(rect.y + rect.height), size.height) - y);
    return {x, y, width, height, radius: Math.max(0, Math.min(Number(rect.radius) || 0, width / 2, height / 2, 40))};
  }).filter(rect => rect.width > 0 && rect.height > 0);
}

export function playerOverlayBounds(content, video) {
  if (!video) return null;
  return {x: Math.round(content.x + video.x), y: Math.round(content.y + video.y), width: Math.max(1, Math.round(video.width)), height: Math.max(1, Math.round(video.height))};
}

export function pointInside(point, rect) {
  return Boolean(rect && point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height);
}
