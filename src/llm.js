/**
 * DeepSeek Chat Completions 客户端（零依赖，基于 Node 18+ 内置 fetch）。
 *
 * 支持：
 *  - 流式 SSE（stream: true），逐块产出文本
 *  - 非流式
 *  - 自动重试（429 / 5xx / 网络抖动），指数退避
 *  - AbortSignal 取消（用户发新消息时可打断旧请求）
 *  - deepseek-reasoner 的 reasoning_content 单独回调
 *  - 用量统计
 *
 * 官方文档：https://api-docs.deepseek.com/
 */

export class LlmError extends Error {
  constructor(message, { status = 0, code = '', body = null, retryable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.retryable = retryable;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

export class LlmClient {
  /**
   * @param {{
   *   apiKey: string,
   *   baseUrl?: string,
   *   model?: string,
   *   temperature?: number,
   *   maxTokens?: number,
   *   timeoutMs?: number,
   *   maxRetries?: number,
   *   stream?: boolean,
   *   fetchImpl?: typeof fetch,
   *   logger?: {debug:Function,info:Function,warn:Function,error:Function},
   * }} opts
   */
  constructor(opts = {}) {
    const {
      apiKey = '',
      baseUrl = 'https://api.deepseek.com',
      model = 'deepseek-chat',
      temperature = 1.0,
      maxTokens = 1024,
      timeoutMs = 60_000,
      maxRetries = 2,
      stream = true,
      fetchImpl = globalThis.fetch,
      logger = null,
    } = opts;

    if (!apiKey) throw new LlmError('缺少 DEEPSEEK_API_KEY，请在 .env 中配置');
    if (typeof fetchImpl !== 'function') {
      throw new LlmError('当前 Node 版本不支持 fetch，请升级到 Node 18.17+');
    }

    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.model = model;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.timeoutMs = timeoutMs;
    this.maxRetries = Math.max(0, maxRetries);
    this.stream = stream;
    this.fetch = fetchImpl;
    this.logger = logger;

    this.usage = {
      promptTokens: 0,
      completionTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      requests: 0,
      errors: 0,
    };
  }

  get endpoint() {
    // 兼容 https://api.deepseek.com 与 https://api.deepseek.com/v1 两种写法
    const base = /\/v\d+$/.test(this.baseUrl) ? this.baseUrl : `${this.baseUrl}/v1`;
    return `${base}/chat/completions`;
  }

  #headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
  }

  #payload(messages, overrides = {}) {
    const p = {
      model: overrides.model || this.model,
      messages,
      temperature: overrides.temperature ?? this.temperature,
      max_tokens: overrides.maxTokens ?? this.maxTokens,
      stream: overrides.stream ?? this.stream,
    };
    if (p.stream) p.stream_options = { include_usage: true };
    if (overrides.jsonMode) p.response_format = { type: 'json_object' };
    if (overrides.topP !== undefined) p.top_p = overrides.topP;
    if (overrides.stop) p.stop = overrides.stop;
    return p;
  }

  /**
   * 带重试的请求，返回 Response（body 未消费）。
   * 每次尝试使用独立的 AbortController：
   *   - 超时只终止「本次尝试」，可以进入下一次重试
   *   - 外部 signal 取消（例如用户再次发送消息）则立即抛出，不再重试
   */
  async #request(messages, overrides = {}) {
    const payload = this.#payload(messages, overrides);
    const url = this.endpoint;
    const timeoutMs = overrides.timeoutMs ?? this.timeoutMs;
    let lastErr = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const external = overrides.signal;
      if (external?.aborted) throw new DOMException('Aborted', 'AbortError');

      const controller = new AbortController();
      const onExternalAbort = () => controller.abort(external?.reason);
      external?.addEventListener?.('abort', onExternalAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('timeout'));
      }, timeoutMs);

      let waitMs = 0;
      try {
        this.logger?.debug?.(`POST ${url} model=${payload.model} attempt=${attempt + 1}/${this.maxRetries + 1}`);
        const res = await this.fetch(url, {
          method: 'POST',
          headers: this.#headers(),
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (res.ok) return res;

        const text = await res.text().catch(() => '');
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text };
        }
        const message = body?.error?.message || `HTTP ${res.status}`;
        const retryable = RETRYABLE_STATUS.has(res.status);
        lastErr = new LlmError(`DeepSeek 接口错误：${message}`, {
          status: res.status,
          code: body?.error?.type || body?.error?.code || '',
          body,
          retryable,
        });
        if (!retryable || attempt === this.maxRetries) break;

        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 500 * 2 ** attempt + Math.random() * 200;
        this.logger?.warn?.(`请求失败(${res.status})，${Math.round(waitMs)}ms 后重试…`);
      } catch (err) {
        if (external?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (timedOut) {
          lastErr = new LlmError(`请求超时（${timeoutMs}ms）`, { retryable: true });
        } else if (err?.name === 'AbortError') {
          throw err;
        } else {
          lastErr = new LlmError(`网络错误：${err?.message || err}`, { retryable: true });
        }
        if (attempt === this.maxRetries) break;
        waitMs = 500 * 2 ** attempt + Math.random() * 200;
        this.logger?.warn?.(`${lastErr.message}，${Math.round(waitMs)}ms 后重试…`);
      } finally {
        clearTimeout(timer);
        external?.removeEventListener?.('abort', onExternalAbort);
      }

      if (waitMs > 0) await sleep(waitMs, external);
    }

    this.usage.errors += 1;
    throw lastErr || new LlmError('DeepSeek 请求失败');
  }

  /**
   * 非流式对话。
   * @param {Array<{role:string, content:string}>} messages
   * @returns {Promise<{content:string, reasoning:string, usage:object, model:string, finishReason:string}>}
   */
  async chat(messages, overrides = {}) {
    const res = await this.#request(messages, { ...overrides, stream: false });
    const data = await res.json();
    const choice = data?.choices?.[0] || {};
    this.#trackUsage(data?.usage);
    return {
      content: choice.message?.content ?? '',
      reasoning: choice.message?.reasoning_content ?? '',
      finishReason: choice.finish_reason ?? 'stop',
      model: data.model ?? this.model,
      usage: data.usage ?? null,
    };
  }

  /**
   * 流式对话：异步生成器，逐块产出事件。
   * @param {Array<{role:string, content:string}>} messages
   * @param {{onDelta?:(t:string)=>void, onReasoning?:(t:string)=>void, signal?:AbortSignal}} overrides
   * @returns {AsyncGenerator<{type:'delta'|'done', text?:string, usage?:object, model?:string}>}
   */
  async *streamChat(messages, overrides = {}) {
    const res = await this.#request(messages, { ...overrides, stream: true });
    if (!res.body) throw new LlmError('响应没有 body，无法流式读取');

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';
    let usage = null;
    let model = this.model;

    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of rawEvent.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let json;
            try {
              json = JSON.parse(data);
            } catch {
              continue; // 不完整或非 JSON 的 SSE 行直接跳过
            }
            if (json.model) model = json.model;
            if (json.usage) usage = json.usage;
            const delta = json.choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.reasoning_content) {
              overrides.onReasoning?.(delta.reasoning_content);
              yield { type: 'reasoning', text: delta.reasoning_content };
            }
            if (delta.content) {
              full += delta.content;
              overrides.onDelta?.(delta.content);
              yield { type: 'delta', text: delta.content };
            }
          }
        }
      }
    } finally {
      this.#trackUsage(usage);
    }

    yield { type: 'done', text: full, usage, model };
  }

  /**
   * 一次性获取完整回复文本（内部聚合流式结果）。
   * @returns {Promise<{content:string, reasoning:string, usage:object|null, model:string}>}
   */
  async complete(messages, overrides = {}) {
    if (overrides.stream === false || (!this.stream && overrides.stream !== true)) {
      return this.chat(messages, overrides);
    }
    let content = '';
    let reasoning = '';
    let usage = null;
    let model = this.model;
    for await (const ev of this.streamChat(messages, overrides)) {
      if (ev.type === 'done') {
        content = ev.text ?? content;
        usage = ev.usage ?? usage;
        model = ev.model ?? model;
      } else if (ev.type === 'reasoning') {
        reasoning += ev.text;
      }
    }
    return { content, reasoning, usage, model, finishReason: 'stop' };
  }

  /** 轻量连通性检查（会消耗极少量 token） */
  async ping() {
    const r = await this.chat([{ role: 'user', content: 'ping' }], { maxTokens: 8, stream: false });
    return { ok: true, model: r.model, reply: r.content };
  }

  #trackUsage(usage) {
    this.usage.requests += 1;
    if (usage) {
      const prompt = usage.prompt_tokens || 0;
      this.usage.promptTokens += prompt;
      this.usage.completionTokens += usage.completion_tokens || 0;

      // 上下文硬盘缓存命中情况（DeepSeek 默认开启，无需配置）。
      // 命中部分的单价远低于未命中，多轮对话的成本主要取决于该比例。
      let hit = usage.prompt_cache_hit_tokens;
      let miss = usage.prompt_cache_miss_tokens;
      if (hit === undefined && usage.prompt_tokens_details) {
        hit = usage.prompt_tokens_details.cached_tokens;
      }
      if (hit === undefined || hit === null) {
        this.usage.cacheMissTokens += prompt;
      } else {
        hit = Number(hit) || 0;
        this.usage.cacheHitTokens += hit;
        this.usage.cacheMissTokens +=
          miss === undefined || miss === null ? Math.max(0, prompt - hit) : Number(miss) || 0;
      }
    }
  }

  /** 缓存命中率（0~1）；没有任何输入时返回 null */
  cacheHitRate() {
    const total = this.usage.cacheHitTokens + this.usage.cacheMissTokens;
    return total > 0 ? this.usage.cacheHitTokens / total : null;
  }

  /**
   * 估算花费（人民币）。
   *
   * 价格来自官方定价页 https://api-docs.deepseek.com/zh-cn/quick_start/pricing ：
   *   高峰时段为北京时间周一至周五 9:00-12:00、14:00-18:00（不含法定节假日），
   *   其余时段（含周末与法定节假日全天）为空闲时段，单价为高峰的一半。
   * 价格可能调整，此处数字仅用于粗略参考。
   */
  estimateCostCNY(now = new Date()) {
    // 每百万 token 的高峰价
    const TABLE = {
      'deepseek-flash': { cacheHit: 0.04, miss: 2.0, out: 8.0 },
      'deepseek-v4-pro': { cacheHit: 0.3, miss: 9.0, out: 27.0 },
      // 旧模型名仍可调用，按 flash 计费
      'deepseek-chat': { cacheHit: 0.04, miss: 2.0, out: 8.0 },
      'deepseek-reasoner': { cacheHit: 0.04, miss: 2.0, out: 8.0 },
    };
    const price = TABLE[this.model] || TABLE['deepseek-flash'];
    const factor = isPeakHour(now) ? 1 : 0.5;
    return (
      (this.usage.cacheHitTokens / 1_000_000) * price.cacheHit * factor +
      (this.usage.cacheMissTokens / 1_000_000) * price.miss * factor +
      (this.usage.completionTokens / 1_000_000) * price.out * factor
    );
  }
}

/**
 * 是否处于高峰计费时段。
 * 官方口径：北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰，
 * 其余时段（含周末与节假日全天）为空闲，单价为高峰的一半。
 * 此处按时区换算为北京时间；法定节假日不单独判断（仅用于估算，不生成精确账单）。
 */
export function isPeakHour(now = new Date()) {
  // 转成北京时间（UTC+8）
  const bj = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60_000);
  const day = bj.getDay(); // 0=周日 6=周六
  if (day === 0 || day === 6) return false;
  const h = bj.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

export default LlmClient;
