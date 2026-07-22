'use strict';

// tokiori-cc worklog — 日別の成果アイテム（作業ログ）を収集して tokiori に push する。
//
// 収集源:
//   - GitHub (gh CLI 経由・ローカルの gh 認証を使用):
//       自分が作成した PR / マージされた自分の PR / 作成した Issue / レビューした PR
//   - Claude Code: ~/.claude/projects のセッション（タイトルとプロジェクト名のみ。
//       会話本文・コードは送らない — hook と同じ送信ポリシー）
//
// 複数端末運用が前提。API はアイテム単位の冪等 upsert（itemKey で重複排除）なので、
// 同じ GitHub 活動を複数の端末が push しても 1 件にまとまる。
// Claude セッションは端末ごとに異なるため、各端末で実行すると合算される。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const config = require('./config');
const auth = require('./auth');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GH_LIMIT = 100;

/* ---------------- date helpers ---------------- */

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseRange(rest) {
  const get = (flag) => {
    const i = rest.indexOf(flag);
    return i >= 0 && rest[i + 1] ? rest[i + 1] : null;
  };
  const today = localDateStr(new Date());
  let from = get('--from');
  let to = get('--to');
  const date = get('--date');
  const days = get('--days');

  if (date) { from = date; to = date; }
  if (days && !from) {
    const n = Math.max(1, Number(days) | 0);
    const d = new Date();
    d.setDate(d.getDate() - (n - 1));
    from = localDateStr(d);
    to = today;
  }
  if (!from) from = today;
  if (!to) to = today;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    throw new Error('日付は YYYY-MM-DD 形式で指定してください');
  }
  if (from > to) throw new Error('--from は --to 以前にしてください');
  return { from, to };
}

function inRange(dateStr, range) {
  return dateStr >= range.from && dateStr <= range.to;
}

/* ---------------- GitHub (gh CLI) ---------------- */

function gh(args, opts) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

function ghJson(args) {
  const out = gh(args);
  try { return JSON.parse(out || '[]'); } catch (_) { return []; }
}

function ghAvailable() {
  try { gh(['auth', 'status', '--active']); return true; } catch (_) { return false; }
}

const SEARCH_FIELDS = 'number,title,repository,url,createdAt,closedAt,updatedAt,author';

