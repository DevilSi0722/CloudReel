import {randomUUID} from 'node:crypto';
import {seedHubUrl, catalogFromSnapshot, detailFromSnapshot, resourcesFromSnapshot} from '../core/discovery.mjs';

export class DiscoveryService {
  constructor({createBrowser} = {}) {
    this.createBrowser = createBrowser; this.queue = Promise.resolve(); this.cache = new Map(); this.resources = new Map();
  }
  serial(work) {const result = this.queue.then(work); this.queue = result.catch(() => {}); return result;}
  browser() {return this.view ??= this.createBrowser();}
  async cached(key, work, fresh = false) {
    const old = this.cache.get(key); if (!fresh && old && Date.now() - old.at < 5 * 60000) return structuredClone(old.value);
    const value = await work(); this.cache.set(key, {at:Date.now(), value});
    if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value);
    return structuredClone(value);
  }
  catalog({category = 'all', query = '', page = 1, order = 'update', fresh = false} = {}) {
    if (!['all','movies','shows','anime'].includes(category) || !['update','date','score'].includes(order) || typeof query !== 'string' || query.length > 80 || !Number.isInteger(page) || page < 1 || page > 1000) throw new Error('无效的片源筛选。');
    const path = query.trim() ? '/s/' + encodeURIComponent(query.trim()) + '/' : ({all:'/',movies:'/categories/1/movies/',shows:'/categories/3/movies/',anime:'/categories/2/movies/'})[category];
    const url = new URL(seedHubUrl(path)); url.searchParams.set('order', order); if (page > 1) url.searchParams.set('page', String(page));
    return this.serial(() => this.cached(url.href, async () => catalogFromSnapshot(await this.browser().page(url.href)), fresh === true));
  }
  detail(id) {
    if (!/^\d{1,16}$/.test(String(id))) throw new Error('无效的作品。');
    return this.serial(() => this.cached('detail:' + id, async () => {
      const snapshot = await this.browser().page(seedHubUrl('/movies/' + id + '/'));
      const detail = detailFromSnapshot(snapshot);
      const resources = detail.resources.map(resource => {
        const key = randomUUID(); this.resources.set(key, resource.url);
        return {id:key, title:resource.title};
      });
      if (this.resources.size > 5000) {this.resources.clear(); this.cache.clear(); for (const [index, resource] of resources.entries()) this.resources.set(resource.id, detail.resources[index].url);}
      return {...detail, resources};
    }));
  }
  resolve(id) {
    const url = this.resources.get(id); if (!url) throw new Error('资源列表已过期，请重新打开作品。');
    return this.serial(() => this.cached('resource:' + id, async () => {
      const resources = resourcesFromSnapshot(await this.browser().page(url));
      const baidu = resources.find(resource => resource.provider === 'baidu');
      if (!baidu) throw new Error(resources.length ? '这个资源来自其他网盘，请选择另一个百度资源。' : '没有读取到百度分享地址，请换一个资源或稍后重试。');
      return baidu.url;
    }));
  }
  close() {this.view?.destroy(); this.view = null; this.cache.clear(); this.resources.clear();}
}
