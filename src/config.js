/**
 * 配置加载：default.json → 用户 config.json → 环境变量（优先级递增）
 */
/**
 * AI 服务商预设。
 *
 * 客户端用的是 OpenAI 兼容的 /chat/completions 协议，所以下面这些服务商
 * 只需换 baseUrl + model + key 就能直接跑，不需要改代码。
 * 若你的服务商不在此表里，用 AI_PROVIDER=openai-compatible 并自己填 AI_BASE_URL / AI_MODEL。
 *
 * balance: 该服务商是否提供可查询的账户余额接口（目前只有 DeepSeek 有）。
 */
export const AI_PRESETS = {
  deepseek:            { baseUrl: 'https://api.deepseek.com',                          model: 'deepseek-chat',               balance: true },
  openai:              { baseUrl: 'https://api.openai.com/v1',                         model: 'gpt-4o-mini',                 balance: false },
  dashscope:           { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',                   balance: false },
  moonshot:            { baseUrl: 'https://api.moonshot.cn/v1',                        model: 'moonshot-v1-8k',              balance: false },
  zhipu:               { baseUrl: 'https://open.bigmodel.cn/api/paas/v4',              model: 'glm-4-flash',                 balance: false },
  siliconflow:         { baseUrl: 'https://api.siliconflow.cn/v1',                     model: 'deepseek-ai/DeepSeek-V3',     balance: false },
  ark:                 { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',          model: '',                            balance: false },
  ollama:              { baseUrl: 'http://127.0.0.1:11434/v1',                         model: 'qwen2.5:7b',                  balance: false },
  lmstudio:            { baseUrl: 'http://127.0.0.1:1234/v1',                          model: '',                            balance: false },
  'openai-compatible': { baseUrl: '',                                                  model: '',                            balance: false },
};

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');

export function deepMerge(base, patch) {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (typeof base !== 'object' || typeof patch !== 'object') return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v);
  return out;
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`配置文件解析失败 ${file}: ${err.message}`);
  }
}

export function toBool(v, dflt = false) {
  if (v === undefined || v === null || v === '') return dflt;
  return /^(1|true|yes|y|on)$/i.test(String(v).trim());
}

