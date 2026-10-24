/**
 * 用量统计：区分「本次进程」和「历史累计」。
 *
 * 数据来源是 LlmClient 自己的 usage 计数器（每次请求累加）。
 * 它每启动一个进程就从 0 开始，所以：
 *
 *     session（本次） = client.usage 当前值
 *     lifetime（累计） = 上次落盘的 lifetime + session
 *
 * 这样重启机器人不会把总量清零，而「本次」又能真实反映这一个进程花了多少。
 *
 * 落盘位置：data/usage.json（跟着 PERSIST_SESSIONS 走，不落盘时只在内存里）。
 */
import fs from 'node:fs';
import path from 'node:path';

const FIELDS = ['requests', 'promptTokens', 'completionTokens', 'cacheHitTokens', 'cacheMissTokens'];

function emptyCounters() {
  return { requests: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, costCNY: 0 };
}

function add(a, b) {
  const out = { ...emptyCounters() };
  for (const k of FIELDS) out[k] = (Number(a?.[k]) || 0) + (Number(b?.[k]) || 0);
  out.costCNY = (Number(a?.costCNY) || 0) + (Number(b?.costCNY) || 0);
  return out;
}

export class UsageTracker {
  /**
   * @param {{file?:string|null, logger?:object}} opts file 为空则只记内存
   */
  constructor({ file = null, logger = null } = {}) {
    this.file = file;
    this.log = logger;
    this.startedAt = Date.now();
    /** 历史累计（上个进程落盘的值）——本次的用量要加在它上面 */
    this.baseline = emptyCounters();
    this.lifetime = emptyCounters();
    this.session = emptyCounters();
    this.updatedAt = null;

    if (file) {
      try {
        if (fs.existsSync(file)) {
          const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
          if (j?.lifetime) this.baseline = add(emptyCounters(), j.lifetime);
          this.previousUpdatedAt = j?.updatedAt ?? null;
        }
      } catch (err) {
        this.log?.warn?.(`用量文件读取失败，从零开始：${err.message}`);
      }
    }
  }

  /** 把 client 的当前计数折算成 session / lifetime（不落盘） */
  compute(client) {
    const u = client?.usage ?? {};
    const session = {
      requests: Number(u.requests) || 0,
      promptTokens: Number(u.promptTokens) || 0,
      completionTokens: Number(u.completionTokens) || 0,
      cacheHitTokens: Number(u.cacheHitTokens) || 0,
      cacheMissTokens: Number(u.cacheMissTokens) || 0,
      costCNY: typeof client?.estimateCostCNY === 'function' ? client.estimateCostCNY() : 0,
    };
    this.session = session;
    // 等式就一句：累计 = 历史基线 + 本次。
    // 每次都用基线重算，所以反复 save 不会把同一个 session 重复累加进去。
    this.lifetime = add(this.baseline, session);
    return { session, lifetime: this.lifetime };
  }

  /** 计算并落盘 */
  save(client) {
    const r = this.compute(client);
    this.updatedAt = Date.now();
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(
          this.file,
          JSON.stringify(
            {
              updatedAt: this.updatedAt,
              sessionStartedAt: this.startedAt,
              session: r.session,
              lifetime: r.lifetime,
              cacheHitRate:
                r.session.cacheHitTokens + r.session.cacheMissTokens > 0
                  ? r.session.cacheHitTokens / (r.session.cacheHitTokens + r.session.cacheMissTokens)
                  : null,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        this.log?.warn?.(`用量落盘失败：${err.message}`);
      }
    }
    return r;
  }

  /** 定时保存；返回停止函数 */
  start(client, intervalMs = 15000) {
    const timer = setInterval(() => this.save(client), intervalMs);
    timer.unref?.();
    return () => {
      clearInterval(timer);
      this.save(client);
    };
  }

  /** 「累计」里扣除历史，只留本次（供 UI 展示用） */
  snapshot(client) {
    const r = this.compute(client);
    return { ...r, startedAt: this.startedAt, updatedAt: this.updatedAt ?? Date.now() };
  }
}

export default UsageTracker;
