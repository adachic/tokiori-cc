'use strict';

// ローカル Web UI（依存追加なし・Node 標準 http のみ）。
// ・repoMap（ローカルディレクトリ名 → 実カテゴリ）の紐づけ表を編集
// ・タイムライン上の未分類(uncat)セッションをカテゴリ指定で一括解消
// CLI の `tokiori-cc categorize` と同じ適用ロジック（cmd_categorize.applyGroup）を共有する。
// 127.0.0.1 のみにバインドし、外部からは触れない。

const http = require('http');
const { spawn } = require('child_process');
const config = require('./config');
const categories = require('./categories');
const { optionPaths } = require('./categories');
const { collectGroups, applyGroup } = require('./cmd_categorize');
const { REPO_RULES } = require('./categorize');

// 組み込みルールの表示用（match → categoryPath）。
const REPO_RULES_DISPLAY = REPO_RULES.map((r) => ({ match: r.match, categoryPath: r.categoryPath }));

const DEFAULT_PORT = 8126;

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref(); } catch (_) { /* noop */ }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function fmtDur(sec) {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`;
}

// REST 階層（value 付き）を取得し、options（"親label/子label"）と tree を返す。
// ダッシュボードでの変更が即反映されるよう毎回取り直す（失敗時はキャッシュ）。
async function fetchTree(cfg) {
  try {
    const tree = await categories.listRest(cfg);
    const options = [];
    for (const p of tree) for (const c of p.subs || []) options.push(`${p.label}/${c.label}`);
    // LLM 分類用キャッシュも更新（best-effort・失敗無視）。
    return { tree, options };
  } catch (_) {
    return { tree: null, options: optionPaths(cfg.categories || []) };
  }
}


async function buildState() {
  const cfg = config.load();
  const loggedIn = !!(cfg.auth && cfg.auth.refreshToken);
  if (!loggedIn) {
    return { env: cfg.env, loggedIn: false, fallback: cfg.fallbackCategory || '(uncat)', options: [], tree: [], repoMap: cfg.repoMap || {}, groups: [], builtins: REPO_RULES_DISPLAY };
  }
  const { tree, options } = await fetchTree(cfg);
  let groups = [];
  try {
    groups = (await collectGroups(cfg)).map((g) => {
      const totalSec = g.entries.reduce((a, s) => a + Math.max(0, ((s.endMs || s.startMs) - s.startMs) / 1000), 0);
      const prefixLen = ('Claude Code: ' + g.repo).length + 2;
      const sample = g.entries.map((e) => e.title).find((t) => t && t.length > prefixLen) || '';
      return { repo: g.repo, count: g.entries.length, totalSec, dur: fmtDur(totalSec), sample };
    }).sort((a, b) => b.count - a.count);
  } catch (e) {
    groups = [];
  }
  return {
    env: cfg.env,
    loggedIn: true,
    fallback: cfg.fallbackCategory || '(uncat)',
    options,
    tree: tree || [],
    repoMap: cfg.repoMap || {},
    groups,
    builtins: REPO_RULES_DISPLAY,
  };
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/state') {
    return sendJson(res, 200, await buildState());
  }

  if (req.method === 'POST' && url.pathname === '/api/repo-map') {
    // 紐づけ表の追加/更新/削除（config のみ。タイムラインには遡及しない）。
    const body = await readBody(req);
    const repo = String(body.repo || '').trim();
    const categoryPath = body.categoryPath == null ? '' : String(body.categoryPath).trim();
    if (!repo) return sendJson(res, 400, { error: 'repo は必須です' });
    const cfg = config.load();
    cfg.repoMap = cfg.repoMap || {};
    if (categoryPath) cfg.repoMap[repo] = categoryPath;
    else delete cfg.repoMap[repo];
    config.save(cfg);
    return sendJson(res, 200, { ok: true, repoMap: cfg.repoMap });
  }

  if (req.method === 'POST' && url.pathname === '/api/classify') {
    // 未分類グループへカテゴリ適用：repoMap 保存 + 既存タイムライン更新 + pending 除去。
    const body = await readBody(req);
    const repo = String(body.repo || '').trim();
    const categoryPath = String(body.categoryPath || '').trim();
    if (!repo || !categoryPath) return sendJson(res, 400, { error: 'repo と categoryPath は必須です' });
    const cfg = config.load();
    if (!cfg.userId) return sendJson(res, 401, { error: '未ログインです（tokiori-cc login）' });
    // 現時点の最新エントリを再収集（古い endMs での上書きを避ける）。
    let entries = [];
    try {
      const groups = await collectGroups(cfg);
      const g = groups.find((x) => x.repo === repo);
      entries = g ? g.entries : [];
    } catch (e) {
      return sendJson(res, 502, { error: 'uncat 再取得に失敗: ' + ((e && e.message) || e) });
    }
    try {
      const { updated, failed } = await applyGroup(cfg, repo, entries, categoryPath);
      return sendJson(res, 200, { ok: true, repo, categoryPath, updated, failed });
    } catch (e) {
      return sendJson(res, 500, { error: (e && e.message) || String(e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/category/rename') {
    // カテゴリの表示名(label)を変更。value/parentValue は不変スラッグ。
    // バックエンドが既存セッションの categoryPath を追従更新し、
    // こちらはローカル repoMap を追従させる。
    const body = await readBody(req);
    const value = String(body.value || '').trim();
    const parentValue = body.parentValue ? String(body.parentValue).trim() : null;
    const label = String(body.label || '').trim();
    if (!value || !label) return sendJson(res, 400, { error: 'value と label は必須です' });
    const cfg = config.load();
    if (!cfg.userId) return sendJson(res, 401, { error: '未ログインです（tokiori-cc login）' });
    try {
      const r = await categories.renameAndRemap(cfg, { value, parentValue, label });
      return sendJson(res, 200, { ok: true, ...r });
    } catch (e) {
      return sendJson(res, 500, { error: (e && e.message) || String(e) });
    }
  }

  return sendJson(res, 404, { error: 'not found' });
}

function start(opts) {
  opts = opts || {};
  const port = opts.port || DEFAULT_PORT;
  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, `http://127.0.0.1:${port}`); } catch (_) { return sendJson(res, 400, { error: 'bad url' }); }
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(req, res, url); } catch (e) { return sendJson(res, 500, { error: (e && e.message) || String(e) }); }
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(PAGE_HTML);
    }
    res.writeHead(404); res.end('not found');
  });

  server.on('error', (e) => {
    process.stderr.write(`✗ UI サーバ起動失敗: ${(e && e.message) || e}\n`);
    if (e && e.code === 'EADDRINUSE') process.stderr.write(`  ポート ${port} が使用中です。\`tokiori-cc ui --port <別ポート>\` を試してください。\n`);
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    const link = `http://127.0.0.1:${port}`;
    process.stderr.write(`✓ tokiori-cc UI: ${link}\n  （停止は Ctrl-C）\n`);
    if (!opts.noOpen) openBrowser(link);
  });
  return server;
}

