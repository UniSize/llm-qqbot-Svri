/**
 * OneBot 11 桥接（QQ）。
 *
 * OneBot 是 QQ 生态中的既有标准，NapCat / LLOneBot / go-cqhttp 等实现把 QQ
 * 包装为 HTTP + WebSocket 接口，收发均为结构化数据：不需要像素级点按、窗口切换、
 * 剪贴板或 OCR，因此不存在微信 4.x 客户端自动化所遇到的问题。
 *
 * 本文件只依赖 OneBot 11 协议本身，不绑定任何具体实现：
 *   - 发送：HTTP POST {base}/send_private_msg | /send_group_msg
 *   - 接收：WebSocket 正向连接（本端为客户端，连接到框架的 ws 服务）
 *
 * 引擎（engine.js）完全复用：会话上下文、限流、DeepSeek 对接与分片回复均由该层提供。
 */

/** 消息段数组 → 纯文本 */
export function segmentsToText(segments) {
  if (!Array.isArray(segments)) return '';
  return segments
    .map((s) => {
      switch (s?.type) {
        case 'text':
          return s.data?.text ?? '';
        case 'face':
          return '[表情]';
        case 'image':
          return '[图片]';
        case 'record':
          return '[语音]';
        case 'video':
          return '[视频]';
        case 'file':
          return '[文件]';
        case 'at':
          return `@${s.data?.qq ?? ''}`;
        default:
          return '';
      }
    })
    .join('');
}

/** 取出消息里所有被 @ 的 QQ 号 */
export function mentionedIds(segments) {
  if (!Array.isArray(segments)) return [];
  return segments.filter((s) => s?.type === 'at').map((s) => String(s.data?.qq ?? ''));
}

/**
 * OneBot 事件 → engine 需要的「规范化消息」。
 *
 * 引擎通过文本中的 `@机器人昵称` 判断是否被 @，因此将 at 消息段里
 * 「机器人自身的 QQ 号」替换成 `@<昵称>`，其他人的 @ 还原为 `@QQ号`。
 * 这样既有的准入判断逻辑可以原样复用。
 *
 * @param {object} event OneBot 上报事件
 * @param {{selfId:string, selfName:string}} ctx
 */
export function toNormalizedMessage(event, ctx) {
  const { selfId, selfName } = ctx;
  const segments = event.message;
  const isGroup = event.message_type === 'group';

  let text = '';
  if (Array.isArray(segments)) {
    text = segments
      .map((s) => {
        if (s?.type === 'text') return s.data?.text ?? '';
        if (s?.type === 'at') {
          const qq = String(s.data?.qq ?? '');
          if (qq === String(selfId)) return `@${selfName}`;
          if (qq === 'all') return '@所有人';
          return `@${qq}`;
        }
        return segmentsToText([s]);
      })
      .join('');
  } else {
    text = String(event.raw_message ?? event.message ?? '');
  }

  const sender = event.sender ?? {};
  return {
    id: String(event.message_id ?? ''),
    text,
    talkerId: String(event.user_id ?? ''),
    talkerName: sender.card || sender.nickname || String(event.user_id ?? 'unknown'),
    roomId: isGroup ? String(event.group_id ?? '') : null,
    roomTopic: isGroup ? String(event.group_id ?? '') : null,
    self: String(event.user_id ?? '') === String(selfId),
    botId: String(selfId ?? ''),
    date: event.time ? new Date(Number(event.time) * 1000) : new Date(),
    mentions: mentionedIds(segments),
    raw: event,
  };
}

/** 用 Node 内置能力加载 WebSocket：Node 22+ 有全局 WebSocket，否则回退到 ws 包 */
async function resolveWebSocket() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  try {
    const mod = await import('ws');
    return mod.default ?? mod.WebSocket;
  } catch {
    throw new Error(
      '当前 Node 没有内置 WebSocket，且未安装 ws 包。请升级到 Node 22+ 或执行：npm i ws',
    );
  }
}

