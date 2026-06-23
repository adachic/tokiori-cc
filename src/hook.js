'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const auth = require('./auth');
const client = require('./client');
const pending = require('./pending');
const { ulid, startOffset, firstUserTimestampMs, firstUserText, gitRoot, localDayStartMs, dayKey } = require('./util');
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

    // ブロック分割: 日付が変わった or 一定時間アイドルが空いたら新ブロックにする。
    // これにより各ブロックは1日内に収まり、夜間などの長時間アイドルも繰り越さない。
    const gapMs = (cfg.gapMinutes > 0 ? cfg.gapMinutes : 0) * 60 * 1000;
    const todayKey = dayKey(now);
    let st = loadState(claudeSessionId);
    const dayChanged = st && st.day && st.day !== todayKey;
    const gapExceeded = st && gapMs > 0 && st.lastSeenMs && (now - st.lastSeenMs) > gapMs;

    if (!st || !st.categoryPath || !st.day || dayChanged || gapExceeded) {
      // 新ブロックの開始 = 「本日0:00」かつ「前回終了後」以降の最初の発話（無ければ now）。
      const sinceMs = Math.max(localDayStartMs(now), (st && st.lastSeenMs) ? st.lastSeenMs + 1 : 0);
      let blockStart = (transcriptPath && firstUserTimestampMs(transcriptPath, sinceMs));
      if (!Number.isFinite(blockStart) || blockStart < sinceMs || blockStart > now) blockStart = now;
      const sessionId = ulid(blockStart);
      const startMs = blockStart + startOffset(sessionId);
      const ctx = { cwd, firstUserText: transcriptPath ? firstUserText(transcriptPath, sinceMs) : '' };
      const decided = await classify(ctx, cfg);
      st = {
        day: todayKey,
        sessionId,
        startMs,
        lastSeenMs: now,
        claudeSessionId,
        cwd,
        categoryPath: decided.categoryPath,
        title: decided.title,
      };
    } else {
      st.lastSeenMs = now;
    }
    saveState(claudeSessionId, st);

    const categoryPath = st.categoryPath;
    const title = st.title;

    // 短すぎセッションのスキップ（Phase 1 既定 0 = 無効）。
    const elapsedSec = Math.max(0, Math.floor((now - st.startMs) / 1000));
    if (cfg.minSeconds > 0 && elapsedSec < cfg.minSeconds) {
      return finish(dryRun, { skipped: 'too_short', elapsedSec });
    }

    const payload = {
      newStartMs: st.startMs,
      newEndMs: Math.max(now, st.startMs + 1000),
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
