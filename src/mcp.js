'use strict';

// 最小 stdio MCP サーバ（JSON-RPC 2.0 / Content-Length フレーミング）。
// Phase 1: status / set_enabled を Claude から叩けるようにする薄い窓口。
// 実反映は Stop フックが担うため、ここは補助的な操作のみ。

const config = require('./config');

const SERVER_INFO = { name: 'tokiori', version: '0.1.0' };

const TOOLS = [
  { name: 'tokiori_status', description: 'tokiori 連携の状態（有効/ログイン/最終反映）を返す', inputSchema: { type: 'object', properties: {} } },
  { name: 'tokiori_set_enabled', description: 'タイムライン自動反映の ON/OFF を切替', inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] } },
];

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function result(id, res) { send({ jsonrpc: '2.0', id, result: res }); }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return result(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (method === 'notifications/initialized') return; // 通知（応答不要）
  if (method === 'tools/list') return result(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      if (name === 'tokiori_status') {
        const cfg = config.load();
        const text = JSON.stringify({ enabled: cfg.enabled, loggedIn: !!(cfg.auth && cfg.auth.refreshToken), userId: cfg.userId, env: cfg.endpoints.env }, null, 2);
        return result(id, { content: [{ type: 'text', text }] });
      }
      if (name === 'tokiori_set_enabled') {
        const cfg = config.load();
        cfg.enabled = !!args.enabled;
        config.save(cfg);
        return result(id, { content: [{ type: 'text', text: `enabled=${cfg.enabled}` }] });
      }
      return error(id, -32602, `unknown tool: ${name}`);
    } catch (e) {
      return result(id, { isError: true, content: [{ type: 'text', text: String(e && e.message || e) }] });
    }
  }
  if (typeof id !== 'undefined') return error(id, -32601, `method not found: ${method}`);
}

// Content-Length フレーミングのパーサ。
function start() {
  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf('\r\n\r\n');
      if (sep === -1) return;
      const header = buf.slice(0, sep).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { buf = buf.slice(sep + 4); continue; }
      const len = Number(m[1]);
      const start = sep + 4;
      if (buf.length < start + len) return;
      const body = buf.slice(start, start + len).toString('utf8');
      buf = buf.slice(start + len);
      let msg;
      try { msg = JSON.parse(body); } catch (_) { continue; }
      try { handle(msg); } catch (_) { /* 1件の失敗で落とさない */ }
    }
  });
  process.stdin.resume();
}

module.exports = { start };