function collectGithub(range, log) {
  if (!ghAvailable()) {
    log('(GitHub スキップ: gh が無いか未ログイン)');
    return [];
  }
  let login = '';
  try { login = gh(['api', 'user', '-q', '.login']).trim(); } catch (_) { /* noop */ }

  const items = [];
  const seen = new Set();
  const push = (item) => {
    if (!inRange(item.date, range)) return;
    if (seen.has(item.itemKey)) return;
    seen.add(item.itemKey);
    items.push(item);
  };
  const repoName = (r) => (r && (r.nameWithOwner || r.name)) || '';
  const created = `${range.from}..${range.to}`;

  // 自分が作成した PR
  for (const pr of ghJson(['search', 'prs', '--author=@me', `--created=${created}`, '--json', SEARCH_FIELDS, '--limit', String(GH_LIMIT)])) {
    const repo = repoName(pr.repository);
    const d = new Date(pr.createdAt);
    push({
      date: localDateStr(d), ts: d.getTime(),
      itemKey: `gh-pr-created:${repo}:${pr.number}`,
      source: 'github', kind: 'pr-created',
      title: pr.title, url: pr.url, repo,
    });
  }

  // マージされた自分の PR（merged 日ベース。search に mergedAt が無いので closedAt で代用）
  for (const pr of ghJson(['search', 'prs', '--author=@me', '--merged', `--merged-at=${created}`, '--json', SEARCH_FIELDS, '--limit', String(GH_LIMIT)])) {
    const repo = repoName(pr.repository);
    const d = new Date(pr.closedAt || pr.updatedAt);
    push({
      date: localDateStr(d), ts: d.getTime(),
      itemKey: `gh-pr-merged:${repo}:${pr.number}`,
      source: 'github', kind: 'pr-merged',
      title: pr.title, url: pr.url, repo,
    });
  }

  // 自分が作成した Issue
  for (const is of ghJson(['search', 'issues', '--author=@me', `--created=${created}`, '--json', SEARCH_FIELDS, '--limit', String(GH_LIMIT)])) {
    const repo = repoName(is.repository);
    const d = new Date(is.createdAt);
    push({
      date: localDateStr(d), ts: d.getTime(),
      itemKey: `gh-issue-created:${repo}:${is.number}`,
      source: 'github', kind: 'issue-created',
      title: is.title, url: is.url, repo,
    });
  }

  // 自分がレビューした PR（他人の PR のみ）。レビュー提出日は per-PR で取得して確定させる
  if (login) {
    const reviewed = ghJson(['search', 'prs', `--reviewed-by=${login}`, `--updated=${range.from}..`, '--json', SEARCH_FIELDS, '--limit', String(GH_LIMIT)])
      .filter((pr) => pr.author && pr.author.login && pr.author.login !== login);
    for (const pr of reviewed) {
      const repo = repoName(pr.repository);
      if (!repo) continue;
      let reviews = [];
      try {
        reviews = ghJson(['api', `repos/${repo}/pulls/${pr.number}/reviews`, '--paginate']);
      } catch (_) { continue; }
      const days = new Set();
      for (const rv of reviews) {
        if (!rv.user || rv.user.login !== login || !rv.submitted_at) continue;
        const d = new Date(rv.submitted_at);
        const ds = localDateStr(d);
        if (!inRange(ds, range) || days.has(ds)) continue;
        days.add(ds);
        push({
          date: ds, ts: d.getTime(),
          itemKey: `gh-pr-reviewed:${repo}:${pr.number}:${ds}`,
          source: 'github', kind: 'pr-reviewed',
          title: pr.title, url: pr.url, repo,
        });
      }
    }
  }

  return items;
}

/* ---------------- Claude Code sessions ---------------- */

const MAX_SESSION_SCAN_BYTES = 20 * 1024 * 1024;

function unescapeJsonString(m) {
  try { return JSON.parse(`"${m}"`); } catch (_) { return m; }
}

function extractSessionMeta(file) {
  let text;
  try {
    if (fs.statSync(file).size > MAX_SESSION_SCAN_BYTES) return { title: '', cwd: '' };
    text = fs.readFileSync(file, 'utf8');
  } catch (_) { return { title: '', cwd: '' }; }

  let cwd = '';
  const cwdMatch = text.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
  if (cwdMatch) cwd = unescapeJsonString(cwdMatch[1]);

  // 圧縮サマリーがあれば最優先
  const sumMatch = text.match(/"type":"summary","summary":"((?:[^"\\]|\\.)*)"/) ||
                   text.match(/"summary":"((?:[^"\\]|\\.)*)"/);
  if (sumMatch) return { title: unescapeJsonString(sumMatch[1]), cwd };

  // 無ければ最初のユーザー指示
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    if (obj.type !== 'user' || obj.isMeta) continue;
    const content = obj.message && obj.message.content;
    let t = '';
    if (typeof content === 'string') t = content;
    else if (Array.isArray(content)) {
      const c = content.find((x) => x && x.type === 'text' && x.text);
      t = c ? c.text : '';
    }
    t = String(t || '').trim();
    if (!t || t.startsWith('<') || t.startsWith('Caveat:')) continue;
    return { title: t.replace(/\s+/g, ' ').slice(0, 120), cwd };
  }
  return { title: '', cwd };
}

