/**
 * 人格实测：调用真实 DeepSeek 接口，检查每个人格的回复是否符合其设定。
 *
 *   node tools/test-personas-live.mjs            # 测全部人格
 *   node tools/test-personas-live.mjs 摩根        # 只测指定人格
 *
 * 会消耗少量 token（每个问题约几百 token 输入、几十 token 输出）。
 * 仅做单轮对话、不携带历史，便于对比不同人格对同一问题的反应。
 */
import { loadEnv } from '../src/env.js';
import { loadConfig } from '../src/config.js';
import { loadPersonas } from '../src/personas.js';
import { LlmClient } from '../src/llm.js';

loadEnv(process.cwd());
const cfg = loadConfig();

const PROBES = [
  '你是谁？',
  '我为什么要听你的？',
  '说个你讨厌的东西。',
  '今天有点累。',
];

const only = process.argv[2] ? String(process.argv[2]).trim() : null;
const { list } = loadPersonas(cfg.behavior.personasDir ?? './personas', {});
const targets = only
  ? list.filter((p) => p.id === only || p.name === only || p.aliases.includes(only))
  : list;

if (!targets.length) {
  console.log(only ? `没找到人格「${only}」` : 'personas/ 里没有可用人格');
  process.exit(1);
}

const client = new LlmClient({
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

console.log(`模型：${cfg.ai.model}`);
console.log(`人格：${targets.map((p) => p.name).join('、')}`);
console.log(`问题：${PROBES.join(' / ')}`);

for (const p of targets) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${p.name}  (${p.id})  —— ${p.description}`);
  console.log('═'.repeat(64));
  console.log(`system: ${p.systemPrompt.slice(0, 80)}…\n`);

  for (const q of PROBES) {
    try {
      const r = await client.chat(
        [
          { role: 'system', content: p.systemPrompt },
          { role: 'user', content: q },
        ],
        { maxTokens: cfg.ai.maxTokens, stream: false },
      );
      console.log(`👤 ${q}`);
      console.log(`🤖 ${String(r.content).trim()}\n`);
    } catch (err) {
      console.log(`👤 ${q}`);
      console.log(`⚠️  调用失败：${err.message}\n`);
    }
  }
}

console.log('═'.repeat(64));
console.log('用量：');
console.log(`  请求数        ${client.usage.requests}`);
console.log(`  输入 tokens   ${client.usage.promptTokens}（缓存命中 ${client.usage.cacheHitTokens}）`);
console.log(`  输出 tokens   ${client.usage.completionTokens}`);
console.log(`  估算花费      ¥${client.estimateCostCNY().toFixed(6)}`);
