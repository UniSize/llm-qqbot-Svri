/**
 * 本地 mock DeepSeek 服务：用于离线自测，不需要真实 API Key。
 * 启动：node test/mock-deepseek-server.js [port]
 *
 * 行为：
 *   - POST /v1/chat/completions 支持 stream / 非 stream
 *   - 如果请求头 Authorization 为 Bearer sk-bad → 返回 401
 *   - 如果 body.model === 'flaky-model' 且 header 'x-fail-times' 未耗尽 → 返回 503（测试重试）
 *   - 回复内容会把收到的对话轮数、用户最后一句原样带出来，方便断言上下文
 */
import http from 'node:http';

export function createMockServer() {
  const state = { requests: 0, flakyLeft: 0, lastBody: null };

  const server = http.createServer((req, res) => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }

    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      state.requests += 1;
      const auth = req.headers.authorization || '';
      if (auth.includes('sk-bad')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Authentication Fails, Your api key is invalid', type: 'authentication_error' } }));
        return;
      }

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid json' } }));
        return;
      }
      state.lastBody = body;

      // 模拟前 N 次失败
      const failTimes = Number(req.headers['x-fail-times'] || 0);
      if (failTimes > 0 && state.flakyLeft < failTimes) {
        state.flakyLeft += 1;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'server overloaded' } }));
        return;
      }

      const msgs = body.messages || [];
      const userTurns = msgs.filter((m) => m.role === 'user');
      const lastUser = userTurns.at(-1)?.content ?? '';
      const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
      const reply = `收到第${userTurns.length}轮:「${lastUser}」| 上下文消息数=${msgs.length} | 人设=${sys.slice(0, 6)}`;
      const usage = {
        prompt_tokens: Math.max(1, JSON.stringify(msgs).length >> 2),
        completion_tokens: Math.max(1, reply.length >> 1),
        total_tokens: 0,
      };
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

      if (body.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        // 把回复切成小块按 SSE 发出去，模拟真实流式
        const pieces = reply.match(/.{1,5}/gs) || [reply];
        for (const p of pieces) {
          res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: p }, index: 0 }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage,
        }),
      );
    });
  });

  return {
    server,
    state,
    /** @returns {Promise<{port:number, url:string, close:()=>Promise<void>}>} */
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          resolve({
            port: addr.port,
            url: `http://127.0.0.1:${addr.port}`,
            close: () => new Promise((r) => server.close(() => r())),
          });
        });
      });
    },
  };
}

// 直接运行时作为独立服务启动
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('mock-deepseek-server.js')) {
  const port = Number(process.argv[2] || 8788);
  const mock = createMockServer();
  const info = await mock.listen(port);
  console.log(`[mock-deepseek] listening on ${info.url}  (POST /v1/chat/completions)`);
}
