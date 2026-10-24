/**
 * 对话引擎：把「QQ 消息」翻译成「DeepSeek 请求」，再把回复交回适配层发送。
 * 这一层完全不依赖任何聊天框架，可以在没有 QQ 的环境里直接单测。
 */
import { LlmClient } from './llm.js';
import { SessionStore, sessionId, personaFingerprint } from './session.js';
import { RateLimiter, KeyedLock } from './ratelimit.js';
import { splitText, stripMention, isMentioned, estimateTokens } from './text.js';
import { loadPersonas, matchPersona, formatPersonaList } from './personas.js';
import { PersonaStateStore } from './persona-state.js';

export class ChatEngine {
  /**
   * @param {object} config 见 config/default.json
   * @param {{logger?:object, client?:LlmClient, now?:()=>number}} [deps]
   */
  constructor(config, deps = {}) {
    this.config = config;
    this.log = deps.logger ?? null;
    this.now = deps.now ?? (() => Date.now());

    this.client =
      deps.client ??
      new LlmClient({
        apiKey: config.ai.apiKey,
        baseUrl: config.ai.baseUrl,
        model: config.ai.model,
        temperature: config.ai.temperature,
        maxTokens: config.ai.maxTokens,
        timeoutMs: config.ai.timeoutMs,
        maxRetries: config.ai.maxRetries,
        stream: config.ai.stream,
        logger: this.log,
      });

    const persistPath = config.storage.persistSessions
      ? `${config.storage.dir}/sessions.json`
      : null;
    this.sessions = new SessionStore({
      maxTurns: config.behavior.maxHistoryTurns,
      maxTokens: config.behavior.maxHistoryTokens ?? 0,
      ttlMinutes: config.storage.sessionTtlMinutes,
      persistPath,
    });
    this.limiter = new RateLimiter({ perMinute: config.behavior.rateLimitPerMinute });
    this.lock = new KeyedLock();
    /** @type {Map<string, AbortController>} 每个会话当前进行中的请求 */
    this.inflight = new Map();

    // ---- 多人格 ----
    // 人格内容来自 personas/ 目录里用户自己写的 JSON，程序不内置任何人格。
    const personaDir = config.behavior.personasDir ?? null;
    const { list: personaList } = loadPersonas(personaDir, { logger: this.log });
    this.personas = personaList;
    if (personaList.length) {
      this.log?.info?.(
        `已加载 ${personaList.length} 个人格：${personaList.map((p) => p.name).join('、')}`,
      );
    } else {
      // 没有可用人格 → 退回单人格模式：直接使用 .env 中的 SYSTEM_PROMPT，
      // 不弹出选择菜单，personas/ 目录可以为空。
      // 该模式是默认行为，因此以 info 而非 warn 记录。
      this.log?.info?.(
        `未配置多人格，按单人格模式运行（使用 .env 的 SYSTEM_PROMPT）` +
          `；人格目录：${personaDir ?? '(未设置)'}`,
      );
    }
    // 可选的默认人格：配置 PERSONA 后跳过选择菜单，直接使用该人格
    this.defaultPersona =
      personaList.find((p) => p.id === config.behavior.defaultPersona) ?? null;

    this.personaState = new PersonaStateStore({
      persistPath: config.storage.persistSessions ? `${config.storage.dir}/personas.json` : null,
      logger: this.log,
    });
    // 人格文件被删除后，此前选择该人格的聊天需重新选择，否则会持续引用已不存在的人格
    this.personaState.dropUnknown(personaList.map((p) => p.id));

    this.stats = { handled: 0, replied: 0, skipped: 0, blocked: 0, failed: 0, personaAsked: 0 };
  }

  /**
   * 不含人格指纹的会话 ID。
   * 「该聊天选择了哪个人格」需在人格确定之前即可查询，因此基础 key 中不能带指纹。
   */
  baseKeyOf(msg) {
    return sessionId({
      roomId: msg.roomId ?? null,
      talkerId: msg.talkerId,
      groupContext: this.config.wechat.groupContext ?? 'per-user',
    });
  }

  /** 某个聊天当前生效的人格；没选过就回落到配置的默认人格（可能为 null） */
  personaFor(baseKey) {
    const id = this.personaState.personaIdOf(baseKey);
    if (id) return this.personas.find((p) => p.id === id) ?? null;
    return this.defaultPersona;
  }

  /**
   * 会话 ID = 基础 key + 当前人格的指纹。
   * 更换人格 → 指纹变化 → 自动切换到全新上下文（旧人格的历史仍保留在存储中，
   * 切回后可以继续使用）。
   */
  sessionKeyFor(baseKey, persona) {
    const prompt = persona?.systemPrompt ?? this.config.bot.systemPrompt;
    const tag = personaFingerprint(prompt);
    return tag ? `${baseKey}@${tag}` : baseKey;
  }

