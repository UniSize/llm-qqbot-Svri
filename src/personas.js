/**
 * 多人格系统：从 personas/ 目录读取人格定义，供引擎按会话选择。
 *
 * 一个人的 JSON 长这样（见 personas/ 目录里的实际文件）：
 *   {
 *     "id": "enterprise",              // 唯一标识，用于 /人格 enterprise
 *     "name": "企业",                   // 显示名，也用于 /人格 企业
 *     "aliases": ["Enterprise", "大E"], // 额外可匹配的名字（同时会并入 @ 识别名单）
 *     "description": "碧蓝航线 · 已誓约",
 *     "systemPrompt": "你是……",         // 必须是单行字符串
 *     "greeting": "……"                  // 可选：切换过去时的一句回应
 *   }
 *
 * 为什么要独立成目录而不是全塞进 .env：
 *   1. .env 一行一个键，人设多了会变成一坨无法维护的长行
 *   2. 人格文本里的换行/引号/中文标点在 JSON 里有明确的转义规则，
 *      不会再出现「多行值被解析器吞掉」那类问题
 */
import fs from 'node:fs';
import path from 'node:path';

/** 读取目录下所有 *.json 人格定义；坏文件跳过并记进 errors，不影响其它人格 */
export function loadPersonas(dir, { logger } = {}) {
  const list = [];
  const errors = [];
  if (!dir || !fs.existsSync(dir)) return { list, errors };

  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    errors.push(`${dir}: ${err.message}`);
    return { list, errors };
  }

  for (const name of entries.sort()) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    if (name.startsWith('_')) continue; // _template.json 之类不进列表
    const full = path.join(dir, name);
    try {
      // 去掉 UTF-8 BOM：记事本 / PowerShell 的 Set-Content -Encoding UTF8 都会带上，
      // 而 JSON.parse 遇到 BOM 会直接抛错，人格会被静默跳过。
      const text = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '');
      const raw = JSON.parse(text);
      const id = String(raw.id || path.basename(name, '.json')).trim();
      const systemPrompt = String(raw.systemPrompt ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
      if (!systemPrompt) {
        errors.push(`${name}: 缺少 systemPrompt`);
        continue;
      }
      list.push({
        id,
        name: String(raw.name || id).trim(),
        aliases: Array.isArray(raw.aliases) ? raw.aliases.map((s) => String(s).trim()).filter(Boolean) : [],
        description: String(raw.description ?? '').trim(),
        systemPrompt,
        greeting: raw.greeting ? String(raw.greeting).trim() : '',
        file: name,
      });
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }

  for (const e of errors) logger?.warn?.(`人格文件有问题，已跳过 —— ${e}`);
  return { list, errors };
}

/**
 * 按 id / name / aliases 匹配人格。支持：
 *   - 精确匹配 id 或 name（忽略大小写）
 *   - 唯一的部分匹配（「企业」能匹配到 name 为「企业（已誓约）」的人格）
 *   - 序号（"1"、"2"）对应 /人格 列表里的编号
 * @returns {{persona?:object, error?:string, matches?:object[]}}
 */
export function matchPersona(list, query) {
  const q = String(query ?? '').trim();
  if (!q) return { error: 'empty' };
  const lower = q.toLowerCase();

  // 序号
  if (/^\d+$/.test(q)) {
    const i = Number(q) - 1;
    if (i >= 0 && i < list.length) return { persona: list[i] };
    return { error: 'no-such-index' };
  }

  // 精确：id 或 name
  const exact = list.find((p) => p.id.toLowerCase() === lower || p.name.toLowerCase() === lower);
  if (exact) return { persona: exact };

  // 精确：别名
  const byAlias = list.find((p) => p.aliases.some((a) => a.toLowerCase() === lower));
  if (byAlias) return { persona: byAlias };

  // 模糊：子串。多个命中时返回候选让调用方提示用户，不猜。
  const loose = list.filter(
    (p) =>
      p.id.toLowerCase().includes(lower) ||
      p.name.toLowerCase().includes(lower) ||
      p.aliases.some((a) => a.toLowerCase().includes(lower)),
  );
  if (loose.length === 1) return { persona: loose[0] };
  if (loose.length > 1) return { error: 'ambiguous', matches: loose };
  return { error: 'not-found' };
}

/** 渲染人格列表（不含标题，标题由调用方给，避免重复） */
export function formatPersonaList(list, currentId) {
  if (!list.length) return '还没有配置任何人格：请在 personas/ 目录里放 .json 文件。';
  const lines = [];
  list.forEach((p, i) => {
    const mark = p.id === currentId ? ' ← 当前' : '';
    const desc = p.description ? `（${p.description}）` : '';
    lines.push(`${i + 1}. ${p.name}${desc}${mark}`);
  });
  lines.push('', '发送「/人格 名字」或「/人格 序号」切换。');
  return lines.join('\n');
}

export default loadPersonas;
