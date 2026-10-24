/**
 * 会话上下文：按「会话 ID」维护多轮对话历史。
 *
 * 会话 ID 约定：
 *   - 私聊：`c:<联系人id>`
 *   - 群聊：`r:<群id>#<发言人id>`（群里每个人的上下文互相隔离）
 *   - 群共享：`r:<群id>`（groupContext: shared 时使用，全群共用一段上下文）
 */

import fs from 'node:fs';
import { estimateTokens } from './text.js';
import path from 'node:path';

let seq = 0;

export class SessionStore {
  /**
   * @param {{maxTurns?: number, maxTokens?: number, ttlMinutes?: number, persistPath?: string|null}} opts
   *   maxTurns: 保留多少组「用户 + 助手」往返（配置值不设上限）
   *   maxTokens: 历史总 token 预算；0 = 只看轮数。设置该值后即可把轮数调得很大而不超出上下文窗口
   */
  constructor({ maxTurns = 8, maxTokens = 0, ttlMinutes = 120, persistPath = null } = {}) {
    this.maxTurns = Math.max(1, maxTurns);
    // 0 = 不按 token 裁剪。设为非零值可多一层保护：
    // 模型上下文为 1M，超出时 API 直接返回 400，因此轮数调大时必须依靠该预算兜底。
    this.maxTokens = Math.max(0, Number(maxTokens) || 0);
    this.ttlMs = ttlMinutes > 0 ? ttlMinutes * 60_000 : 0;
    this.persistPath = persistPath;
    /** @type {Map<string, {id:string, messages:Array, createdAt:number, updatedAt:number, turns:number}>} */
    this.sessions = new Map();
    if (persistPath) this.#load();
  }

  #load() {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      for (const [k, v] of Object.entries(data.sessions || {})) this.sessions.set(k, v);
    } catch {
      /* 损坏的存档直接忽略 */
    }
  }

  get(id) {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, messages: [], createdAt: Date.now(), updatedAt: Date.now(), turns: 0, seq: ++seq };
      this.sessions.set(id, s);
    }
    if (this.ttlMs && Date.now() - s.updatedAt > this.ttlMs) {
      s.messages = [];
      s.turns = 0;
    }
    return s;
  }

  /** 取出用于请求模型的消息数组（系统提示词由调用方注入在最前） */
  history(id) {
    return this.get(id).messages.slice();
  }

  /**
   * 记录一轮问答。
   * @param {string} id
   * @param {string} userText
   * @param {string} assistantText
   */
  append(id, userText, assistantText) {
    const s = this.get(id);
    s.messages.push({ role: 'user', content: userText });
    if (assistantText) s.messages.push({ role: 'assistant', content: assistantText });
    s.turns += 1;
    s.updatedAt = Date.now();
    this.#trim(s);
    this.#maybeSave();
    return s;
  }

  #trim(s) {
    const keep = this.maxTurns * 2;
    if (s.messages.length > keep) s.messages = s.messages.slice(s.messages.length - keep);

    // 再按 token 预算从最早的开始丢弃（成对丢弃，避免拆散 user/assistant）
    if (this.maxTokens > 0) {
      let total = s.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
      while (total > this.maxTokens && s.messages.length > 2) {
        const dropped = s.messages.splice(0, 2);
        total -= dropped.reduce((n, m) => n + estimateTokens(m.content), 0);
      }
    }
  }

  reset(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.messages = [];
    s.turns = 0;
    s.updatedAt = Date.now();
    this.#maybeSave();
    return true;
  }

  /** 清理过期会话，返回清理数量 */
  sweep() {
    if (!this.ttlMs) return 0;
    const now = Date.now();
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (now - s.updatedAt > this.ttlMs) {
        this.sessions.delete(id);
        n += 1;
      }
    }
    if (n) this.#maybeSave();
    return n;
  }

  stats() {
    return {
      sessions: this.sessions.size,
      messages: [...this.sessions.values()].reduce((a, s) => a + s.messages.length, 0),
    };
  }

  #maybeSave() {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const sessions = {};
      for (const [k, v] of this.sessions) sessions[k] = v;
      fs.writeFileSync(this.persistPath, JSON.stringify({ savedAt: Date.now(), sessions }, null, 2));
    } catch {
      /* 忽略落盘错误 */
    }
  }
}

/**
 * 规范化会话 ID。
 *
 * `personaTag` 是当前人格的指纹。将其并入 ID 用于解决一个具体问题：
 * 会话历史会落盘（persistSessions），更换 SYSTEM_PROMPT 后重启，
 * 旧人格的对话记录会被加载回来——模型看到的上下文里全是旧身份的自我介绍，
 * 于是新人格被压制，机器人仍然自称旧名称。
 * 将人格指纹放入 key 后，更换人格等同于开启一个全新会话，旧历史自然不会命中。
 */
export function sessionId({ roomId = null, talkerId, groupContext = 'per-user', personaTag = null }) {
  const tag = personaTag ? `@${personaTag}` : '';
  if (roomId) {
    return groupContext === 'shared'
      ? `r:${roomId}${tag}`
      : `r:${roomId}#${talkerId}${tag}`;
  }
  return `c:${talkerId}${tag}`;
}

/** 由人格文本计算短指纹（无需密码学强度，只需内容变化时结果不同） */
export function personaFingerprint(systemPrompt = '') {
  const s = String(systemPrompt ?? '');
  if (!s) return null;
  let h = 0x811c9dc5; // FNV-1a 32bit
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).slice(0, 6);
}

export default SessionStore;