  keyOf(msg) {
    const baseKey = this.baseKeyOf(msg);
    return this.sessionKeyFor(baseKey, this.personaFor(baseKey));
  }

  /**
   * 决定是否响应该消息，以及最终要发给模型的用户文本。
   * @returns {{action:'reply'|'ignore', reason?:string, text?:string, command?:string}}
   */
  decide(msg) {
    const { wechat, bot } = this.config;

    if (msg.self || !msg.text?.trim()) return { action: 'ignore', reason: 'empty-or-self' };
    if (wechat.selfReplyLoopGuard && msg.talkerId === msg.botId) return { action: 'ignore', reason: 'loop-guard' };

    const baseKey = this.baseKeyOf(msg);
    const persona = this.personaFor(baseKey);
    const names = this.#botNames(persona);

    let text = stripMention(msg.text, { botName: bot.name, mentions: names });

    // 私聊：永远回复（除非白名单模式）
    if (!msg.roomId) {
      if (wechat.aliasWhitelist?.length && !wechat.aliasWhitelist.includes(msg.talkerName)) {
        return { action: 'ignore', reason: 'alias-not-whitelisted' };
      }
    } else {
      if (wechat.groupWhitelist?.length && !wechat.groupWhitelist.includes(msg.roomTopic)) {
        return { action: 'ignore', reason: 'group-not-whitelisted' };
      }
      // 等待该聊天选择人格时跳过 @ 要求。
      // 否则群内刚发出菜单，用户回复「阿尔法」会被 @ 规则拦截，导致无法完成选择。
      const awaitingPersona =
        this.personas.length > 0 && !persona && this.personaState.isAwaiting(baseKey);
      if (!awaitingPersona) {
        const verdict = this.#groupVerdict(msg, names);
        if (!verdict.ok) return { action: 'ignore', reason: verdict.reason };
        // 由「昵称出现在文本里」触发时（没有 @），去除开头的昵称，
        // 避免把「小深你好」整句交给模型。
        if (verdict.byName && !verdict.byAt) {
          for (const n of names) {
            if (text.startsWith(n)) {
              text = text.slice(n.length).replace(/^[\s,，:：、]+/, '').trim();
              break;
            }
          }
        }
      }
    }

    const command = this.#matchCommand(text);
    if (command) return { action: 'reply', text: '', command, baseKey, persona };
    if (!text) return { action: 'ignore', reason: 'empty-after-strip' };

    // 超长输入直接截断，避免超出上下文长度
    const maxInput = 4000;
    return {
      action: 'reply',
      text: text.length > maxInput ? text.slice(0, maxInput) : text,
      baseKey,
      persona,
    };
  }

