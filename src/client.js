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

module.exports = { postManualUpdate };
