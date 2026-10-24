#!/usr/bin/env node
/**
 * 控制台（WebUI）入口。
 *
 *   npm run ui                 启动控制台并自动打开浏览器
 *   npm run ui -- --port 6180  指定端口
 *   npm run ui -- --no-open    不自动打开浏览器
 *
 * 作为**独立进程**运行，不承载于机器人进程内。原因：
 *   · 机器人重载或重启时控制台不会中断
 *   · 可以从外部直接观察机器人是否存活（依据单实例锁端口 39999）
 *
 * 仅绑定 127.0.0.1，且所有请求都需携带 token（首次使用打印出的带 token 地址打开即可）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadEnv } from '../src/env.js';
import { loadConfig } from '../src/config.js';
import Logger from '../src/logger.js';
import { createWebUiServer } from '../src/webui/server.js';
import { createHandlers } from '../src/webui/handlers.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(PROJECT_ROOT);

const argv = process.argv.slice(2);
const argValue = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};

const cfg = loadConfig();
const log = new Logger({ level: 'info', dir: cfg.storage.logDir, name: 'webui' });

const port = Number(argValue('--port') || process.env.WEBUI_PORT || 6180);
const wantOpen = !argv.includes('--no-open') && process.env.WEBUI_NO_OPEN !== '1';

const handlers = createHandlers({ projectRoot: PROJECT_ROOT, logger: log });
const webui = createWebUiServer({
  projectRoot: PROJECT_ROOT,
  dataDir: cfg.storage.dir,
  pageFile: path.join(PROJECT_ROOT, 'webui', 'index.html'),
  handlers,
  logger: log,
  envToken: process.env.WEBUI_TOKEN || '',
});

function openBrowser(url) {
  try {
    const child = spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测端口上的服务是否为当前控制台。
 * 判断依据：能否用同一套 token 正常应答 /api/status —— 以此区分
 * 「已有控制台在运行」与「端口被其他程序占用」。
 */
async function probeExistingWebUi(port, token) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status?token=${encodeURIComponent(token)}`, {
      signal: ctl.signal,
    });
    if (!res.ok) return false;
    const j = await res.json();
    return Boolean(j && typeof j === 'object' && 'bot' in j && 'napcat' in j);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

try {
  await webui.listen(port, '127.0.0.1');
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    // 端口被占 —— 先判断是否已有控制台在运行。
    // 双击快捷方式的语义是「打开控制台」，并非「必须由本进程启动」，
    // 因此已有控制台在运行时直接把浏览器指向它，不报错退出。
    const url = `http://127.0.0.1:${port}/?token=${webui.token}`;
    const ours = await probeExistingWebUi(port, webui.token);
    if (ours) {
      log.info('==============================================');
      log.info('  控制台已在运行，正在打开');
      log.info('==============================================');
      log.info(`\n  ${url}\n`);
      if (wantOpen) {
        openBrowser(url);
        log.info('已打开浏览器。本窗口可以关闭（不影响已运行的控制台）。');
      } else {
        log.info('（已指定 --no-open，请手动复制上方地址）');
      }
      process.exit(0);
    }
    log.error(`端口 ${port} 已被其他程序占用。请更换端口：npm run ui -- --port ${port + 1}`);
    log.error('（也可用 curl http://127.0.0.1:' + port + '/ 查看占用该端口的程序）');
  } else {
    log.error(`启动失败：${err.message}`);
  }
  process.exit(1);
}

const url = `http://127.0.0.1:${port}/?token=${webui.token}`;

log.info('==============================================');
log.info('  DeepSeek QQ 机器人 · 控制台');
log.info('==============================================');
log.info(`\n控制台地址：\n  ${url}\n`);
log.info(`访问令牌：${webui.token}  （来源：${webui.tokenSource}）`);
log.info('只监听 127.0.0.1，局域网内其他机器无法访问。');
log.info('如需固定令牌：在 .env 中设置 WEBUI_TOKEN=你的令牌');
log.info('\n按 Ctrl+C 退出（不影响正在运行的机器人）。\n');

if (wantOpen) {
  const opened = openBrowser(url);
  log.info(opened ? '已尝试打开浏览器。' : '无法自动打开浏览器，请手动复制上方地址。');
}

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  log.info('\n控制台已关闭（机器人不受影响）。');
  webui.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
