/**
 * 控制台（WebUI）的接口实现。由 src/webui/server.js 调用。
 *
 * 设计原则：
 *   · 每个 handler 返回 { status, body }，由 server 负责序列化
 *   · 出错不抛到 server，统一转成 { status:4xx/5xx, body:{ error } }
 *   · 「测试对话」与机器人使用同一份 DeepSeek 配置，测试结果与线上一致
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PersonaStore, PersonaError, validatePersona } from '../persona-store.js';
import { loadConfig, AI_PRESETS } from '../config.js';
import { LlmClient } from '../llm.js';
import { collectStatus } from './status.js';
import { setEnvValues, EnvWriteError } from '../env-write.js';

/** 测试对话的会话历史（仅保存在内存中，控制台重启后清空） */
const chatSessions = new Map();


/** 定位一键启动脚本 start-bot.ps1（通常位于项目上一级目录） */
export function findLauncher(projectRoot) {
  const candidates = [
    process.env.LAUNCHER_PATH,
    path.join(projectRoot, '..', 'start-bot.ps1'),
    path.join(projectRoot, 'start-bot.ps1'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return path.resolve(c);
    } catch {
      /* 忽略 */
    }
  }
  return null;
}

export function createHandlers({ projectRoot, logger = null }) {
  const cfg = loadConfig();
  const store = new PersonaStore({ dir: cfg.behavior.personasDir, logger });

  // 客户端按需创建：若在构造阶段就实例化，未配置 DEEPSEEK_API_KEY 时会直接抛错，
  // 导致连「状态」页面都无法打开——而查看状态恰是最需要页面可用的场景。
  let clientRef = null;
  const getClient = () => {
    if (clientRef) return clientRef;
    if (!cfg.ai.apiKey) {
      throw new Error('未配置 DEEPSEEK_API_KEY，无法试聊。请在 .env 中填写后重载。');
    }
    clientRef = new LlmClient({
      apiKey: cfg.ai.apiKey,
      baseUrl: cfg.ai.baseUrl,
      model: cfg.ai.model,
      temperature: cfg.ai.temperature,
      maxTokens: cfg.ai.maxTokens,
      timeoutMs: cfg.ai.timeoutMs,
      maxRetries: 1,
      stream: false,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    return clientRef;
  };

  let balanceCache = null;

  const ok = (body) => ({ status: 200, body });
  const fail = (status, error) => ({ status, body: { error } });

  return {
    /** 只暴露非敏感字段（不返回 API Key） */
    config: () => {
      const key = cfg.ai.apiKey || '';
      return ok({
        model: cfg.ai.model,
        baseUrl: cfg.ai.baseUrl,
        apiKeyMasked: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '(未配置)',
        botName: cfg.bot.name,
        groupTrigger: cfg.behavior.groupTrigger,
        maxHistoryTurns: cfg.behavior.maxHistoryTurns,
        maxHistoryTokens: cfg.behavior.maxHistoryTokens ?? 0,
        rateLimitPerMinute: cfg.behavior.rateLimitPerMinute,
        personaDir: cfg.behavior.personasDir,
        defaultPersona: cfg.behavior.defaultPersona || '',
        persistSessions: cfg.storage.persistSessions,
        onebot: { httpUrl: cfg.onebot.httpUrl, wsUrl: cfg.onebot.wsUrl },
        // 服务端页面构建号，前端据此判断自身是否为旧版本
        pageBuild: (() => {
          try {
            return String(fs.statSync(path.join(projectRoot, 'webui', 'index.html')).mtimeMs);
          } catch {
            return null;
          }
        })(),
      });
    },

    status: async () =>
      ok(
        await collectStatus({
          projectRoot,
          dataDir: cfg.storage.dir,
          logDir: cfg.storage.logDir,
          personasDir: cfg.behavior.personasDir,
          onebot: {
            httpUrl: cfg.onebot.httpUrl,
            accessToken: cfg.onebot.accessToken,
          },
        }),
      ),

    listPersonas: () => {
      try {
        return ok({ personas: store.list() });
      } catch (err) {
        return fail(500, err.message);
      }
    },

    savePersona: (body = {}) => {
      try {
        const saved = store.save(body, { originalId: body.originalId || null });
        return ok({ persona: saved });
      } catch (err) {
        if (err instanceof PersonaError) return fail(400, err.message);
        return fail(500, err.message);
      }
    },

    deletePersona: (query = {}) => {
      try {
        return ok(store.remove(query.id));
      } catch (err) {
        if (err instanceof PersonaError) return fail(err.code === 'NOT_FOUND' ? 404 : 400, err.message);
        return fail(500, err.message);
      }
    },

    /**
     * 用指定人格试聊一句。使用与机器人相同的 DeepSeek 配置，
     * 结果与线上一致（差异：不受群聊 @ 规则、限流与记忆轮数影响）。
     */
    chat: async (body = {}) => {
      const personaId = String(body.personaId ?? '').trim();
      const message = String(body.message ?? '').trim();
      if (!message) return fail(400, '消息不能为空');

      let systemPrompt;
      let label;
      if (personaId) {
        const p = store.read(personaId);
        if (!p) return fail(404, `找不到人格「${personaId}」`);
        systemPrompt = p.systemPrompt;
        label = p.name;
      } else {
        // 未指定人格时使用 .env 中的兜底人格（单人格模式的行为）
        systemPrompt = cfg.bot.systemPrompt;
        label = cfg.bot.name;
      }
      if (!systemPrompt) return fail(400, '这个人格没有正文（systemPrompt）');

      const key = personaId || '__env__';
      if (body.reset) chatSessions.delete(key);
      const history = chatSessions.get(key) ?? [];

      const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: message },
      ];

      const started = Date.now();
      let client;
      try {
        client = getClient();
      } catch (err) {
        return fail(400, err.message);
      }
      try {
        const r = await client.chat(messages, {
          maxTokens: cfg.ai.maxTokens,
          stream: false,
        });
        const reply = String(r.content ?? '').trim();
        history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
        // 仅保留最近 20 轮，避免内存无限增长
        while (history.length > 40) history.splice(0, 2);
        chatSessions.set(key, history);
        return ok({
          persona: label,
          systemPromptPreview: systemPrompt.slice(0, 120),
          reply,
          elapsedMs: Date.now() - started,
          turns: history.length / 2,
          usage: r.usage ?? null,
        });
      } catch (err) {
        return fail(502, `调用模型失败：${err.message}`);
      }
    },

    resetChat: (body = {}) => {
      chatSessions.delete(String(body.personaId ?? '__env__'));
      return ok({ reset: true });
    },

    /**
     * 一键启动整套：QQ + NapCat + 机器人 + 看门狗。
     *
     * 直接复用项目已有的 start-bot.ps1，不重复实现启动逻辑：
     *   · 该脚本已支持「按需注入」「跳过已在运行的组件」「弹出系统通知」
     *   · 注入需要管理员权限，脚本会自行弹出 UAC 窗口；网页侧只能**触发**启动，
     *     实际授权需在弹窗中确认。因此不能以 hidden 方式启动，必须保留可见窗口，
     *     否则 UAC 弹窗未被处理时会一直阻塞。
     */
    start: () => {
      const launcher = findLauncher(projectRoot);
      if (!launcher) {
        return fail(
          500,
          '找不到 start-bot.ps1。该文件通常与本项目同级（Workshop\\start-bot.ps1）；' +
            '也可在本项目的 .env 中用 LAUNCHER_PATH 指定绝对路径。',
        );
      }
      try {
        // cmd /c start 会新开一个控制台窗口：UAC 弹窗与自检进度都在该窗口中显示。
        // 注意：路径**不应自行加引号**。cmd 会重新解析整条命令行，再叠加 Node 自身的
        // 转义，会变成 ""C:\...\start-bot.ps1"" 这类畸形参数，导致 start 不启动任何
        // 进程，且 stdio:'ignore' 会吞掉报错信息。
        // 实测：不加引号（路径不含空格）在 detached + ignore 下工作正常。
        const child = spawn(
          'cmd',
          ['/c', 'start', '', 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher],
          { detached: true, stdio: 'ignore', cwd: path.dirname(launcher), windowsHide: false },
        );
        child.unref();
        logger?.info?.(`控制台触发了一键启动：${launcher}`);
        return ok({
          started: true,
          launcher,
          note: '已打开启动窗口。若需注入 NapCat，会弹出 UAC 授权窗口，请点击「是」。完成后本页状态会自动更新。',
        });
      } catch (err) {
        return fail(500, `启动失败：${err.message}`);
      }
    },

    /**
     * 修改「运行参数」，目前仅开放记忆轮数、历史 token 上限与限流。
     *
     * 仅开放这三项的原因：取值均为纯数字，填写错误不会导致机器人无法启动。
     * API Key、接入方式等改错会直接造成启动失败的项，仍需手动编辑 .env。
     * 写入前自动备份为 .env.bak，且只按 key 替换对应行，保留原有注释与顺序。
     */
    saveRuntime: (body = {}) => {
      const envPath = path.join(projectRoot, '.env');
      const values = {};
      if (body.maxHistoryTurns !== undefined && body.maxHistoryTurns !== '') {
        const n = Number(body.maxHistoryTurns);
        if (!Number.isInteger(n) || n < 0 || n > 2000) return fail(400, '记忆轮数需为 0–2000 的整数');
        values.MAX_HISTORY_TURNS = String(n);
      }
      if (body.maxHistoryTokens !== undefined && body.maxHistoryTokens !== '') {
        const n = Number(body.maxHistoryTokens);
        if (!Number.isInteger(n) || n < 0 || n > 900000) return fail(400, '历史 token 上限需为 0–900000 的整数（0 = 不限）');
        values.MAX_HISTORY_TOKENS = String(n);
      }
      if (body.rateLimitPerMinute !== undefined && body.rateLimitPerMinute !== '') {
        const n = Number(body.rateLimitPerMinute);
        if (!Number.isInteger(n) || n < 0 || n > 600) return fail(400, '限流需为 0–600 的整数（0 = 不限）');
        values.RATE_LIMIT_PER_MINUTE = String(n);
      }
      if (!Object.keys(values).length) return fail(400, '没有要改的项');
      try {
        const r = setEnvValues(envPath, values);
        logger?.info?.(`运行参数已写回 .env：${JSON.stringify(values)}`);
        return ok({
          ...r,
          values,
          note: '已写入 .env。需点击「重载机器人」后生效（.env 仅在启动时读取一次）。',
        });
      } catch (err) {
        if (err instanceof EnvWriteError) return fail(400, err.message);
        return fail(500, err.message);
      }
    },

    /**
     * 自主设计人格：用户只提供「作品来源 + 角色名」，由模型写出完整设定。
     *
     * 内容边界（写入提示词，同时在此说明）：
     *   仅生成**正常向、全年龄**的聊天人格，不产出任何性内容。
     *   若角色出自成人向作品，只抽取其非成人向的性格内核（性格、语气、人际关系）。
     */
    designPersona: async (body = {}) => {
      const source = String(body.source ?? '').trim();
      const name = String(body.name ?? '').trim();
      if (!source) return fail(400, '请填写「作品来源」（例如：Fate/Grand Order）');
      if (!name) return fail(400, '请填写「角色名称」（例如：摩根）');

      let client;
      try {
        client = getClient();
      } catch (err) {
        return fail(400, err.message);
      }

      const meta = [
        '你是一个角色设定助手。用户会给你一个作品来源和一个角色名，',
        '请你据此写一份「聊天机器人人格设定」。',
        '',
        '硬性要求：',
        '· 只做正常向、全年龄的聊天人设。绝对不要写任何性内容、露骨描写或成人向设定。',
        '· 如果这个角色只出自成人向作品，就只抽取其非成人向的性格内核',
        '  （性格、语气、人际关系、在意的事），不写任何性相关内容。',
        '· 忠于原作：性格、说话方式、对用户的称呼、人际关系、标志性习惯都要对得上。',
        '· 不要复述剧情。重点写「这个角色怎么说话、怎么想、在意什么」。',
        '· 如果对某个细节没把握，就写得保守一点，不要编造具体台词或设定。',
        '',
        'systemPrompt 的写法（中文，200–450 字，一段连贯说明）：',
        '  你是谁、什么身份；什么性格；怎么称呼对方；说话的长短和语气；',
        '  有哪些习惯或口癖；不要做什么。',
        '',
        '只输出一个 JSON，不要任何其它文字、不要代码块标记：',
        '{"name":"...","aliases":["...","..."],"description":"一行简介","greeting":"一句开场白","systemPrompt":"..."}',
      ].join('\n');

      try {
        const r = await client.chat(
          [
            { role: 'system', content: meta },
            { role: 'user', content: `作品来源：${source}\n角色名称：${name}` },
          ],
          { maxTokens: 1600, stream: false },
        );
        let raw = String(r.content ?? '').trim();
        // 容忍模型偶尔套一层代码块
        raw = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start < 0 || end <= start) return fail(502, '模型未返回合法 JSON，请重试或调整描述');
        const draft = JSON.parse(raw.slice(start, end + 1));

        // 复用同一套校验，避免生成空正文或超长内容
        const candidate = {
          name: String(draft.name || name).trim(),
          aliases: draft.aliases ?? [],
          description: String(draft.description ?? '').trim(),
          greeting: String(draft.greeting ?? '').trim(),
          systemPrompt: String(draft.systemPrompt ?? '').trim(),
        };
        const problems = validatePersona(candidate);
        return ok({
          draft: candidate,
          problems,
          usage: r.usage ?? null,
          note: '这是草稿，确认无误后再点击「保存」。内容不合适可以直接修改。',
        });
      } catch (err) {
        return fail(502, `生成失败：${err.message}`);
      }
    },

    /**
     * 用量与余额。
     *
     * 三个来源：
     *   机器人     ← 读 data/usage.json（机器人进程自己在写，见 src/usage-tracker.js）
     *   控制台试聊 ← 本进程内存里的 client.usage
     *   账户余额   ← 调用 DeepSeek 的 /user/balance（缓存 60 秒，不每次请求）
     */
    usage: async () => {
      const out = {
        bot: null,
        console: null,
        balance: null,
        balanceError: null,
      };

      // 1) 机器人（独立进程写的）
      if (cfg.storage.persistSessions) {
        try {
          const f = path.join(cfg.storage.dir, 'usage.json');
          if (!fs.existsSync(f)) {
            out.bot = { pending: true }; // 已开启落盘但机器人尚未写入，重启后开始统计
          } else {
            const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
            out.bot = {
              session: j.session ?? null,
              lifetime: j.lifetime ?? null,
              cacheHitRate: j.cacheHitRate ?? null,
              sessionStartedAt: j.sessionStartedAt ?? null,
              updatedAt: j.updatedAt ?? null,
            };
          }
        } catch (err) {
          out.bot = { error: err.message };
        }
      }

      // 2) 控制台自己的试聊用量
      try {
        const c = getClient();
        const u = c.usage;
        out.console = {
          requests: u.requests,
          promptTokens: u.promptTokens,
          completionTokens: u.completionTokens,
          cacheHitTokens: u.cacheHitTokens,
          cacheMissTokens: u.cacheMissTokens,
          costCNY: c.estimateCostCNY(),
          cacheHitRate: c.cacheHitRate(),
        };
      } catch {
        out.console = null; // 未配置 Key 或尚未试聊
      }

      // 3) 账户余额（60 秒缓存）
      const now = Date.now();
      if (balanceCache && now - balanceCache.at < 60_000) {
        out.balance = balanceCache.value;
      } else if (!AI_PRESETS[cfg.ai.provider || 'deepseek']?.balance) {
        // 只有部分服务商提供余额查询接口，其余如实说明而不是显示 0
        out.balanceError = `当前服务商（${cfg.ai.provider || 'deepseek'}）未提供余额查询接口`;
      } else if (!cfg.ai.apiKey) {
        out.balanceError = '未配置 API Key';
      } else {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 6000);
        try {
          const res = await fetch(`${String(cfg.ai.baseUrl).replace(/\/+$/, '')}/user/balance`, {
            headers: { Authorization: `Bearer ${cfg.ai.apiKey}` },
            signal: ctl.signal,
          });
          const j = await res.json();
          if (res.ok && j?.balance_infos?.length) {
            const b = j.balance_infos[0];
            out.balance = {
              available: j.is_available !== false,
              currency: b.currency,
              total: Number(b.total_balance),
              granted: Number(b.granted_balance),
              toppedUp: Number(b.topped_up_balance),
            };
            balanceCache = { at: now, value: out.balance };
          } else {
            out.balanceError = j?.error?.message || `查询失败 HTTP ${res.status}`;
          }
        } catch (err) {
          out.balanceError = err.name === 'AbortError' ? '查询超时' : err.message;
        } finally {
          clearTimeout(timer);
        }
      }

      return ok(out);
    },

    /** 触发一次重载（复用项目根目录的 reload.ps1） */
    reload: () => {
      const script = path.join(projectRoot, 'reload.ps1');
      if (!fs.existsSync(script)) return fail(500, `找不到 ${script}`);
      try {
        // detached + unref：reload.ps1 会终止当前机器人并重新启动，
        // 不应挂在本控制台进程下
        const child = spawn(
          'powershell',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
          { detached: true, stdio: 'ignore', windowsHide: true },
        );
        child.unref();
        logger?.info?.('控制台触发了重载');
        return ok({ started: true, script });
      } catch (err) {
        return fail(500, `启动重载失败：${err.message}`);
      }
    },

    /** 读取日志尾部内容（供「日志」页签使用） */
    logs: (query = {}) => {
      const which = String(query.which ?? 'bot');
      const files = {
        bot: path.join(cfg.storage.logDir, 'bot-run.log'),
        launcher: path.join(cfg.storage.logDir, 'launcher.log'),
        watchdog: path.join(cfg.storage.logDir, 'watchdog.log'),
      };
      const file = files[which] ?? files.bot;
      const lines = Math.min(Math.max(Number(query.lines) || 100, 10), 500);
      try {
        if (!fs.existsSync(file)) return ok({ which, file, lines: [] });
        const all = fs
          .readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .filter((l) => l.length);
        return ok({ which, file, lines: all.slice(-lines) });
      } catch (err) {
        return fail(500, err.message);
      }
    },
  };
}

export default createHandlers;
