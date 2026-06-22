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

// config にキャッシュ（オフライン時/LLM 候補用）。
async function sync(cfg) {
  cfg = cfg || config.load();
  const cats = await fetchCategories(cfg);
  cfg.categories = cats;
  config.save(cfg);
  return cats;
}

module.exports = { fetchCategories, optionPaths, sync };
