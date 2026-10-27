export class TaskPool {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  run(work, signal) {
    return new Promise((resolve, reject) => {
      const task = {work, signal, resolve, reject};
      task.abort = () => {const index = this.queue.indexOf(task); if (index >= 0) this.queue.splice(index, 1); reject(signal.reason);};
      if (signal?.aborted) {reject(signal.reason); return;}
      signal?.addEventListener('abort', task.abort, {once: true});
      this.queue.push(task); this.drain();
    });
  }
  drain() {
    while (this.active < this.limit && this.queue.length) {
      const task = this.queue.shift(); task.signal?.removeEventListener('abort', task.abort);
      if (task.signal?.aborted) {task.reject(task.signal.reason); continue;}
      this.active++;
      Promise.resolve().then(() => {task.signal?.throwIfAborted(); return task.work();}).then(task.resolve, task.reject).finally(() => {this.active--; this.drain();});
    }
  }
}

export async function mapConcurrent(values, limit, work, signal) {
  let index = 0;
  const results = await Promise.allSettled(Array.from({length: Math.min(values.length, limit)}, async () => {
    while (index < values.length && !signal?.aborted) {const current = index++; await work(values[current], current);}
  }));
  const failure = results.find(result => result.status === 'rejected'); if (failure) throw failure.reason;
}

// A cancelled metadata run stops waiting for shared artwork. Other callers
// can still use the same download and its eventual local cache entry.
export function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
