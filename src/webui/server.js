/**
 * 控制台（WebUI）的 HTTP 服务。零依赖（仅使用 node:http / node:fs / node:path）。
 *
 * 安全设计（该界面可以修改人格、可以触发重载，因此必须限制访问）：
 *   1. 仅绑定 127.0.0.1 —— 局域网内其他机器无法连接
 *   2. 所有请求都需携带 token：?token=xxx 或 Cookie。
 *      首次通过带 token 的 URL 访问后会写入 Cookie，之后刷新无需再携带。
 *   3. token 自动生成，保存在 data/webui-token.txt；也可用 .env 的 WEBUI_TOKEN 固定
 *   4. 仅接受 GET/POST/DELETE，且请求体有大小上限
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_BODY = 512 * 1024; // 512 KB，足以容纳最长的人格正文

function readToken({ projectRoot, dataDir, envToken = '' }) {
  if (envToken) return { token: envToken, source: '.env' };
  const file = path.join(dataDir, 'webui-token.txt');
  try {
    if (fs.existsSync(file)) {
      const t = fs.readFileSync(file, 'utf8').trim();
      if (t) return { token: t, source: 'data/webui-token.txt' };
    }
  } catch {
    /* 读取失败，改用新生成的 token */
  }
  const t = crypto.randomBytes(6).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, t + '\n', 'utf8');
  } catch {
    /* 写入失败仍可使用，但每次重启令牌都会更换 */
  }
  return { token: t, source: 'generated' };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`JSON 解析失败：${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {{projectRoot:string, dataDir:string, pageFile:string, handlers:object,
 *          logger?:object, envToken?:string}} opts
 */
export function createWebUiServer(opts) {
  const { projectRoot, dataDir, pageFile, handlers, logger = null, envToken = '' } = opts;
  const { token, source } = readToken({ projectRoot, dataDir, envToken });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const cookies = parseCookies(req.headers.cookie);

    const send = (status, body, extraHeaders = {}) => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, {
        'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extraHeaders,
      });
      res.end(payload);
    };

    // ---- 鉴权 ----
    const given = url.searchParams.get('token') || cookies.dsh_webui || '';
    if (given !== token) {
      if (url.pathname.startsWith('/api/')) {
        return send(401, { error: '无效或缺失的 token' });
      }
      return send(
        401,
        `<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:40px;line-height:1.7">
         <h2>需要访问令牌</h2>
         <p>请用带 token 的地址打开：</p>
         <pre style="background:#f4f4f4;padding:12px;border-radius:6px">http://127.0.0.1:${server.address()?.port ?? ''}/?token=${token}</pre>
         <p style="color:#888">令牌来源：${source}。也可在 .env 中用 WEBUI_TOKEN 固定它。</p>
         </body>`,
      );
    }

    // 首次带 token 访问时写入 Cookie，之后刷新无需再携带
    const newCookie = cookies.dsh_webui === token ? {} : { 'Set-Cookie': `dsh_webui=${token}; Path=/; SameSite=Strict; Max-Age=31536000` };

    // ---- 路由 ----
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === 'GET /' || route === 'GET /index.html') {
        if (!fs.existsSync(pageFile)) return send(500, '找不到界面文件 webui/index.html');
        // 把 index.html 的修改时间作为「构建号」注入页面。
        // 作用：标签页停留在旧版本时能发现服务端已更新并提示刷新，
        // 避免出现「按钮点击无响应」且无法定位原因的情况。
        const build = String(fs.statSync(pageFile).mtimeMs);
        const html = fs.readFileSync(pageFile, 'utf8').replace('__BUILD__', build);
        return send(200, html, newCookie);
      }
      if (route === 'GET /favicon.ico') {
        res.writeHead(204);
        return res.end();
      }

      const h = handlers;
      let result;
      if (route === 'GET /api/config') result = h.config();
      else if (route === 'GET /api/status') result = await h.status();
      else if (route === 'GET /api/personas') result = h.listPersonas();
      else if (route === 'GET /api/usage') result = await h.usage();
      else if (route === 'GET /api/logs') result = h.logs(Object.fromEntries(url.searchParams));
      else if (route === 'POST /api/personas') result = h.savePersona(await readBody(req));
      else if (route === 'DELETE /api/personas') result = h.deletePersona(Object.fromEntries(url.searchParams));
      else if (route === 'POST /api/chat') result = await h.chat(await readBody(req));
      else if (route === 'POST /api/chat/reset') result = h.resetChat(await readBody(req));
      else if (route === 'POST /api/reload') result = h.reload();
      else if (route === 'POST /api/start') result = h.start();
      else if (route === 'POST /api/runtime') result = h.saveRuntime(await readBody(req));
      else if (route === 'POST /api/personas/design') result = await h.designPersona(await readBody(req));
      else return send(404, { error: `没有这个接口：${route}` });

      const headers = result.status === 200 ? newCookie : {};
      return send(result.status, result.body, headers);
    } catch (err) {
      logger?.error?.(`控制台处理 ${route} 出错：${err.message}`);
      return send(500, { error: err.message });
    }
  });

  server.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      /* 忽略 */
    }
  });

  return {
    server,
    token,
    tokenSource: source,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

export default createWebUiServer;
