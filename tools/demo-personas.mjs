/**
 * 多人格流程演示（不连 QQ、不花 token）。
 *
 *   node tools/demo-personas.mjs
 *
 * 使用真实的 personas/ 配置目录，DeepSeek 客户端替换为桩实现，
 * 因此只展示「选中哪个人格、发给模型的 system prompt 内容、上下文如何隔离」。
 */
import { loadConfig } from '../src/config.js';
import { loadEnv } from '../src/env.js';
import { ChatEngine } from '../src/engine.js';

loadEnv(process.cwd());
const cfg = loadConfig();
cfg.behavior.rateLimitPerMinute = 0;
cfg.storage.logDir = null;
// 演示需从干净状态开始：否则上一次演示选中的人格与上下文会被落盘复用，
// 从而无法观察到「首次对话弹出菜单」这一步。
cfg.storage.persistSessions = false;

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const seen = [];
const fakeClient = {
  usage: { promptTokens: 0, completionTokens: 0, requests: 0, errors: 0 },
  async complete(messages) {
    const sys = messages.find((m) => m.role === 'system');
    const last = messages[messages.length - 1];
    seen.push({ system: sys?.content ?? '(无)', user: last.content, historyCount: messages.length - 2 });
    return { content: `【假回复】收到「${last.content}」`, usage: null, model: 'stub' };
  },
  estimateCostCNY: () => 0,
};

const engine = new ChatEngine(cfg, { logger: silent, client: fakeClient });

function hr(t) {
  console.log(`\n${'─'.repeat(60)}\n${t}\n${'─'.repeat(60)}`);
}

hr('可用人格');
if (!engine.personas.length) {
  console.log('（personas/ 目录里没有可用人格）');
  console.log('复制 _template.json 并去掉文件名开头的下划线，填写内容后重新运行本脚本。');
  process.exit(0);
}
engine.personas.forEach((p, i) => {
  console.log(`  ${i + 1}. ${p.name.padEnd(16)} id=${p.id.padEnd(14)} ${p.description}`);
  console.log(`      ${p.systemPrompt.slice(0, 56)}…`);
});

const talker = { talkerId: 'demo-user', talkerName: '演示用户', roomId: null, botId: 'bot' };
let n = 0;

async function send(text) {
  n += 1;
  const replies = [];
  const result = await engine.handle(
    { id: `m${n}`, self: false, ...talker, text },
    { onReply: async (t, meta) => replies.push({ t, meta }) },
  );
  console.log(`\n👤 ${text}`);
  for (const r of replies) console.log(`🤖 ${r.t.replace(/\n/g, '\n   ')}`);
  if (!replies.length) console.log(`   （无回复，status=${result.status}${result.reason ? ' ' + result.reason : ''}）`);
  return { result, replies };
}

hr('① 首次消息 —— 应先弹出人格菜单，不调用模型');
await send('你好，在吗');
console.log(`\n   模型被调用次数：${seen.length}（应为 0，即未产生模型调用）`);

hr('② 回复序号选择人格 —— 同时补答上一句问题');
await send('1');
const first = seen[seen.length - 1];
if (first) {
  console.log(`\n   实际发给模型的 system：`);
  console.log(`     ${first.system.slice(0, 70)}…`);
  console.log(`   实际发给模型的问题：${JSON.stringify(first.user)}（应为上一句原文，而非「1」）`);
  console.log(`   携带的历史条数：${first.historyCount}（新人格应为 0）`);
}

hr('③ 正常对话');
await send('帮我出个主意');

hr('④ 查看人格列表');
await send('/人格');

const other = engine.personas[1];
if (other) {
  hr(`⑤ 切换到「${other.name}」—— 上下文应为全新`);
  await send(`/人格 ${other.name}`);
  await send('你好');
  const now = seen[seen.length - 1];
  console.log(`\n   切换到新人格后携带的历史条数：${now.historyCount}（应为 0）`);
  console.log(`   system 已换成：${now.system.slice(0, 50)}…`);

  hr('⑥ 切回第一个人格 —— 原有历史应仍保留');
  await send(`/人格 1`);
  await send('接着刚才的聊');
  const back = seen[seen.length - 1];
  console.log(`\n   切回后携带的历史条数：${back.historyCount}（应大于 0，说明历史被保留了）`);
}

hr('汇总');
console.log(`  模型总调用次数：${seen.length}`);
console.log(`  每次调用用的 system prompt（去重）：`);
[...new Set(seen.map((s) => s.system))].forEach((s, i) => console.log(`    ${i + 1}. ${s.slice(0, 60)}…`));
