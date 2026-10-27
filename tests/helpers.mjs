export function memoryStore() {
  return { data: { settings: { baiduClientId: 'baidu-app', traktClientId: 'trakt-app', traktRedirectUri: 'https://example.com/callback', autoSync: true }, secrets: {}, items: [], pending: [], logs: [] },
    secret(name) { return this.data.secrets[name] ?? null; }, setSecret(name, value) { this.data.secrets[name] = value; }, persist() {}, log(message) { this.data.logs.push(message); },
    queue(job) { this.data.pending = this.data.pending.filter(old => old.itemId !== job.itemId); this.data.pending.push({ ...job, id: crypto.randomUUID() }); },
    item(id) { const item = this.data.items.find(item => item.id === id); if (!item) throw new Error('missing'); return item; }
  };
}
