/**
 * 群聊触发规则的本机验证脚本（不依赖 QQ）。
 *
 *   node tools/verify-trigger.mjs
 *
 * 使用真实的 .env 配置构造引擎，输入各类群聊 / 私聊消息并打印判定结果。
 * DeepSeek 客户端替换为桩实现，不产生任何 API 费用。
 */
import { loadConfig } from '../src/config.js';
import { loadEnv } from '../src/env.js';
import { ChatEngine } from '../src/engine.js';

loadEnv(process.cwd());
const cfg = loadConfig();

// 复现 OneBotBridge.start() 的行为：连接建立后用 get_login_info 返回的真实昵称
// 与 QQ 号注册进 mentions。离线验证时没有桥接，需在此补充，
// 否则以 QQ 昵称称呼机器人会被判定为不触发。
const SIMULATED_BRIDGE = { nickname: '鸽戏孤影', userId: '123456789' };
cfg.wechat.mentions = [
  ...new Set([...(cfg.wechat.mentions ?? []), SIMULATED_BRIDGE.nickname, SIMULATED_BRIDGE.userId].filter(Boolean)),
];

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const fakeClient = {
  usage: { promptTokens: 0, completionTokens: 0, requests: 0, errors: 0 },
  async complete() {
    return { content: '（假回复：验证触发用）', usage: null, model: 'fake' };
  },
  estimateCostCNY: () => 0,
};

const engine = new ChatEngine(cfg, { logger: silent, client: fakeClient });

const names = [...new Set([cfg.bot.name, ...(cfg.wechat.mentions ?? [])].filter(Boolean))];
console.log('=== 当前生效配置 ===');
console.log('  groupTrigger :', cfg.behavior.groupTrigger);
console.log('  识别名单     :', names.join(', '));
console.log('  群白名单     :', cfg.wechat.groupWhitelist.length ? cfg.wechat.groupWhitelist.join(', ') : '(不限)');
console.log('');

const base = { id: 'x', talkerId: 'u1', talkerName: '小王', self: false, botId: 'bot' };
const cases = [
  // [说明, 消息, 期望动作]
  ['群里闲聊（无任何提及）', { text: '大家中午吃什么', roomId: 'r1', roomTopic: 'Ourselves' }, 'ignore'],
  ['群里写名字「小深」', { text: '小深帮我算 1+1', roomId: 'r1', roomTopic: 'Ourselves' }, 'reply'],
  ['群里写 QQ 昵称', { text: '鸽戏孤影在吗', roomId: 'r1', roomTopic: 'Ourselves' }, 'reply'],
  ['群里 @ 机器人', { text: '@鸽戏孤影 你好', roomId: 'r1', roomTopic: 'Ourselves' }, 'reply'],
  ['群里 @ 机器人（换行）', { text: '@小深\u2005讲讲冒泡排序', roomId: 'r1', roomTopic: 'Ourselves' }, 'reply'],
  ['私聊（无提及）', { text: '你好', roomId: null }, 'reply'],
  ['自己发的消息', { text: '小深你好', roomId: 'r1', roomTopic: 'Ourselves', self: true }, 'ignore'],
];

let pass = 0;
for (const [label, msg, want] of cases) {
  const d = engine.decide({ ...base, ...msg });
  const got = d.action;
  const ok = got === want;
  if (ok) pass += 1;
  const detail = [
    d.reason ? `reason=${d.reason}` : '',
    d.text !== undefined && d.text !== '' ? `发给模型="${d.text}"` : '',
    d.command ? `command=${d.command}` : '',
  ]
    .filter(Boolean)
    .join('  ');
  console.log(`${ok ? '✅' : '❌'} ${label.padEnd(22)} -> ${got}${detail ? '  ' + detail : ''}`);
}

console.log('');
console.log(`结果: ${pass}/${cases.length} 符合预期`);
process.exit(pass === cases.length ? 0 : 1);
