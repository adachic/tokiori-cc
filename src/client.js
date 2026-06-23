'use strict';

const auth = require('./auth');

// POST {trackApi}/manual/update?userId=... に完了済みセッションを upsert。
async function postManualUpdate(cfg, payload) {
  const idToken = await auth.getIdToken(cfg);
  const url = `${cfg.endpoints.trackApi}/manual/update?userId=${encodeURIComponent(cfg.userId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`manual/update HTTP ${res.status}: ${text}`);
  return text;
}

// タイムライン（ManualSession v2）を GraphQL listManualLogs で読み取り。
// sinceMs 以降のエントリを body 展開して返す。ページングは自動で辿る。
const LIST_QUERY =
  'query($u:ID!,$s:AWSTimestamp,$l:Int,$t:String){' +
  ' listManualLogs(userId:$u, since:$s, limit:$l, nextToken:$t){ items{ ts body sessionId } nextToken } }';

async function listManualLogs(cfg, sinceMs, opts) {
  opts = opts || {};
  const limit = opts.limit || 200;
  const maxPages = opts.maxPages || 20;
  const token = await auth.getIdToken(cfg);
  const out = [];
  let nextToken = null;
  for (let i = 0; i < maxPages; i++) {
    const res = await fetch(cfg.endpoints.appsyncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ query: LIST_QUERY, variables: { u: cfg.userId, s: sinceMs, l: limit, t: nextToken } }),
    });
    const j = await res.json().catch(() => ({}));
    if (j.errors) throw new Error('listManualLogs: ' + JSON.stringify(j.errors).slice(0, 200));
    const conn = (j.data && j.data.listManualLogs) || { items: [], nextToken: null };
    for (const it of conn.items || []) {
      let b;
      try { b = typeof it.body === 'string' ? JSON.parse(it.body) : it.body; } catch (_) { b = {}; }
      out.push({
        sessionId: it.sessionId || b.sessionId,
        startMs: b.startMs,
        endMs: b.endMs,
        title: b.title || '',
        categoryPath: b.categoryPath || '',
        memo: b.memo || '',
        durationSeconds: b.durationSeconds,
        status: b.status,
      });
    }
    nextToken = conn.nextToken;
    if (!nextToken) break;
  }
  return out;
}

module.exports = { postManualUpdate, listManualLogs };
