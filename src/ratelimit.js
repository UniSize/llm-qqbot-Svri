/**
 * 滑动窗口限流 + 并发锁。
 */
export class RateLimiter {
  /**
   * @param {{perMinute?: number}} opts perMinute<=0 表示不限流
   */
  constructor({ perMinute = 10 } = {}) {
    this.perMinute = perMinute > 0 ? perMinute : 0;
    /** @type {Map<string, number[]>} 每个 key 的时间戳队列 */
    this.hits = new Map();
  }

  /**
   * 消耗一次配额。
   * @returns {{ok:boolean, retryAfterMs?:number, remaining?:number}}
   */
  take(key, now = Date.now()) {
    if (!this.perMinute) return { ok: true, remaining: Infinity };
    const windowStart = now - 60_000;
    const list = (this.hits.get(key) || []).filter((t) => t > windowStart);
    if (list.length >= this.perMinute) {
      const retryAfterMs = Math.max(0, list[0] + 60_000 - now);
      this.hits.set(key, list);
      return { ok: false, retryAfterMs, remaining: 0 };
    }
    list.push(now);
    this.hits.set(key, list);
    return { ok: true, remaining: this.perMinute - list.length };
  }

  reset(key) {
    this.hits.delete(key);
  }

  sweep(now = Date.now()) {
    const windowStart = now - 60_000;
    for (const [k, list] of this.hits) {
      const kept = list.filter((t) => t > windowStart);
      if (kept.length) this.hits.set(k, kept);
      else this.hits.delete(k);
    }
  }
}

/** 简单的「同一会话串行执行」锁，防止用户连发消息导致上下文错乱 */
export class KeyedLock {
  constructor() {
    /** @type {Map<string, Promise<any>>} */
    this.chains = new Map();
    this.pending = new Set();
  }

  isBusy(key) {
    return this.pending.has(key);
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  run(key, fn) {
    const prev = this.chains.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.pending.add(key);
    const cleanup = () => {
      if (this.chains.get(key) === tracked) this.chains.delete(key);
      this.pending.delete(key);
    };
    const tracked = next.then(
      (v) => {
        cleanup();
        return v;
      },
      (e) => {
        cleanup();
        throw e;
      },
    );
    this.chains.set(key, tracked.catch(() => {}));
    return tracked;
  }
}

export default RateLimiter;
