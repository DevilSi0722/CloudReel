// Both the website and OAuth quota endpoints report bytes. Missing fields
// must never be displayed as an empty drive or an unlimited plan.
export function normalizeBaiduQuota(data) {
  const bytes = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
  if (!data || !bytes(data.total) || Number(data.total) <= 0 || !bytes(data.used)) throw new Error('百度没有返回有效的容量信息，请稍后刷新。');
  const total = Number(data.total), used = Number(data.used);
  return {total, used, available: Math.max(0, total - used)};
}
