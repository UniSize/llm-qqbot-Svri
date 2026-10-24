/**
 * 本地 mock OneBot 11 服务：离线测试 QQ 桥接，不需要真的 QQ / NapCat。
 *
 *   node test/mock-onebot-server.js [port]
 *
 * 提供：
 *   HTTP  POST /get_login_info | /send_private_msg | /send_group_msg | /get_group_list ...
 *   WS    ws://127.0.0.1:<port>/   —— 连上后可通过 pushMessage() 推事件
 *
 * 鉴权：设置 access_token 后，请求必须带 Authorization: Bearer <token>，
 *       WebSocket 必须带 ?access_token=<token>，否则返回 401 / 拒绝握手。
 */
import http from 'node:http';
import { MiniWebSocketServer } from './mini-ws-server.js';

export function createMockOneBot({ accessToken = '', selfId = 10001, nickname = '机器人' } = {}) {
  const state = {
    calls: [],
    sent: [],
    requests: 0,
    unauthorized: 0,
  };
  const wss = new MiniWebSocketServer();

  const server = http.createServer((req, res) => {
    state.requests += 1;

    // 鉴权
    if (accessToken) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${accessToken}`) {
        state.unauthorized += 1;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'failed', retcode: 1403, message: 'token 校验失败' }));
        return;
      }
    }

    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'failed', retcode: 1400, message: 'invalid json' }));
        return;
      }

      const action = (req.url || '/').replace(/^\/+/, '').split('?')[0];
      state.calls.push({ action, body });

      const reply = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data, echo: body.echo ?? null }));
      };

      switch (action) {
        case 'get_login_info':
          return reply({ user_id: selfId, nickname });
        case 'get_version_info':
          return reply({ app_name: 'mock-onebot', app_version: '1.0.0', protocol_version: 'v11' });
        case 'get_group_list':
          return reply([{ group_id: 20001, group_name: '测试群' }]);
        case 'send_private_msg': {
          const text = segmentsToText(body.message);
          state.sent.push({ type: 'private', user_id: body.user_id, text });
          return reply({ message_id: state.sent.length });
        }
        case 'send_group_msg': {
          const text = segmentsToText(body.message);
          state.sent.push({ type: 'group', group_id: body.group_id, text });
          return reply({ message_id: state.sent.length });
        }
        default:
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'failed', retcode: 1404, message: `unknown action: ${action}` }));
      }
    });
  });

  /** 模拟框架上报一条消息事件 */
  function pushMessage(event) {
    return wss.broadcast({ post_type: 'message', self_id: selfId, time: Math.floor(Date.now() / 1000), ...event });
  }

  /** 构造一条私聊事件 */
  function privateEvent({ userId = 10086, text = '你好', messageId = Math.floor(Math.random() * 1e6), nickname: nick = '小王', segments = null } = {}) {
    return {
      message_type: 'private',
      sub_type: 'friend',
      message_id: messageId,
      user_id: userId,
      raw_message: text,
      message: segments ?? [{ type: 'text', data: { text } }],
      sender: { user_id: userId, nickname: nick },
    };
  }

  /** 构造一条群聊事件；mention 为 true 时插入 at 机器人段 */
  function groupEvent({ groupId = 20001, userId = 10086, text = '你好', mention = false, nickname: nick = '小王', segments = null } = {}) {
    const segs = segments ?? [
      ...(mention ? [{ type: 'at', data: { qq: String(selfId) } }, { type: 'text', data: { text: ' ' } }] : []),
      { type: 'text', data: { text } },
    ];
    return {
      message_type: 'group',
      sub_type: 'normal',
      message_id: Math.floor(Math.random() * 1e6),
      group_id: groupId,
      user_id: userId,
      raw_message: text,
      message: segs,
      sender: { user_id: userId, nickname: nick, card: '' },
    };
  }

  return {
    state,
    wss,
    server,
    pushMessage,
    privateEvent,
    groupEvent,
    listen(port = 0) {
      return new Promise((resolve) => {
        server.on('upgrade', (req, socket) => {
          if (accessToken) {
            const url = new URL(req.url, 'http://127.0.0.1');
            if (url.searchParams.get('access_token') !== accessToken) {
              state.unauthorized += 1;
              socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
              socket.destroy();
              return;
            }
          }
          wss.handleUpgrade(req, socket);
        });
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          resolve({
            port: addr.port,
            httpUrl: `http://127.0.0.1:${addr.port}`,
            wsUrl: `ws://127.0.0.1:${addr.port}`,
            close: () =>
              new Promise((r) => {
                wss.close();
                server.close(() => r());
              }),
          });
        });
      });
    },
  };
}

function segmentsToText(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message
    .map((s) => (s?.type === 'text' ? s.data?.text ?? '' : `[${s?.type}]`))
    .join('');
}

// 直接运行
if (process.argv[1]?.endsWith('mock-onebot-server.js')) {
  const port = Number(process.argv[2] || 5700);
  const token = process.env.ONEBOT_TOKEN || '';
  const mock = createMockOneBot({ accessToken: token });
  const info = await mock.listen(port);
  console.log(`[mock-onebot] HTTP ${info.httpUrl}  WS ${info.wsUrl}  token=${token ? '已启用' : '无'}`);
}
