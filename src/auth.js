'use strict';

const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const config = require('./config');
const { decodeJwt } = require('./util');

// ---- Cognito IDP 低レベル呼び出し（fetch / Node18+） ----
async function idpCall(region, target, body) {
  const url = `https://cognito-idp.${region}.amazonaws.com/`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch (_) { /* noop */ }
  if (!res.ok) {
    const msg = json.message || json.__type || text || `HTTP ${res.status}`;
    const err = new Error(`Cognito ${target} failed: ${msg}`);
    err.cognitoType = json.__type;
    throw err;
  }
  return json;
}

// refreshToken → 新しい idToken。メモリ内で短時間キャッシュ。
let _cache = { idToken: null, expMs: 0 };

async function getIdToken(cfg) {
  cfg = cfg || config.load();
  const now = Date.now();
  if (_cache.idToken && _cache.expMs - 60_000 > now) return _cache.idToken;

  const refreshToken = cfg.auth && cfg.auth.refreshToken;
  if (!refreshToken) {
    const e = new Error('未ログインです。`tokiori-cc login` を実行してください。');
    e.code = 'NO_AUTH';
    throw e;
  }
  const { region } = cfg.endpoints;
  const webClientId = cfg.endpoints.cliClientId || cfg.endpoints.webClientId;
  const out = await idpCall(region, 'InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    ClientId: webClientId,
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  });
  const idToken = out.AuthenticationResult && out.AuthenticationResult.IdToken;
  if (!idToken) throw new Error('idToken を取得できませんでした');
  const payload = decodeJwt(idToken) || {};
  _cache = { idToken, expMs: (payload.exp ? payload.exp * 1000 : now + 50 * 60_000) };
  return idToken;
}

function userIdFromIdToken(idToken) {
  const p = decodeJwt(idToken) || {};
  return p.sub || p['cognito:username'] || null;
}

// ---- パスワードログイン（USER_PASSWORD_AUTH）----
// Google フェデレーションでないネイティブ dev ユーザー向け。
async function loginWithPassword(cfg, email, password) {
  const { region } = cfg.endpoints;
  const webClientId = cfg.endpoints.cliClientId || cfg.endpoints.webClientId;
  const out = await idpCall(region, 'InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: webClientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  const ar = out.AuthenticationResult;
  if (!ar || !ar.RefreshToken) {
    throw new Error(`想定外のチャレンジ応答: ${out.ChallengeName || '(なし)'}（MFA等は未対応）`);
  }
  return { refreshToken: ar.RefreshToken, userId: userIdFromIdToken(ar.IdToken) };
}

// ---- ブラウザ PKCE ループバックログイン（Hosted UI）----
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref(); } catch (_) { /* noop */ }
}

async function loginWithBrowser(cfg, opts) {
  opts = opts || {};
  const port = opts.port || cfg.endpoints.loopbackPort || 8123;
  const { cognitoDomain } = cfg.endpoints;
  const webClientId = cfg.endpoints.cliClientId || cfg.endpoints.webClientId;
  const redirectUri = `http://localhost:${port}/callback`;
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  // identity_provider=Google で Hosted UI の選択画面を飛ばして Google へ直行。
  // （COGNITO/Google 両方有効だと選択画面で詰まりやすいため）
  const idp = opts.idp === null ? '' : `&identity_provider=${encodeURIComponent(opts.idp || 'Google')}`;
  const authorizeUrl =
    `https://${cognitoDomain}/oauth2/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(webClientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent('openid email profile')}` +
    idp +
    `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, redirectUri);
      process.stderr.write(`[login] 受信: ${req.method} ${u.pathname}${u.search ? ' (?'+Array.from(u.searchParams.keys()).join(',')+')' : ''}\n`);
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const gotState = u.searchParams.get('state');
      const gotCode = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="font-family:sans-serif">tokiori 連携が完了しました。このタブを閉じてください。</body></html>');
      server.close();
      if (err) return reject(new Error(`認可エラー: ${err}`));
      if (gotState !== state) return reject(new Error('state 不一致（CSRF 疑い）'));
      if (!gotCode) return reject(new Error('認可コードが取得できませんでした'));
      resolve(gotCode);
    });
    server.on('error', reject);
    server.listen(port, () => {
      process.stderr.write(`ブラウザを開きます。開かない場合は次の URL へ:\n${authorizeUrl}\n`);
      openBrowser(authorizeUrl);
    });
    setTimeout(() => { try { server.close(); } catch (_) {} reject(new Error('ログインがタイムアウトしました')); }, 300_000);
  });

  // code → token 交換
  const tokenUrl = `https://${cognitoDomain}/oauth2/token`;
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: webClientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.refresh_token) {
    throw new Error(`トークン交換に失敗: ${json.error || res.status}`);
  }
  return { refreshToken: json.refresh_token, userId: userIdFromIdToken(json.id_token) };
}

module.exports = { getIdToken, loginWithPassword, loginWithBrowser, userIdFromIdToken };
