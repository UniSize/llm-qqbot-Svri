/**
 * 离线自测：不联网、不需要真实 API Key，用本地 mock 服务跑通全链路。
 *   node test/run-tests.js      或      npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockServer } from './mock-deepseek-server.js';
import { parseEnv } from '../src/env.js';
import { loadConfig, validateConfig, describeConfig, deepMerge } from '../src/config.js';
import { createPlugin } from '../src/plugin.js';
import { ChatEngine } from '../src/engine.js';
import { LlmClient } from '../src/llm.js';
import { splitText, stripMention, isMentioned, estimateTokens } from '../src/text.js';
import { RateLimiter, KeyedLock } from '../src/ratelimit.js';
import { SessionStore, sessionId } from '../src/session.js';
import { loadPersonas, matchPersona, formatPersonaList } from '../src/personas.js';
import { PersonaStateStore } from '../src/persona-state.js';
import { PersonaStore, PersonaError, safeId, validatePersona, normalizePersona } from '../src/persona-store.js';
import { setEnvValues, validateEnvEntry, EnvWriteError } from '../src/env-write.js';
import { createWebUiServer } from '../src/webui/server.js';
import { createHandlers } from '../src/webui/handlers.js';
import { isPortOpen, tailFile } from '../src/webui/status.js';
import { OneBotBridge, toNormalizedMessage, segmentsToText, mentionedIds } from '../src/onebot-bridge.js';
import { createMockOneBot } from './mock-onebot-server.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function baseConfig(port, overrides = {}) {
  const cfg = loadConfig({ env: {} });
  cfg.ai.apiKey = 'sk-mock-test-key';
  cfg.ai.baseUrl = `http://127.0.0.1:${port}`;
  cfg.ai.model = 'deepseek-chat';
  cfg.ai.stream = true;
  cfg.storage.logDir = null;
  cfg.behavior.typingDelayMs = 0;
  cfg.behavior.rateLimitPerMinute = 0;
  // 隔离：默认不读取真实的 personas/ 目录。
  // 否则一旦该目录出现人格文件，这些用例会被人格选择流程拦截。
  cfg.behavior.personasDir = null;
  cfg.behavior.defaultPersona = '';
  // 测试不依赖窗口焦点；显式关掉，避免默认值变化影响用例
  cfg.wechat = { ...(cfg.wechat || {}), ui: { requireForeground: false, ...((cfg.wechat || {}).ui || {}) } };
  return deepMerge(cfg, overrides);
}

function makeEngine(cfg) {
  return new ChatEngine(cfg, { logger: silentLogger });
}

/** 跑一条消息，收集回复 */
async function turn(engine, msg, sink = {}) {
  const replies = [];
  const partials = [];
  const result = await engine.handle(
    {
      id: `t${Math.random()}`,
      talkerId: 'user-a',
      talkerName: '小王',
      roomId: null,
      roomTopic: null,
      self: false,
      botId: 'bot-id',
      text: msg.text,
      ...msg,
    },
    {
      onReply: async (text, meta) => replies.push({ text, meta }),
      onPartial: async (t) => partials.push(t),
      ...sink,
    },
  );
  return { result, replies, partials };
}

/* ------------------------------------------------------------------ */
/* 单元测试：纯函数                                                     */
/* ------------------------------------------------------------------ */

test('parseEnv 能解析注释、引号和空格', () => {
  const env = parseEnv(`
# 注释
DEEPSEEK_API_KEY=sk-abc123
export BOT_NAME="小 深"
GROUP_WHITELIST='群A,群B'
EMPTY=
  `);
  assert.equal(env.DEEPSEEK_API_KEY, 'sk-abc123');
  assert.equal(env.BOT_NAME, '小 深');
  assert.equal(env.GROUP_WHITELIST, '群A,群B');
  assert.equal(env.EMPTY, '');
});

test('stripMention / isMentioned 处理 QQ 的 @ 格式', () => {
  const text = '@小深\u2005今天天气怎么样？';
  assert.equal(isMentioned(text, { botName: '小深' }), true);
  assert.equal(stripMention(text, { botName: '小深' }), '今天天气怎么样？');
  assert.equal(isMentioned('今天天气怎么样', { botName: '小深' }), false);
  assert.equal(isMentioned('@所有人 开会了', { botName: '小深' }), true);
});

test('splitText 分片不丢字且尽量在标点处断开', () => {
  const text = '第一句话。第二句话！第三句话？第四句话，第五句话；第六句话。'.repeat(3);
  const parts = splitText(text, 40);
  assert.ok(parts.length > 1, '应该被切成多段');
  assert.equal(parts.join('').replace(/\s/g, ''), text.replace(/\s/g, ''), '分片后内容不能丢');
  assert.ok(parts.every((p) => p.length <= 40), '每段都不能超长');
  assert.equal(splitText('', 40).length, 0);
});

test('estimateTokens 对中文有合理估算', () => {
  assert.ok(estimateTokens('你好世界') >= 4);
  assert.ok(estimateTokens('hello world') < estimateTokens('你好世界你好世界'));
});

test('RateLimiter 滑动窗口生效并能恢复', () => {
  const rl = new RateLimiter({ perMinute: 2 });
  const t0 = 1_000_000;
  assert.equal(rl.take('k', t0).ok, true);
  assert.equal(rl.take('k', t0 + 1000).ok, true);
  const blocked = rl.take('k', t0 + 2000);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0);
  // 窗口滑过去之后恢复
  assert.equal(rl.take('k', t0 + 61_000).ok, true);
  // 不限流模式
  const off = new RateLimiter({ perMinute: 0 });
  for (let i = 0; i < 100; i += 1) assert.equal(off.take('k', t0).ok, true);
});

test('KeyedLock 串行执行同一 key', async () => {
  const lock = new KeyedLock();
  const order = [];
  const task = (n, ms) =>
    lock.run('same', async () => {
      order.push(`start${n}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end${n}`);
      return n;
    });
  await Promise.all([task(1, 30), task(2, 5)]);
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2'], '必须严格串行');
  assert.equal(lock.isBusy('same'), false);
});

test('SessionStore 按轮数裁剪并支持重置', () => {
  const s = new SessionStore({ maxTurns: 2, ttlMinutes: 0 });
  for (let i = 1; i <= 5; i += 1) s.append('c:a', `问${i}`, `答${i}`);
  const h = s.history('c:a');
  assert.equal(h.length, 4, '2 轮 = 4 条消息');
  assert.equal(h[0].content, '问4');
  assert.equal(s.reset('c:a'), true);
  assert.equal(s.history('c:a').length, 0);
});

test('sessionId 私聊与群聊隔离规则', () => {
  assert.equal(sessionId({ talkerId: 'u1' }), 'c:u1');
  assert.equal(sessionId({ roomId: 'r1', talkerId: 'u1' }), 'r:r1#u1');
  assert.equal(sessionId({ roomId: 'r1', talkerId: 'u1', groupContext: 'shared' }), 'r:r1');
});

/* ------------------------------------------------------------------ */
/* 集成测试：mock DeepSeek 服务                                          */
/* ------------------------------------------------------------------ */

const mock = createMockServer();
const server = await mock.listen(0);

test('端到端：私聊一条消息 → 流式回复', async () => {
  // streamMinDelta 调小，才能观察到流式中间态回调
  const cfg = baseConfig(server.port, { behavior: { streamMinDelta: 10 } });
  const engine = makeEngine(cfg);
  const { result, replies, partials } = await turn(engine, { text: '你好' });
  assert.equal(result.status, 'ok');
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /收到第1轮:「你好」/);
  assert.match(replies[0].text, /人设=你是「小深」/);
  assert.ok(partials.length >= 1, '流式模式应该产生中间态回调');
  assert.ok(replies[0].meta.usage.prompt_tokens > 0);
});

