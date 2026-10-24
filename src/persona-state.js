/**
 * 每个「聊天」的人格状态：选了哪个人格、是否正在等人选。
 *
 * key 用的是不含人格指纹的 baseKey（c:<用户> 或 r:<群>#<用户>），
 * 因为「选了哪个人格」这件事必须在人格确定**之前**就能查到。
 *
 * 状态可以落盘，这样重启机器人后不会又弹一次选择菜单。
 */
import fs from 'node:fs';
import path from 'node:path';

export class PersonaStateStore {
  /**
   * @param {{persistPath?:string|null, logger?:object}} [opts]
   */
  constructor({ persistPath = null, logger = null } = {}) {
    this.persistPath = persistPath;
    this.log = logger;
    /** @type {Map<string, {personaId?:string, awaiting?:boolean, updatedAt:number}>} */
    this.map = new Map();
    if (persistPath) this.#load();
  }

  get(key) {
    return this.map.get(key) ?? null;
  }

  /** 当前聊天选定的人格 id（没选返回 null） */
  personaIdOf(key) {
    return this.map.get(key)?.personaId ?? null;
  }

  /** 是否正在等用户选人格 */
  isAwaiting(key) {
    return this.map.get(key)?.awaiting === true;
  }

  /** 合并写入（personaId: null 表示清除选择） */
  set(key, patch = {}) {
    const cur = this.map.get(key) ?? {};
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    if (next.personaId === null) delete next.personaId;
    this.map.set(key, next);
    this.#save();
    return next;
  }

  clear(key) {
    this.map.delete(key);
    this.#save();
  }

  /** 某人已经被删除的人格 → 清掉选择，逼它重新选 */
  dropUnknown(validIds) {
    const valid = new Set(validIds);
    let dropped = 0;
    for (const [k, v] of this.map) {
      if (v.personaId && !valid.has(v.personaId)) {
        this.map.set(k, { ...v, awaiting: true, updatedAt: Date.now() });
        delete this.map.get(k).personaId;
        dropped += 1;
      }
    }
    if (dropped) {
      this.log?.warn?.(`有 ${dropped} 个聊天选择的人格已不存在，下次会重新询问`);
      this.#save();
    }
    return dropped;
  }

  get size() {
    return this.map.size;
  }

  #load() {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      for (const [k, v] of Object.entries(data?.chats ?? {})) {
        this.map.set(k, v);
      }
    } catch (err) {
      this.log?.warn?.(`人格状态读取失败，按空处理：${err.message}`);
    }
  }

  #save() {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const chats = {};
      for (const [k, v] of this.map) chats[k] = v;
      fs.writeFileSync(this.persistPath, JSON.stringify({ savedAt: Date.now(), chats }, null, 2));
    } catch (err) {
      this.log?.warn?.(`人格状态落盘失败：${err.message}`);
    }
  }
}

export default PersonaStateStore;
