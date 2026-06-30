'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const config = require('./config');
const pending = require('./pending');
const client = require('./client');
const categories = require('./categories');
const { optionPaths } = require('./categories');
const { gitRoot } = require('./util');

function ask(rl, q) {
  return new Promise((resolve) => rl.question(q, (a) => resolve(String(a).trim())));
}

function fmtDur(sec) {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`;
}

// "Claude Code: <repo>: <work>" / "Claude Code: <repo>" → repo
function repoFromTitle(title) {
  const m = /^Claude Code:\s*([^:]+?)(?::|$)/.exec(title || '');
  return m ? m[1].trim() : null;
}

// dir に一致する state ファイルの categoryPath を更新（進行中セッションを次回 Stop で反映）。
function patchStates(repo, categoryPath) {
  let dirents = [];
  try { dirents = fs.readdirSync(config.STATE_DIR); } catch (_) { return; }
  for (const f of dirents) {
    const p = path.join(config.STATE_DIR, f);
    let st;
    try { st = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { continue; }
    const root = gitRoot(st.cwd) || st.cwd || '';
    if (path.basename(root) === repo) {
      st.categoryPath = categoryPath;
      try { fs.writeFileSync(p, JSON.stringify(st) + '\n'); } catch (_) { /* noop */ }
    }
  }
}

// タイムライン上の既存 uncat + 保留中をリポジトリ単位に集約。
async function collectGroups(cfg) {
  const fallback = cfg.fallbackCategory || '(uncat)';
  const groups = new Map(); // repo -> { repo, entries: Map(sessionId->{sessionId,startMs,endMs,title}) }
  const add = (repo, e) => {
    if (!repo || !e.sessionId) return;
    if (!groups.has(repo)) groups.set(repo, { repo, entries: new Map() });
    groups.get(repo).entries.set(e.sessionId, e);
  };

  // 1) タイムラインの既存 uncat（claude-code 由来）
  const days = cfg.categorizeDays || 60;
  const sinceMs = Date.now() - days * 24 * 3600 * 1000;
  let rows = [];
  try { rows = await client.listManualLogs(cfg, sinceMs); } catch (e) { /* オフライン等は pending のみ */ }
  for (const r of rows) {
    if (r.categoryPath !== fallback) continue;
    if (!(r.title || '').startsWith('Claude Code:')) continue; // 自分の手動データは触らない
    const repo = repoFromTitle(r.title) || '(不明)';
    add(repo, { sessionId: r.sessionId, startMs: r.startMs, endMs: r.endMs, title: r.title });
  }

  // 2) 保留キュー（投稿失敗分なども拾う）
  const p = pending.load();
  for (const d of Object.values(p.dirs || {})) {
    for (const s of Object.values(d.sessions || {})) {
      add(d.dir, { sessionId: s.sessionId, startMs: s.startMs, endMs: s.endMs, title: s.title });
    }
  }
  return [...groups.values()].map((g) => ({ repo: g.repo, entries: [...g.entries.values()] }));
}

// リポジトリ1グループに categoryPath を適用：
// ①config.repoMap に保存（以降自動） ②既存タイムラインを更新 ③state を patch ④pending から除去。
// CLI（run）と UI（ui.js）の双方から使う共通処理。{ updated, failed } を返す。
async function applyGroup(cfg, repo, entries, categoryPath) {
  cfg.repoMap = cfg.repoMap || {};
  cfg.repoMap[repo] = categoryPath;
  config.save(cfg);

  let updated = 0;
  const failed = [];
  for (const s of entries || []) {
    try {
      await client.postManualUpdate(cfg, {
        newStartMs: s.startMs,
        newEndMs: Math.max(s.endMs || s.startMs, s.startMs + 1000),
        title: s.title,
        categoryPath,
        sessionId: s.sessionId,
        memo: 'claude-code (recategorized)',
      });
      updated++;
    } catch (e) {
      failed.push({ sessionId: s.sessionId, error: (e && e.message) || String(e) });
    }
  }
  patchStates(repo, categoryPath);
  pending.removeDir(repo);
  return { updated, failed };
}

async function run() {
  const cfg = config.load();
  if (!cfg.userId) {
    process.stderr.write('未ログインです。`tokiori-cc login` を実行してください。\n');
    return 1;
  }

  let opts = optionPaths(cfg.categories || []);
  if (!opts.length) {
    try { await categories.sync(cfg); } catch (_) { /* noop */ }
    opts = optionPaths(config.load().categories || []);
  }
  if (!opts.length) {
    process.stderr.write('カテゴリ候補を取得できませんでした（`tokiori-cc sync-categories`）。\n');
    return 1;
  }

  const groups = await collectGroups(cfg);
  if (!groups.length) {
    process.stderr.write('未分類（uncat）のエントリはありません。\n');
    return 0;
  }
  groups.sort((a, b) => b.entries.length - a.entries.length);

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  process.stderr.write(`未分類リポジトリ ${groups.length} 件。番号でカテゴリ指定 / s=スキップ / q=終了\n\n`);

  try {
    for (const g of groups) {
      const totalSec = g.entries.reduce((a, s) => a + Math.max(0, ((s.endMs || s.startMs) - s.startMs) / 1000), 0);
      const sample = g.entries.map((e) => e.title).find((t) => t && t.length > ('Claude Code: ' + g.repo).length + 2);
      process.stderr.write(`■ ${g.repo}  (${g.entries.length}件 / 計${fmtDur(totalSec)})\n`);
      if (sample) process.stderr.write(`  例: ${sample.slice(0, 70)}\n`);
      opts.forEach((o, i) => process.stderr.write(`   ${String(i + 1).padStart(2)}) ${o}\n`));

      const ans = await ask(rl, '  選択> ');
      if (ans === 'q') break;
      if (ans === 's' || ans === '') { process.stderr.write('  → スキップ\n\n'); continue; }
      const idx = Number(ans) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= opts.length) {
        process.stderr.write('  → 無効な入力。スキップ\n\n');
        continue;
      }
      const chosen = opts[idx];

      const { updated, failed } = await applyGroup(cfg, g.repo, g.entries, chosen);
      for (const f of failed) process.stderr.write(`    ! 更新失敗 ${f.sessionId}: ${f.error}\n`);
      process.stderr.write(`  → ${chosen} に設定（${updated}件更新・以降自動）\n\n`);
    }
  } finally {
    rl.close();
  }
  return 0;
}

module.exports = { run, collectGroups, applyGroup, patchStates, repoFromTitle };
