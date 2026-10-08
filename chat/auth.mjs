import { createServer } from 'node:http';
import { readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
const tokenPath = new URL('token.json', import.meta.url), clientPath = new URL('google-client.json', import.meta.url);
const CHAT_SCOPES = ['spaces.readonly', 'memberships.readonly', 'messages.readonly', 'messages.create'].map(s => `https://www.googleapis.com/auth/chat.${s}`);
const page = ok => `<!doctype html><meta charset="utf-8"><title>Google Chat setup</title><p>Google Chat sign-in ${ok ? 'finished' : 'failed; see the setup window'}. You can close this tab.</p>`;

// google-client.json is a Google "Desktop app" client. Google treats its secret as not confidential:
// it ships with the app, and each user's own consent is what grants access.
export async function authorize({account, openBrowser}) {
  const c = JSON.parse(readFileSync(clientPath, 'utf8')).installed;
  if (!c?.client_id || !c.client_secret || !/^https:\/\/accounts\.google\.com\//.test(c.auth_uri) || !/^https:\/\/oauth2\.googleapis\.com\//.test(c.token_uri))
    throw new Error('This OAuth client file is not a Google "Desktop app" client. In Google Cloud, create an OAuth client of type "Desktop app" and download its JSON.');
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(16).toString('base64url');
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  let respond;
  const callback = new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const q = new URL(req.url, redirectUri).searchParams;
      if (!q.has('state')) return res.writeHead(404).end();
      respond = ok => res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}).end(page(ok));
      if (q.get('state') !== state) reject(new Error('Sign-in response did not match this setup run. Run the setup again.'));
      else if (!q.get('code')) reject(new Error(`Google sign-in was cancelled or failed (${q.get('error') || 'no code'}).`));
      else resolve(q.get('code'));
    });
    setTimeout(() => reject(new Error('Timed out after 5 minutes waiting for Google sign-in. Run the setup again.')), 300_000).unref();
  });
  callback.catch(() => {});
  try {
    const url = new URL(c.auth_uri);
    url.search = new URLSearchParams({client_id: c.client_id, redirect_uri: redirectUri, response_type: 'code', scope: ['openid', 'email', ...CHAT_SCOPES].join(' '),
      state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', login_hint: account});
    console.log(`Sign in to Google in your browser. If it does not open, paste this address into it:\n${url}`);
    try { await openBrowser?.(url.href); } catch {}
    const code = await callback;
    const res = await fetch(c.token_uri, {method: 'POST', signal: AbortSignal.timeout(30_000), body: new URLSearchParams({
      code, code_verifier: verifier, client_id: c.client_id, client_secret: c.client_secret, redirect_uri: redirectUri, grant_type: 'authorization_code'})});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google rejected the sign-in (${data.error || `HTTP ${res.status}`}).`);
    // The id_token came straight from Google's token endpoint over TLS, so its signature needs no check.
    const claims = JSON.parse(Buffer.from(String(data.id_token).split('.')[1] || '', 'base64url').toString() || '{}');
    if (claims.email_verified !== true || String(claims.email).toLowerCase() !== account.toLowerCase())
      throw new Error(`Signed in as ${claims.email || 'an unknown account'}, but this setup is for ${account}. Run the setup again and choose ${account}.`);
    if (!data.refresh_token) throw new Error('Google returned no refresh token. Run the setup again.');
    const granted = String(data.scope).split(' ');
    if (CHAT_SCOPES.some(s => !granted.includes(s))) throw new Error('Not all Google Chat permissions were granted. Run the setup again and tick all boxes on the Google consent screen.');
    writeFileSync(tokenPath, JSON.stringify({account, refresh_token: data.refresh_token}), {mode: 0o600}); chmodSync(tokenPath, 0o600);
    respond?.(true);
    return {account};
  } catch (error) { respond?.(false); throw error; }
  finally { server.close(); }
}

// Returns false and keeps the files when Google could not be reached, so the user can retry.
export async function revoke() {
  if (existsSync(tokenPath)) {
    let refresh_token;
    try { ({refresh_token} = JSON.parse(readFileSync(tokenPath, 'utf8'))); } catch { /* An unreadable token cannot be revoked. */ }
    if (refresh_token) try {
      const res = await fetch('https://oauth2.googleapis.com/revoke', {method: 'POST', body: new URLSearchParams({token: refresh_token}), signal: AbortSignal.timeout(30_000)});
      // 400 means Google already treats the token as invalid.
      if (!res.ok && res.status !== 400) return false;
    } catch { return false; }
  }
  rmSync(tokenPath, {force: true});
  return true;
}
