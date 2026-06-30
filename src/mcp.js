'use strict';

// 最小 stdio MCP サーバ（JSON-RPC 2.0 / Content-Length フレーミング）。
// Phase 1: status / set_enabled を Claude から叩けるようにする薄い窓口。
// 実反映は Stop フックが担うため、ここは補助的な操作のみ。

const config = require('./config');
const categories = require('./categories');
const cmdCategorize = require('./cmd_categorize');

const SERVER_INFO = { name: 'tokiori', version: '0.2.0' };

const TOOLS = [
  { name: 'tokiori_status', description: 'tokiori 連携の状態（有効/ログイン/環境/未分類件数）を返す', inputSchema: { type: 'object', properties: {} } },
  { name: 'tokiori_set_enabled', description: 'タイムライン自動反映の ON/OFF を切替', inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] } },
  { name: 'tokiori_list_categories', description: 'カテゴリ階層（親/子・value付き）と "親/子" 形の選択肢一覧を返す', inputSchema: { type: 'object', properties: {} } },
  { name: 'tokiori_list_uncat', description: '未分類(uncat)セッションをリポジトリ単位で一覧（repo/件数/合計秒/例タイトル）', inputSchema: { type: 'object', properties: {} } },
  { name: 'tokiori_categorize', description: '未分類リポジトリにカテゴリを適用：repoMap保存＋既存タイムライン更新＋pending除去（以降自動）。categoryPath は "親/子"', inputSchema: { type: 'object', properties: { repo: { type: 'string' }, categoryPath: { type: 'string' } }, required: ['repo', 'categoryPath'] } },
  { name: 'tokiori_set_repo_map', description: 'ローカルディレクトリ→カテゴリの紐づけ(repoMap)を追加/更新。categoryPath を空にすると削除', inputSchema: { type: 'object', properties: { repo: { type: 'string' }, categoryPath: { type: 'string' } }, required: ['repo'] } },
  { name: 'tokiori_rename_category', description: 'カテゴリ表示名(label)を変更。value(不変スラッグ)で対象指定、子は parentValue 必須。既存タイムラインはサーバが追従、ローカルrepoMapも追従更新', inputSchema: { type: 'object', properties: { value: { type: 'string' }, parentValue: { type: 'string' }, label: { type: 'string' } }, required: ['value', 'label'] } },
];

function ok(text) { return { content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }] }; }

async function callTool(name, args) {
  if (name === 'tokiori_status') {
    const cfg = config.load();
    return ok({ enabled: cfg.enabled, loggedIn: !!(cfg.auth && cfg.auth.refreshToken), userId: cfg.userId, env: cfg.endpoints.env, uncatPending: require('./pending').count() });
  }
  if (name === 'tokiori_set_enabled') {
    const cfg = config.load();
    cfg.enabled = !!args.enabled;
    config.save(cfg);
    return ok(`enabled=${cfg.enabled}`);
  }
  if (name === 'tokiori_list_categories') {
    const tree = await categories.listRest();
    const options = [];
    for (const p of tree) for (const c of p.subs || []) options.push(`${p.label}/${c.label}`);
    return ok({ tree, options });
  }
  if (name === 'tokiori_list_uncat') {
    const cfg = config.load();
    const groups = (await cmdCategorize.collectGroups(cfg)).map((g) => {
      const totalSec = g.entries.reduce((a, s) => a + Math.max(0, ((s.endMs || s.startMs) - s.startMs) / 1000), 0);
      const sample = g.entries.map((e) => e.title).find((t) => t) || '';
      return { repo: g.repo, count: g.entries.length, totalSec: Math.round(totalSec), sample };
    }).sort((a, b) => b.count - a.count);
    return ok({ count: groups.length, groups });
  }
  if (name === 'tokiori_categorize') {
    const repo = String(args.repo || '').trim();
    const categoryPath = String(args.categoryPath || '').trim();
    if (!repo || !categoryPath) throw new Error('repo と categoryPath は必須です');
    const cfg = config.load();
    if (!cfg.userId) throw new Error('未ログインです（tokiori-cc login）');
    const groups = await cmdCategorize.collectGroups(cfg);
    const g = groups.find((x) => x.repo === repo);
    const entries = g ? g.entries : [];
    const { updated, failed } = await cmdCategorize.applyGroup(cfg, repo, entries, categoryPath);
    return ok({ ok: true, repo, categoryPath, updated, failed });
  }
  if (name === 'tokiori_set_repo_map') {
    const repo = String(args.repo || '').trim();
    const categoryPath = args.categoryPath == null ? '' : String(args.categoryPath).trim();
    if (!repo) throw new Error('repo は必須です');
    const cfg = config.load();
    cfg.repoMap = cfg.repoMap || {};
    if (categoryPath) cfg.repoMap[repo] = categoryPath; else delete cfg.repoMap[repo];
    config.save(cfg);
    return ok({ ok: true, repoMap: cfg.repoMap });
  }
  if (name === 'tokiori_rename_category') {
    const cfg = config.load();
    if (!cfg.userId) throw new Error('未ログインです（tokiori-cc login）');
    const r = await categories.renameAndRemap(cfg, { value: args.value, parentValue: args.parentValue || null, label: args.label });
    return ok({ ok: true, ...r });
  }
  throw new Error(`unknown tool: ${name}`);
}

// MCP stdio は改行区切り JSON（NDJSON）。1 メッセージ = 1 行。
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function result(id, res) { send({ jsonrpc: '2.0', id, result: res }); }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return result(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (method === 'notifications/initialized') return; // 通知（応答不要）
  if (method === 'tools/list') return result(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    // ネットワークを伴うツールがあるため非同期。失敗は isError で返す（接続は維持）。
    Promise.resolve()
      .then(() => callTool(name, args))
      .then((res) => result(id, res))
      .catch((e) => result(id, { isError: true, content: [{ type: 'text', text: String((e && e.message) || e) }] }));
    return;
  }
  if (typeof id !== 'undefined') return error(id, -32601, `method not found: ${method}`);
}

// 改行区切り JSON（NDJSON）のパーサ。
function start() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      try { handle(msg); } catch (_) { /* 1件の失敗で落とさない */ }
    }
  });
  process.stdin.resume();
}

module.exports = { start };
