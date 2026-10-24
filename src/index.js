/**
 * 包入口：对外导出的全部 API。典型用法：
 *
 *   import { bootstrap } from 'llm-qqbot-Svri';
 *   const plugin = await bootstrap({ startWechat: true });   // 启动桥接（当前为 OneBot 11 / QQ）
 */
export { createPlugin, bootstrap, default } from './plugin.js';
export { ChatEngine } from './engine.js';
export { LlmClient, LlmError } from './llm.js';
export { SessionStore, sessionId } from './session.js';
export { RateLimiter, KeyedLock } from './ratelimit.js';
export { OneBotBridge, toNormalizedMessage, segmentsToText, mentionedIds } from './onebot-bridge.js';
export { createBridge } from './bridges.js';
export { loadConfig, validateConfig, describeConfig } from './config.js';
export { loadEnv, parseEnv } from './env.js';
export { splitText, stripMention, isMentioned, estimateTokens } from './text.js';
export { Logger } from './logger.js';
