import {normalizeBaiduQuota} from '../core/baidu-quota.mjs';

const empty = () => ({loading: false, total: null, used: null, available: null, updatedAt: null, error: null});
export class BaiduQuotaMonitor {
  constructor({read, identity, notify = () => {}, now = Date.now, setTimer = setInterval, clearTimer = clearInterval, setDelay = setTimeout, clearDelay = clearTimeout}) {
    Object.assign(this, {read, identity, notify, now, setTimer, clearTimer, setDelay, clearDelay});
    this.state = empty(); this.key = null; this.generation = 0; this.lastAttempt = null; this.pending = null; this.stopped = false; this.timer = null; this.delay = null;
  }
  reset() {
    if (this.delay !== null) this.clearDelay(this.delay);
    this.delay = null; this.generation++; this.key = null; this.state = empty(); this.lastAttempt = null; this.pending = null;
  }
  synchronize() {
    const key = this.identity() || null;
    if (key !== this.key) {this.reset(); this.key = key;}
    return key;
  }
  status() {this.synchronize(); return {...this.state};}
  refresh({force = false} = {}) {
    const key = this.synchronize();
    if (!key || this.stopped) return Promise.resolve(this.status());
    if (this.pending) return this.pending;
    if (this.lastAttempt !== null && this.now() - this.lastAttempt < (force ? 1000 : 60000)) return Promise.resolve(this.status());
    const generation = this.generation;
    this.lastAttempt = this.now(); this.state.loading = true;
    const current = () => {this.synchronize(); return !this.stopped && generation === this.generation && this.key === key;};
    this.pending = Promise.resolve().then(async () => {
      if (!current()) return this.status();
      try {
        const data = normalizeBaiduQuota(await this.read());
        if (current()) this.state = {...data, loading: true, updatedAt: new Date(this.now()).toISOString(), error: null};
      } catch {
        if (current()) this.state.error = this.state.updatedAt ? '暂时无法更新容量，显示上次读数' : '暂时无法读取容量，请稍后重试';
      } finally {
        if (current()) {this.state.loading = false; this.pending = null; this.notify();}
      }
      return this.status();
    });
    this.notify();
    return this.pending;
  }
  changed() {
    if (this.stopped || !this.synchronize()) return;
    const generation = this.generation;
    if (this.delay !== null) this.clearDelay(this.delay);
    this.delay = this.setDelay(async () => {
      this.delay = null;
      // A read started before a file operation may still contain the old usage.
      // Coalesce a trailing read after it finishes instead of reusing that result.
      if (this.pending) {
        await this.pending;
        this.synchronize();
        if (!this.stopped && generation === this.generation) this.changed();
      } else await this.refresh({force: true});
    }, 2000); this.delay?.unref?.();
  }
  start() {
    if (this.stopped || this.timer !== null) return;
    this.timer = this.setTimer(() => {void this.refresh();}, 60000); this.timer?.unref?.(); void this.refresh();
  }
  stop() {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    if (this.delay !== null) this.clearDelay(this.delay);
    this.timer = null; this.delay = null; this.reset();
  }
}