function collectClaude(range, log) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(root).map((n) => path.join(root, n))
      .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } });
  } catch (_) {
    log('(Claude Code スキップ: ~/.claude/projects が無い)');
    return [];
  }

  const device = os.hostname();
  const items = [];
  for (const dir of projectDirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch (_) { continue; }
    for (const name of files) {
      const file = path.join(dir, name);
      let st;
      try { st = fs.statSync(file); } catch (_) { continue; }
      if (!st.isFile() || st.size < 2048) continue;
      const date = localDateStr(st.mtime);
      if (!inRange(date, range)) continue;
      const meta = extractSessionMeta(file);
      if (!meta.title) continue;
      const project = meta.cwd ? path.basename(meta.cwd) : path.basename(dir).split('-').pop();
      items.push({
        date, ts: st.mtime.getTime(),
        itemKey: `cc-session:${path.basename(name, '.jsonl')}`,
        source: 'claude-code', kind: 'session',
        title: meta.title, repo: project, device,
      });
    }
  }
  return items;
}

/* ---------------- push ---------------- */

async function pushItems(cfg, items) {
  const idToken = await auth.getIdToken(cfg);
  const url = `${cfg.endpoints.trackApi}/worklog?userId=${encodeURIComponent(cfg.userId)}`;
  let saved = 0;
  for (let i = 0; i < items.length; i += 100) {
    const chunk = items.slice(i, i + 100);
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ items: chunk }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`worklog HTTP ${res.status}: ${text.slice(0, 200)}`);
    try { saved += (JSON.parse(text).saved || chunk.length); } catch (_) { saved += chunk.length; }
  }
  return saved;
}

/* ---------------- entrypoint ---------------- */

function loadCfg(envOverride) {
  const base = config.load();
  if (!envOverride || envOverride === base.env) return base;
  if (!config.ENDPOINTS[envOverride]) throw new Error(`未知の env: ${envOverride}（dev|prod）`);
  const acct = (base.accounts || {})[envOverride] || {};
  return {
    ...base,
    env: envOverride,
    endpoints: config.ENDPOINTS[envOverride],
    userId: acct.userId || null,
    auth: { refreshToken: acct.refreshToken || null },
  };
}

async function run(rest) {
  const log = (m) => process.stderr.write(m + '\n');
  const dryRun = rest.includes('--dry-run');
  const noGithub = rest.includes('--no-github');
  const noClaude = rest.includes('--no-claude');
  const ei = rest.indexOf('--env');
  const envOverride = ei >= 0 && rest[ei + 1] ? rest[ei + 1] : null;

  let range;
  try { range = parseRange(rest); } catch (e) { log(`✗ ${e.message}`); return 1; }

  const items = [];
  if (!noGithub) items.push(...collectGithub(range, log));
  if (!noClaude) items.push(...collectClaude(range, log));
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.ts || 0) - (b.ts || 0)));

  const bySource = {};
  for (const it of items) bySource[it.source] = (bySource[it.source] || 0) + 1;
  const summary = Object.entries(bySource).map(([k, v]) => `${k} ${v}件`).join(' / ') || '0件';
  log(`✓ 収集 ${range.from}..${range.to}: ${summary}`);

  if (dryRun) {
    if (rest.includes('--json')) {
      process.stdout.write(JSON.stringify(items, null, 2) + '\n');
    } else {
      for (const it of items) {
        process.stdout.write(`${it.date} [${it.source}/${it.kind}] ${it.title}${it.repo ? ` (${it.repo})` : ''}\n`);
      }
    }
    log('(dry-run: push しませんでした)');
    return 0;
  }

  if (items.length === 0) { log('push するアイテムがありません'); return 0; }

  const cfg = loadCfg(envOverride);
  if (!cfg.userId || !cfg.auth.refreshToken) {
    log(`✗ [${cfg.env}] は未ログインです。\`tokiori-cc login --env ${cfg.env}\` を実行してください`);
    return 1;
  }
  try {
    const saved = await pushItems(cfg, items);
    log(`✓ push 完了 [${cfg.env}] ${saved}件`);
    return 0;
  } catch (e) {
    log(`✗ push 失敗: ${e && e.message || e}`);
    config.logError(`worklog: ${e && e.message || e}`);
    return 1;
  }
}

module.exports = { run };
