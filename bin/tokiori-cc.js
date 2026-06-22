#!/usr/bin/env node
'use strict';

const config = require('../src/config');

async function readLine(prompt) {
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', (d) => { process.stdin.pause(); resolve(String(d).trim()); });
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case 'hook': {
      const { run } = require('../src/hook');
      const dryRun = rest.includes('--dry-run');
      process.exitCode = await run({ dryRun });
      return;
    }

    case 'mcp': {
      require('../src/mcp').start();
      return; // 常駐
    }

    case 'init':
    case 'doctor': {
      const initmod = require('../src/init');
      const out = cmd === 'init' ? initmod.init() : initmod.doctor();
      process.stderr.write(
        `✓ ${cmd} 完了\n` +
        `  config : ${out.configPath}\n` +
        `  shim   : ${out.shim}\n` +
        `  node   : ${out.nodeBin}\n` +
        `  core   : ${out.coreEntry}\n` +
        `  Stopフック: ${out.registered ? '登録しました' : '既に登録済み'} (${out.command})\n\n` +
        `次: \`tokiori-cc login\` でログイン → 以降は自動反映\n` +
        `MCP追加: claude mcp add tokiori -- ${out.shim} mcp\n`
      );
      return;
    }

    case 'login': {
      const auth = require('../src/auth');
      // --env dev|prod でログイン先環境を切替（省略時は現在の env）。
      const ei = rest.indexOf('--env');
      if (ei >= 0 && rest[ei + 1]) config.setEnv(rest[ei + 1]);
      const cfg = config.load();
      const usePassword = rest.includes('--password');
      try {
        let res;
        if (usePassword) {
          const email = await readLine('email: ');
          const password = await readLine('password: ');
          res = await auth.loginWithPassword(cfg, email, password);
        } else {
          res = await auth.loginWithBrowser(cfg, {});
        }
        config.setAccount(cfg, cfg.env, { userId: res.userId, refreshToken: res.refreshToken });
        process.stderr.write(`✓ ログイン完了 [${cfg.env}] userId=${res.userId}\n`);
        // 実カテゴリ階層をキャッシュ（LLM 候補/検証用）。失敗しても致命ではない。
        try {
          const cats = await require('../src/categories').sync(config.load());
          process.stderr.write(`✓ カテゴリ同期 ${cats.length} 親カテゴリ\n`);
        } catch (e) {
          process.stderr.write(`(カテゴリ同期スキップ: ${e && e.message || e})\n`);
        }
      } catch (e) {
        process.stderr.write(`✗ ログイン失敗: ${e && e.message || e}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'sync-categories': {
      try {
        const cats = await require('../src/categories').sync(config.load());
        process.stderr.write(`✓ ${cats.length} 親カテゴリを同期\n`);
        for (const c of cats) process.stderr.write(`  ${c.label}: ${(c.subs || []).map((s) => s.label).join(', ')}\n`);
      } catch (e) {
        process.stderr.write(`✗ 同期失敗: ${e && e.message || e}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'categorize': {
      process.exitCode = await require('../src/cmd_categorize').run();
      return;
    }

    case 'classify': {
      // デバッグ用：cwd を分類して結果を表示（書き込みなし）。
      const { classify } = require('../src/categorize');
      const cfg = config.load();
      const cwd = rest[0] || process.cwd();
      const out = await classify({ cwd, firstUserText: '' }, cfg);
      process.stdout.write(JSON.stringify({ cwd, ...out }, null, 2) + '\n');
      return;
    }

    case 'use': {
      const env = rest[0];
      try {
        config.setEnv(env);
        process.stderr.write(`✓ 反映先を [${env}] に切替えました（必要なら \`tokiori-cc login\`）\n`);
      } catch (e) {
        process.stderr.write(`✗ ${e && e.message || e}\n`);
        process.exitCode = 1;
      }
      return;
    }

    case 'status': {
      const cfg = config.load();
      const pendingCount = require('../src/pending').count();
      const accounts = {};
      for (const e of Object.keys(config.ENDPOINTS)) {
        const a = (cfg.accounts && cfg.accounts[e]) || {};
        accounts[e] = a.refreshToken ? `logged-in (${a.userId})` : 'not-logged-in';
      }
      process.stdout.write(JSON.stringify({
        enabled: cfg.enabled,
        env: cfg.env,
        loggedIn: !!(cfg.auth && cfg.auth.refreshToken),
        userId: cfg.userId,
        accounts,
        trackApi: cfg.endpoints.trackApi,
        minSeconds: cfg.minSeconds,
        autoUpdate: cfg.autoUpdate,
        uncatPending: pendingCount,
      }, null, 2) + '\n');
      if (pendingCount > 0) process.stderr.write(`\n未分類 ${pendingCount} 件。\`tokiori-cc categorize\` で分類できます。\n`);
      return;
    }

    case 'on':
    case 'off': {
      const cfg = config.load();
      cfg.enabled = cmd === 'on';
      config.save(cfg);
      process.stderr.write(`enabled=${cfg.enabled}\n`);
      return;
    }

    default:
      process.stderr.write(
        'tokiori-cc <command>\n' +
        '  init            固定シム設置 + Stopフック登録 + config 作成\n' +
        '  login [--env dev|prod] [--password]  ログイン（既定は現在のenv）\n' +
        '  use <dev|prod>  反映先環境を切替\n' +
        '  hook [--dry-run]    Stopフック本体（Claude Codeが呼ぶ）\n' +
        '  mcp             MCP stdio サーバ\n' +
        '  status          状態表示\n' +
        '  categorize      未分類セッションを対話でカテゴリ指定\n' +
        '  sync-categories 実カテゴリ階層を再取得\n' +
        '  classify [cwd]  cwd の分類結果を表示（デバッグ）\n' +
        '  on | off        自動反映の ON/OFF\n' +
        '  doctor          シム/フック登録を再整合\n'
      );
      process.exitCode = cmd ? 1 : 0;
  }
}

main();
