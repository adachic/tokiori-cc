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

// dir に一致する state ファイルの categoryPath を更新（進行中セッションを次回 Stop で反映）。
function patchStates(dir, categoryPath) {
  let dirents = [];
  try { dirents = fs.readdirSync(config.STATE_DIR); } catch (_) { return; }
  for (const f of dirents) {
    const p = path.join(config.STATE_DIR, f);
    let st;
    try { st = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { continue; }
    const root = gitRoot(st.cwd) || st.cwd;
    if (path.basename(root || '') === dir) {
      st.categoryPath = categoryPath;
      try { fs.writeFileSync(p, JSON.stringify(st) + '\n'); } catch (_) { /* noop */ }
    }
  }
}

async function run() {
  const cfg = config.load();
  const p = pending.load();
  const dirs = Object.values(p.dirs || {});
  if (!dirs.length) {
    process.stderr.write('保留中の未分類セッションはありません。\n');
    return 0;
  }
  if (!cfg.userId) {
    process.stderr.write('未ログインです。`tokiori-cc login` を実行してください。\n');
    return 1;
  }

  // カテゴリ候補（無ければ同期）。
  let opts = optionPaths(cfg.categories || []);
  if (!opts.length) {
    try { await categories.sync(cfg); } catch (_) { /* noop */ }
    opts = optionPaths(config.load().categories || []);
  }
  if (!opts.length) {
    process.stderr.write('カテゴリ候補を取得できませんでした（`tokiori-cc sync-categories`）。\n');
    return 1;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  process.stderr.write(`未分類のリポジトリ ${dirs.length} 件。番号でカテゴリ指定 / s=スキップ / q=終了\n\n`);

  try {
    for (const d of dirs) {
      const sessions = Object.values(d.sessions || {});
      const totalSec = sessions.reduce((a, s) => a + Math.max(0, (s.endMs - s.startMs) / 1000), 0);
      process.stderr.write(`■ ${d.dir}  (${sessions.length}セッション / 計${fmtDur(totalSec)})\n`);
      process.stderr.write(`  cwd: ${d.cwd}\n`);
      if (d.firstUserText) process.stderr.write(`  最初の指示: ${d.firstUserText.slice(0, 80).replace(/\n/g, ' ')}\n`);
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

      // ① 以降は自動分類されるよう repoMap に保存
      cfg.repoMap = cfg.repoMap || {};
      cfg.repoMap[d.dir] = chosen;
      config.save(cfg);

      // ② 既存タイムラインのカテゴリを更新（同 sessionId で再 upsert）
      let updated = 0;
      for (const s of sessions) {
        try {
          await client.postManualUpdate(cfg, {
            newStartMs: s.startMs,
            newEndMs: s.endMs,
            title: s.title,
            categoryPath: chosen,
            sessionId: s.sessionId,
            memo: `claude-code (recategorized)`,
          });
          updated++;
        } catch (e) {
          process.stderr.write(`    ! 更新失敗 ${s.sessionId}: ${e && e.message || e}\n`);
        }
      }
      // ③ 進行中セッションの state も更新
      patchStates(d.dir, chosen);
      pending.removeDir(d.dir);
      process.stderr.write(`  → ${chosen} に設定（既存${updated}件更新・以降自動）\n\n`);
    }
  } finally {
    rl.close();
  }
  return 0;
}

module.exports = { run };
