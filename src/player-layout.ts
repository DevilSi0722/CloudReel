type Rect = {x: number; y: number; width: number; height: number};

export function playerPopoverPosition(anchor: Rect, panel: {width: number; height: number}, viewport: {width: number; height: number}, placement: 'above' | 'below' = 'above') {
  const edge = 16, gap = 10;
  const left = Math.max(edge, Math.min(anchor.x + anchor.width / 2 - panel.width / 2, viewport.width - panel.width - edge));
  const maxHeight = Math.max(0, placement === 'above' ? anchor.y - gap - edge : viewport.height - anchor.y - anchor.height - gap - edge);
  const height = Math.min(panel.height, maxHeight);
  const top = placement === 'above' ? Math.max(edge, anchor.y - gap - height) : anchor.y + anchor.height + gap;
  return {left, top, maxHeight};
}
