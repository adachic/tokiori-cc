'use strict';

const crypto = require('crypto');
const fs = require('fs');

// Crockford base32（ULID 用）
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(now, len) {
  let str = '';
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % 32;
    str = ENC[mod] + str;
    now = Math.floor(now / 32);
  }
  return str;
}

function encodeRandom(len) {
  let str = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) {
    str += ENC[bytes[i] % 32];
  }
  return str;
}

// dashboard と同じく ULID 形式の sessionId を払い出す（時刻順ソート可能）。
function ulid(nowMs) {
  const t = typeof nowMs === 'number' ? nowMs : Date.now();
  return encodeTime(t, 10) + encodeRandom(16);
}

// sessionId から決まる 0..999 の決定的オフセット(ms)。
// ManualSession は SK=startMs のため、同一ミリ秒開始の別セッションが衝突して
// 上書き消失するのを防ぐ。同一セッションでは常に同じ値＝冪等。
function startOffset(sessionId) {
  let h = 0;
  const s = String(sessionId || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 1000;
}

// JWT のペイロード（base64url）をデコード。検証はしない（自分のトークン用）。
function decodeJwt(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
    return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

// Claude Code の transcript(JSONL) から最初のユーザー発話時刻(ms)を拾う。
// 取れなければ null。セッション開始時刻の推定に使う。
function firstUserTimestampMs(transcriptPath) {
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_) {
        continue;
      }
      const ts = obj && obj.timestamp;
      if (typeof ts === 'string') {
        const ms = Date.parse(ts);
        if (Number.isFinite(ms)) return ms;
      }
    }
  } catch (_) {
    /* transcript 読めなければ null */
  }
  return null;
}

// transcript から「編集/コマンド実行 等の tool_use が一度でもあったか」を判定。
// 読み取り専用/質問だけのセッションをスキップするための材料。
function hasMutatingToolUse(transcriptPath) {
  const MUT = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash', 'MultiEdit']);
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.includes('tool_use')) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_) {
        continue;
      }
      const content = obj && obj.message && obj.message.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c && c.type === 'tool_use' && MUT.has(c.name)) return true;
      }
    }
  } catch (_) {
    /* 不明なら true 寄りにしたいが、ここでは false を返し呼び出し側で既定判断 */
  }
  return false;
}

// cwd から git リポジトリのルートを探す（.git を持つ最も近い祖先）。
// 見つからなければ null。repoMap のキー（ディレクトリ名）の安定化に使う。
function gitRoot(cwd) {
  const path = require('path');
  let dir = String(cwd || '');
  for (let i = 0; i < 40 && dir && dir !== path.dirname(dir); i++) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
    } catch (_) { /* noop */ }
    dir = path.dirname(dir);
  }
  return null;
}

// transcript の最初のユーザー発話テキストを取り出す（LLM 分類のヒント用）。
function firstUserText(transcriptPath) {
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (!obj || obj.type !== 'user') continue;
      const c = obj.message && obj.message.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        const t = c.find((x) => x && x.type === 'text');
        if (t && typeof t.text === 'string') return t.text;
      }
    }
  } catch (_) { /* noop */ }
  return '';
}

module.exports = { ulid, startOffset, decodeJwt, firstUserTimestampMs, hasMutatingToolUse, firstUserText, gitRoot };
