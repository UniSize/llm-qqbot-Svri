#!/usr/bin/env node
/**
 * 命令行入口。
 *
 *   npm start                 启动并连接后端（OneBot 11 / QQ）
 *   npm start -- --check      仅检查 DeepSeek Key 是否可用
 *   npm start -- --console    不连接后端，在终端内直接与模型对话（调试用）
 *   npm start -- --dry-run    加载配置、打印摘要后退出
 */
import readline from 'node:readline';
import net from 'node:net';
import { loadEnv } from '../src/env.js';
import { loadConfig, validateConfig, describeConfig } from '../src/config.js';
import { createPlugin } from '../src/plugin.js';
import Logger from '../src/logger.js';
import path from 'node:path';
import { UsageTracker } from '../src/usage-tracker.js';

loadEnv(process.cwd());

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argValue = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};

const configFile = argValue('--config');
const cfg = loadConfig({ configFile });
if (has('--mock')) {
  // 离线自测：指向本地 mock 服务
  process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:8788';
  process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-mock-local-test';
  cfg.ai.baseUrl = process.env.DEEPSEEK_BASE_URL;
  cfg.ai.apiKey = process.env.DEEPSEEK_API_KEY;
}

const log = new Logger({ level: cfg.storage.logLevel, dir: cfg.storage.logDir, name: 'cli' });

/**
 * 单实例锁。
 *
 * 必要性：启动脚本与看门狗都可能检测到「机器人未运行」并各自启动一个实例，
 * 两个实例同时连接 OneBot 的 WebSocket，会导致**同一条消息被回复两次**。
 * 实现方式：在 127.0.0.1 上占用一个端口作为锁。端口唯一且进程退出时自动释放，
 * 相比 PID 文件更不容易产生残留死锁。
 *
 * 仅在机器人正式启动时加锁（--check / --dry-run / --console 不占用）。
 */
const SINGLETON_PORT = 39999;
let singletonServer = null;

async function acquireSingletonLock() {
  const server = net.createServer();
  const ok = await new Promise((resolve) => {
    server.once('error', (err) => resolve(err.code !== 'EADDRINUSE'));
    server.listen(SINGLETON_PORT, '127.0.0.1', () => resolve(true));
  });
  if (!ok) return false;
  singletonServer = server;
  // 不要让该监听句柄阻止进程退出
  singletonServer.unref?.();
  return true;
}

function banner() {
  log.info('==============================================');
  log.info(`  LLM QQ 机器人 v0.2.0`);
  log.info('==============================================');
  log.info(`\n${describeConfig(cfg)}\n`);
}

banner();

const problems = validateConfig(cfg);
if (problems.length) {
  for (const p of problems) log.warn(`⚠️  ${p}`);
  if (!has('--dry-run') && !has('--console')) {
    log.error('配置不完整，已退出。请复制 .env.example 为 .env 并填写 DEEPSEEK_API_KEY。');
    process.exit(1);
  }
}

if (has('--dry-run')) {
  log.info('配置加载正常（--dry-run）');
  process.exit(0);
}

const plugin = createPlugin(cfg, { logger: log });

if (has('--check')) {
  try {
    const r = await plugin.engine.client.ping();
    log.info(`✅ DeepSeek 连通正常：model=${r.model} reply=${JSON.stringify(r.reply)}`);
    process.exit(0);
  } catch (err) {
    log.error(`❌ DeepSeek 连接失败：${err.message}`);
    process.exit(2);
  }
}

if (has('--console')) {
  log.info('进入终端对话模式，直接输入内容回车；/reset 清空上下文，/exit 退出。\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '用户 > ' });
  // 串行队列：保证同一时间只有一个请求，且退出前能等待未完成的回复
  let queue = Promise.resolve();

  const ask = (text) =>
    plugin.handleMessage(
      { text, talkerId: 'console-user', talkerName: '终端用户' },
      {
        onReply: async (reply) => {
          process.stdout.write(`\n${cfg.bot.name} > ${reply}\n\n`);
        },
      },
    );

  rl.on('line', (line) => {
    // 注意：stdin 被管道关闭时 rl.close() 可能先于队列跑完触发，因此需要状态守卫
    if (rl.closed) return;
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }
    if (text === '/exit' || text === '/quit') {
      rl.close();
      return;
    }
    rl.pause();
    queue = queue
      .then(() => ask(text))
      .catch((err) => log.error(`出错：${err.message}`))
      .then(() => {
        if (rl.closed) return;
        try {
          rl.resume();
          rl.prompt();
        } catch {
          /* 输入流已结束，忽略 */
        }
      });
  });

  rl.on('close', async () => {
    process.stdout.write('\n');
    await queue.catch(() => {});
    const s = plugin.status();
    log.info(`本次终端会话：回复 ${s.engine.replied} 条，失败 ${s.engine.failed} 条`);
    await plugin.stop();
    log.info('已退出。');
    process.exit(0);
  });
} else {
  // 正式启动：先获取单实例锁，避免启动器与看门狗各启动一个实例导致重复回复
  const gotLock = await acquireSingletonLock();
  if (!gotLock) {
    log.error(`已有机器人在运行（单实例端口 ${SINGLETON_PORT} 被占用），本实例退出。`);
    log.error('如果确认没有其他实例，请检查是否有残留的 node 进程。');
    process.exit(0);
  }

  try {
    await plugin.start({
      onError: (err) => log.error('连接错误：', err?.message || err),
    });
    // ---- 用量统计 ----
    // 仅在正式启动路径记录；--console / --check 不落盘
    const usageFile = cfg.storage.persistSessions ? path.join(cfg.storage.dir, 'usage.json') : null;
    const tracker = new UsageTracker({ file: usageFile, logger: log });
    const stopUsage = tracker.start(plugin.engine.client, 15000);
    const prev = tracker.lifetime;
    if (prev.requests > 0) {
      log.info(
        `历史累计：${prev.requests} 次请求，${(prev.promptTokens + prev.completionTokens).toLocaleString()} tokens，约 ¥${prev.costCNY.toFixed(4)}`,
      );
    }
    process.once('exit', stopUsage);

    const s = plugin.status();
    log.info(`机器人已就绪：${s.bridge?.selfName}`);
    // 群聊触发规则按实际配置生成，不固定写成「必须 @」
    const trigger = String(cfg.behavior.groupTrigger || '').toLowerCase();
    const names = [...new Set([cfg.bot.name, ...(cfg.wechat.mentions ?? [])].filter(Boolean))];
    const triggerText =
      trigger === 'all' || trigger === 'off'
        ? '群里每条消息都会回复'
        : trigger === 'mention' || trigger === 'at'
          ? `群里需要 @${cfg.bot.name} 才回复`
          : `群里 @它 或消息里出现「${names.join('」「')}」就会回复`;
    log.info(`私聊直接说话；${triggerText}。按 Ctrl+C 退出。`);
  } catch (err) {
    log.error(`启动失败：${err.message}`);
    process.exit(1);
  }
}

// 优雅退出
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    log.info('\n正在退出…');
    const s = plugin.status();
    log.info(`本次会话：处理 ${s.engine.handled} 条，回复 ${s.engine.replied} 条，失败 ${s.engine.failed} 条，` +
      `tokens 输入 ${s.usage.promptTokens} / 输出 ${s.usage.completionTokens}，约 ¥${s.costCNY}`);
    await plugin.stop();
    process.exit(0);
  });
}