export class OneBotBridge {
  /**
   * @param {object} cfg 完整配置（见 config/default.json 的 onebot 段）
   * @param {{engine:import('./engine.js').ChatEngine, logger:object}} deps
   */
  constructor(cfg, { engine, logger } = {}) {
    this.cfg = cfg;
    this.engine = engine;
    this.log = logger;
    this.ws = null;
    this.selfId = null;
    this.selfName = cfg.bot.name;
    this.startedAt = null;
    this.counters = { received: 0, sent: 0, skipped: 0, errors: 0, reconnects: 0 };
    this.reconnectDelayMs = 1000;
    this.stopped = false;
    this.pending = new Map();
    this.seq = 0;
    /** 健康状态：healthy | degraded | down */
    this.health = 'starting';
    this.healthTimer = null;
    this.consecutiveHealthFailures = 0;
    this.lastHealthyAt = null;
  }

  get options() {
    const o = this.cfg.onebot ?? {};
    return {
      httpUrl: 'http://127.0.0.1:3000',
      wsUrl: 'ws://127.0.0.1:3001',
      accessToken: '',
      reconnectMaxDelayMs: 30000,
      /** 健康探测间隔 */
      healthIntervalMs: 30000,
      /** 连续失败多少次算掉线 */
      healthFailThreshold: 2,
      groupRequireMention: this.cfg.wechat.groupRequireMention,
      ...o,
    };
  }

