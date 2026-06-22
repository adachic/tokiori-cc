'use strict';

const path = require('path');
const { optionPaths } = require('./categories');

// Phase 2: リポジトリ → 実カテゴリ（listCategories の正準ラベル "親/子"）の対応。
// cwd のパス要素に match が含まれれば採用。リポジトリルートでも当たるよう
// 祖先ディレクトリ名（例 'tokiori'）でマッチさせる。
const REPO_RULES = [
  { match: 'tokiori', categoryPath: '開発/ときおり' },
  { match: 'contextpilot', categoryPath: '開発/ContextPilot' },
  { match: 'tamagolabo', categoryPath: '開発/タマゴラボ' },
  { match: 'newgame-hyouryuujima', categoryPath: '開発/漂流島' },
  { match: 'hyouryuujima', categoryPath: '開発/漂流島' },
  { match: '7days', categoryPath: '開発/7days' },
  { match: 'newapp', categoryPath: '開発/新アプリ' },
  { match: 'newgame', categoryPath: '開発/新アプリ' },
  { match: 'churnguard', categoryPath: '開発/新アプリ' },
  { match: 'pivot', categoryPath: '仕事/pivot' },
  { match: 'konica', categoryPath: '仕事/コニカミノルタ' },
  { match: 'konicaminolta', categoryPath: '仕事/コニカミノルタ' },
];

function repoName(cwd) {
  if (!cwd) return 'work';
  return path.basename(String(cwd)) || 'work';
}

// 静的マップで cwd → categoryPath。config.repoMap で上書き/追加可能。
function staticMatch(cwd, cfg) {
  if (!cwd) return null;
  const parts = String(cwd).split(path.sep);
  // ユーザー定義（config.repoMap: { ディレクトリ名: "親/子" }）を優先。
  const userMap = (cfg && cfg.repoMap) || {};
  for (const part of parts) {
    if (userMap[part]) return userMap[part];
  }
  for (const rule of REPO_RULES) {
    if (parts.includes(rule.match)) return rule.categoryPath;
  }
  return null;
}

// 未知リポジトリ向け：Anthropic API(haiku) で実カテゴリ候補から1つ選ばせる。
// APIキーが無ければ null（→ 呼び出し側で (uncat) フォールバック）。
async function classifyWithLLM(ctx, cfg) {
  const apiKey = (cfg && cfg.anthropicApiKey) || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const options = optionPaths(cfg.categories || []);
  if (!options.length) return null;

  const hint = (ctx.firstUserText || '').slice(0, 500);
  const prompt =
    `次の開発作業を、カテゴリ候補から最も近いもの1つに分類してください。\n` +
    `必ず候補のいずれかを "親/子" の形でそのまま1行で返す。該当が無ければ (uncat) とだけ返す。説明不要。\n\n` +
    `作業ディレクトリ: ${ctx.cwd}\n` +
    (hint ? `最初の指示: ${hint}\n` : '') +
    `\n候補:\n` + options.map((o) => `- ${o}`).join('\n');

  const model = (cfg.llm && cfg.llm.model) || 'claude-haiku-4-5-20251001';
  const ctrl = AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: 'user', content: prompt }] }),
    signal: ctrl,
  });
  const j = await res.json().catch(() => ({}));
  const text = (j.content && j.content[0] && j.content[0].text || '').trim();
  if (!text) return null;
  // 候補集合に対して厳密検証（ハルシネーション防止）。
  const set = new Set(options);
  if (set.has(text)) return text;
  // 余計な装飾を除いて再判定
  const cleaned = text.replace(/^["'`\s]+|["'`\s]+$/g, '');
  return set.has(cleaned) ? cleaned : null;
}

// 1行に整形（最初の非空行・空白圧縮・引用符除去・最大長で切り詰め）。
function cleanOneLine(s, max) {
  let t = String(s || '').replace(/\r/g, '').split('\n').map((x) => x.trim()).find((x) => x.length > 0) || '';
  t = t.replace(/\s+/g, ' ').trim().replace(/^["'`「『]+|["'`」』]+$/g, '');
  if (t.length > max) t = t.slice(0, max).trim() + '…';
  return t;
}

// 作業内容タイトル：最初のユーザー指示から。APIキーがあれば LLM で簡潔化。
async function workTitle(ctx, cfg) {
  const text = (ctx && ctx.firstUserText) || '';
  if (!text.trim()) return '';
  const max = (cfg && cfg.titleMaxLen) || 60;
  const apiKey = (cfg && cfg.anthropicApiKey) || process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const s = await summarizeTitleLLM(text, apiKey, cfg);
      if (s) return cleanOneLine(s, max);
    } catch (_) { /* フォールバックへ */ }
  }
  return cleanOneLine(text, max);
}

async function summarizeTitleLLM(text, apiKey, cfg) {
  const model = (cfg && cfg.llm && cfg.llm.model) || 'claude-haiku-4-5-20251001';
  const prompt =
    `次の開発指示を、時間記録用の短い作業タイトルにしてください。` +
    `日本語・20〜30字・体言止め・挨拶や記号や絵文字は除く・1行だけ返す。説明不要。\n\n指示:\n${text.slice(0, 1000)}`;
  const signal = AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 48, messages: [{ role: 'user', content: prompt }] }),
    signal,
  });
  const j = await res.json().catch(() => ({}));
  return (j.content && j.content[0] && j.content[0].text || '').trim();
}

// メイン：静的マップ→（未知なら）LLM→フォールバック の順で categoryPath を決める。
async function classify(ctx, cfg) {
  const base = `Claude Code: ${repoName(ctx.cwd)}`;
  const work = await workTitle(ctx, cfg);
  const title = work ? `${base}: ${work}` : base;
  const stat = staticMatch(ctx.cwd, cfg);
  if (stat) return { categoryPath: stat, title, by: 'map' };

  let llm = null;
  try { llm = await classifyWithLLM(ctx, cfg); } catch (_) { llm = null; }
  if (llm) return { categoryPath: llm, title, by: 'llm' };

  return { categoryPath: (cfg && cfg.fallbackCategory) || '(uncat)', title, by: 'fallback' };
}

module.exports = { classify, staticMatch, repoName, REPO_RULES };
