'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const auth = require('./auth');
const client = require('./client');
const pending = require('./pending');
const { ulid, startOffset, firstUserTimestampMs, firstUserText, gitRoot } = require('./util');
const { classify } = require('./categorize');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 3000); // フックを長く止めない
  });
}

function statePath(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(config.STATE_DIR, `${safe}.json`);
}

function loadState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8'));
  } catch (_) {
    return null;
  }
}

function saveState(sessionId, st) {
  config.ensureDirs();
  fs.writeFileSync(statePath(sessionId), JSON.stringify(st) + '\n');
}

// 入口。例外は決して投げない（Claude Code をブロックしないため常に exit 0）。
async function run(opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  try {
    const cfg = config.load();
    if (!cfg.enabled) return finish(dryRun, { skipped: 'disabled' });

    const raw = await readStdin();
    let evt = {};
    try { evt = JSON.parse(raw || '{}'); } catch (_) { evt = {}; }

    const claudeSessionId = evt.session_id || evt.sessionId || 'unknown';
    const cwd = evt.cwd || process.cwd();
    const transcriptPath = evt.transcript_path || evt.transcriptPath || null;
    const now = Date.now();

    // セッション単位 upsert：初回は作成、以降は同 sessionId を伸ばす。
    // カテゴリ/タイトルはセッションごとに一度だけ判定し state に固定（LLM の再呼び出しを避ける）。
    let st = loadState(claudeSessionId);
    if (!st || !st.categoryPath) {
      const baseStartMs = (st && st.startMs) || (transcriptPath && firstUserTimestampMs(transcriptPath)) || now;
      const sessionId = (st && st.sessionId) || ulid(baseStartMs);
      // 同一ミリ秒開始の衝突回避（既存 state の startMs はそのまま尊重）。
      const startMs = (st && st.startMs) ? st.startMs : baseStartMs + startOffset(sessionId);
      const ctx = { cwd, firstUserText: transcriptPath ? firstUserText(transcriptPath) : '' };
      const decided = await classify(ctx, cfg);
      st = {
        sessionId,
        startMs,
        claudeSessionId,
        cwd,
        categoryPath: decided.categoryPath,
        title: decided.title,
      };
      saveState(claudeSessionId, st);
    }

    const categoryPath = st.categoryPath;
    const title = st.title;

    // 短すぎセッションのスキップ（Phase 1 既定 0 = 無効）。
    const elapsedSec = Math.max(0, Math.floor((now - st.startMs) / 1000));
    if (cfg.minSeconds > 0 && elapsedSec < cfg.minSeconds) {
      return finish(dryRun, { skipped: 'too_short', elapsedSec });
    }

    const payload = {
      newStartMs: st.startMs,
      newEndMs: now,
      title,
      categoryPath,
      sessionId: st.sessionId,
      memo: `claude-code session ${claudeSessionId}`,
    };

    // uncat なら、後で `tokiori-cc categorize` で聞けるよう保留キューに記録（フックは非対話）。
    if (!dryRun && categoryPath === (cfg.fallbackCategory || '(uncat)')) {
      const root = gitRoot(cwd) || cwd;
      pending.record({
        dir: path.basename(root),
        cwd,
        firstUserText: transcriptPath ? firstUserText(transcriptPath) : '',
        session: { sessionId: st.sessionId, startMs: st.startMs, endMs: now, title },
      });
    }

    if (dryRun) {
      return finish(true, { wouldPost: true, userId: cfg.userId, payload, by: st.categoryPath });
    }

    if (!cfg.userId) {
      config.logError('userId 未設定（login 未完了）');
      return finish(false, { skipped: 'no_user' });
    }
    await client.postManualUpdate(cfg, payload);
    return finish(false, { posted: true });
  } catch (e) {
    config.logError(`hook: ${e && e.stack ? e.stack : e}`);
    // ブロックしない
    if (opts.dryRun) process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }, null, 2) + '\n');
    return 0;
  }
}

function finish(dryRun, info) {
  if (dryRun) process.stdout.write(JSON.stringify(info, null, 2) + '\n');
  return 0;
}

module.exports = { run };
