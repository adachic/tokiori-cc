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

// ローカル時刻でその ms の属する日の 0:00 の ms。
function localDayStartMs(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ローカル時刻の YYYY-MM-DD。
function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// transcript から sinceMs 以降で最初のメッセージ時刻(ms)。取れなければ null。
// sinceMs 省略時はセッション最初の時刻。
function firstUserTimestampMs(transcriptPath, sinceMs) {
  const since = Number.isFinite(sinceMs) ? sinceMs : -Infinity;
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      const ts = obj && obj.timestamp;
      if (typeof ts === 'string') {
        const ms = Date.parse(ts);
        if (Number.isFinite(ms) && ms >= since) return ms;
      }
    }
  } catch (_) { /* transcript 読めなければ null */ }
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

// スラッシュコマンド等の制御テキストを人間可読に整える。
// 例: "<command-name>/pr</command-name><command-message>pr-review</command-message>..." → "/pr"
function cleanUserText(s) {
  let t = String(s || '');
  const nameM = /<command-name>\s*([^<]+?)\s*<\/command-name>/i.exec(t);
  if (nameM) {
    let name = nameM[1].trim();
    if (!name.startsWith('/')) name = '/' + name.replace(/^\/+/, '');
    return name;
  }
  // 各種タグ/ラッパを除去
  t = t.replace(/<command-[a-z-]+>/gi, ' ').replace(/<\/command-[a-z-]+>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

// transcript から sinceMs 以降の最初のユーザー発話テキスト（整形済み・分類/タイトル用）。
function firstUserText(transcriptPath, sinceMs) {
  const since = Number.isFinite(sinceMs) ? sinceMs : -Infinity;
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (!obj || obj.type !== 'user') continue;
      const ms = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
      if (Number.isFinite(ms) && ms < since) continue;
      const c = obj.message && obj.message.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        const t = c.find((x) => x && x.type === 'text');
        if (t && typeof t.text === 'string') text = t.text;
      }
      const cleaned = cleanUserText(text);
      if (cleaned) return cleaned;
    }
  } catch (_) { /* noop */ }
  return '';
}

// transcript から sinceMs 以降のユーザー発話テキストを時系列で列挙（detail memo 用）。
// tool_result のみのメッセージは firstUserText 同様に除外。連続する同一発話はまとめる。
function userTextsSince(transcriptPath, sinceMs, opts) {
  opts = opts || {};
  const since = Number.isFinite(sinceMs) ? sinceMs : -Infinity;
  const maxEach = opts.maxEach || 120;   // 1指示あたりの最大長
  const maxCount = opts.maxCount || 50;  // 収集する最大件数
  const out = [];
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (!obj || obj.type !== 'user' || obj.isMeta) continue;
      const ms = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
      if (Number.isFinite(ms) && ms < since) continue;
      const c = obj.message && obj.message.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        const t = c.find((x) => x && x.type === 'text');
        if (t && typeof t.text === 'string') text = t.text;
      }
      let cleaned = cleanUserText(text);
      if (!cleaned) continue;
      if (cleaned.length > maxEach) cleaned = cleaned.slice(0, maxEach) + '…';
      if (out.length && out[out.length - 1] === cleaned) continue;
      out.push(cleaned);
      if (out.length >= maxCount) break;
    }
  } catch (_) { /* noop */ }
  return out;
}

module.exports = { ulid, startOffset, decodeJwt, firstUserTimestampMs, hasMutatingToolUse, firstUserText, userTextsSince, cleanUserText, gitRoot, localDayStartMs, dayKey };
