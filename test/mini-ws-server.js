/**
 * 最小 WebSocket 服务端（RFC6455）—— 仅用于测试 mock OneBot，零依赖。
 *
 * 不依赖 `ws` 包的原因：目标机器没有 `ws` 包，npm CLI 也不在 Node 运行时里。
 * 只实现测试需要的部分：握手、文本帧收发、ping/pong、close。
 * 不做分片聚合（消息都很小，且客户端不会分片）。
 */
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class MiniWebSocketServer {
  constructor() {
    /** @type {Set<import('node:net').Socket>} */
    this.clients = new Set();
    this.closed = false;
  }

  /** 挂到 http server 的 'upgrade' 事件上 */
  handleUpgrade(req, socket) {
    if (this.closed) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    socket.on('error', () => this.clients.delete(socket));
    socket.on('close', () => this.clients.delete(socket));

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = decodeFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.totalLength);
        if (frame.opcode === 0x8) {
          this.clients.delete(socket);
          socket.end(encodeFrame(Buffer.alloc(0), 0x8));
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(frame.payload, 0xa));
          continue;
        }
        if (frame.opcode === 0x1) {
          try {
            this.onMessage?.(JSON.parse(frame.payload.toString('utf8')), socket);
          } catch {
            /* 非法 JSON 忽略 */
          }
        }
      }
    });

    this.clients.add(socket);
    this.onOpen?.(socket);
  }

  /** 向所有已连接客户端广播一个 JSON 事件 */
  broadcast(obj) {
    const frame = encodeFrame(Buffer.from(JSON.stringify(obj), 'utf8'), 0x1);
    let n = 0;
    for (const c of this.clients) {
      if (c.destroyed) continue;
      try {
        c.write(frame);
        n += 1;
      } catch {
        this.clients.delete(c);
      }
    }
    return n;
  }

  get clientCount() {
    return this.clients.size;
  }

  close() {
    this.closed = true;
    for (const c of this.clients) {
      try {
        c.end(encodeFrame(Buffer.alloc(0), 0x8));
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}

/** 解析一帧；数据不足返回 null */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) === 0x80;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) === 0x80;
  let len = buf[1] & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    if (big > 1_000_000n) throw new Error('frame too large');
    len = Number(big);
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;

  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { fin, opcode, payload, totalLength: offset + len };
}

/** 编码一帧（服务端 → 客户端，不掩码） */
function encodeFrame(payload, opcode = 0x1) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

export default MiniWebSocketServer;