export function toNum(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export function toList(v) {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.map(String);
  return String(v)
    .split(/[,，;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {{configFile?:string, env?:Record<string,string|undefined>}} opts
 * @returns {object} 完整配置
 */
export function loadConfig({ configFile = null, env = process.env } = {}) {
  const defaults = readJson(path.join(PROJECT_ROOT, 'config', 'default.json')) ?? {};
  const fileCfg = configFile ? readJson(path.resolve(configFile)) : null;
  let cfg = deepMerge(defaults, fileCfg);

  const e = (k) => env[k];
  const patch = { ai: {}, bot: {}, wechat: {}, behavior: {}, storage: {} };

  // 选服务商：AI_PROVIDER 决定 baseUrl/model 的默认值
  const provider = String(e('AI_PROVIDER') || 'deepseek').toLowerCase();
  patch.ai.provider = provider;
  const preset = AI_PRESETS[provider] || AI_PRESETS['openai-compatible'];

  // 优先级：AI_* > DEEPSEEK_*（向后兼容）> 服务商预设
  const apiKey = e('AI_API_KEY') ?? e('DEEPSEEK_API_KEY');
  if (apiKey) patch.ai.apiKey = apiKey;
  const baseUrl = e('AI_BASE_URL') ?? e('DEEPSEEK_BASE_URL') ?? preset.baseUrl;
  if (baseUrl) patch.ai.baseUrl = baseUrl;
  const model = e('AI_MODEL') ?? e('DEEPSEEK_MODEL') ?? preset.model;
  if (model) patch.ai.model = model;
  // 兼容两种写法：DEEPSEEK_TEMPERATURE 与早期的 TEMPERATURE
  if (e('TEMPERATURE') && !e('DEEPSEEK_TEMPERATURE')) patch.ai.temperature = toNum(e('TEMPERATURE'), 1.0);
  if (e('DEEPSEEK_TEMPERATURE')) patch.ai.temperature = toNum(e('DEEPSEEK_TEMPERATURE'), 1.0);
  if (e('DEEPSEEK_TIMEOUT_MS')) patch.ai.timeoutMs = toNum(e('DEEPSEEK_TIMEOUT_MS'), 60000);
  if (e('DEEPSEEK_STREAM')) patch.ai.stream = toBool(e('DEEPSEEK_STREAM'), true);
  if (e('MAX_TOKENS')) patch.ai.maxTokens = toNum(e('MAX_TOKENS'), 1024);

  if (e('BOT_NAME')) patch.bot.name = e('BOT_NAME');
  if (e('SYSTEM_PROMPT')) patch.bot.systemPrompt = e('SYSTEM_PROMPT');
  if (e('WELCOME_MESSAGE')) patch.bot.welcomeMessage = e('WELCOME_MESSAGE');
  if (e('ERROR_MESSAGE')) patch.bot.errorMessage = e('ERROR_MESSAGE');

  if (e('WECHAT_PUPPET')) patch.wechat.puppet = e('WECHAT_PUPPET');
  if (e('GROUP_REQUIRE_MENTION') !== undefined) patch.wechat.groupRequireMention = toBool(e('GROUP_REQUIRE_MENTION'), true);
  if (e('GROUP_WHITELIST')) patch.wechat.groupWhitelist = toList(e('GROUP_WHITELIST'));
  if (e('ALIAS_WHITELIST')) patch.wechat.aliasWhitelist = toList(e('ALIAS_WHITELIST'));
  if (e('GROUP_CONTEXT')) patch.wechat.groupContext = e('GROUP_CONTEXT');

  // OneBot（QQ）
  if (e('ONEBOT_HTTP_URL')) patch.onebot = { ...(patch.onebot || {}), httpUrl: e('ONEBOT_HTTP_URL') };
  if (e('ONEBOT_WS_URL')) patch.onebot = { ...(patch.onebot || {}), wsUrl: e('ONEBOT_WS_URL') };
  if (e('ONEBOT_ACCESS_TOKEN')) patch.onebot = { ...(patch.onebot || {}), accessToken: e('ONEBOT_ACCESS_TOKEN') };

  if (e('MAX_HISTORY_TURNS')) patch.behavior.maxHistoryTurns = toNum(e('MAX_HISTORY_TURNS'), 8);
  if (e('MAX_HISTORY_TOKENS') !== undefined) patch.behavior.maxHistoryTokens = toNum(e('MAX_HISTORY_TOKENS'), 0);
  if (e('RATE_LIMIT_PER_MINUTE')) patch.behavior.rateLimitPerMinute = toNum(e('RATE_LIMIT_PER_MINUTE'), 10);
  if (e('STREAM_MIN_DELTA')) patch.behavior.streamMinDelta = toNum(e('STREAM_MIN_DELTA'), 60);
  if (e('MAX_REPLY_CHARS')) patch.behavior.maxReplyChars = toNum(e('MAX_REPLY_CHARS'), 1200);
  if (e('GROUP_TRIGGER')) patch.behavior.groupTrigger = String(e('GROUP_TRIGGER')).trim().toLowerCase();
  if (e('BOT_ALIASES')) patch.wechat.mentions = toList(e('BOT_ALIASES'));
  if (e('PERSONA_DIR')) patch.behavior.personasDir = e('PERSONA_DIR');
  // 配置 PERSONA 后跳过人格选择菜单，直接使用该人格（适用于仅使用一个人格的场景）
  if (e('PERSONA')) patch.behavior.defaultPersona = String(e('PERSONA')).trim();

  if (e('DATA_DIR')) patch.storage.dir = e('DATA_DIR');
  if (e('LOG_DIR')) patch.storage.logDir = e('LOG_DIR');
  if (e('LOG_LEVEL')) patch.storage.logLevel = e('LOG_LEVEL');
  // 控制台（WebUI，独立进程，见 bin/webui.js）
  if (e('WEBUI_PORT')) patch.storage.webuiPort = toNum(e('WEBUI_PORT'), 6180);
  if (e('WEBUI_TOKEN')) patch.storage.webuiToken = e('WEBUI_TOKEN');
  if (e('PERSIST_SESSIONS') !== undefined) patch.storage.persistSessions = toBool(e('PERSIST_SESSIONS'), false);
  if (e('SESSION_TTL_MINUTES')) patch.storage.sessionTtlMinutes = toNum(e('SESSION_TTL_MINUTES'), 120);

  cfg = deepMerge(cfg, patch);

  // 相对路径统一解析到项目根目录，避免受 cwd 影响
  for (const key of ['dir', 'logDir']) {
    const p = cfg.storage[key];
    if (p && !path.isAbsolute(p)) cfg.storage[key] = path.resolve(PROJECT_ROOT, p);
  }
  return cfg;
}

/** 启动前校验，返回问题列表 */
export function validateConfig(cfg) {
  const problems = [];
  if (!cfg.ai.apiKey) {
    problems.push('缺少 API Key：请在 .env 设置 AI_API_KEY（旧名 DEEPSEEK_API_KEY 仍兼容）');
  } else if ((cfg.ai.provider || 'deepseek') === 'deepseek' && !/^sk-/.test(cfg.ai.apiKey)) {
    // 只有 DeepSeek 的密钥固定以 sk- 开头；其他服务商格式各不相同，不做假设
    problems.push('DEEPSEEK_API_KEY 不以 sk- 开头，请确认');
  }
  if (!/^https?:\/\//.test(cfg.ai.baseUrl || '')) problems.push('AI_BASE_URL 必须是 http(s) 地址');
  if (!cfg.bot.name) problems.push('BOT_NAME 不能为空');
  if (cfg.behavior.maxHistoryTurns < 0) problems.push('MAX_HISTORY_TURNS 不能为负');
  return problems;
}

/** 打印配置摘要（自动隐藏密钥） */
export function describeConfig(cfg) {
  const mask = (k) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : '（未配置）');
  const kind = String(cfg.wechat.puppet || '').toLowerCase();
  const transport =
    kind === 'onebot' || kind === 'qq' || !kind
      ? `OneBot(QQ)  HTTP=${cfg.onebot?.httpUrl}  WS=${cfg.onebot?.wsUrl}${cfg.onebot?.accessToken ? '  已启用 token' : ''}`
      : `⚠️ 不支持的接入方式「${cfg.wechat.puppet}」——当前仅支持 onebot（QQ）`;
  const trigger = String(cfg.behavior.groupTrigger || '').toLowerCase();
  const triggerText =
    trigger === 'all' || trigger === 'off'
      ? '每条消息均回复'
      : trigger === 'mention' || trigger === 'at'
        ? '必须 @'
        : '@ 或提到名字';

  return [
    `模型        : ${cfg.ai.model}  @ ${cfg.ai.baseUrl}`,
    `API Key     : ${mask(cfg.ai.apiKey)}`,
    `机器人昵称  : ${cfg.bot.name}`,
    `接入方式    : ${transport}`,
    `群聊触发    : ${triggerText}${cfg.wechat.groupWhitelist.length ? `，白名单群 ${cfg.wechat.groupWhitelist.length} 个` : ''}`,
    `记忆轮数    : ${cfg.behavior.maxHistoryTurns} 轮${cfg.storage.persistSessions ? '（落盘保存）' : ''} / 限流 ${cfg.behavior.rateLimitPerMinute || '不限'} 次每分钟`,
    `流式输出    : ${cfg.ai.stream ? '开' : '关'}`,
  ].join('\n');
}

export default loadConfig;
