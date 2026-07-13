'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const auth = require('./auth');
const client = require('./client');
const pending = require('./pending');
const { sessionIdFor, startOffset, gitRoot, readTranscriptEvents, computeBlocks } = require('./util');
const { classify, summarizeInstructionsLLM } = require('./categorize');

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

    // 作業ブロックは「人間が実際にタイプした発話」を基準に transcript から算出する。
    // Stop 発火時刻(now)や自動注入メッセージでは延長しないため、就寝・離席のような
    // 閾値超のアイドルは別ブロックに切れ、無人時間が作業に混ざらない（computeBlocks 参照）。
    const gapMs = (cfg.gapMinutes > 0 ? cfg.gapMinutes : 30) * 60 * 1000;
    const events = transcriptPath ? readTranscriptEvents(transcriptPath) : [];
    const blocks = computeBlocks(events, gapMs);
    if (!blocks.length) return finish(dryRun, { skipped: 'no_human_activity' });
    const block = blocks[blocks.length - 1]; // 直近（進行中）の人間発話ブロック

    // 同一ブロックでは sessionId/startMs を保って冪等に upsert する（state に保存）。
    let st = loadState(claudeSessionId);
    const sameBlock = st && st.blockStartMs === block.startMs && st.categoryPath;
    if (!sameBlock) {
      // 新しいブロック → 分類し直し、memo/summary/posted をリセット。
      const decided = await classify({ cwd, firstUserText: block.firstText }, cfg);
      // sessionId はブロックから決定的に生成（backfill と一致 → 移行時も重複しない）。
      const sid = sessionIdFor(`${claudeSessionId}:${block.startMs}`, block.startMs);
      st = {
        claudeSessionId,
        blockStartMs: block.startMs,
        sessionId: sid,
        startMs: block.startMs + startOffset(sid),
        cwd,
        categoryPath: decided.categoryPath,
        title: decided.title,
        posted: false,
      };
    }
    st.cwd = cwd;
    st.instructions = block.prompts; // detail memo 用（transcript から都度取得・状態に溜めない）

    const memo = await buildMemo(cfg, st, claudeSessionId, dryRun);

    const startMs = st.startMs;
    const endMs = Math.max(block.endMs, startMs + 1000);
    const categoryPath = st.categoryPath;
    const title = st.title;

    // 短すぎブロックのスキップ（既定 0 = 無効）。
    const elapsedSec = Math.max(0, Math.floor((endMs - startMs) / 1000));
    if (cfg.minSeconds > 0 && elapsedSec < cfg.minSeconds) {
      saveState(claudeSessionId, st);
      return finish(dryRun, { skipped: 'too_short', elapsedSec });
    }

    const payload = {
      newStartMs: startMs,
      newEndMs: endMs,
      title,
      categoryPath,
      sessionId: st.sessionId,
      memo,
    };

    // uncat なら、後で `tokiori-cc categorize` で聞けるよう保留キューに記録（フックは非対話）。
    if (!dryRun && categoryPath === (cfg.fallbackCategory || '(uncat)')) {
      const root = gitRoot(cwd) || cwd;
      pending.record({
        dir: path.basename(root),
        cwd,
        firstUserText: block.firstText,
        session: { sessionId: st.sessionId, startMs, endMs, title },
      });
    }

    if (dryRun) {
      return finish(true, { wouldPost: true, userId: cfg.userId, blocks: blocks.length, payload, by: categoryPath });
    }

    if (!cfg.userId) {
      config.logError('userId 未設定（login 未完了）');
      saveState(claudeSessionId, st);
      return finish(false, { skipped: 'no_user' });
    }

    // 変化が無ければ再送しない（自動 Stop の連発で無駄打ちしない）。
    if (st.posted && st.postedEndMs === endMs) {
      saveState(claudeSessionId, st);
      return finish(false, { skipped: 'unchanged' });
    }

    await client.postManualUpdate(cfg, payload);
    st.posted = true;
    st.postedEndMs = endMs;
    saveState(claudeSessionId, st);
    return finish(false, { posted: true });
  } catch (e) {
    config.logError(`hook: ${e && e.stack ? e.stack : e}`);
    // ブロックしない
    if (opts.dryRun) process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }, null, 2) + '\n');
    return 0;
  }
}

// tokiori-cc が書いた memo の目印。この接頭辞が無い memo は手編集とみなし保持する。
const MEMO_MARK = 'claude-code';

// タイムライン上の現在の memo（同一ブロックのもの）。読めなければ null。
async function remoteMemo(cfg, st) {
  try {
    const logs = await client.listManualLogs(cfg, Math.max(0, st.startMs - 1000), { limit: 100, maxPages: 2 });
    const it = logs.find((l) => l.sessionId === st.sessionId);
    return it ? (it.memo || '') : null;
  } catch (_) {
    return null;
  }
}

function bulletsBody(st, cfg) {
  const max = cfg.detailMaxLen > 0 ? cfg.detailMaxLen : 1000;
  let body = (st.instructions || []).map((s) => `・${s}`).join('\n');
  if (body.length > max) body = body.slice(0, max) + '…';
  return body;
}

// memo を組み立てる。detail 無効なら従来どおり session ID のみ。
// 有効時は「ID 行 + 指示の箇条書き（または LLM 要約）」。
// ダッシュボードで memo が手編集されていたら以降は上書きせずそのまま維持する。
async function buildMemo(cfg, st, claudeSessionId, dryRun) {
  const head = `claude-code session ${claudeSessionId}`;
  const mode = cfg.detail;
  if (mode !== 'instructions' && mode !== 'summary') return head;

  if (!dryRun && st.posted) {
    const remote = await remoteMemo(cfg, st);
    if (remote != null && remote !== '' && !remote.startsWith(MEMO_MARK)) {
      st.userMemo = remote;
      st.memoLocked = true;
    }
  }
  if (st.memoLocked) return st.userMemo || head;

  if (mode === 'summary') {
    const n = (st.instructions || []).length;
    if (n && st.summaryFor !== n) {
      try {
        const s = await summarizeInstructionsLLM(st.instructions, cfg);
        if (s) { st.summary = s; st.summaryFor = n; }
      } catch (_) { /* 前回要約 or 箇条書きへフォールバック */ }
    }
    if (st.summary) {
      const max = cfg.detailMaxLen > 0 ? cfg.detailMaxLen : 1000;
      let body = st.summary;
      if (body.length > max) body = body.slice(0, max) + '…';
      return `${head}\n${body}`;
    }
  }

  const body = bulletsBody(st, cfg);
  return body ? `${head}\n${body}` : head;
}

function finish(dryRun, info) {
  if (dryRun) process.stdout.write(JSON.stringify(info, null, 2) + '\n');
  return 0;
}

module.exports = { run };
