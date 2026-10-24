/**
 * 人格文件的增删改查。
 *
 * 与 src/personas.js 的分工：
 *   personas.js  只负责「读」——机器人启动时把 personas/ 加载成列表
 *   本文件        负责「写」——WebUI 通过它新建 / 修改 / 删除人格文件
 *
 * 写文件时刻意保持「一个 JSON 一个文件」，不做汇总大文件：
 *   · 用户可以直接用编辑器改，也可以用 WebUI 改，两者不冲突
 *   · 坏掉一个不影响其它
 *
 * 安全约束（都很重要）：
 *   1. id 会被当文件名用 —— 必须过滤掉路径分隔符和 Windows 保留字符，
 *      否则可以通过 ../../ 写到项目外面去
 *   2. 以 _ 开头的文件是模板，不允许通过接口删改
 *   3. 保存前一定校验 systemPrompt 非空，否则机器人会把它当坏文件跳过
 */
import fs from 'node:fs';
import path from 'node:path';

/** Windows 上文件名非法字符 + 路径分隔符 + 控制字符 */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001F]/g;

export class PersonaError extends Error {
  constructor(message, code = 'PERSONA_ERROR') {
    super(message);
    this.code = code;
  }
}

/** 把任意名字整理成安全的文件名（不含扩展名） */
export function safeId(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new PersonaError('id 不能为空', 'EMPTY_ID');
  const cleaned = raw
    .replace(ILLEGAL, '')
    .replace(/\.+$/, '') // Windows 不允许以点结尾
    .replace(/\s+/g, '-')
    .replace(/^[_\-]+/, '') // 去掉开头的 _ 和 -（_ 是模板保留前缀）
    .trim();
  if (!cleaned) throw new PersonaError(`id「${raw}」里没有可用字符`, 'BAD_ID');
  if (cleaned.length > 64) throw new PersonaError('id 太长（上限 64 字符）', 'BAD_ID');
  return cleaned;
}

