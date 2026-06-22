'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');

const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

// 固定シム本体。設定には常にこのパスだけを書く（中身は更新しない）。
// 実処理は最新のコアへ丸投げする。Phase 1 はローカルのリポジトリを指す。
function shimContents(coreEntry, nodeBin) {
  return `#!/usr/bin/env bash
# tokiori-cc 固定シム（このファイルは書き換えない）。
# 実処理はコアへ丸投げ。コア更新時もこのシムと settings.json は不変。
exec ${nodeBin} ${coreEntry} "$@"
`;
}

// Node 18+ を解決。まず init を実行している現在の node（>=18 なら最も確実）。
// 次に nvm の node18+。最後は PATH の node。
function resolveNode() {
  const major = Number((process.versions.node || '0').split('.')[0]);
  if (major >= 18 && process.execPath && fs.existsSync(process.execPath)) {
    return process.execPath;
  }
  const candidates = [];
  const nvm = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    for (const v of fs.readdirSync(nvm)) {
      const m = /^v(\d+)\./.exec(v);
      if (m && Number(m[1]) >= 18) candidates.push({ major: Number(m[1]), bin: path.join(nvm, v, 'bin', 'node') });
    }
  } catch (_) { /* nvm 無し */ }
  candidates.sort((a, b) => b.major - a.major);
  for (const c of candidates) {
    if (fs.existsSync(c.bin)) return c.bin;
  }
  // 最後は PATH の node に賭ける
  return 'node';
}

function installShim() {
  config.ensureDirs();
  const coreEntry = path.resolve(__dirname, '..', 'bin', 'tokiori-cc.js');
  const nodeBin = resolveNode();
  fs.writeFileSync(config.SHIM_PATH, shimContents(coreEntry, nodeBin), { mode: 0o755 });
  return { shim: config.SHIM_PATH, coreEntry, nodeBin };
}

// ~/.claude/settings.json の hooks.Stop に固定シムを冪等に登録。
function registerStopHook() {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); } catch (_) { settings = {}; }
  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];

  const command = `${config.SHIM_PATH} hook`;
  const already = settings.hooks.Stop.some(
    (g) => Array.isArray(g.hooks) && g.hooks.some((h) => h && h.type === 'command' && typeof h.command === 'string' && h.command.includes('tokiori-cc') && h.command.includes('hook'))
  );
  if (!already) {
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command }] });
  }
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return { registered: !already, command };
}

function init() {
  const cfg = config.load();
  config.save(cfg); // config.json を作成/補完
  const shim = installShim();
  const hook = registerStopHook();
  return { configPath: config.CONFIG_PATH, ...shim, ...hook };
}

// doctor: シムとフック登録を期待状態へ冪等に再整合。
function doctor() {
  return init();
}

module.exports = { init, doctor, installShim, registerStopHook, CLAUDE_SETTINGS };