const PAGE_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tokiori-cc 連携設定</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Segoe UI", sans-serif; margin: 0; background: #f6f7f9; color: #1c1f23; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 24px 18px 64px; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .sub { color: #6b7280; font-size: 12.5px; margin-bottom: 18px; }
  .badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; vertical-align: middle; margin-left: 6px; }
  .badge.prod { background: #fde2e2; color: #b42318; }
  .badge.dev { background: #e0f2fe; color: #0369a1; }
  .card { background: #fff; border: 1px solid #e6e8eb; border-radius: 12px; padding: 16px 18px; margin-bottom: 18px; }
  .card h2 { font-size: 14px; margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
  .count { font-size: 11px; color: #6b7280; font-weight: 400; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 7px 4px; vertical-align: middle; border-bottom: 1px solid #f0f1f3; }
  td.repo { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  select { font-size: 13px; padding: 5px 8px; border: 1px solid #d4d7dc; border-radius: 7px; background: #fff; max-width: 230px; }
  input[type=text] { font-size: 13px; padding: 5px 8px; border: 1px solid #d4d7dc; border-radius: 7px; width: 150px; }
  button { font-size: 12.5px; padding: 5px 11px; border: 1px solid #d4d7dc; border-radius: 7px; background: #fff; cursor: pointer; }
  button:hover { background: #f3f4f6; }
  button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  button.primary:hover { background: #1d4ed8; }
  button.link { border: none; background: none; color: #b42318; padding: 4px 6px; }
  .muted { color: #9aa0a6; font-size: 12px; }
  .grp-meta { font-size: 11.5px; color: #6b7280; }
  .grp-sample { font-size: 11.5px; color: #9aa0a6; margin-top: 2px; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: #6b7280; font-size: 13px; padding: 6px 2px; }
  #toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); background: #1c1f23; color: #fff; padding: 9px 16px; border-radius: 8px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  #toast.show { opacity: 1; }
  details { margin-top: 8px; } summary { font-size: 12px; color: #6b7280; cursor: pointer; }
  .builtin { font-family: ui-monospace, monospace; font-size: 11.5px; color: #6b7280; }
  .err { background: #fef2f2; border: 1px solid #fecaca; color: #b42318; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
  .catp { margin-bottom: 10px; }
  .catrow { display: flex; align-items: center; gap: 7px; padding: 4px 2px; }
  .catrow.child { padding-left: 20px; }
  .catrow .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .catrow .nm { font-size: 13px; flex: 1; }
  .catrow.parent .nm { font-weight: 600; }
  .catrow .edit { border: none; background: none; cursor: pointer; color: #6b7280; font-size: 13px; padding: 2px 6px; visibility: hidden; }
  .catrow:hover .edit { visibility: visible; }
  .catrow input { font-size: 13px; padding: 4px 7px; border: 1px solid #2563eb; border-radius: 6px; }
</style></head>
<body><div class="wrap">
  <h1>Claude Code 連携設定 <span id="envBadge" class="badge"></span></h1>
  <div class="sub">ローカルディレクトリ → カテゴリの紐づけ表と、未分類セッションの解消をここで管理します。</div>
  <div id="warn"></div>

  <div class="card">
    <h2>未分類セッション <span id="grpCount" class="count"></span></h2>
    <div id="groups"><div class="empty">読み込み中…</div></div>
  </div>

  <div class="card">
    <h2>紐づけ表 (repoMap) <span id="mapCount" class="count"></span></h2>
    <table><tbody id="mapBody"></tbody></table>
    <div style="margin-top:12px; display:flex; gap:8px; align-items:center;">
      <input id="newRepo" type="text" placeholder="ディレクトリ名">
      <span class="muted">→</span>
      <select id="newCat"></select>
      <button class="primary" id="addBtn">追加</button>
    </div>
    <details>
      <summary>組み込みルール（編集不可・repoMap が優先）</summary>
      <div id="builtins" style="margin-top:8px;"></div>
    </details>
  </div>

  <div class="card">
    <h2>カテゴリ名の編集 <span class="count">表示名を変更（既存タイムラインも自動追従）</span></h2>
    <div id="cats"><div class="empty">読み込み中…</div></div>
  </div>
</div>
<div id="toast"></div>
<script>
let STATE = null;
const $ = (id) => document.getElementById(id);
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2000); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function optionsHtml(selected) {
  let h = '<option value="">未設定</option>';
  for (const o of STATE.options) h += '<option value="' + esc(o) + '"' + (o === selected ? ' selected' : '') + '>' + esc(o) + '</option>';
  return h;
}
async function api(path, method, body) {
  const res = await fetch(path, { method: method || 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
  return j;
}
async function load() {
  try { STATE = await api('/api/state'); } catch (e) { $('warn').innerHTML = '<div class="err">読み込み失敗: ' + esc(e.message) + '</div>'; return; }
  render();
}
function render() {
  const b = $('envBadge'); b.textContent = STATE.env; b.className = 'badge ' + (STATE.env === 'prod' ? 'prod' : 'dev');
  $('warn').innerHTML = STATE.loggedIn ? '' : '<div class="err">未ログインです。ターミナルで <code>tokiori-cc login</code> を実行してください。</div>';

  // 未分類グループ
  $('grpCount').textContent = STATE.groups.length ? STATE.groups.length + ' 件' : '';
  const g = $('groups');
  if (!STATE.groups.length) { g.innerHTML = '<div class="empty">' + (STATE.loggedIn ? '未分類はありません 🎉' : '—') + '</div>'; }
  else {
    let h = '<table><tbody>';
    for (const x of STATE.groups) {
      h += '<tr><td class="repo">' + esc(x.repo) +
        '<div class="grp-meta">' + x.count + '件 / 計' + esc(x.dur) + '</div>' +
        (x.sample ? '<div class="grp-sample">' + esc(x.sample) + '</div>' : '') +
        '</td><td style="text-align:right;"><select data-classify="' + esc(x.repo) + '">' +
        '<option value="">分類する…</option>' +
        STATE.options.map((o) => '<option value="' + esc(o) + '">' + esc(o) + '</option>').join('') +
        '</select></td></tr>';
    }
    h += '</tbody></table>';
    g.innerHTML = h;
    g.querySelectorAll('select[data-classify]').forEach((sel) => sel.addEventListener('change', onClassify));
  }

  // 紐づけ表
  const entries = Object.entries(STATE.repoMap || {});
  $('mapCount').textContent = entries.length ? entries.length + ' 件' : '';
  const mb = $('mapBody');
  if (!entries.length) mb.innerHTML = '<tr><td class="empty" colspan="3">まだありません。下で追加できます。</td></tr>';
  else {
    mb.innerHTML = entries.map(([repo, cat]) =>
      '<tr><td class="repo">' + esc(repo) + '</td>' +
      '<td><select data-repo="' + esc(repo) + '">' + optionsHtml(cat) + '</select></td>' +
      '<td style="text-align:right;"><button class="link" data-del="' + esc(repo) + '">削除</button></td></tr>'
    ).join('');
    mb.querySelectorAll('select[data-repo]').forEach((sel) => sel.addEventListener('change', onMapChange));
    mb.querySelectorAll('button[data-del]').forEach((btn) => btn.addEventListener('click', onMapDelete));
  }
  $('newCat').innerHTML = optionsHtml('');

  // 組み込みルール
  $('builtins').innerHTML = (STATE.builtins || []).map((r) => '<div class="builtin">' + esc(r.match) + ' → ' + esc(r.categoryPath) + '</div>').join('');

  // カテゴリ名の編集
  renderCats();
}
function catRow(node, isParent, parentValue) {
  const pv = parentValue == null ? '' : parentValue;
  return '<div class="catrow ' + (isParent ? 'parent' : 'child') + '" data-value="' + esc(node.value) + '" data-parent="' + esc(pv) + '" data-label="' + esc(node.label) + '">' +
    '<span class="dot" style="background:' + esc(node.color || '#cbd5e1') + '"></span>' +
    '<span class="nm">' + esc(node.label) + '</span>' +
    '<button class="edit" title="名前を変更">✎</button></div>';
}
function renderCats() {
  const el = $('cats');
  const tree = STATE.tree || [];
  if (!tree.length) { el.innerHTML = '<div class="empty">' + (STATE.loggedIn ? 'カテゴリがありません' : '—') + '</div>'; return; }
  let h = '';
  for (const p of tree) {
    h += '<div class="catp">' + catRow(p, true, null);
    for (const c of p.subs || []) h += catRow(c, false, p.value);
    h += '</div>';
  }
  el.innerHTML = h;
  el.querySelectorAll('.catrow .edit').forEach((btn) => btn.addEventListener('click', startRename));
}
function startRename(e) {
  const row = e.target.closest('.catrow');
  if (row.querySelector('input')) return;
  const cur = row.getAttribute('data-label');
  const nm = row.querySelector('.nm');
  nm.innerHTML = '<input type="text" value="' + esc(cur) + '"> <button class="primary" data-save>保存</button> <button data-cancel>取消</button>';
  const input = nm.querySelector('input');
  input.focus(); input.select();
  const commit = () => doRename(row, input.value.trim());
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(); if (ev.key === 'Escape') render(); });
  nm.querySelector('[data-save]').addEventListener('click', commit);
  nm.querySelector('[data-cancel]').addEventListener('click', () => render());
}
async function doRename(row, label) {
  const value = row.getAttribute('data-value');
  const parentValue = row.getAttribute('data-parent') || null;
  const old = row.getAttribute('data-label');
  if (!label || label === old) { render(); return; }
  try {
    const r = await api('/api/category/rename', 'POST', { value, parentValue, label });
    toast('「' + old + '」→「' + label + '」' + (r.repoChanged ? '（紐づけ' + r.repoChanged + '件も更新）' : ''));
    await load();
  } catch (err) { toast('失敗: ' + err.message); render(); }
}
async function onClassify(e) {
  const repo = e.target.getAttribute('data-classify');
  const categoryPath = e.target.value;
  if (!categoryPath) return;
  e.target.disabled = true;
  try {
    const r = await api('/api/classify', 'POST', { repo, categoryPath });
    toast(repo + ' → ' + categoryPath + '（' + r.updated + '件更新・以降自動）');
    await load();
  } catch (err) { toast('失敗: ' + err.message); e.target.disabled = false; }
}
async function onMapChange(e) {
  const repo = e.target.getAttribute('data-repo');
  const categoryPath = e.target.value;
  try { await api('/api/repo-map', 'POST', { repo, categoryPath }); toast(categoryPath ? (repo + ' → ' + categoryPath) : (repo + ' を未設定に')); await load(); }
  catch (err) { toast('失敗: ' + err.message); }
}
async function onMapDelete(e) {
  const repo = e.target.getAttribute('data-del');
  try { await api('/api/repo-map', 'POST', { repo, categoryPath: '' }); toast(repo + ' を削除'); await load(); }
  catch (err) { toast('失敗: ' + err.message); }
}
$('addBtn').addEventListener('click', async () => {
  const repo = $('newRepo').value.trim();
  const categoryPath = $('newCat').value;
  if (!repo) { toast('ディレクトリ名を入力'); return; }
  if (!categoryPath) { toast('カテゴリを選択'); return; }
  try { await api('/api/repo-map', 'POST', { repo, categoryPath }); $('newRepo').value = ''; toast(repo + ' → ' + categoryPath); await load(); }
  catch (err) { toast('失敗: ' + err.message); }
});
load();
</script>
</body></html>`;

module.exports = { start, DEFAULT_PORT };
