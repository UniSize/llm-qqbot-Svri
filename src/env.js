/**
 * 极简 .env 解析器（零依赖）。
 * 读取工作目录下的 .env，写进 process.env（已存在的真实环境变量优先）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 解析 .env 文本为键值对 */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    // 去掉成对引号
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * 加载 .env 文件到 process.env。
 * @param {string} [cwd] 目录，默认 process.cwd()
 * @param {{override?: boolean}} [opts]
 * @returns {Record<string,string>} 实际加载的键值
 */
export function loadEnv(cwd = process.cwd(), opts = {}) {
  const file = path.join(cwd, '.env');
  if (!fs.existsSync(file)) return {};
  const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
  const applied = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!opts.override && process.env[k] !== undefined && process.env[k] !== '') continue;
    process.env[k] = v;
    applied[k] = v;
  }
  return applied;
}

export default loadEnv;