  #headers() {
    const o = this.options;
    const h = { 'Content-Type': 'application/json' };
    if (o.accessToken) h.Authorization = `Bearer ${o.accessToken}`;
    return h;
  }

  /** 调用 OneBot HTTP API */
  async call(action, params = {}, timeoutMs = 15000) {
    const o = this.options;
    const url = `${o.httpUrl.replace(/\/+$/, '')}/${action}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`OneBot HTTP ${res.status}: ${JSON.stringify(data)?.slice(0, 200)}`);
      if (data && data.status && data.status !== 'ok' && data.retcode !== 0) {
        throw new Error(`OneBot 返回失败: retcode=${data.retcode} ${data.message ?? ''}`);
      }
      return data?.data ?? data;
    } finally {
      clearTimeout(timer);
    }
  }

  async start({ onQrCode, onLogin, onLogout, onError } = {}) {
    this.startedAt = Date.now();
    this.stopped = false;
    const o = this.options;

    // 1) 先做存活探测并获取登录信息，错误信息需指明原因
    let info;
    try {
      info = await this.call('get_login_info');
    } catch (err) {
      const e = new Error(
        `连不上 OneBot 的 HTTP 服务（${o.httpUrl}）：${err.message}\n` +
          '请确认 NapCat/LLOneBot 已启动，且 onebot.httpUrl 与它的 HTTP 服务地址一致。',
      );
      e.code = 'ONEBOT_HTTP_UNREACHABLE';
      throw e;
    }
    this.selfId = String(info?.user_id ?? '');
    this.selfName = info?.nickname || this.cfg.bot.name;

    // 引擎通过文本中的 `@<BOT_NAME>` 判断是否被提及。QQ 的提及携带账号真实昵称
    // （at 消息段中另含 QQ 号），两者都不一定等于 BOT_NAME。
    // 因此将两者都登记进名单，避免准入判断把所有 @ 都当作闲聊。
    this.cfg.wechat.mentions = [
      ...new Set([
        ...(this.cfg.wechat.mentions ?? []),
        this.selfName,
        this.selfId,
        String(info?.user_id ?? ''),
      ].filter(Boolean)),
    ];
    this.log?.info?.(`@ 识别名单：${this.cfg.wechat.mentions.join(', ')}`);

    this.log?.info?.(`已连接 OneBot：QQ ${this.selfName}(${this.selfId})  HTTP=${o.httpUrl}`);
    onLogin?.({ id: this.selfId, name: this.selfName });

    // 2) 建立 WebSocket 接收事件
    await this.#connectWs({ onError, onLogout });
    // 3) 启动健康探测 + 断线恢复
    this.#startHealthCheck({ onError, onLogout });
    this.health = 'healthy';
    this.lastHealthyAt = Date.now();
    return { status: 'ok', selfId: this.selfId };
  }

  /**
   * 定期探测 OneBot 的 HTTP 服务，用于区分两种情况：
   *   - 仅 WS 断开 → #connectWs 会自动重连，此处只需确认后端仍在线
   *   - NapCat 完全停止 → HTTP 同样失败，此时重连无意义，需告警
   * 后端恢复后会自动把 WS 重新接上，不需要人工介入。
   */
  #startHealthCheck({ onError, onLogout } = {}) {
    if (this.healthTimer) clearInterval(this.healthTimer);
    const o = this.options;
    this.healthTimer = setInterval(() => {
      this.#healthCheck({ onError, onLogout }).catch(() => {});
    }, o.healthIntervalMs);
    this.healthTimer.unref?.();
  }

  async #healthCheck({ onError, onLogout } = {}) {
    if (this.stopped) return;
    const o = this.options;
    try {
      await this.call('get_login_info', {}, 5000);
      // 后端服务正常
      this.consecutiveHealthFailures = 0;
      if (this.health !== 'healthy') {
        this.log?.info?.(`✅ OneBot 已恢复（此前状态：${this.health}）`);
        this.health = 'healthy';
        // WS 若也断开，确保重连正在进行
        if (!this.ws) await this.#connectWs({ onError, onLogout });
      }
      this.lastHealthyAt = Date.now();
    } catch (err) {
      this.consecutiveHealthFailures += 1;
      const threshold = Math.max(1, Number(o.healthFailThreshold) || 2);
      if (this.health !== 'down' && this.consecutiveHealthFailures >= threshold) {
        this.health = 'down';
        this.log?.error?.(
          `❌ OneBot 已掉线（连续 ${this.consecutiveHealthFailures} 次探测失败）。` +
            `请检查 QQ 是否仍在运行、NapCat 是否已退出；恢复后机器人会自动重连，无需重启。`,
        );
      } else if (this.consecutiveHealthFailures === 1) {
        this.health = 'degraded';
        this.log?.warn?.(`OneBot HTTP 无响应（第 1 次）：${err.message}`);
      }
    }
  }

  /** 立刻做一次健康探测（供外部/测试调用） */
  async probeHealth() {
    await this.#healthCheck({});
    return this.health;
  }

  async #connectWs({ onError, onLogout } = {}) {
    const o = this.options;
    const WebSocketImpl = await resolveWebSocket();
    const url = o.accessToken
      ? `${o.wsUrl}?access_token=${encodeURIComponent(o.accessToken)}`
      : o.wsUrl;

    this.ws = new WebSocketImpl(url);

    this.ws.addEventListener?.('open', () => {
      this.reconnectDelayMs = 1000;
      this.log?.info?.(`事件通道已连接：${o.wsUrl}`);
    });
    this.ws.addEventListener?.('message', (ev) => {
      this.#onEvent(ev.data).catch((err) => {
        this.counters.errors += 1;
        this.log?.error?.('处理事件异常：', err);
      });
    });
    this.ws.addEventListener?.('close', () => {
      if (this.stopped) return;
      this.counters.reconnects += 1;
      this.log?.warn?.(`事件通道断开，${Math.round(this.reconnectDelayMs / 1000)}s 后重连…`);
      setTimeout(() => {
        if (!this.stopped) {
          this.#connectWs({ onError, onLogout }).catch((err) => this.log?.error?.('重连失败：', err));
        }
      }, this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, o.reconnectMaxDelayMs);
      onLogout?.();
    });
    this.ws.addEventListener?.('error', (err) => {
      this.counters.errors += 1;
      this.log?.error?.(`事件通道错误：${err?.message ?? err}`);
      onError?.(err);
    });

    // 部分实现（如 go-cqhttp）会先发一个 lifecycle 事件
    return this.ws;
  }

  async #onEvent(raw) {
    let event;
    try {
      event = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (this.cfg.onebot?.debugEvents) this.log?.debug?.(`事件: ${JSON.stringify(event).slice(0, 300)}`);
    if (event?.post_type !== 'message') return; // 仅处理消息事件
    if (event.message_type !== 'private' && event.message_type !== 'group') return;

    const fromSelf = String(event.user_id) === String(this.selfId);
    if (this.cfg.onebot?.debugEvents) {
      this.log?.info?.(
        `收到消息事件: type=${event.message_type} user=${event.user_id} self=${this.selfId} fromSelf=${fromSelf} raw="${String(event.raw_message ?? '').slice(0, 60)}"`,
      );
    }
    // 跳过自身消息以避免自问自答循环，除非显式允许
    // （仅有一个账号时可用于测试整条链路）。
    if (fromSelf && !this.cfg.onebot?.allowSelfMessages) return;

    const msg = toNormalizedMessage(event, { selfId: this.selfId, selfName: this.selfName });
    this.counters.received += 1;
    if (this.cfg.onebot?.debugEvents) {
      this.log?.info?.(
        `规范化后: room=${msg.roomId} talker=${msg.talkerName} text="${msg.text.slice(0, 60)}"`,
      );
    }

    const key = this.engine.keyOf(msg);
    // 用户再次发言 → 中断上一轮
    if (this.cfg.behavior.interruptOnNewMessage !== false) this.engine.abort(key);

    const sink = {
      onReply: async (text, meta) => {
        const parts = this.engine.chunkReply(text, this.cfg.behavior.maxReplyChars);
        for (const part of parts) {
          await this.#send(msg, part);
        }
        this.log?.debug?.(`已回复 ${parts.length} 段 (${meta?.kind ?? 'answer'})`);
      },
    };

    const result = await this.engine.handle(msg, sink);
    if (result.status === 'ignored') this.counters.skipped += 1;
  }

  /** 发送消息：群聊回复到群，私聊回复到用户 */
  async #send(msg, text) {
    try {
      if (msg.roomId) {
        await this.call('send_group_msg', {
          group_id: Number(msg.roomId),
          message: [{ type: 'text', data: { text } }],
        });
      } else {
        await this.call('send_private_msg', {
          user_id: Number(msg.talkerId),
          message: [{ type: 'text', data: { text } }],
        });
      }
      this.counters.sent += 1;
    } catch (err) {
      this.counters.errors += 1;
      this.log?.error?.(`发送失败：${err.message}`);
      throw err;
    }
  }

  /** 主动发送（外部调用），target 为 QQ 号或群号 */
  async push(target, text, { group = false } = {}) {
    const action = group ? 'send_group_msg' : 'send_private_msg';
    const key = group ? 'group_id' : 'user_id';
    await this.call(action, { [key]: Number(target), message: [{ type: 'text', data: { text } }] });
    this.counters.sent += 1;
  }

  status() {
    return {
      mode: 'onebot',
      running: !!this.ws,
      loggedIn: !!this.selfId,
      selfId: this.selfId,
      selfName: this.selfName,
      health: this.health,
      lastHealthySec: this.lastHealthyAt ? Math.round((Date.now() - this.lastHealthyAt) / 1000) : null,
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      counters: { ...this.counters },
      engine: this.engine.stats,
      usage: this.engine.client.usage,
    };
  }

  async stop() {
    this.stopped = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    try {
      this.ws?.close?.();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.health = 'stopped';
    this.log?.info?.('OneBot 桥接已停止');
  }
}

export default OneBotBridge;
