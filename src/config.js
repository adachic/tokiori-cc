'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const ROOT = path.join(HOME, '.tokiori');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_DIR = path.join(ROOT, 'state');
const BIN_DIR = path.join(ROOT, 'bin');
const SHIM_PATH = path.join(BIN_DIR, 'tokiori-cc');
const ERROR_LOG = path.join(ROOT, 'error.log');

// 環境別エンドポイント。ログイン用 client は web クライアント
// （API オーソライザーが aud=web クライアントのトークンしか受理しないため）。
// web クライアントには loopback http://localhost:8123/callback を追加済み。
const ENDPOINTS = {
  dev: {
    env: 'dev',
    region: 'ap-northeast-1',
    trackApi: 'https://9q4rt06675.execute-api.ap-northeast-1.amazonaws.com/track',
    appsyncUrl: 'https://mwwq5wdklbe4jfwtscurhdkzwa.appsync-api.ap-northeast-1.amazonaws.com/graphql',
    userPoolId: 'ap-northeast-1_a9Yv1f2rz',
    webClientId: '43u1oh2302jjmia3tedbtksgkp',
    cliClientId: '43u1oh2302jjmia3tedbtksgkp',
    loopbackPort: 8123,
    identityPoolId: 'ap-northeast-1:666e5e0f-4ff3-4634-b6bc-f8b7a335a467',
    cognitoDomain: 'admin-console-tokiori-dev.auth.ap-northeast-1.amazoncognito.com',
  },
  prod: {
    env: 'prod',
    region: 'ap-northeast-1',
    trackApi: 'https://zq3s5dpz9i.execute-api.ap-northeast-1.amazonaws.com/track',
    appsyncUrl: 'https://onfkao4r6rebje2lrrj3e3fa5y.appsync-api.ap-northeast-1.amazonaws.com/graphql',
    userPoolId: 'ap-northeast-1_G5FGoR5aN',
    webClientId: '2jaeuq2219fa6038v2unhntla7',
    cliClientId: '2jaeuq2219fa6038v2unhntla7',
    loopbackPort: 8123,
    identityPoolId: 'ap-northeast-1:9bc8ce0c-84da-4b42-bce9-6b1b8c1ae837',
    cognitoDomain: 'admin-console-tokiori-prod.auth.ap-northeast-1.amazoncognito.com',
  },
};

const DEFAULT_ENV = 'prod';

function ensureDirs() {
  for (const d of [ROOT, STATE_DIR, BIN_DIR]) fs.mkdirSync(d, { recursive: true });
}

// 永続化する生フィールド（解決済みの endpoints/userId/auth は保存しない）。
function rawDefaults() {
  return {
    version: 2,
    enabled: true,
    autoUpdate: false,
    minSeconds: 0,
    // 日跨ぎ/長時間アイドルで新ブロックに分割する閾値（分）。0 で無効。
    gapMinutes: 30,
    env: DEFAULT_ENV,
    accounts: {},              // { dev:{userId,refreshToken}, prod:{...} }
    categories: [],
    repoMap: {},
    fallbackCategory: '(uncat)',
    anthropicApiKey: null,
    titleMaxLen: 60,
    // memo に残す詳細: 'none'（従来どおりIDのみ）| 'instructions'（指示の箇条書き）| 'summary'（LLM要約）。
    // 指示テキストの抜粋を送信するため opt-in（README の送信ポリシー参照）。
    detail: 'none',
    detailMaxLen: 1000,
    llm: { model: 'claude-haiku-4-5-20251001' },
  };
}

function readRaw() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { raw = {}; }
  raw = { ...rawDefaults(), ...raw };
  // v1（top-level endpoints/userId/auth）→ v2（accounts）への移行。
  if (!raw.accounts) raw.accounts = {};
  if (raw.auth && raw.auth.refreshToken && !raw.accounts.dev) {
    raw.accounts.dev = { userId: raw.userId || null, refreshToken: raw.auth.refreshToken };
  }
  delete raw.auth; delete raw.userId; delete raw.endpoints;
  if (!ENDPOINTS[raw.env]) raw.env = DEFAULT_ENV;
  return raw;
}

// 読み出し用の解決済みビュー（hook/auth/client は cfg.endpoints/userId/auth を見る）。
function load() {
  const raw = readRaw();
  const acct = raw.accounts[raw.env] || {};
  return {
    ...raw,
    endpoints: ENDPOINTS[raw.env],
    userId: acct.userId || null,
    auth: { refreshToken: acct.refreshToken || null },
  };
}

// 保存：解決済みフィールドは落として生フィールドのみ書く。
function save(cfg) {
  ensureDirs();
  const raw = {
    version: 2,
    enabled: cfg.enabled,
    autoUpdate: cfg.autoUpdate,
    minSeconds: cfg.minSeconds,
    gapMinutes: cfg.gapMinutes != null ? cfg.gapMinutes : 30,
    env: cfg.env,
    accounts: cfg.accounts || {},
    categories: cfg.categories || [],
    repoMap: cfg.repoMap || {},
    fallbackCategory: cfg.fallbackCategory || '(uncat)',
    anthropicApiKey: cfg.anthropicApiKey || null,
    titleMaxLen: cfg.titleMaxLen || 60,
    detail: cfg.detail || 'none',
    detailMaxLen: cfg.detailMaxLen || 1000,
    llm: cfg.llm || { model: 'claude-haiku-4-5-20251001' },
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
}

// ログイン結果を現在 env のアカウントへ保存。
function setAccount(cfg, env, account) {
  cfg.accounts = cfg.accounts || {};
  cfg.accounts[env] = account;
  save(cfg);
}

function setEnv(env) {
  if (!ENDPOINTS[env]) throw new Error(`未知の env: ${env}（dev|prod）`);
  const raw = readRaw();
  raw.env = env;
  save({ ...raw, env });
  return env;
}

function logError(msg) {
  try {
    ensureDirs();
    fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) { /* 黙殺 */ }
}

module.exports = {
  HOME, ROOT, CONFIG_PATH, STATE_DIR, BIN_DIR, SHIM_PATH, ERROR_LOG,
  ENDPOINTS, DEFAULT_ENV,
  ensureDirs, load, save, setAccount, setEnv, logError,
};
