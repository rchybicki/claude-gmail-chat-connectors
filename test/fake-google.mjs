// Fake Google for tests: replaces globalThis.fetch. Loopback (127.0.0.1) requests go to the real fetch.
export const ACCESS_TOKEN = 'ya29.FAKE-ACCESS-TOKEN';
export const requests = [];
const realFetch = globalThis.fetch;
const reply = (status, body) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
let refreshes = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input), method = init.method || 'GET', body = init.body === undefined ? undefined : String(init.body);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  requests.push({method, url: url.href, body});
  if (url.href === 'https://oauth2.googleapis.com/token') {
    const p = new URLSearchParams(body);
    if (p.get('grant_type') === 'refresh_token') {
      if (p.get('refresh_token') === 'revoked') return reply(400, {error: 'invalid_grant'});
      refreshes++;
      return reply(200, {access_token: ACCESS_TOKEN, expires_in: 3599});
    }
    // authorization_code: the test encodes the scenario as base64url JSON in the code.
    const s = JSON.parse(Buffer.from(p.get('code'), 'base64url').toString());
    const idToken = `e30.${Buffer.from(JSON.stringify({email: s.email, email_verified: s.email_verified ?? true})).toString('base64url')}.sig`;
    return reply(200, {access_token: ACCESS_TOKEN, refresh_token: s.refresh_token, scope: s.scope, id_token: idToken, expires_in: 3599});
  }
  if (url.href === 'https://oauth2.googleapis.com/revoke') return reply(200, {});
  if (url.hostname === 'chat.googleapis.com') {
    if (url.pathname.includes('notfound')) return reply(404, {error: {code: 404, message: 'Space not found', status: 'NOT_FOUND'}});
    const authOk = new Headers(init.headers).get('authorization') === `Bearer ${ACCESS_TOKEN}`;
    return reply(200, {method, url: url.href, body: body && JSON.parse(body), authOk, refreshes, fetches: requests.length});
  }
  return reply(599, {error: {message: `unexpected request ${url.href}`}});
};
