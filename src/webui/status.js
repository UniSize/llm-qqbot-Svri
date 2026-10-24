/**
 * 控制台（WebUI）的状态采集。
 *
 * 控制台是**独立进程**（不运行在机器人进程内），因此只能从外部观察机器人。
 * 项目内可用的观测点：
 *
 *   127.0.0.1:39999   ← 机器人启动时占用的单实例锁端口。
 *                        该端口处于监听状态即可判定机器人正在运行。这是最可靠的
 *                        存活信号，比扫描进程名稳定（不受路径变化、多个 node 进程干扰）。
 *   127.0.0.1:3000    ← OneBot HTTP（可同时查询登录状态）
 *   127.0.0.1:3001    ← OneBot WebSocket
 *   127.0.0.1:6099    ← NapCat WebUI
 *
 * 仅使用 node:net / node:fs / node:child_process，不引入任何依赖。
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** 机器人单实例锁端口，见 bin/cli.js 的 SINGLETON_PORT */
export const SINGLETON_PORT = 39999;

/** 探测某个端口上是否有服务在监听 */
export function isPortOpen(port, { host = '127.0.0.1', timeoutMs = 400 } = {}) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try {
      sock.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/**
 * 通过 netstat 反查监听指定端口的进程 PID。
 * 仅适用于 Windows（本项目为 Windows 专用）。失败时静默返回 null，
 * 避免状态面板因取不到 PID 而整体报错。
 */
export function pidOfPort(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const args = ['-ano', '-p', 'TCP'];
    execFile('netstat', args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const needle = `:${port} `;
      for (const line of String(stdout).split(/\r?\n/)) {
        if (!line.includes('LISTENING')) continue;
        if (!line.includes(needle)) continue;
        const cols = line.trim().split(/\s+/);
        const pid = Number(cols[cols.length - 1]);
        if (Number.isFinite(pid) && pid > 0) return resolve(pid);
      }
      resolve(null);
    });
  });
}

/** 调用 OneBot 的 HTTP 接口（带超时，失败返回 null） */
export async function onebotCall(action, params = {}, { httpUrl = 'http://127.0.0.1:3000', accessToken = '', timeoutMs = 2500 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${httpUrl.replace(/\/+$/, '')}/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(params),
      signal: ctl.signal,
    });
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 读取文件末尾 N 行 */
export function tailFile(file, lines = 40) {
  try {
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    const all = text.split(/\r?\n/).filter((l) => l.length);
    return all.slice(-lines);
  } catch {
    return [];
  }
}

/**
 * 汇总一份状态快照。
 * @param {{projectRoot:string, dataDir:string, logDir:string, personasDir:string,
 *          onebot?:{httpUrl:string, wsUrl:string, accessToken:string}}} opts
 */
export async function collectStatus(opts) {
  const {
    projectRoot,
    dataDir,
    logDir,
    personasDir,
    onebot = { httpUrl: 'http://127.0.0.1:3000', accessToken: '' },
  } = opts;

  const [lockOpen, http3000, ws3001, webui6099] = await Promise.all([
    isPortOpen(SINGLETON_PORT),
    isPortOpen(3000),
    isPortOpen(3001),
    isPortOpen(6099),
  ]);

  // 机器人运行时才查询 PID，可省略一次 netstat 调用
  const botPid = lockOpen ? await pidOfPort(SINGLETON_PORT) : null;

  let login = null;
  let version = null;
  if (http3000) {
    const info = await onebotCall('get_login_info', {}, onebot);
    if (info && info.status === 'ok') {
      login = {
        nickname: info.data?.nickname ?? null,
        userId: String(info.data?.user_id ?? '') || null,
      };
    }
    const v = await onebotCall('get_version_info', {}, onebot);
    if (v && v.status === 'ok') {
      version = {
        app: v.data?.app_name ?? null,
        version: v.data?.app_version ?? null,
        protocol: v.data?.protocol_version ?? null,
      };
    }
  }

  // 人格
  let personas = { count: 0, templates: 0, files: [] };
  try {
    if (fs.existsSync(personasDir)) {
      const names = fs.readdirSync(personasDir).filter((n) => n.toLowerCase().endsWith('.json'));
      personas.files = names;
      personas.templates = names.filter((n) => n.startsWith('_')).length;
      personas.count = names.length - personas.templates;
    }
  } catch {
    /* 忽略 */
  }

  // 各聊天选了哪个人格
  let selection = {};
  try {
    const p = path.join(dataDir, 'personas.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      selection = j?.chats ?? {};
    }
  } catch {
    /* 忽略 */
  }

  // 一键启动脚本是否就位（前端据此决定按钮可用性）
  let launcher = null;
  for (const c of [process.env.LAUNCHER_PATH, path.join(projectRoot, '..', 'start-bot.ps1'), path.join(projectRoot, 'start-bot.ps1')]) {
    if (!c) continue;
    try {
      if (fs.existsSync(c)) {
        launcher = path.resolve(c);
        break;
      }
    } catch {
      /* 忽略 */
    }
  }

  return {
    time: new Date().toISOString(),
    launcher,
    bot: { running: lockOpen, pid: botPid },
    napcat: { http3000, ws3001, webui6099 },
    onebot: { login, version, httpUrl: onebot.httpUrl },
    personas,
    selection,
    tail: tailFile(path.join(logDir, 'bot-run.log'), 30),
    logDir,
    projectRoot,
  };
}

export default collectStatus;