  /**
   * 机器人的全部称呼：配置的昵称 + 别名 + 当前人格的名称/别名。
   * 人格自带的名称也需能触发，否则选定「企业」后群内称呼「企业」时不会响应。
   */
  #botNames(persona = null) {
    const names = [
      this.config.bot.name,
      persona?.name,
      ...(persona?.aliases ?? []),
      ...(this.config.wechat.mentions ?? []),
    ];
    return [...new Set(names.map((s) => String(s ?? '').trim()).filter(Boolean))];
  }

  /**
   * 群聊触发判定。behavior.groupTrigger 取值：
   *
   *   'mention'         仅 @ 机器人时回复（旧行为）
   *   'name'            消息中出现机器人昵称/别名即回复（@ 亦计入）
   *   'mention-or-name' @ 或出现昵称均回复（默认）
   *   'all'             群内每条消息均回复
   *
   * 私聊不经过该判定 —— 私聊始终回复。
   * @returns {{ok:boolean, reason?:string, byAt?:boolean, byName?:boolean}}
   */
  #groupVerdict(msg, names) {
    const b = this.config.behavior ?? {};
    const legacy = this.config.wechat.groupRequireMention;
    const mode = String(b.groupTrigger ?? (legacy === false ? 'all' : 'mention-or-name')).toLowerCase();

    if (mode === 'all') return { ok: true };
    if (mode === 'off') return { ok: true };

    const allNames = names ?? this.#botNames();
    const byAt = isMentioned(msg.text, { botName: this.config.bot.name, mentions: allNames });
    const byName = allNames.some((n) => msg.text.includes(n));

    switch (mode) {
      case 'mention':
      case 'at':
        return byAt ? { ok: true, byAt } : { ok: false, reason: 'no-mention' };
      case 'name':
        return byAt || byName ? { ok: true, byAt, byName } : { ok: false, reason: 'no-name' };
      case 'mention-or-name':
      case 'name-or-mention':
      default:
        return byAt || byName
          ? { ok: true, byAt, byName }
          : { ok: false, reason: 'no-mention-or-name' };
    }
  }

  /**
   * 匹配内置命令，支持带参数（例如 `/人格 企业`）。
   * @returns {{name:string, args:string}|null}
   */
  #matchCommand(text) {
    const cmds = this.config.behavior.commands ?? {};
    const t = String(text ?? '').trim();
    const tl = t.toLowerCase();
    for (const [name, list] of Object.entries(cmds)) {
      for (const c of list) {
        const raw = String(c);
        const cl = raw.toLowerCase();
        if (tl === cl) return { name, args: '' };
        if (tl.startsWith(`${cl} `) || tl.startsWith(`${cl}\u3000`)) {
          return { name, args: t.slice(raw.length).trim() };
        }
      }
    }
    return null;
  }

  /** 组装发给模型的消息数组。systemPrompt 取当前人格，而不是全局 bot.systemPrompt */
  buildMessages(key, userText, persona = null) {
    const { bot } = this.config;
    const sys = [];
    const prompt = persona?.systemPrompt ?? bot.systemPrompt;
    if (prompt) sys.push({ role: 'system', content: prompt });
    const ctx = this.config.behavior.contextPrompt;
    if (ctx) sys.push({ role: 'system', content: ctx });
    return [...sys, ...this.sessions.history(key), { role: 'user', content: userText }];
  }

  /**
   * 处理一条消息。
   * @param {object} msg 规范化消息
   * @param {{onReply:(text:string, meta:object)=>Promise<any>, onTyping?:Function, onPartial?:(text:string)=>Promise<any>}} sink
   * @returns {Promise<{status:string, reply?:string, reason?:string}>}
   */
  async handle(msg, sink) {
    this.stats.handled += 1;
    const decision = this.decide(msg);
    if (decision.action === 'ignore') {
      this.stats.skipped += 1;
      this.log?.debug?.(`忽略消息(${decision.reason}) from=${msg.talkerName}`);
      return { status: 'ignored', reason: decision.reason };
    }

    const baseKey = decision.baseKey ?? this.baseKeyOf(msg);
    const who = msg.roomId ? `${msg.roomTopic || msg.roomId}/${msg.talkerName}` : msg.talkerName;

    // 限流按「聊天」而不是按人格计数，否则切人格能绕过限流
    const quota = this.limiter.take(baseKey, this.now());
    if (!quota.ok) {
      this.stats.blocked += 1;
      const secs = Math.ceil(quota.retryAfterMs / 1000);
      this.log?.warn?.(`触发限流：${who}，${secs}s 后可用`);
      if (this.config.behavior.rateLimitMessage !== false) {
        await sink.onReply(`消息有点多，请 ${secs} 秒后再试 🙏`, { kind: 'rate-limit' });
      }
      return { status: 'rate-limited' };
    }

    // 内置命令（reset / help / persona）
    if (decision.command) {
      const reply = await this.#runCommand(decision.command, baseKey);
      if (reply != null) {
        await sink.onReply(reply, { kind: 'command' });
        return { status: 'command', reply };
      }
    }

    // --- 人格选择闸门 ---
    // 仅在 personas/*.json 中确实存在人格时才启用多人格。
    // 没有任何人格文件时，退回单一 SYSTEM_PROMPT 行为：
    // 未配置人格的用户不会看到选择菜单，旧配置也完全向后兼容。
    let userText = decision.text;
    let persona = this.personaFor(baseKey);
    if (this.personas.length && !persona) {
      const sel = await this.#handlePersonaSelection(userText, baseKey, sink);
      if (!sel.proceed) return sel.result;
      // 选择人格时若已携带问题，则继续使用该问题，而不是把选项序号「1」发给模型
      userText = sel.text;
      persona = this.personaFor(baseKey);
      if (!persona) return { status: 'awaiting-persona' };
    }

    // 人格确定之后才能算出真正的会话 key（含人格指纹）
    const key = this.keyOf(msg);

    // 同一会话串行，避免上下文错乱
    return this.lock.run(key, async () => {
      const controller = new AbortController();
      this.inflight.set(key, controller);
      const started = this.now();
      try {
        await Promise.resolve(sink.onTyping?.(true)).catch(() => {});
        const messages = this.buildMessages(key, userText, persona);
        const tag = persona ? `［${persona.name}］` : '';
        this.log?.info?.(
          `提问 ← ${who}${tag}：${userText.slice(0, 60)}${userText.length > 60 ? '…' : ''} (≈${estimateTokens(userText)} tokens)`,
        );

        const streamer = this.#makeStreamer(sink);
        const result = await this.client.complete(messages, {
          signal: controller.signal,
          onDelta: streamer.onDelta,
        });

        const finalText = streamer.finish(result.content, result.reasoning);
        await streamer.drain(); // 先让中间态消息送达，再发送正式回复
        if (!finalText.trim()) {
          this.stats.failed += 1;
          await sink.onReply(this.config.bot.errorMessage, { kind: 'error' });
          return { status: 'empty-reply' };
        }

        this.sessions.append(key, userText, finalText);
        await sink.onReply(finalText, {
          kind: 'answer',
          usage: result.usage,
          elapsedMs: this.now() - started,
          asChunks: true,
        });
        this.stats.replied += 1;
        this.log?.info?.(
          `回复 → ${who}：${finalText.slice(0, 60)}${finalText.length > 60 ? '…' : ''} (${this.now() - started}ms, ${result.usage?.total_tokens ?? '?'} tokens)`,
        );
        return { status: 'ok', reply: finalText };
      } catch (err) {
        if (err?.name === 'AbortError') {
          this.log?.info?.(`请求被取消：${who}`);
          return { status: 'aborted' };
        }
        this.stats.failed += 1;
        this.log?.error?.(`处理失败 ${who}：`, err);
        await Promise.resolve(sink.onReply(this.#friendlyError(err), { kind: 'error' })).catch(() => {});
        return { status: 'error', reason: err?.message };
      } finally {
        this.inflight.delete(key);
        await Promise.resolve(sink.onTyping?.(false)).catch(() => {});
      }
    });
  }

  /** 流式转发：按阈值把增量推给宿主（宿主端表现为「正在输入」中间态） */
  #makeStreamer(sink) {
    const minDelta = this.config.behavior.streamMinDelta ?? 60;
    const usePartial = typeof sink.onPartial === 'function' && !!this.config.ai.stream;
    let buffer = '';
    let pushed = 0;
    /** 中间态推送串行链：既保证顺序，也保证能在最终回复前 drain 干净 */
    let chain = Promise.resolve();

    return {
      onDelta: usePartial
        ? (t) => {
            buffer += t;
            if (buffer.length - pushed >= minDelta) {
              pushed = buffer.length;
              const snapshot = buffer;
              chain = chain.then(() => sink.onPartial(snapshot)).catch(() => {});
            }
          }
        : undefined,
      /** 等待所有中间态推送落地（否则中间态可能晚于正式回复到达） */
      drain: () => chain.catch(() => {}),
      finish: (content) => {
        // 流式被中途打断时 content 可能为空，用缓存的增量兜底
        return (content || buffer || '').trim();
      },
    };
  }

  #friendlyError(err) {
    const s = String(err?.message || err);
    if (/401|api key|Authentication/i.test(s)) return '配置有误：DeepSeek API Key 无效或已过期，请联系管理员检查配置。';
    if (/402|Insufficient Balance|余额/i.test(s)) return 'DeepSeek 账户余额不足，暂时无法回答 😢';
    if (/429|rate limit|Too Many/i.test(s)) return '请求过于频繁，请稍后再试～';
    if (/超时|timeout|网络/i.test(s)) return '网络响应较慢，未能及时取得答案，请重新发送 🙏';
    return this.config.bot.errorMessage;
  }

  /** 人格列表文本（带当前项标记） */
  #personaMenu(baseKey, header) {
    const cur = this.personaFor(baseKey);
    return [header, '', formatPersonaList(this.personas, cur?.id ?? null)].join('\n');
  }

  /**
   * 人格选择闸门。以下两种情况会进入该分支：
   *   1. 该聊天从未选择过人格 → 发送菜单，并暂存用户原本的消息
   *   2. 正在等待选择 → 将这条消息作为选择结果解析
   *
   * @returns {{proceed:true, text:string} | {proceed:false, result:object}}
   */
  async #handlePersonaSelection(text, baseKey, sink) {
    const cur = this.personaState.get(baseKey) ?? {};

    // 正在等待选择（或首次发言）：尝试把这条消息作为选择结果解析
    const r = matchPersona(this.personas, text);
    if (r.persona) {
      this.personaState.set(baseKey, { personaId: r.persona.id, awaiting: false, pendingText: null });
      const lines = [];
      if (r.persona.greeting) lines.push(r.persona.greeting);
      lines.push(`已选择「${r.persona.name}」。`);
      await sink.onReply(lines.join('\n'), { kind: 'persona' });
      this.log?.info?.(`人格已选定：${baseKey} → ${r.persona.name}(${r.persona.id})`);

      // 若用户首条消息即为问题，选择完成后直接作答，无需重复提问
      const pending = String(cur.pendingText ?? '').trim();
      if (pending) return { proceed: true, text: pending };
      return { proceed: false, result: { status: 'persona-selected', reply: lines.join('\n') } };
    }

    // 选择无效 → 发送菜单（首次与选择无效均走该分支）
    const first = !cur.awaiting;
    if (first) this.stats.personaAsked += 1;
    this.personaState.set(baseKey, {
      awaiting: true,
      pendingText: first ? String(text ?? '').trim() : cur.pendingText ?? null,
    });
    const header = first
      ? '首次对话，请先选择一个聊天人格：'
      : `没找到「${String(text ?? '').slice(0, 20)}」对应的人格，请回复序号或名字：`;
    const menu = this.#personaMenu(baseKey, header);
    await sink.onReply(menu, { kind: 'persona' });
    this.log?.info?.(`已发送人格选择菜单 → ${baseKey}${first ? '（首次）' : '（重选）'}`);
    return { proceed: false, result: { status: 'awaiting-persona' } };
  }

  async #runCommand(cmd, baseKey) {
    const name = typeof cmd === 'string' ? cmd : cmd?.name;
    const args = typeof cmd === 'string' ? '' : String(cmd?.args ?? '');
    switch (name) {
      case 'reset': {
        // 只清当前人格的上下文（key 带人格指纹，换人格后是另一套历史）
        const key = this.sessionKeyFor(baseKey, this.personaFor(baseKey));
        this.sessions.reset(key);
        this.limiter.reset(baseKey);
        return this.config.bot.resetMessage;
      }
      case 'persona': {
        if (!this.personas.length) {
          return [
            '当前是单人格模式：直接使用 .env 里的 SYSTEM_PROMPT，没有可切换的人格。',
            '',
            '如需切换为多人格：在 personas/ 目录放置 .json 文件（可复制 _template.json 参照填写），然后重载机器人。',
          ].join('\n');
        }
        const cur = this.personaFor(baseKey);
        const q = args.trim();
        if (!q) return this.#personaMenu(baseKey, '可用人格：');
        const r = matchPersona(this.personas, q);
        if (r.persona) {
          this.personaState.set(baseKey, { personaId: r.persona.id, awaiting: false, pendingText: null });
          const lines = [];
          if (r.persona.greeting) lines.push(r.persona.greeting);
          lines.push(`已切换为「${r.persona.name}」。`);
          this.log?.info?.(`人格已切换：${baseKey} → ${r.persona.name}`);
          return lines.join('\n');
        }
        if (r.error === 'ambiguous') {
          const names = (r.matches ?? []).map((p) => p.name).join('、');
          return `「${q}」匹配到多个人格：${names}。请说得更具体一点。`;
        }
        return `没找到「${q}」对应的人格。\n\n${formatPersonaList(this.personas, cur?.id ?? null)}`;
      }
      case 'help':
        return [
          `我是 ${this.personaFor(baseKey)?.name ?? this.config.bot.name}，由 DeepSeek（${this.config.ai.model}）驱动。`,
          '',
          '· 直接发消息即可对话',
          `· ${(this.config.behavior.commands.persona || ['/人格'])[0]} 查看 / 切换人格`,
          `· ${(this.config.behavior.commands.reset || ['/reset'])[0]} 清空上下文`,
          `· ${(this.config.behavior.commands.help || ['/help'])[0]} 查看帮助`,
        ].join('\n');
      default:
        return null;
    }
  }

  /** 用户发送新消息 → 中断上一轮请求，使机器人只处理最新消息 */
  abort(key) {
    const c = this.inflight.get(key);
    if (c) {
      c.abort(new DOMException('superseded', 'AbortError'));
      return true;
    }
    return false;
  }

  /** 定时清理过期会话/限流记录 */
  startHousekeeping(intervalMs = 10 * 60_000) {
    const timer = setInterval(() => {
      const n = this.sessions.sweep();
      this.limiter.sweep();
      if (n) this.log?.debug?.(`清理过期会话 ${n} 个`);
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** 把回复按平台单条长度上限切片 */
  chunkReply(text, maxLen = this.config.behavior.maxReplyChars ?? 1200) {
    const parts = splitText(text, maxLen);
    // 分段时附加序号，便于阅读
    if (parts.length <= 1) return parts;
    return parts.map((p, i) => `(${i + 1}/${parts.length}) ${p}`);
  }
}

export default ChatEngine;