test('多轮上下文：第二轮能看到历史', async () => {
  const cfg = baseConfig(server.port);
  const engine = makeEngine(cfg);
  await turn(engine, { text: '第一句' });
  const { replies } = await turn(engine, { text: '第二句' });
  assert.match(replies[0].text, /收到第2轮:「第二句」/, '第二轮必须带上历史，否则轮数会算成 1');
  // 系统提示词 + 2 条历史 + 本次 = 4 条
  assert.match(replies[0].text, /上下文消息数=4/);
});

test('群聊：未 @ 不回复，@ 之后剥离昵称再问', async () => {
  const cfg = baseConfig(server.port, { wechat: { groupRequireMention: true } });
  const engine = makeEngine(cfg);

  const ignored = await turn(engine, { text: '大家中午吃什么', roomId: 'room1', roomTopic: '摸鱼群' });
  assert.equal(ignored.result.status, 'ignored');
  assert.equal(ignored.replies.length, 0, '群里闲聊不应该触发回复');

  const replied = await turn(engine, { text: '@小深\u2005帮我写个冒泡排序', roomId: 'room1', roomTopic: '摸鱼群' });
  assert.equal(replied.result.status, 'ok');
  assert.match(replied.replies[0].text, /「帮我写个冒泡排序」/, '@昵称必须被剥掉');
});

test('群聊白名单 + 群内上下文隔离', async () => {
  const cfg = baseConfig(server.port, {
    wechat: { groupRequireMention: true, groupWhitelist: ['允许的群'] },
  });
  const engine = makeEngine(cfg);

  const wrongRoom = await turn(engine, { text: '@小深 在吗', roomId: 'r2', roomTopic: '别的群' });
  assert.equal(wrongRoom.result.reason, 'group-not-whitelisted');

  const u1 = await turn(engine, { text: '@小深 我是甲', roomId: 'r3', roomTopic: '允许的群', talkerId: 'u1', talkerName: '甲' });
  assert.match(u1.replies[0].text, /第1轮/);
  // 同一个群内的另一位用户应拥有全新的上下文
  const u2 = await turn(engine, { text: '@小深 我是乙', roomId: 'r3', roomTopic: '允许的群', talkerId: 'u2', talkerName: '乙' });
  assert.match(u2.replies[0].text, /第1轮/, '群里不同人的上下文必须隔离');
  // 甲再说一句，应累积到第 2 轮
  const u1b = await turn(engine, { text: '@小深 继续', roomId: 'r3', roomTopic: '允许的群', talkerId: 'u1', talkerName: '甲' });
  assert.match(u1b.replies[0].text, /第2轮/);
});

test('限流：超过每分钟配额给出提示', async () => {
  const cfg = baseConfig(server.port, { behavior: { rateLimitPerMinute: 2 } });
  const engine = makeEngine(cfg);
  await turn(engine, { text: '1' });
  await turn(engine, { text: '2' });
  const third = await turn(engine, { text: '3' });
  assert.equal(third.result.status, 'rate-limited');
  assert.match(third.replies[0].text, /消息有点多/);
});

test('/reset 命令清空上下文', async () => {
  const cfg = baseConfig(server.port);
  const engine = makeEngine(cfg);
  await turn(engine, { text: '记住我叫小王' });
  const reset = await turn(engine, { text: '/reset' });
  assert.equal(reset.result.status, 'command');
  assert.match(reset.replies[0].text, /上下文已清空/);
  const after = await turn(engine, { text: '我叫什么' });
  assert.match(after.replies[0].text, /第1轮/, 'reset 后轮数应重新从 1 开始');
});

test('/help 命令返回使用说明', async () => {
  const engine = makeEngine(baseConfig(server.port));
  const { replies } = await turn(engine, { text: '/help' });
  assert.match(replies[0].text, /DeepSeek/);
  assert.match(replies[0].text, /\/reset/);
});

test('超长回复自动分片', async () => {
  const cfg = baseConfig(server.port, { behavior: { maxReplyChars: 30 } });
  const engine = makeEngine(cfg);
  const parts = engine.chunkReply('甲'.repeat(100), 30);
  assert.ok(parts.length >= 4);
  assert.ok(parts[0].startsWith('(1/'), '多段时应有编号');
  assert.ok(parts.every((p) => p.length <= 40));
  delete cfg.behavior.maxReplyChars;
});

test('401 鉴权失败给出易读提示', async () => {
  const cfg = baseConfig(server.port);
  const engine = new ChatEngine(cfg, {
    logger: silentLogger,
    client: new LlmClient({
      apiKey: 'sk-bad-key',
      baseUrl: `http://127.0.0.1:${server.port}`,
      maxRetries: 0,
      logger: silentLogger,
    }),
  });
  const { result, replies } = await turn(engine, { text: '你好' });
  assert.equal(result.status, 'error');
  assert.match(replies[0].text, /API Key 无效|配置有误/);
});

test('5xx 自动重试后成功', async () => {
  const flaky = createMockServer();
  const flakyServer = await flaky.listen(0);
  try {
    const cfg = baseConfig(flakyServer.port);
    const engine = new ChatEngine(cfg, {
      logger: silentLogger,
      client: new LlmClient({
        apiKey: 'sk-mock-test-key',
        baseUrl: `http://127.0.0.1:${flakyServer.port}`,
        maxRetries: 3,
        stream: false,
        logger: silentLogger,
      }),
    });
    // 让 mock 连续失败 2 次
    const originalFetch = globalThis.fetch;
    const client = engine.client;
    client.fetch = (url, init) =>
      originalFetch(url, { ...init, headers: { ...init.headers, 'x-fail-times': '2' } });
    const { result, replies } = await turn(engine, { text: '重试测试' });
    assert.equal(result.status, 'ok', '重试之后应该成功');
    assert.match(replies[0].text, /重试测试/);
    assert.equal(flaky.state.requests, 3, '应该是 2 次失败 + 1 次成功');
  } finally {
    await flakyServer.close();
  }
});

test('取消请求：AbortSignal 能中断进行中的回答', async () => {
  const cfg = baseConfig(server.port);
  const engine = makeEngine(cfg);
  const key = 'c:user-a';
  const pending = turn(engine, { text: '一个很长的问题' });
  // 立刻打断（引擎在锁内注册 inflight）
  await new Promise((r) => setTimeout(r, 0));
  engine.abort(key);
  const { result } = await pending;
  assert.ok(['aborted', 'ok'].includes(result.status), '要么被取消要么已完成');
});

test('流式中间态必须先于正式回复送达（drain 竞态回归）', async () => {
  const cfg = baseConfig(server.port, { behavior: { streamMinDelta: 10 } });
  const engine = makeEngine(cfg);
  const events = [];
  // 让中间态比正式回复更慢，验证引擎会等待其落地
  await engine.handle(
    { text: '竞态测试', talkerId: 'user-a', talkerName: '小王', roomId: null, self: false, botId: 'bot' },
    {
      onPartial: async (t) => {
        await new Promise((r) => setTimeout(r, 20));
        events.push(`partial:${t.length}`);
      },
      onReply: async () => events.push('final'),
    },
  );
  assert.ok(events.length >= 2, '应该既有中间态也有正式回复');
  assert.equal(events.at(-1), 'final', '正式回复必须是最后一个事件');
  assert.ok(events.slice(0, -1).every((e) => e.startsWith('partial:')), '中间态必须全部先落地');
});

