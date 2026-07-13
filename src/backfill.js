'use strict';

// 過去補正: 旧アルゴリズムで記録された「就寝・離席を含む肥大ブロック」を、
// 新しい computeBlocks（人間発話ベース＋応答テール）の結果に合わせて作り直す。
//
// 方針:
//  - タイムライン（ManualSession）を memo 先頭の "claude-code session <cid>" で
//    Claude Code セッション(cid)ごとに束ね、対応する transcript を再計算する。
//  - 差（旧合計 − 新合計）が閾値以上に縮むものだけ対象にする（＝肥大していたもの）。
//  - 実行時: 旧セッションを sessionId 指定で削除 → 新ブロックを投稿。
//  - カテゴリは時間的に重なる旧ブロックから継承（ダッシュボードでの手動分類を保持）。
//  - memo 先頭が "claude-code session" でないもの（手編集）は束ねず一切触らない。
//  - 既定は dry-run。--apply で初めて書き込む。

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const client = require('./client');
const { sessionIdFor, startOffset, readTranscriptEvents, computeBlocks } = require('./util');
const { repoName, staticMatch } = require('./categorize');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function findTranscript(cid) {
  try {
    for (const proj of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, proj, `${cid}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch (_) { /* noop */ }
  return null;
}

function cidFromMemo(memo) {
  const m = /^claude-code session (\S+)/.exec(String(memo || ''));
  return m ? m[1] : null;
}

// transcript の最初に現れる cwd（分類・repo 名用）。
function firstCwd(transcriptPath) {
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.includes('"cwd"')) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      if (o && typeof o.cwd === 'string' && o.cwd) return o.cwd;
    }
  } catch (_) { /* noop */ }
  return '';
}

function oneLine(s, max) {
  let t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length > max) t = t.slice(0, max).trim() + '…';
  return t;
}

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

// 新ブロック d に、時間的に最も重なる旧ブロックのカテゴリを継承させる。
function inheritCategory(d, olds, cwd, cfg) {
  let best = null; let bestOv = 0;
  for (const o of olds) {
    const ov = overlap(d.startMs, d.endMs, o.startMs, o.endMs);
    if (ov > bestOv) { bestOv = ov; best = o; }
  }
  if (best && best.categoryPath) return best.categoryPath;
  return staticMatch(cwd, cfg) || (cfg.fallbackCategory || '(uncat)');
}

// dry-run 用の要約 + 実行計画を返す。
async function analyze(cfg, opts) {
  const gapMs = (cfg.gapMinutes > 0 ? cfg.gapMinutes : 30) * 60 * 1000;
  const minReduceMin = opts.minReduceMin != null ? opts.minReduceMin : 15;
  const sinceMs = opts.sinceMs || 0;
  const force = !!opts.force;
  // --recent-hours: transcript がこの時間内に更新された cid だけ対象（ライブ再キー用）。
  const recentCutoff = opts.recentHours ? Date.now() - opts.recentHours * 3600 * 1000 : 0;

  const existing = await client.listManualLogs(cfg, sinceMs, { limit: 200, maxPages: 100 });

  const byCid = new Map();
  let handEdited = 0;
  for (const s of existing) {
    if (!Number.isFinite(s.startMs) || !Number.isFinite(s.endMs)) continue;
    const cid = cidFromMemo(s.memo);
    if (!cid) { handEdited++; continue; } // 手編集 memo 等 → 触らない
    if (!byCid.has(cid)) byCid.set(cid, []);
    byCid.get(cid).push(s);
  }

  const actions = [];   // 補正対象
  const skips = [];     // 対象外（理由付き）
  for (const [cid, olds] of byCid) {
    const tp = findTranscript(cid);
    if (!tp) { skips.push({ cid, reason: 'no_transcript', olds }); continue; }
    if (recentCutoff) {
      let mtime = 0;
      try { mtime = fs.statSync(tp).mtimeMs; } catch (_) { mtime = 0; }
      if (mtime < recentCutoff) { skips.push({ cid, reason: 'not_recent', olds }); continue; }
    }
    const cwd = firstCwd(tp);
    const desired = computeBlocks(readTranscriptEvents(tp), gapMs);
    if (!desired.length) { skips.push({ cid, reason: 'no_human_blocks', olds }); continue; }
    const oldSpan = olds.reduce((a, o) => a + Math.max(0, o.endMs - o.startMs), 0);
    const newSpan = desired.reduce((a, d) => a + (d.endMs - d.startMs), 0);
    const reduceMin = (oldSpan - newSpan) / 60000;
    // 通常は肥大（reduceMin>=閾値）だけ対象。--force は id 正規化/再キーのため全件対象。
    if (!force && reduceMin < minReduceMin) {
      skips.push({ cid, reason: 'ok', olds, reduceMin }); continue;
    }
    const posts = buildPosts(cid, cwd, desired, olds, cfg);
    actions.push({ cid, cwd, olds, oldSpan, newSpan, reduceMin, posts });
  }

  return { existing: existing.length, handEdited, actions, skips, gapMs, minReduceMin, force, recentHours: opts.recentHours || 0 };
}

function buildPosts(cid, cwd, desired, olds, cfg) {
  const titleMax = cfg.titleMaxLen || 60;
  return desired.map((d) => {
    const sid = sessionIdFor(`${cid}:${d.startMs}`, d.startMs);
    const startMs = d.startMs + startOffset(sid);
    const endMs = Math.max(d.endMs, startMs + 1000);
    const categoryPath = inheritCategory(d, olds, cwd, cfg);
    const title = `Claude Code: ${repoName(cwd)}: ${oneLine(d.firstText, titleMax)}`;
    const memo = `claude-code session ${cid}`;
    return { sessionId: sid, blockStartMs: d.startMs, newStartMs: startMs, newEndMs: endMs, title, categoryPath, memo };
  });
}

async function apply(cfg, actions) {
  let deleted = 0; let posted = 0; let failed = 0;
  for (const a of actions) {
    const keepIds = new Set(a.posts.map((p) => p.sessionId));
    // 1) 置き換えられる（新 id 集合に無い）旧セッションだけ削除。
    //    id が一致する分は決定的なので upsert で上書き＝削除不要。
    for (const o of a.olds) {
      if (keepIds.has(o.sessionId)) continue;
      try { await client.postManualUpdate(cfg, { delete: true, sessionId: o.sessionId }); deleted++; }
      catch (e) { failed++; process.stderr.write(`  ✗ delete ${o.sessionId}: ${e && e.message || e}\n`); }
    }
    // 2) 新ブロックを投稿（決定的 id なので再実行しても不変）。
    for (const p of a.posts) {
      try { await client.postManualUpdate(cfg, { newStartMs: p.newStartMs, newEndMs: p.newEndMs, title: p.title, categoryPath: p.categoryPath, sessionId: p.sessionId, memo: p.memo }); posted++; }
      catch (e) { failed++; process.stderr.write(`  ✗ post ${p.sessionId}: ${e && e.message || e}\n`); }
    }
    // 3) ローカルのフック状態を最終ブロックへ同期（ライブ継続時に重複させない）。
    syncHookState(a);
  }
  return { deleted, posted, failed };
}

// backfill 後、フックが次の Stop で同じ現行ブロックを別 id で再投稿しないよう、
// state ファイル（cid キー）を最終ブロックの決定的 id / 開始に合わせておく。
function syncHookState(a) {
  try {
    const last = a.posts[a.posts.length - 1];
    if (!last) return;
    const st = {
      claudeSessionId: a.cid,
      blockStartMs: last.blockStartMs,
      sessionId: last.sessionId,
      startMs: last.newStartMs,
      cwd: a.cwd,
      categoryPath: last.categoryPath,
      title: last.title,
      posted: true,
      postedEndMs: last.newEndMs,
    };
    config.ensureDirs();
    const safe = String(a.cid).replace(/[^A-Za-z0-9_.-]/g, '_');
    fs.writeFileSync(path.join(config.STATE_DIR, `${safe}.json`), JSON.stringify(st) + '\n');
  } catch (_) { /* 状態同期の失敗は致命ではない */ }
}

function fmt(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function run(opts) {
  opts = opts || {};
  const cfg = config.load();
  if (!cfg.userId) { process.stderr.write('login が必要です（tokiori-cc login）\n'); return 1; }

  process.stderr.write(`[backfill] env=${cfg.env} userId=${cfg.userId} gap=${cfg.gapMinutes}m ${opts.apply ? '(APPLY)' : '(dry-run)'}\n`);
  const rep = await analyze(cfg, opts);

  const totOldMin = rep.actions.reduce((a, x) => a + x.oldSpan, 0) / 60000;
  const totNewMin = rep.actions.reduce((a, x) => a + x.newSpan, 0) / 60000;

  process.stderr.write(
    `対象タイムライン: ${rep.existing} 件 / 手編集(除外): ${rep.handEdited} 件\n` +
    `補正対象セッション: ${rep.actions.length} 件（${rep.skips.filter(s => s.reason === 'ok').length} 件は既に妥当・${rep.skips.filter(s => s.reason === 'no_transcript').length} 件は transcript 無し）\n` +
    `合計: 旧 ${totOldMin.toFixed(0)}分 → 新 ${totNewMin.toFixed(0)}分（${(totOldMin - totNewMin).toFixed(0)}分の無人時間を除外）\n\n`
  );

  for (const a of rep.actions) {
    process.stderr.write(`● ${a.cid.slice(0, 8)} ${repoName(a.cwd)}  旧${a.olds.length}件 ${(a.oldSpan / 60000).toFixed(0)}分 → 新${a.posts.length}件 ${(a.newSpan / 60000).toFixed(0)}分\n`);
    for (const o of a.olds) process.stderr.write(`    − 削除 ${fmt(o.startMs)}→${fmt(o.endMs)} (${((o.endMs - o.startMs) / 60000).toFixed(0)}m) [${o.categoryPath}]\n`);
    for (const p of a.posts) process.stderr.write(`    ＋ 投稿 ${fmt(p.newStartMs)}→${fmt(p.newEndMs)} (${((p.newEndMs - p.newStartMs) / 60000).toFixed(0)}m) [${p.categoryPath}] ${p.title.slice(0, 40)}\n`);
  }

  if (opts.showNoTranscript) {
    for (const s of rep.skips.filter(s => s.reason === 'no_transcript')) {
      process.stderr.write(`  (transcript無し) ${s.cid.slice(0, 8)} 旧${s.olds.length}件\n`);
    }
  }

  if (!opts.apply) {
    process.stderr.write(`\ndry-run のため書き込みなし。実行するには --apply を付けてください。\n`);
    return 0;
  }
  if (!rep.actions.length) { process.stderr.write(`\n補正対象なし。\n`); return 0; }

  process.stderr.write(`\n適用中…\n`);
  const res = await apply(cfg, rep.actions);
  process.stderr.write(`完了: 削除 ${res.deleted} / 投稿 ${res.posted}${res.failed ? ` / 失敗 ${res.failed}` : ''}\n`);
  return res.failed ? 1 : 0;
}

module.exports = { run, analyze, findTranscript, cidFromMemo };