/** 校验一份人格数据，返回问题列表（空数组 = 没问题） */
export function validatePersona(input = {}) {
  const problems = [];
  const name = String(input.name ?? '').trim();
  const prompt = String(input.systemPrompt ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();

  if (!name) problems.push('显示名（name）不能为空');
  const promptLen = prompt.length;
  if (!promptLen) problems.push('人格正文（systemPrompt）不能为空');
  else if (promptLen < 10) problems.push(`人格正文太短（${promptLen} 字），模型很难稳定扮演，建议至少写 50 字`);
  else if (promptLen > 8000) problems.push(`人格正文过长（${promptLen} 字），会显著增加每次请求的开销，建议控制在 4000 字内`);

  if (input.aliases !== undefined && !Array.isArray(input.aliases) && typeof input.aliases !== 'string') {
    problems.push('aliases 必须是数组或逗号分隔的字符串');
  }
  if (input.greeting !== undefined && String(input.greeting).length > 500) {
    problems.push('greeting 过长（上限 500 字）');
  }
  return problems;
}

/** 把接口传来的原始字段整理成规范的 persona 对象 */
export function normalizePersona(input = {}, fallbackId = null) {
  const id = safeId(input.id ?? fallbackId ?? input.name);
  const aliasesRaw = input.aliases;
  const aliases = (
    Array.isArray(aliasesRaw)
      ? aliasesRaw
      : String(aliasesRaw ?? '')
          .split(/[,，]/)
          .map((s) => s.trim())
  )
    .map((s) => String(s).trim())
    .filter(Boolean);

  return {
    id,
    name: String(input.name ?? id).trim(),
    aliases: [...new Set(aliases)],
    description: String(input.description ?? '').trim(),
    greeting: String(input.greeting ?? '').trim(),
    systemPrompt: String(input.systemPrompt ?? '').replace(/\s*\r?\n\s*/g, ' ').trim(),
  };
}

export class PersonaStore {
  /**
   * @param {{dir:string, logger?:object}} opts
   */
  constructor({ dir, logger = null } = {}) {
    if (!dir) throw new PersonaError('未配置 personasDir', 'NO_DIR');
    this.dir = dir;
    this.log = logger;
  }

  /** 目录里的所有 .json（含 _ 开头的模板），返回文件名与是否可编辑 */
  files() {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((n) => n.toLowerCase().endsWith('.json'))
      .sort()
      .map((name) => {
        const full = path.join(this.dir, name);
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(full);
          size = st.size;
          mtime = st.mtimeMs;
        } catch {
          /* 忽略读取失败 */
        }
        return {
          file: name,
          id: path.basename(name, '.json'),
          template: name.startsWith('_'),
          size,
          mtime,
        };
      });
  }

  /** 读一个文件（按 id 或文件名） */
  read(idOrFile) {
    const info = this.#locate(idOrFile);
    if (!info) return null;
    try {
      const text = fs.readFileSync(path.join(this.dir, info.file), 'utf8').replace(/^\uFEFF/, '');
      const raw = JSON.parse(text);
      const persona = normalizePersona({ ...raw, id: raw.id || info.id }, info.id);
      return { ...info, ...persona, raw };
    } catch (err) {
      throw new PersonaError(`读取 ${info.file} 失败：${err.message}`, 'READ_FAILED');
    }
  }

  /** 列出全部（模板文件也返回，但标记 template:true，前端置灰） */
  list() {
    const out = [];
    for (const f of this.files()) {
      try {
        const p = this.read(f.file);
        if (p) out.push(p);
      } catch (err) {
        out.push({ ...f, broken: true, error: err.message });
      }
    }
    return out;
  }

  /**
   * 新建或覆盖一个人格。
   * @param {object} input 来自接口的原始字段
   * @param {{originalId?:string}} [opts] originalId 用于「改了 id 相当于重命名」
   */
  save(input = {}, { originalId = null } = {}) {
    const problems = validatePersona(input);
    if (problems.length) throw new PersonaError(problems.join('；'), 'INVALID');

    const persona = normalizePersona(input, originalId);
    const target = path.join(this.dir, `${persona.id}.json`);

    // 防越界：最终路径必须落在 personas 目录里
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(this.dir) + path.sep)) {
      throw new PersonaError('目标路径超出 personas 目录，已拒绝', 'OUT_OF_DIR');
    }

    // 不允许覆盖模板文件（_ 前缀）
    if (path.basename(resolved).startsWith('_')) {
      throw new PersonaError('以 _ 开头的文件是模板，不通过接口修改', 'IS_TEMPLATE');
    }

    // 改了 id 且原文件存在 → 相当于重命名，删掉旧文件
    if (originalId && originalId !== persona.id) {
      const old = this.#locate(originalId);
      if (old && !old.template) {
        const oldPath = path.join(this.dir, old.file);
        if (path.resolve(oldPath) !== resolved) {
          try {
            fs.rmSync(oldPath);
          } catch (err) {
            this.log?.warn?.(`重命名时删除旧文件失败：${err.message}`);
          }
        }
      }
    }

    fs.mkdirSync(this.dir, { recursive: true });
    const payload = {
      id: persona.id,
      name: persona.name,
      ...(persona.aliases.length ? { aliases: persona.aliases } : {}),
      ...(persona.description ? { description: persona.description } : {}),
      ...(persona.greeting ? { greeting: persona.greeting } : {}),
      systemPrompt: persona.systemPrompt,
    };
    fs.writeFileSync(resolved, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    this.log?.info?.(`人格已保存：${path.basename(resolved)}`);
    return this.read(persona.id);
  }

  /** 删除一个人格文件 */
  remove(idOrFile) {
    const info = this.#locate(idOrFile);
    if (!info) throw new PersonaError(`找不到人格「${idOrFile}」`, 'NOT_FOUND');
    if (info.template) throw new PersonaError('模板文件不允许删除', 'IS_TEMPLATE');
    const full = path.resolve(path.join(this.dir, info.file));
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) {
      throw new PersonaError('路径超出 personas 目录，已拒绝', 'OUT_OF_DIR');
    }
    fs.rmSync(full);
    this.log?.info?.(`人格已删除：${info.file}`);
    return { deleted: info.file };
  }

  /** 按 id 或文件名定位 */
  #locate(idOrFile) {
    const want = String(idOrFile ?? '').trim();
    if (!want) return null;
    const all = this.files();
    return (
      all.find((f) => f.file === want) ??
      all.find((f) => f.file === `${want}.json`) ??
      all.find((f) => f.id.toLowerCase() === want.toLowerCase()) ??
      null
    );
  }
}

export default PersonaStore;