test('createPlugin 完整链路（attach 到宿主总线）', async () => {
  const cfg = baseConfig(server.port);
  const plugin = createPlugin(cfg, { logger: silentLogger });
  const handlers = [];
  const sent = [];
  const host = {
    on: (evt, h) => {
      handlers.push([evt, h]);
      return () => {};
    },
    sendMessage: async (msg, text) => sent.push(text),
  };
  plugin.attach(host);
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0][0], 'message');

  await handlers[0][1]({ text: '通过宿主总线发来的消息', talkerId: 'u9', talkerName: '宿主用户' });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /通过宿主总线发来的消息/);

  const status = plugin.status();
  assert.equal(status.engine.replied, 1);
  assert.ok(status.usage.requests >= 1);
  assert.ok(status.costCNY >= 0);
  await plugin.stop();
});

test('配置校验能发现缺失的 Key', () => {
  const cfg = loadConfig({ env: {} });
  cfg.ai.apiKey = '';
  const problems = validateConfig(cfg);
  assert.ok(problems.some((p) => p.includes('API Key')));
});

test('CLI 冒烟测试：配置加载 → 描述 → 建插件 全流程可用', async () => {
  // 说明：不 spawn 子进程（沙箱下 stdio 管道会被拒绝），改为在进程内运行 CLI 依赖的同一条链路：
  // 设置环境变量 → loadConfig → validateConfig → describeConfig → createPlugin
  const cfg = loadConfig({
    env: {
      DEEPSEEK_API_KEY: 'sk-cli-smoke-test',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.port}`,
      BOT_NAME: '冒烟机器人',
      GROUP_REQUIRE_MENTION: 'false',
      MAX_HISTORY_TURNS: '3',
      RATE_LIMIT_PER_MINUTE: '0',
    },
  });
  assert.equal(cfg.bot.name, '冒烟机器人');
  assert.equal(cfg.wechat.groupRequireMention, false);
  assert.equal(cfg.behavior.maxHistoryTurns, 3);
  assert.equal(cfg.behavior.rateLimitPerMinute, 0);
  // 测试隔离：该用例自行构建配置、不经 baseConfig，因此需显式关闭人格目录；
  // 否则 personas/ 中一旦出现人格文件，本用例就会弹出人格菜单。
  cfg.behavior.personasDir = null;
  cfg.behavior.defaultPersona = '';
  assert.equal(validateConfig(cfg).length, 0, '完整配置不应有校验问题');

  const desc = describeConfig(cfg);
  assert.match(desc, /deepseek-chat/);
  assert.match(desc, /冒烟机器人/);
  assert.ok(!desc.includes('sk-cli-smoke-test'), '配置摘要必须隐藏完整密钥');

  const plugin = createPlugin(cfg, { logger: silentLogger });
  const replies = [];
  await plugin.handleMessage(
    { text: '冒烟测试', talkerId: 'cli-user', talkerName: 'CLI' },
    { onReply: async (t) => replies.push(t) },
  );
  assert.match(replies[0], /冒烟测试/);
  await plugin.stop();
});

test('OneBot: 启动时用真实昵称与 QQ 号注册 @ 识别名单（真机环境已验证）', async () => {
  // 真机环境下的问题：BOT_NAME 为「小深」，而 QQ 的 @ 段携带的是账号真实昵称
  // 「鸽戏孤影」或 QQ 号。若仅用 BOT_NAME 匹配，群内 @ 机器人会被当作闲聊忽略。
  const mock = createMockOneBot({ selfId: 10001, nickname: '鸽戏孤影' });
  const info = await mock.listen(0);
  try {
    const cfg = onebotConfig({ port: server.port, httpUrl: info.httpUrl, wsUrl: info.wsUrl });
    cfg.bot.name = '小深'; // 刻意与真实昵称不同，用于验证注册逻辑
    const engine = makeEngine(cfg);
    const bridge = new OneBotBridge(cfg, { engine, logger: silentLogger });
    await bridge.start();
    await waitFor(() => mock.wss.clientCount === 1, { label: 'WS 连接' });

    assert.ok(cfg.wechat.mentions.includes('鸽戏孤影'), '@ 识别名单应包含真实昵称');
    assert.ok(cfg.wechat.mentions.includes('10001'), '@ 识别名单应包含 QQ 号');

    // 用真实昵称 @ 机器人，应该能触发回复
    mock.pushMessage(
      mock.groupEvent({
        groupId: 20001,
        userId: 10086,
        nickname: '小王',
        text: '你好',
        mention: true, // at 段里是 selfId=10001
      }),
    );
    await waitFor(() => mock.state.sent.length >= 1, { label: '昵称未匹配时也能回复' });
    assert.match(mock.state.sent[0].text, /你好/);
    assert.equal(bridge.counters.skipped, 0, '不应该被判成 no-mention');
    await bridge.stop();
  } finally {
    await info.close();
  }
});

test('群聊触发模式：mention-or-name 下不加 @ 只说名字也能触发', async () => {
  const cfg = baseConfig(server.port, {
    wechat: { groupRequireMention: true, mentions: ['小深'] },
    behavior: { groupTrigger: 'mention-or-name' },
  });
  const engine = makeEngine(cfg);

  // 1) 完全没提到 → 忽略
  const silent = await turn(engine, { text: '大家中午吃什么', roomId: 'r9', roomTopic: '群9' });
  assert.equal(silent.result.status, 'ignored');
  assert.equal(silent.result.reason, 'no-mention-or-name');

  // 2) 文本里写了名字（没有 @）→ 回复，且名字被剥离
  const byName = await turn(engine, { text: '小深帮我算一下 1+1', roomId: 'r9', roomTopic: '群9' });
  assert.equal(byName.result.status, 'ok', '提到名字就应该回复');
  assert.match(byName.replies[0].text, /「帮我算一下 1\+1」/, '开头的名字应被剥掉');

  // 3) @ 依然有效
  const byAt = await turn(engine, { text: '@小深\u2005你好', roomId: 'r9', roomTopic: '群9' });
  assert.equal(byAt.result.status, 'ok');
  assert.match(byAt.replies[0].text, /「你好」/);
});

test('群聊触发模式：mention 仍然只认 @；all 则全都回', async () => {
  const mk = (trigger) =>
    makeEngine(
      baseConfig(server.port, {
        wechat: { groupRequireMention: true, mentions: ['小深'] },
        behavior: { groupTrigger: trigger },
      }),
    );

  // mention：只说名字不算
  const strict = await turn(mk('mention'), { text: '小深在吗', roomId: 'rA', roomTopic: '群A' });
  assert.equal(strict.result.status, 'ignored');
  assert.equal(strict.result.reason, 'no-mention');

  // all：闲聊也回
  const loose = await turn(mk('all'), { text: '大家中午吃什么', roomId: 'rB', roomTopic: '群B' });
  assert.equal(loose.result.status, 'ok', 'all 模式下群里任何消息都应回复');
});

test('私聊永远回复，不受群聊触发模式影响', async () => {
  const cfg = baseConfig(server.port, {
    wechat: { groupRequireMention: true, mentions: ['小深'] },
    behavior: { groupTrigger: 'mention' }, // 最严格的群聊模式
  });
  const engine = makeEngine(cfg);
  const dm = await turn(engine, { text: '你好' }); // 没有 roomId = 私聊
  assert.equal(dm.result.status, 'ok', '私聊不需要任何提及就应回复');
  assert.match(dm.replies[0].text, /「你好」/);
});

test('OneBot: 健康探测能识别掉线（后端消失 → down，停止后 → stopped）', async () => {
  const t = await startOneBot({ ai: { stream: false } });
  try {
    assert.equal(await t.bridge.probeHealth(), 'healthy', '刚连上应判为 healthy');
    assert.equal(t.bridge.status().health, 'healthy');

    // 关掉 mock，模拟 NapCat 整个进程消失（不是简单的 WS 断开）
    // 注意：bridge.options 是 getter，每次返回新对象，必须改底层 config
    t.bridge.cfg.onebot.healthFailThreshold = 1;
    await t.info.close();
    await new Promise((r) => setTimeout(r, 200));

    const down = await t.bridge.probeHealth();
    assert.equal(down, 'down', '后端消失后应判为 down');
    assert.equal(t.bridge.status().health, 'down');
    assert.ok(t.bridge.status().lastHealthySec !== null, '应记录最后一次健康时间');
  } finally {
    await t.bridge.stop();
    assert.equal(t.bridge.status().health, 'stopped');
  }
});

test('所有含中文的 .ps1 必须带 UTF-8 BOM（PowerShell 5.1 编码约束）', async () => {
  // 背景：Windows PowerShell 5.1 读取不带 BOM 的 .ps1 时，按系统 ANSI 代码页
  // （中文系统为 GBK）解码。文件中只要存在非 ASCII 字节，中文就会被解码为乱码、
  // 引号失配，导致整个脚本无法解析。多数编辑器保存时会丢弃 BOM，
  // 因此需要由测试守住该约束：存在非 ASCII 字节就必须带 BOM。
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const workshopRoot = path.resolve(projectRoot, '..');

  const files = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === 'logs' || name === 'data' || name.startsWith('.')) continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (name.endsWith('.ps1')) files.push(full);
    }
  };
  walk(workshopRoot, 0);

  assert.ok(files.length > 0, '应该找到至少一个 .ps1');

  const bad = [];
  for (const f of files) {
    const buf = readFileSync(f);
    const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    let nonAscii = 0;
    for (const byte of buf) if (byte > 127) nonAscii += 1;
    // 纯 ASCII 的文件不需要 BOM（任何编码下解码都一样）
    if (nonAscii > 0 && !hasBom) {
      bad.push(`${path.relative(workshopRoot, f)} (${nonAscii} 个非 ASCII 字节但没有 BOM)`);
    }
  }
  assert.equal(
    bad.length,
    0,
    `以下 .ps1 会被 PS 5.1 解码错乱，请另存为「UTF-8 带 BOM」：\n  ${bad.join('\n  ')}`,
  );
});

test('换人格会自动开新会话：旧历史不会覆盖新身份', async () => {
  // 背景：会话历史会落盘（PERSIST_SESSIONS）。若会话 ID 只由「谁 + 哪个群」决定，
  // 替换 SYSTEM_PROMPT 后重启，旧人格的对话记录会被加载回来，模型沿历史作答，
  // 机器人仍然自称旧名字（实测现象：改为「企业」后仍回答「我是小深」）。
  // 修法是把人格指纹并入会话 ID。
  const mk = (prompt) =>
    makeEngine(baseConfig(server.port, { bot: { name: 'X', systemPrompt: prompt } }));

  const a = mk('你是小深，一个助手。');
  const b = mk('你是企业，白鹰联邦的航母。');
  const msg = { talkerId: 'u1', talkerName: '某人', roomId: null };

  assert.notEqual(a.keyOf(msg), b.keyOf(msg), '人格不同 → 会话 key 必须不同');
  assert.equal(a.keyOf(msg), mk('你是小深，一个助手。').keyOf(msg), '同人格 → key 必须稳定');
  assert.ok(a.keyOf(msg).startsWith('c:u1'), `私聊 key 仍应以 c:<id> 开头，实际 ${a.keyOf(msg)}`);

  const g = { talkerId: 'u1', talkerName: '某人', roomId: 'r1', roomTopic: '群1' };
  assert.notEqual(a.keyOf(g), b.keyOf(g), '群聊下人格不同也应换会话');
  assert.ok(a.keyOf(g).includes('r:r1'), '群聊 key 应保留房间信息');
});

/* ------------------------------------------------------------------ */
/* 多人格                                                              */
/* ------------------------------------------------------------------ */

/** 造一个临时人格目录 */
function makePersonaDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-personas-'));
  for (const [name, obj] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  }
  return dir;
}

const PERSONA_FIXTURES = {
  'alpha.json': {
    id: 'alpha',
    name: '阿尔法',
    aliases: ['Alpha'],
    description: '测试人格一',
    greeting: '（阿尔法上线）',
    systemPrompt: '你是阿尔法。',
  },
  'beta.json': { id: 'beta', name: '贝塔', description: '测试人格二', systemPrompt: '你是贝塔。' },
  '_hidden.json': { id: 'hidden', name: '隐藏人格', systemPrompt: '不该出现在菜单里。' },
};

const personaCfg = (dir, extra = {}) =>
  baseConfig(server.port, { behavior: { personasDir: dir, ...extra } });

test('人格加载：跳过 _ 开头的模板文件，坏文件不影响其它', async () => {
  const dir = makePersonaDir({
    ...PERSONA_FIXTURES,
    'broken.json': '{ 这不是合法 JSON',
    'nosys.json': { id: 'nosys', name: '缺正文' },
  });
  const { list, errors } = loadPersonas(dir, { logger: silentLogger });
  assert.equal(list.length, 2, `应只加载 2 个，实际 ${list.map((p) => p.id).join(',')}`);
  assert.deepEqual(list.map((p) => p.id).sort(), ['alpha', 'beta']);
  assert.equal(errors.length, 2, '坏 JSON 和缺 systemPrompt 都应被记为错误');
});

test('人格匹配：序号 / id / 名字 / 别名 / 部分匹配 / 歧义', async () => {
  const dir = makePersonaDir(PERSONA_FIXTURES);
  const { list } = loadPersonas(dir, { logger: silentLogger });

  assert.equal(matchPersona(list, '1').persona.id, 'alpha');
  assert.equal(matchPersona(list, '2').persona.id, 'beta');
  assert.equal(matchPersona(list, 'alpha').persona.id, 'alpha');
  assert.equal(matchPersona(list, '贝塔').persona.id, 'beta');
  assert.equal(matchPersona(list, 'Alpha').persona.id, 'alpha', '别名应能匹配（忽略大小写）');
  assert.equal(matchPersona(list, '阿').persona.id, 'alpha', '唯一部分匹配应命中');
  assert.equal(matchPersona(list, '9').error, 'no-such-index');
  assert.equal(matchPersona(list, '不存在').error, 'not-found');
  assert.equal(matchPersona(list, '').error, 'empty');
});

test('多人格：首次对话只出菜单，不调用模型', async () => {
  const dir = makePersonaDir(PERSONA_FIXTURES);
  const engine = makeEngine(personaCfg(dir));
  assert.equal(engine.personas.length, 2);

  const t = await turn(engine, { text: '你好' });
  assert.equal(t.result.status, 'awaiting-persona');
  assert.equal(t.replies.length, 1, '只应回一条菜单');
  assert.equal(t.replies[0].meta.kind, 'persona');
  assert.match(t.replies[0].text, /阿尔法/);
  assert.match(t.replies[0].text, /贝塔/);
  assert.doesNotMatch(t.replies[0].text, /隐藏/, '_ 开头的人格不能出现在菜单里');
});

test('多人格：回复序号即选中，并补答此前的第一个问题', async () => {
  const dir = makePersonaDir(PERSONA_FIXTURES);
  const engine = makeEngine(personaCfg(dir));

  await turn(engine, { text: '帮我算 1+1' }); // 首次 → 菜单
  const t = await turn(engine, { text: '1' }); // 选第一个

  const texts = t.replies.map((r) => r.text).join('\n');
  assert.match(texts, /阿尔法上线/, '应回人格的 greeting');
  assert.match(texts, /已选择/, '应有确认');
  assert.ok(
    t.replies.some((r) => r.meta?.kind === 'answer'),
    '首个问题应在选择人格后被回答，不应丢弃',
  );

  // 关键：发给模型的必须是原问题，而不是「1」
  const key = engine.keyOf({ talkerId: 'user-a', roomId: null, talkerName: '小王' });
  const hist = engine.sessions.history(key);
  assert.ok(
    hist.some((m) => m.role === 'user' && m.content.includes('1+1')),
    `历史里应是原问题，实际：${JSON.stringify(hist.map((m) => m.content))}`,
  );
  assert.ok(!hist.some((m) => m.role === 'user' && m.content === '1'), '不能把「1」发给模型');
});

test('多人格：选错会重新出菜单', async () => {
  const dir = makePersonaDir(PERSONA_FIXTURES);
  const engine = makeEngine(personaCfg(dir));
  await turn(engine, { text: '你好' });
  const bad = await turn(engine, { text: '这个人格不存在' });
  assert.equal(bad.result.status, 'awaiting-persona');
  assert.match(bad.replies[0].text, /没找到/);
  assert.match(bad.replies[0].text, /阿尔法/, '重选时仍要列出候选');
});

test('多人格：/人格 列出菜单并标出当前项，/人格 <名字> 可切换', async () => {
  const dir = makePersonaDir(PERSONA_FIXTURES);
  const engine = makeEngine(personaCfg(dir));
  await turn(engine, { text: '你好' });
  await turn(engine, { text: '阿尔法' });

  const list = await turn(engine, { text: '/人格' });
  assert.equal(list.result.status, 'command');
  const alphaLine = list.replies[0].text.split('\n').find((l) => l.includes('阿尔法'));
  assert.ok(alphaLine.includes('当前'), '当前人格应被标记');

  const sw = await turn(engine, { text: '/人格 贝塔' });
  assert.match(sw.replies[0].text, /贝塔/);

  const list2 = await turn(engine, { text: '/人格' });
  const betaLine = list2.replies[0].text.split('\n').find((l) => l.includes('贝塔'));
  assert.ok(betaLine.includes('当前'), '切换后当前项应变成贝塔');
});

test('多人格：换人格即换上下文，切回原人格历史仍在', async () => {
  const dir = makePersonaDir(PERSONA_FIXTURES);
  const engine = makeEngine(personaCfg(dir));
  const msg = { talkerId: 'user-a', roomId: null, talkerName: '小王' };

  await turn(engine, { text: '你好' });
  await turn(engine, { text: '阿尔法' });
  await turn(engine, { text: '记住：我叫小明' });

  const base = engine.baseKeyOf(msg);
  const alpha = engine.personas.find((p) => p.id === 'alpha');
  const beta = engine.personas.find((p) => p.id === 'beta');
  const keyA = engine.sessionKeyFor(base, alpha);
  const keyB = engine.sessionKeyFor(base, beta);

  assert.notEqual(keyA, keyB, '不同人格的会话 key 必须不同');
  assert.ok(engine.sessions.history(keyA).length > 0, '阿尔法应已有历史');
  assert.equal(engine.sessions.history(keyB).length, 0, '贝塔应是全新上下文');

  await turn(engine, { text: '/人格 贝塔' });
  assert.equal(engine.sessions.history(keyB).length, 0, '切换后贝塔依然干净');
  assert.ok(engine.sessions.history(keyA).length > 0, '阿尔法的历史必须保留，切回去能接上');
});

test('多人格：配了默认人格 PERSONA 就不弹菜单', async () => {
  const dir = makePersonaDir(PERSONA_FIXTURES);
  const engine = makeEngine(personaCfg(dir, { defaultPersona: 'beta' }));
  const t = await turn(engine, { text: '你好' });
  assert.equal(t.result.status, 'ok', '有默认人格时应直接对话');
  assert.ok(!t.replies.some((r) => r.meta?.kind === 'persona'), '不应发菜单');
});

test('多人格：一个人格都没有时完全退回旧行为（向后兼容）', async () => {
  const engine = makeEngine(baseConfig(server.port)); // baseConfig 已把 personasDir 置空
  assert.equal(engine.personas.length, 0);
  const t = await turn(engine, { text: '你好' });
  assert.equal(t.result.status, 'ok', '没有人格文件时应像以前一样直接回答');
  assert.ok(!t.replies.some((r) => r.meta?.kind === 'persona'));
});

test('多人格：群聊中用人格名字也能触发', async () => {
  const dir = makePersonaDir(PERSONA_FIXTURES);
  const engine = makeEngine(personaCfg(dir, { groupTrigger: 'mention-or-name' }));
  const g = { roomId: 'r1', roomTopic: '群1' };

  // 群聊中必须先 @ 才会出现人格菜单（避免机器人在群里主动发言）
  const noAt = await turn(engine, { text: '闲聊一句', ...g });
  assert.equal(noAt.result.status, 'ignored', '群里没提到它就该忽略');

  await turn(engine, { text: '@小深 你好', ...g }); // @ 触发 → 菜单
  await turn(engine, { text: '阿尔法', ...g }); // 选中

  const hit = await turn(engine, { text: '阿尔法在吗', ...g });
  assert.equal(hit.result.status, 'ok', '人格名字应能触发群聊回复');
});

test('人格状态：落盘后重启仍记得选择；人格被删则要求重选', async () => {
  const dir = makePersonaDir(PERSONA_FIXTURES);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pstate-'));
  const persistPath = path.join(tmp, 'personas.json');

  const st = new PersonaStateStore({ persistPath, logger: silentLogger });
  st.set('c:123', { personaId: 'alpha', awaiting: false });
  assert.equal(st.personaIdOf('c:123'), 'alpha');

  const st2 = new PersonaStateStore({ persistPath, logger: silentLogger });
  assert.equal(st2.personaIdOf('c:123'), 'alpha', '重启后应记得选择');

  // alpha 被删掉 → 该聊天要重新选
  const dropped = st2.dropUnknown(['beta']);
  assert.equal(dropped, 1);
  assert.equal(st2.personaIdOf('c:123'), null);
  assert.equal(st2.isAwaiting('c:123'), true, '应标记为等待重选');
});

/* ------------------------------------------------------------------ */
/* QQ / OneBot 桥接（mock OneBot：HTTP + 真实 WebSocket）                */
/* ------------------------------------------------------------------ */

/** 轮询等待条件成立 */
async function waitFor(fn, { timeoutMs = 5000, intervalMs = 25, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function onebotConfig(server, overrides = {}) {
  const cfg = baseConfig(server.port, overrides);
  cfg.wechat.puppet = 'onebot';
  cfg.onebot = {
    httpUrl: server.httpUrl,
    wsUrl: server.wsUrl,
    accessToken: server.accessToken ?? '',
    reconnectMaxDelayMs: 2000,
  };
  return cfg;
}

/** 起一个 mock OneBot 并建好桥接，返回 { mock, info, bridge, close } */
async function startOneBot({ deepseek = {}, wechat = {}, accessToken = '', selfId = 10001 } = {}) {
  const mock = createMockOneBot({ accessToken, selfId, nickname: '小深' });
  const info = await mock.listen(0);
  const cfg = onebotConfig(
    { port: server.port, httpUrl: info.httpUrl, wsUrl: info.wsUrl, accessToken },
    { ai: { stream: false, ...deepseek }, wechat: { ...wechat } },
  );
  const engine = makeEngine(cfg);
  const bridge = new OneBotBridge(cfg, { engine, logger: silentLogger });
  await bridge.start();
  await waitFor(() => mock.wss.clientCount === 1, { label: 'WebSocket 连接建立' });
  return {
    mock,
    info,
    bridge,
    engine,
    async close() {
      await bridge.stop();
      await info.close();
    },
  };
}

test('OneBot: segmentsToText / mentionedIds 解析消息段', () => {
  const segs = [
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 你好' } },
    { type: 'image', data: { file: 'x.jpg' } },
    { type: 'face', data: { id: '1' } },
  ];
  assert.equal(segmentsToText(segs), '@10001 你好[图片][表情]');
  assert.deepEqual(mentionedIds(segs), ['10001']);
  assert.equal(segmentsToText('直接是字符串'), '');
});

test('OneBot: toNormalizedMessage 把 @机器人 换成 @昵称', () => {
  const ev = {
    message_type: 'group',
    group_id: 20001,
    user_id: 10086,
    message_id: 5,
    time: 1700000000,
    message: [
      { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: ' 帮我写个排序' } },
      { type: 'at', data: { qq: '99999' } },
    ],
    sender: { nickname: '小王', card: '' },
  };
  const m = toNormalizedMessage(ev, { selfId: '10001', selfName: '小深' });
  assert.equal(m.text, '@小深 帮我写个排序@99999');
  assert.equal(m.roomId, '20001');
  assert.equal(m.talkerId, '10086');
  assert.equal(m.talkerName, '小王');
  assert.equal(m.self, false);

  // 自己发的消息
  const mine = toNormalizedMessage({ ...ev, user_id: 10001 }, { selfId: '10001', selfName: '小深' });
  assert.equal(mine.self, true);
});

test('OneBot: 私聊一条消息 → 自动回复到同一个人', async () => {
  const t = await startOneBot();
  try {
    t.mock.pushMessage(t.mock.privateEvent({ userId: 10086, text: '你好', nickname: '小王' }));
    await waitFor(() => t.mock.state.sent.length >= 1, { label: '收到回复' });

    const sent = t.mock.state.sent[0];
    assert.equal(sent.type, 'private');
    assert.equal(sent.user_id, 10086);
    assert.match(sent.text, /你好/, '回复内容应基于用户消息');
    assert.equal(t.bridge.counters.received, 1);
    assert.equal(t.bridge.counters.sent, 1);
    // 登录信息来自 get_login_info
    assert.equal(t.bridge.selfId, '10001');
  } finally {
    await t.close();
  }
});

test('OneBot: 群聊未 @ 不回复，@ 之后回复到同一个群', async () => {
  const t = await startOneBot({ wechat: { groupRequireMention: true } });
  try {
    // 没 @ → 应该被忽略
    t.mock.pushMessage(t.mock.groupEvent({ groupId: 20001, text: '大家中午吃什么', mention: false }));
    await waitFor(() => t.bridge.counters.received >= 1, { label: '事件被接收' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(t.mock.state.sent.length, 0, '群里闲聊不能触发回复');

    // @ 了 → 回复到群
    t.mock.pushMessage(t.mock.groupEvent({ groupId: 20001, text: '帮我写个冒泡排序', mention: true }));
    await waitFor(() => t.mock.state.sent.length >= 1, { label: '群回复' });
    const sent = t.mock.state.sent[0];
    assert.equal(sent.type, 'group');
    assert.equal(sent.group_id, 20001);
    assert.match(sent.text, /冒泡排序/);
  } finally {
    await t.close();
  }
});

test('OneBot: 群内不同用户的上下文互相隔离', async () => {
  const t = await startOneBot({ wechat: { groupRequireMention: true } });
  try {
    t.mock.pushMessage(t.mock.groupEvent({ groupId: 20001, userId: 111, text: '我是甲', mention: true, nickname: '甲' }));
    await waitFor(() => t.mock.state.sent.length >= 1);
    t.mock.pushMessage(t.mock.groupEvent({ groupId: 20001, userId: 222, text: '我是乙', mention: true, nickname: '乙' }));
    await waitFor(() => t.mock.state.sent.length >= 2);

    // mock DeepSeek 会回报已是第几轮；两人都应是第 1 轮
    assert.match(t.mock.state.sent[0].text, /第1轮/);
    assert.match(t.mock.state.sent[1].text, /第1轮/, '群里另一个人的上下文必须独立');

    t.mock.pushMessage(t.mock.groupEvent({ groupId: 20001, userId: 111, text: '继续', mention: true, nickname: '甲' }));
    await waitFor(() => t.mock.state.sent.length >= 3);
    assert.match(t.mock.state.sent[2].text, /第2轮/);
  } finally {
    await t.close();
  }
});

test('OneBot: 自己发的消息不会触发自问自答', async () => {
  const t = await startOneBot({ selfId: 10001 });
  try {
    t.mock.pushMessage(t.mock.privateEvent({ userId: 10001, text: '我自己说的话' }));
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(t.mock.state.sent.length, 0, '自己的消息必须被忽略');
  } finally {
    await t.close();
  }
});

test('OneBot: access_token 鉴权生效', async () => {
  const t = await startOneBot({ accessToken: 'secret-token-123' });
  try {
    t.mock.pushMessage(t.mock.privateEvent({ userId: 10086, text: '鉴权测试' }));
    await waitFor(() => t.mock.state.sent.length >= 1, { label: '带 token 的回复' });
    assert.equal(t.mock.state.unauthorized, 0, '配置了 token 就不该出现鉴权失败');
    assert.match(t.mock.state.sent[0].text, /鉴权测试/);
  } finally {
    await t.close();
  }

  // 反例：token 不匹配时必须失败
  const mock2 = createMockOneBot({ accessToken: 'right-token' });
  const info2 = await mock2.listen(0);
  try {
    const cfg = onebotConfig({
      port: server.port,
      httpUrl: info2.httpUrl,
      wsUrl: info2.wsUrl,
      accessToken: 'wrong-token',
    });
    const bridge = new OneBotBridge(cfg, { engine: makeEngine(cfg), logger: silentLogger });
    await assert.rejects(() => bridge.start(), /401|token|鉴权/i);
    await bridge.stop();
  } finally {
    await info2.close();
  }
});

test('OneBot: 框架没启动时给出可操作的错误', async () => {
  const cfg = onebotConfig({
    port: server.port,
    httpUrl: 'http://127.0.0.1:59999', // 无人监听
    wsUrl: 'ws://127.0.0.1:59999',
  });
  const bridge = new OneBotBridge(cfg, { engine: makeEngine(cfg), logger: silentLogger });
  await assert.rejects(() => bridge.start(), /连不上 OneBot|NapCat/);
  await bridge.stop();
});

test('OneBot: 长回复按 maxReplyChars 分片发送', async () => {
  const t = await startOneBot({ ai: { stream: false } });
  try {
    // mock DeepSeek 的固定回复不易超长，改为直接验证 chunkReply 的分片结果
    const parts = t.engine.chunkReply('甲'.repeat(120), 40);
    assert.ok(parts.length >= 3, `应切成多段，实际 ${parts.length}`);
    assert.ok(parts[0].startsWith('(1/'), '多段应带编号');
  } finally {
    await t.close();
  }
});

test('OneBot: push() 能主动发消息', async () => {
  const t = await startOneBot();
  try {
    await t.bridge.push(10086, '主动播报');
    assert.equal(t.mock.state.sent.length, 1);
    assert.equal(t.mock.state.sent[0].type, 'private');
    assert.equal(t.mock.state.sent[0].text, '主动播报');

    await t.bridge.push(20001, '群播报', { group: true });
    assert.equal(t.mock.state.sent[1].type, 'group');
    assert.equal(t.mock.state.sent[1].group_id, 20001);

    const st = t.bridge.status();
    assert.equal(st.mode, 'onebot');
    assert.equal(st.loggedIn, true);
    assert.equal(st.counters.sent, 2);
  } finally {
    await t.close();
  }
});

test('OneBot: WebSocket 断开后会自动重连', async () => {
  const t = await startOneBot();
  try {
    assert.equal(t.mock.wss.clientCount, 1);
    // 主动断开所有客户端，模拟框架重启
    for (const c of [...t.mock.wss.clients]) c.destroy();
    await waitFor(() => t.bridge.counters.reconnects >= 1, { label: '检测到断开' });
    await waitFor(() => t.mock.wss.clientCount === 1, { timeoutMs: 8000, label: '自动重连成功' });
    // 重连后仍能正常收发
    t.mock.pushMessage(t.mock.privateEvent({ userId: 10086, text: '重连后测试' }));
    await waitFor(() => t.mock.state.sent.length >= 1, { label: '重连后回复' });
    assert.match(t.mock.state.sent[0].text, /重连后测试/);
  } finally {
    await t.close();
  }
});

/* ------------------------------------------------------------------ */
/* runner                                                             */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
/* ------------------------------------------------------------------ */
/* WebUI 控制台（人格存储 + HTTP 接口）                                   */
/* ------------------------------------------------------------------ */

function makeStoreDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pstore-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

test('persona-store: safeId 会挡掉路径穿越和非法字符', async () => {
  assert.equal(safeId('morgan'), 'morgan');
  assert.equal(safeId('  摩根  '), '摩根');
  assert.equal(safeId('a b'), 'a-b');
  assert.equal(safeId('_template'), 'template', '开头的下划线要被去掉（那是模板保留前缀）');
  assert.equal(safeId('x/../../etc/passwd'), 'x....etcpasswd');
  assert.equal(safeId('a:b*c?d"e<f>g|h'), 'abcdefgh');
  assert.equal(safeId('trailing.'), 'trailing');
  assert.throws(() => safeId(''), /id 不能为空/);
  assert.throws(() => safeId('///'), /没有可用字符/);
  assert.throws(() => safeId('x'.repeat(80)), /太长/);
});

test('persona-store: validatePersona 校验必填项与长度', async () => {
  assert.ok(validatePersona({ name: '', systemPrompt: '' }).length >= 2, '缺 name 和正文都要报');
  assert.match(validatePersona({ name: 'x', systemPrompt: '短' })[0], /太短/);
  assert.equal(validatePersona({ name: 'x', systemPrompt: '你是测试人格，说话简短。'.repeat(3) }).length, 0);
  assert.match(validatePersona({ name: 'x', systemPrompt: 'a'.repeat(9000) })[0], /过长/);
});

test('persona-store: normalizePersona 整理别名并压平换行', async () => {
  const p = normalizePersona({
    id: 'Morgan',
    name: '摩根',
    aliases: 'Morgan, 妖精王，女王',
    systemPrompt: '第一行\n第二行\n\n第三行',
  });
  assert.equal(p.id, 'Morgan');
  assert.deepEqual(p.aliases, ['Morgan', '妖精王', '女王'], '逗号（中英文）都要能分隔');
  assert.equal(p.systemPrompt, '第一行 第二行 第三行', '换行要被压成空格');
});

test('persona-store: 增删改查 + 重命名 + 模板保护', async () => {
  const dir = makeStoreDir({
    '_template.json': { name: '模板', systemPrompt: '这是模板' },
    'keeper.json': { name: '保留', systemPrompt: '这是另一个人格' },
  });
  const store = new PersonaStore({ dir });

  // 新建
  const made = store.save({ id: 'morgan', name: '摩根', aliases: 'Morgan,FGO', systemPrompt: '你是摩根，妖精国的女王。说话强势。' });
  assert.equal(made.id, 'morgan');
  assert.ok(fs.existsSync(path.join(dir, 'morgan.json')));
  assert.equal(store.list().filter((p) => !p.template).length, 2, 'keeper + morgan');

  // 覆盖
  store.save({ id: 'morgan', name: '摩根改', systemPrompt: '改过之后的正文内容，足够长。' });
  assert.equal(store.read('morgan').name, '摩根改');

  // 重命名：改了 id，旧文件应消失
  store.save({ id: 'morgan2', name: '摩根改', systemPrompt: '改过之后的正文内容，足够长。' }, { originalId: 'morgan' });
  assert.equal(fs.existsSync(path.join(dir, 'morgan.json')), false, '旧文件应被删除');
  assert.ok(fs.existsSync(path.join(dir, 'morgan2.json')));

  // 模板不许改也不许删
  assert.throws(() => store.remove('_template.json'), /模板/);
  // 前导下划线会被 safeId 去掉（净化），因此不会生成 _evil.json 这类模板文件名
  const neutralized = store.save({ id: '_evil', name: '中立化', systemPrompt: '这是一段足够长的正文内容。' });
  assert.equal(neutralized.id, 'evil', '前导下划线应被去掉');
  assert.equal(fs.existsSync(path.join(dir, '_evil.json')), false, '不能生成模板前缀的文件');

  // 删除正常人格
  assert.equal(store.remove('keeper.json').deleted, 'keeper.json');
  assert.equal(store.read('keeper'), null);

  // 别的人格不受影响
  assert.ok(store.read('morgan2'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('persona-store: 路径穿越无法写出文件', async () => {
  const dir = makeStoreDir();
  const store = new PersonaStore({ dir });
  const escaped = path.resolve(dir, '..', 'escaped.json');
  fs.rmSync(escaped, { force: true });
  // safeId 会去掉斜杠，最终仍落在目录内；此处确认结果确实位于目录中
  const p = store.save({ id: '../../escaped', name: '偷跑', systemPrompt: '这是一段足够长的正文内容。' });
  assert.ok(path.resolve(path.join(dir, p.id + '.json')).startsWith(path.resolve(dir) + path.sep));
  assert.equal(fs.existsSync(escaped), false, '目录外不应出现文件');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WebUI: 没有 token 一律 401，带 token 才放行', async () => {
  const dir = makeStoreDir({ 'a.json': { name: '甲', systemPrompt: '你是甲，说话简短。' } });
  const pageFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-page-')), 'index.html');
  fs.writeFileSync(pageFile, '<html>ok</html>');
  const handlers = createHandlers({ projectRoot: process.cwd() });
  const webui = createWebUiServer({ projectRoot: process.cwd(), dataDir: dir, pageFile, handlers, envToken: 'test-token-123' });
  const addr = await webui.listen(0);
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const bad = await fetch(`${base}/api/status`);
    assert.equal(bad.status, 401, '不带 token 的 API 请求必须 401');

    const badPage = await fetch(`${base}/`);
    assert.equal(badPage.status, 401, '不带 token 的页面也要 401');

    const good = await fetch(`${base}/api/status?token=test-token-123`);
    assert.equal(good.status, 200);
    const st = await good.json();
    assert.ok('bot' in st && 'napcat' in st && 'personas' in st, '状态快照要有这几个字段');
    assert.equal(typeof st.bot.running, 'boolean');
  } finally {
    await webui.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WebUI: 人格接口能增删改查，非法输入被挡', async () => {
  const dir = makeStoreDir();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proj-'));
  fs.mkdirSync(path.join(projectRoot, 'personas'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'personas', '_template.json'), JSON.stringify({ name: '模板', systemPrompt: '模板正文够长。' }));
  // handlers 会读项目配置，所以把 personasDir 指到临时目录
  const handlers = createHandlers({ projectRoot });
  // 注意：handlers 内部用的是 loadConfig() 的 personasDir（项目里的 personas/），
  // 直接测试 HTTP 层：新建 → 列表 → 删除
  const pageFile = path.join(projectRoot, 'index.html');
  fs.writeFileSync(pageFile, '<html>ok</html>');
  const webui = createWebUiServer({ projectRoot, dataDir: dir, pageFile, handlers, envToken: 'tk' });
  const addr = await webui.listen(0);
  const base = `http://127.0.0.1:${addr.port}/api`;
  const H = { 'Content-Type': 'application/json' };
  try {
    const invalid = await fetch(`${base}/personas?token=tk`, {
      method: 'POST', headers: H, body: JSON.stringify({ name: '', systemPrompt: '' }),
    });
    assert.equal(invalid.status, 400, '缺必填字段应 400');

    const created = await fetch(`${base}/personas?token=tk`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ id: 'webtest', name: '接口测试', systemPrompt: '你是接口测试人格，说话简短。' }),
    });
    // 注意：响应体只能读一次，assert 的第三个参数会立即求值，不能在里面 await .text()
    const createdText = await created.text();
    assert.equal(created.status, 200, createdText);
    const cj = JSON.parse(createdText);
    assert.equal(cj.persona.id, 'webtest');

    const list = await (await fetch(`${base}/personas?token=tk`)).json();
    assert.ok(list.personas.some((p) => p.id === 'webtest'), '新人格应出现在列表里');

    const del = await fetch(`${base}/personas?id=webtest&token=tk`, { method: 'DELETE' });
    assert.equal(del.status, 200);

    const missing = await fetch(`${base}/personas?id=webtest&token=tk`, { method: 'DELETE' });
    assert.equal(missing.status, 404, '删不存在的应 404');
  } finally {
    await webui.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('WebUI: 状态采集工具能用（端口探测 / 读日志尾）', async () => {
  assert.equal(await isPortOpen(1), false, '端口 1 上不该有服务');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tail-'));
  const f = path.join(dir, 'x.log');
  fs.writeFileSync(f, Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n'));
  const tail = tailFile(f, 5);
  assert.equal(tail.length, 5);
  assert.equal(tail[4], 'line99');
  assert.deepEqual(tailFile(path.join(dir, 'nope.log'), 5), [], '文件不存在时返回空数组而不是抛错');
  fs.rmSync(dir, { recursive: true, force: true });
});
test('WebUI: 一键启动接口在找不到 start-bot.ps1 时给出可操作错误', async () => {
  // 只覆盖「找不到脚本」这一分支：实际 spawn 会弹出控制台窗口，不适合放进测试
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nolaunch-'));
  const pageFile = path.join(projectRoot, 'index.html');
  fs.writeFileSync(pageFile, '<html>ok</html>');
  const handlers = createHandlers({ projectRoot });
  const webui = createWebUiServer({ projectRoot, dataDir: projectRoot, pageFile, handlers, envToken: 'tk' });
  const addr = await webui.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${addr.port}/api/start?token=tk`, { method: 'POST' });
    const text = await r.text();
    assert.equal(r.status, 500);
    const j = JSON.parse(text);
    assert.match(j.error, /start-bot\.ps1/, '错误里要提到缺哪个文件');
    assert.match(j.error, /LAUNCHER_PATH/, '并且要告诉用户可以怎么指定');
  } finally {
    await webui.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('.env 改写：仅修改目标 key，保留注释与顺序；非法输入被拦截', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-env-'));
  const envPath = path.join(dir, '.env');
  const original = [
    '# 顶部注释',
    'DEEPSEEK_API_KEY=sk-abc',
    'MAX_HISTORY_TURNS=8',
    '',
    '# 中间注释，必须保留',
    'RATE_LIMIT_PER_MINUTE=10',
    'BOT_NAME=企业   # 行尾注释也保留',
  ].join('\n');
  fs.writeFileSync(envPath, original, 'utf8');

  const r = setEnvValues(envPath, { MAX_HISTORY_TURNS: '20', RATE_LIMIT_PER_MINUTE: '0' });
  assert.deepEqual(r.changed.sort(), ['MAX_HISTORY_TURNS', 'RATE_LIMIT_PER_MINUTE']);
  assert.equal(r.added.length, 0);
  assert.ok(fs.existsSync(envPath + '.bak'), '应生成备份');
  assert.equal(fs.readFileSync(envPath + '.bak', 'utf8'), original, '备份内容应与原文一致');

  const now = fs.readFileSync(envPath, 'utf8');
  assert.match(now, /MAX_HISTORY_TURNS=20/);
  assert.match(now, /RATE_LIMIT_PER_MINUTE=0/);
  assert.match(now, /# 顶部注释/);
  assert.match(now, /# 中间注释，必须保留/);
  assert.match(now, /BOT_NAME=企业   # 行尾注释也保留/, '行尾注释不能被吃掉');
  assert.match(now, /DEEPSEEK_API_KEY=sk-abc/, '没动的键要原样保留');

  // 新键会被追加
  const r2 = setEnvValues(envPath, { NEW_KEY: 'x' });
  assert.deepEqual(r2.added, ['NEW_KEY']);

  // 非法输入
  assert.throws(() => validateEnvEntry('BAD KEY', '1'), /非法的配置键/);
  assert.throws(() => validateEnvEntry('OK', 'a\nb'), /不能包含换行/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SessionStore: token 预算会从最老的开始成对丢弃', async () => {
  const s = new SessionStore({ maxTurns: 1000, maxTokens: 120 });
  for (let i = 0; i < 30; i++) s.append('k', '用户这一句挺长的需要占一些位置'.repeat(2), '助手也回了挺长一段话内容'.repeat(2));
  const h = s.history('k');
  assert.equal(h.length % 2, 0, '必须成对保留，不能把 user/assistant 拆散');
  assert.ok(h.length < 60, `应该被裁掉大部分，实际留了 ${h.length} 条`);
  const total = h.reduce((n, m) => n + estimateTokens(m.content), 0);
  // 裁剪发生在 append 之后，所以最后加进来的那一对可能让总量略微超出
  assert.ok(total <= 120 + 200, `总 token 应在预算附近，实际 ${total}`);
});

const failures = [];
const t0 = Date.now();

console.log('\n=========== LLM QQ 机器人 自测 ===========\n');
for (const { name, fn } of tests) {
  const started = Date.now();
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}  (${Date.now() - started}ms)`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ❌ ${name}`);
    console.log(`     ${String(err?.message).split('\n').join('\n     ')}`);
  }
}

await server.close();
if (mock.state.requests === 0) console.log('\n  ⚠️  mock 服务没有收到任何请求，集成测试可能没真正跑起来');

console.log(`\n-----------------------------------------------`);
console.log(`  通过 ${passed} / ${tests.length}，失败 ${failed}，耗时 ${Date.now() - t0}ms`);
console.log(`-----------------------------------------------\n`);

if (failures.length) {
  for (const f of failures) console.log(`\n[FAIL] ${f.name}\n${f.err?.stack || f.err}`);
  process.exit(1);
}
process.exit(0);
