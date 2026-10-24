/**
 * 插件对外接口：把「大模型对话能力」注册到宿主（OneBot 桥接 / 自研机器人框架 / 测试用例）上。
 *
 * 宿主需提供两类能力：
 *   1. 消息来源：调用 plugin.handleMessage(msg, sink) 或 plugin.attach(host)，由宿主推送消息
 *   2. 发送能力：sink.onReply(text, meta) —— 由宿主决定发送渠道（QQ / WebSocket / 控制台）
 *
 * 这样同一份对话逻辑既能跑在 QQ 上，也能在没有后端的环境里被完整测试。
 */
import { ChatEngine } from './engine.js';
import { loadConfig, validateConfig } from './config.js';
import Logger from './logger.js';
import { stripMention, isMentioned } from './text.js';

export function createPlugin(config, deps = {}) {
  const cfg = config;
  const log = deps.logger ?? new Logger({ level: cfg.storage.logLevel, dir: cfg.storage.logDir, name: 'llm-qqbot-svri' });
  const engine = new ChatEngine(cfg, { logger: log, client: deps.client, now: deps.now });

  // 启动时先报告配置问题而不直接抛错，允许先启动再修正 key
  const problems = validateConfig(cfg);
  for (const p of problems) log.warn(`配置检查：${p}`);

  const plugin = {
    name: 'llm-qqbot-svri',
    version: '0.2.0',
    config: cfg,
    logger: log,
    engine,
    started: false,
    /** @type {object|null} */
    bridge: null,
    /** @type {Array<() => void>} */
    disposers: [],

    /**
     * 处理一条规范化消息。
     * @param {{text:string, talkerId:string, talkerName?:string, roomId?:string|null, roomTopic?:string|null,
     *          self?:boolean, botId?:string|null, id?:string}} msg
     * @param {{onReply:(text:string, meta?:object)=>any, onTyping?:(on:boolean)=>any, onPartial?:(t:string)=>any}} sink
     */
    async handleMessage(msg, sink) {
      if (!sink || typeof sink.onReply !== 'function') {
        throw new Error('handleMessage 需要一个至少包含 onReply 的 sink');
      }
      const normalized = {
        id: msg.id ?? `local-${Date.now()}`,
        text: String(msg.text ?? ''),
        talkerId: msg.talkerId ?? 'unknown',
        talkerName: msg.talkerName ?? msg.talkerId ?? 'unknown',
        roomId: msg.roomId ?? null,
        roomTopic: msg.roomTopic ?? null,
        self: !!msg.self,
        botId: msg.botId ?? null,
        date: msg.date ?? new Date(),
        raw: msg.raw ?? null,
      };
      return engine.handle(normalized, sink);
    },

    /**
     * 把插件挂到宿主的事件总线上（可选便捷方式）。
     * 支持：
     *   host.on('message', handler) / host.onMessage(handler) / host.bus.on(...)
     *   host.sendMessage(target, text) 或 host.say(text)
     */
    attach(host = {}) {
      const subscribe =
        typeof host.on === 'function'
          ? (h) => host.on('message', h)
          : typeof host.onMessage === 'function'
            ? (h) => host.onMessage(h)
            : typeof host.bus?.on === 'function'
              ? (h) => host.bus.on('message', h)
              : null;
      if (!subscribe) throw new Error('宿主未提供 on/onMessage/bus.on，无法 attach');

      const off = subscribe(async (msg) => {
        const send = async (text) => {
          const parts = engine.chunkReply(text, cfg.behavior.maxReplyChars);
          for (const p of parts) {
            if (typeof host.sendMessage === 'function') await host.sendMessage(msg, p);
            else if (typeof host.say === 'function') await host.say(p);
            else throw new Error('宿主未提供 sendMessage/say');
          }
        };
        await plugin.handleMessage(msg, { onReply: (t) => send(t) });
      });
      if (typeof off === 'function') plugin.disposers.push(off);
      return plugin;
    },

    /**
     * 启动接入（当前只支持 OneBot 11 / QQ，见 bridges.js）。
     * @param {{onQrCode?:Function, onLogin?:Function, onLogout?:Function, onError?:Function}} hooks
     */
    async start(hooks = {}) {
      if (plugin.started) return plugin.bridge;
      const { createBridge } = await import('./bridges.js');
      const bridge = await createBridge(cfg, { engine, logger: log });
      plugin.bridge = bridge;
      const stopHousekeeping = engine.startHousekeeping();
      plugin.disposers.push(stopHousekeeping);

      await bridge.start(hooks);
      plugin.started = true;

      const welcome = cfg.bot.welcomeMessage?.replace('{botName}', cfg.bot.name);
      if (welcome && cfg.behavior.sendWelcomeToSelf !== false && bridge.bot?.say) {
        // 仅实现了 say() 的桥接支持向自身发送确认消息；OneBot 桥接不具备该能力
        try {
          await bridge.bot.say(welcome);
        } catch {
          /* 部分接入方式不支持向自身发送消息 */
        }
      }
      return bridge;
    },

    async stop() {
      while (plugin.disposers.length) {
        try {
          plugin.disposers.pop()();
        } catch {
          /* ignore */
        }
      }
      await plugin.bridge?.stop();
      plugin.started = false;
    },

    /** 供外部检查状态 */
    status() {
      return {
        started: plugin.started,
        config: {
          model: cfg.ai.model,
          botName: cfg.bot.name,
          groupRequireMention: cfg.wechat.groupRequireMention,
        },
        engine: engine.stats,
        usage: engine.client.usage,
        costCNY: Number(engine.client.estimateCostCNY().toFixed(4)),
        sessions: engine.sessions.stats(),
        bridge: plugin.bridge?.status?.() ?? null,
      };
    },

    /** 重置某个会话的上下文 */
    resetSession(key) {
      return engine.sessions.reset(key);
    },

    /** 清空所有会话 */
    clearAllSessions() {
      const n = engine.sessions.sessions.size;
      engine.sessions.sessions.clear();
      return n;
    },

    // 供上层做自定义判断
    helpers: { stripMention, isMentioned },
  };

  return plugin;
}

/** 快捷入口：读环境变量 → 建插件 → （可选）启动桥接 */
export async function bootstrap({ configFile = null, env = process.env, startWechat = false } = {}) {
  const cfg = loadConfig({ configFile, env });
  const plugin = createPlugin(cfg);
  if (startWechat) await plugin.start();
  return plugin;
}

export default createPlugin;
