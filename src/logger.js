/**
 * 零依赖日志：控制台彩色输出 + 可选文件落盘。
 */
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
};

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function formatArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export class Logger {
  constructor({ level = 'info', dir = null, name = 'app', console = true } = {}) {
    this.level = LEVELS[level] !== undefined ? level : 'info';
    this.name = name;
    this.toConsole = console;
    this.file = null;
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const day = new Date().toISOString().slice(0, 10);
        this.file = path.join(dir, `${name}-${day}.log`);
      } catch {
        this.file = null;
      }
    }
  }

  child(name) {
    return new Logger({ level: this.level, name: `${this.name}:${name}`, console: this.toConsole });
  }

  #write(level, args) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const text = args.map(formatArg).join(' ');
    const line = `${stamp()} [${level.toUpperCase().padEnd(5)}] [${this.name}] ${text}`;
    if (this.toConsole) {
      const c = COLORS[level] || '';
      process.stdout.write(`${c}${line}${COLORS.reset}\n`);
    }
    if (this.file) {
      try {
        fs.appendFileSync(this.file, `${line}\n`);
      } catch {
        /* 落盘失败不影响主流程 */
      }
    }
  }

  debug(...a) {
    this.#write('debug', a);
  }
  info(...a) {
    this.#write('info', a);
  }
  warn(...a) {
    this.#write('warn', a);
  }
  error(...a) {
    this.#write('error', a);
  }
}

export default Logger;
