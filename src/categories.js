'use strict';

const config = require('./config');
const auth = require('./auth');

// 実カテゴリ階層を listCategories(GraphQL) から取得。
async function fetchCategories(cfg) {
  cfg = cfg || config.load();
  const token = await auth.getIdToken(cfg);
  const res = await fetch(cfg.endpoints.appsyncUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ query: 'query{ listCategories { label color subs { label value color } } }' }),
  });
  const j = await res.json().catch(() => ({}));
  if (j.errors) throw new Error('listCategories: ' + JSON.stringify(j.errors));
  return (j.data && j.data.listCategories) || [];
}

// 取得した階層を "親/子" の選択肢配列へ平坦化（LLM 候補・検証に使う）。
function optionPaths(categories) {
  const out = [];
  for (const c of categories || []) {
    for (const s of c.subs || []) out.push(`${c.label}/${s.label}`);
  }
  return out;
}

// REST GET {trackApi}/categories：value（不変スラッグ）と color を含む完全な階層を取得。
// GraphQL listCategories は親の value を返さないため、リネームにはこちらを使う。
async function listRest(cfg) {
  cfg = cfg || config.load();
  const token = await auth.getIdToken(cfg);
  const res = await fetch(`${cfg.endpoints.trackApi}/categories`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET /categories HTTP ${res.status}: ${text}`);
  let j; try { j = JSON.parse(text); } catch (_) { j = []; }
  // ハンドラは配列、または { items } / { categories } 形を返しうる。
  const arr = Array.isArray(j) ? j : (j.items || j.categories || []);
  return arr.map((p) => ({
    value: p.value,
    label: p.label ?? p.value,
    color: p.color,
    subs: (p.subs || []).map((c) => ({ value: c.value, label: c.label ?? c.value, color: c.color })),
  }));
}

// PUT {trackApi}/categories でラベルを変更。バックエンドが既存セッションの
// categoryPath を自動で追従更新する（親変更は子へ波及）。
async function rename(cfg, { parentValue, value, label, color }) {
  cfg = cfg || config.load();
  const token = await auth.getIdToken(cfg);
  const payload = { parentValue: parentValue || null, value, label };
  if (color) payload.color = color;
  const res = await fetch(`${cfg.endpoints.trackApi}/categories`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PUT /categories HTTP ${res.status}: ${text}`);
  return text;
}

// カテゴリ label 変更に追従してローカル repoMap の値を書き換える。
// child: "親/旧子" → "親/新子"。parent: "旧親/*" の接頭辞を "新親/" に。
function remapRepoMap(cfg, { isParent, parentLabel, oldLabel, newLabel }) {
  const map = cfg.repoMap || {};
  let changed = 0;
  for (const k of Object.keys(map)) {
    const v = map[k];
    if (isParent) {
      if (v === oldLabel) { map[k] = newLabel; changed++; }
      else if (v.startsWith(oldLabel + '/')) { map[k] = newLabel + '/' + v.slice(oldLabel.length + 1); changed++; }
    } else if (v === `${parentLabel}/${oldLabel}`) {
      map[k] = `${parentLabel}/${newLabel}`; changed++;
    }
  }
  return changed;
}

// カテゴリ表示名(label)を変更し、ローカル repoMap も追従更新する高レベル操作。
// 既存タイムラインの categoryPath はバックエンドが追従するためここでは触らない。
// 戻り値: { unchanged, oldLabel, newLabel, repoChanged }
async function renameAndRemap(cfg, { value, parentValue, label }) {
  cfg = cfg || config.load();
  value = String(value || '').trim();
  parentValue = parentValue ? String(parentValue).trim() : null;
  label = String(label || '').trim();
  if (!value || !label) throw new Error('value と label は必須です');

  const tree = await listRest(cfg);
  const isParent = !parentValue;
  let oldLabel = null, color = null, parentLabel = null;
  if (isParent) {
    const p = tree.find((x) => x.value === value);
    if (p) { oldLabel = p.label; color = p.color; }
  } else {
    const p = tree.find((x) => x.value === parentValue);
    parentLabel = p && p.label;
    const c = p && (p.subs || []).find((x) => x.value === value);
    if (c) { oldLabel = c.label; color = c.color; }
  }
  if (oldLabel === label) return { unchanged: true, oldLabel, newLabel: label, repoChanged: 0 };

  await rename(cfg, { parentValue, value, label, color });

  let repoChanged = 0;
  if (oldLabel) {
    repoChanged = remapRepoMap(cfg, { isParent, parentLabel, oldLabel, newLabel: label });
    if (repoChanged) config.save(cfg);
  }
  return { unchanged: false, oldLabel, newLabel: label, repoChanged };
}

// config にキャッシュ（オフライン時/LLM 候補用）。
async function sync(cfg) {
  cfg = cfg || config.load();
  const cats = await fetchCategories(cfg);
  cfg.categories = cats;
  config.save(cfg);
  return cats;
}

module.exports = { fetchCategories, optionPaths, sync, listRest, rename, remapRepoMap, renameAndRemap };
