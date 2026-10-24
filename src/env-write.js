/**
 * 按键改写 .env —— WebUI 修改「记忆轮数 / 限流」这类运行参数时用。
 *
 * 为什么不能直接重新生成整个文件：会丢掉你手写的注释、空行和顺序。
 * 这里只做「按 key 替换那一行」，其余行原样保留。
 *
 * 安全约束：
 *   1. key 只允许 [A-Za-z_][A-Za-z0-9_]*，防注入
 *   2. value 不允许换行（换了行就会破坏 .env 的行结构）
 *   3. 写之前先备份成 .env.bak，出问题能手动还原
 *   4. 只改「已存在的键」或「追加新键」，绝不删除任何东西
 */
import fs from 'node:fs';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class EnvWriteError extends Error {
  constructor(message, code = 'ENV_WRITE_ERROR') {
    super(message);
    this.code = code;
  }
}

/** 校验一个键值对是否可写 */
export function validateEnvEntry(key, value) {
  const k = String(key ?? '').trim();
  const v = String(value ?? '');
  if (!KEY_RE.test(k)) throw new EnvWriteError(`非法的配置键「${k}」（只允许字母数字下划线）`, 'BAD_KEY');
  if (/[\r\n]/.test(v)) throw new EnvWriteError(`「${k}」的值不能包含换行`, 'BAD_VALUE');
  if (v.length > 2000) throw new EnvWriteError(`「${k}」的值过长`, 'BAD_VALUE');
  return { key: k, value: v };
}

/**
 * 改写若干键的值。
 * @param {string} envPath .env 的绝对路径
 * @param {Record<string,string>} values 要写入的键值
 * @returns {{changed:string[], added:string[], backup:string|null}}
 */
export function setEnvValues(envPath, values = {}) {
  const entries = Object.entries(values).map(([k, v]) => validateEnvEntry(k, v));
  if (!entries.length) return { changed: [], added: [], backup: null };

  let text = '';
  let existed = false;
  try {
    if (fs.existsSync(envPath)) {
      text = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
      existed = true;
    }
  } catch (err) {
    throw new EnvWriteError(`读取 .env 失败：${err.message}`, 'READ_FAILED');
  }

  // 备份
  let backup = null;
  if (existed) {
    backup = `${envPath}.bak`;
    try {
      fs.writeFileSync(backup, text, 'utf8');
    } catch {
      backup = null; // 备份失败不阻断，但要如实告知
    }
  }

  const lines = text.split(/\r?\n/);
  const changed = [];
  const added = [];

  for (const { key, value } of entries) {
    const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    const idx = lines.findIndex((l) => re.test(l));
    const newLine = `${key}=${value}`;
    if (idx >= 0) {
      if (lines[idx] !== newLine) {
        lines[idx] = newLine;
        changed.push(key);
      }
    } else {
      lines.push(newLine);
      added.push(key);
    }
  }

  // 末尾保留一个换行
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out = lines.join('\r\n') + '\r\n';

  try {
    fs.writeFileSync(envPath, out, 'utf8');
  } catch (err) {
    throw new EnvWriteError(`写入 .env 失败：${err.message}`, 'WRITE_FAILED');
  }

  return { changed, added, backup };
}

export default setEnvValues;
