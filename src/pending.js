'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

const PENDING_PATH = path.join(config.ROOT, 'pending.json');

function load() {
  try { return JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8')); } catch (_) { return { dirs: {} }; }
}

function save(p) {
  config.ensureDirs();
  fs.writeFileSync(PENDING_PATH, JSON.stringify(p, null, 2) + '\n');
}

// uncat になったセッションをディレクトリ単位で記録（同セッションは upsert）。
// entry: { dir, cwd, firstUserText, session:{sessionId,startMs,endMs,title} }
function record(entry) {
  const p = load();
  const d = p.dirs[entry.dir] || { dir: entry.dir, cwd: entry.cwd, firstUserText: '', sessions: {} };
  d.cwd = entry.cwd;
  if (entry.firstUserText) d.firstUserText = entry.firstUserText;
  if (entry.session && entry.session.sessionId) d.sessions[entry.session.sessionId] = entry.session;
  p.dirs[entry.dir] = d;
  save(p);
}

function removeDir(dir) {
  const p = load();
  delete p.dirs[dir];
  save(p);
}

function count() {
  return Object.keys(load().dirs || {}).length;
}

module.exports = { load, save, record, removeDir, count, PENDING_PATH };
