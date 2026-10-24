/**
 * 文本工具：触发词剥离、长消息分片与 @ 提及判断。
 */

/** 按 maxLen 将文本切成多段，优先在段落、换行、句末标点处断开，尽量避免拆散代码块 */
export function splitText(text, maxLen = 1200) {
  const s = String(text ?? '');
  if (s.length <= maxLen) return s ? [s] : [];
  const parts = [];
  let rest = s;
  while (rest.length > maxLen) {
    let cut = -1;
    const window = rest.slice(0, maxLen);
    // 优先段落 → 换行 → 句末标点 → 空格
    for (const re of [/\n\n/g, /\n/g, /[。！？!?；;]/g, /[，,、\s]/g]) {
      let m;
      const last = { index: -1 };
      while ((m = re.exec(window)) !== null) {
        last.index = m.index + m[0].length;
        if (re.lastIndex === m.index) re.lastIndex += 1;
      }
      if (last.index > maxLen * 0.5) {
        cut = last.index;
        break;
      }
    }
    if (cut <= 0) cut = maxLen;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts.filter(Boolean);
}

/**
 * 去掉消息里的 @提及 和触发前缀。
 * @param {string} text
 * @param {{botName?:string, mentions?:string[]}} opts
 */
export function stripMention(text, { botName = '', mentions = [] } = {}) {
  let s = String(text ?? '');
  const names = new Set([botName, ...mentions, '所有人', 'All', 'all'].filter(Boolean));
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`@${esc}\\s*`, 'g'), ' ');
  }
  // 部分客户端会用 \u2005 包裹 @名字，一并清理
  s = s.replace(/@[^\s\u2005]{1,32}[\u2005]/g, ' ');
  s = s.replace(/\u2005/g, ' ');
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}

/** 判断消息是否 @ 了机器人 */
export function isMentioned(text, { botName = '', mentions = [] } = {}) {
  const s = String(text ?? '');
  const names = [botName, ...mentions].filter(Boolean);
  if (s.includes('@所有人') || /@all\b/i.test(s)) return true;
  return names.some((n) => s.includes(`@${n}`));
}

/** 生成适合手机阅读的「正在输入」占位文本 */
export function typingPlaceholder(name = '') {
  return name ? `${name} 正在思考…` : '正在思考…';
}

/** 粗略估算 token 数（中文约 1 字 1 token，英文约 4 字符 1 token） */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  for (const ch of s) if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk += 1;
  const other = s.length - cjk;
  return cjk + Math.ceil(other / 4);
}

export default splitText;
