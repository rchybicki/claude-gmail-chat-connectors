import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ACCESS_TOKEN, requests } from './fake-google.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fake = pathToFileURL(join(root, 'test', 'fake-google.mjs')).href;
const desktopClient = {installed: {client_id: 'cid.apps.googleusercontent.com', client_secret: 'csecret', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token'}};
const ACCOUNT = 'Jan.Kowalski@randstad.com';
const ALL_SCOPES = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/chat.spaces.readonly https://www.googleapis.com/auth/chat.memberships.readonly https://www.googleapis.com/auth/chat.messages.readonly https://www.googleapis.com/auth/chat.messages.create';

// Copies only the source files into a temp chat/ folder, so real token files are never read or written.
function tempChat(t, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chat-test-')), chat = join(dir, 'chat');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  mkdirSync(chat);
  for (const f of ['server.mjs', 'auth.mjs']) copyFileSync(join(root, 'chat', f), join(chat, f));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction');
  for (const [name, data] of Object.entries(files)) writeFileSync(join(chat, name), JSON.stringify(data));
  return chat;
}

async function startServer(t, files = {'oauth-client.json': desktopClient, 'token.json': {account: ACCOUNT, refresh_token: 'fake-refresh'}}) {
  const chat = tempChat(t, files);
  const client = new Client({name: 'test', version: '1'});
  await client.connect(new StdioClientTransport({command: process.execPath, args: ['--import', fake, join(chat, 'server.mjs')], stderr: 'pipe'}));
  t.after(() => client.close());
  return async (name, args) => {
    const r = await client.callTool({name, arguments: args});
    const text = r.content[0].text;
    assert.ok(!text.includes(ACCESS_TOKEN) && !text.includes('fake-refresh'), 'token leaked in tool output');
    return r.isError ? {error: text} : JSON.parse(text);
  };
}

test('lists the seven tools with correct annotations', async t => {
  const chat = tempChat(t, {});
  const client = new Client({name: 'test', version: '1'});
  await client.connect(new StdioClientTransport({command: process.execPath, args: ['--import', fake, join(chat, 'server.mjs')], stderr: 'pipe'}));
  t.after(() => client.close());
  const {tools} = await client.listTools();
  assert.deepEqual(tools.map(x => x.name), ['list_spaces', 'get_space', 'list_members', 'list_messages', 'get_message', 'search_messages', 'send_message']);
  for (const x of tools) {
    assert.equal(x.inputSchema.additionalProperties, false);
    assert.equal(x.annotations.readOnlyHint, x.name !== 'send_message');
  }
  assert.deepEqual(tools.at(-1).annotations, {readOnlyHint: false, destructiveHint: false, openWorldHint: true});
});

test('refreshes the access token once for two calls and sends it', async t => {
  const call = await startServer(t);
  const a = await call('list_spaces', {}), b = await call('get_space', {spaceId: 'AAA'});
  assert.equal(a.url, 'https://chat.googleapis.com/v1/spaces?pageSize=100');
  assert.equal(b.url, 'https://chat.googleapis.com/v1/spaces/AAA');
  assert.ok(a.authOk && b.authOk);
  assert.equal(b.refreshes, 1);
  assert.equal(b.fetches, 3);
});

test('list_messages always sends orderBy; values are URL-encoded', async t => {
  const call = await startServer(t);
  const r = await call('list_messages', {spaceId: 'AAA', filter: 'createTime > "2026-01-01T00:00:00Z"&x=1'});
  const u = new URL(r.url);
  assert.equal(u.pathname, '/v1/spaces/AAA/messages');
  assert.equal(u.searchParams.get('orderBy'), 'createTime DESC');
  assert.equal(u.searchParams.get('pageSize'), '25');
  assert.equal(u.searchParams.get('filter'), 'createTime > "2026-01-01T00:00:00Z"&x=1');
  assert.equal(u.searchParams.get('x'), null);
  assert.equal(new URL((await call('list_messages', {spaceId: 'AAA', orderBy: 'createTime ASC'})).url).searchParams.get('orderBy'), 'createTime ASC');
  const m = await call('list_members', {spaceId: 'AAA', pageToken: 'tok/+='});
  assert.equal(m.url, 'https://chat.googleapis.com/v1/spaces/AAA/members?pageToken=tok%2F%2B%3D');
  assert.equal((await call('get_message', {name: 'spaces/AAA/messages/m1.m1'})).url, 'https://chat.googleapis.com/v1/spaces/AAA/messages/m1.m1');
});

test('search_messages posts the query as filter', async t => {
  const call = await startServer(t);
  const r = await call('search_messages', {query: 'budget', pageToken: 'next'});
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://chat.googleapis.com/v1/spaces/-/messages:search');
  assert.deepEqual(r.body, {filter: 'budget', pageSize: 25, pageToken: 'next'});
});

test('send_message in a thread sets messageReplyOption and requestId', async t => {
  const call = await startServer(t);
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const r = await call('send_message', {spaceId: 'AAA', text: 'Hi', threadName: 'spaces/AAA/threads/T1', requestId});
  assert.equal(r.requestId, requestId);
  const u = new URL(r.message.url);
  assert.equal(u.pathname, '/v1/spaces/AAA/messages');
  assert.equal(u.searchParams.get('requestId'), requestId);
  assert.equal(u.searchParams.get('messageReplyOption'), 'REPLY_MESSAGE_OR_FAIL');
  assert.deepEqual(r.message.body, {text: 'Hi', thread: {name: 'spaces/AAA/threads/T1'}});
});

test('send_message without a thread generates a requestId and no reply option', async t => {
  const call = await startServer(t);
  const r = await call('send_message', {spaceId: 'AAA', text: 'Hi'});
  const u = new URL(r.message.url);
  assert.match(r.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(u.searchParams.get('requestId'), r.requestId);
  assert.equal(u.searchParams.has('messageReplyOption'), false);
  assert.deepEqual(r.message.body, {text: 'Hi'});
});

test('bad input is rejected before any request', async t => {
  const call = await startServer(t);
  const bad = [
    ['send_message', {spaceId: 'AAA', text: 'Hi', threadName: 'spaces/BBB/threads/T1'}, /threadName must belong to spaceId/],
    ['get_space', {spaceId: 'spaces/AAA'}, /Invalid spaceId/],
    ['get_space', {spaceId: '../x'}, /Invalid spaceId/],
    ['get_message', {name: 'spaces/AAA/messages/..'}, /Invalid name/],
    ['get_message', {name: 'spaces/AAA/threads/T1'}, /Invalid name/],
    ['list_spaces', {pageSize: 0}, /Invalid pageSize/],
    ['list_spaces', {pageSize: '5'}, /Invalid pageSize/],
    ['list_messages', {spaceId: 'AAA', orderBy: 'createTime'}, /Invalid orderBy/],
    ['search_messages', {query: ''}, /Invalid query/],
    ['search_messages', {query: 'x', pageSize: 101}, /Invalid pageSize/],
    ['send_message', {spaceId: 'AAA', text: 'Hi', requestId: 'not-a-uuid'}, /Invalid requestId/],
    ['send_message', {spaceId: 'AAA'}, /Missing argument: text/],
    ['list_spaces', {foo: 1}, /Unknown argument: foo/],
    ['get_space', {spaceId: 'AAA', __proto__x: 1}, /Unknown argument/],
    ['delete_space', {}, /Unknown tool/]
  ];
  for (const [name, args, pattern] of bad) assert.match((await call(name, args)).error, pattern, name);
  assert.equal((await call('list_spaces', {})).fetches, 2);
});

test('Google API errors return status and message', async t => {
  const call = await startServer(t);
  assert.equal((await call('get_space', {spaceId: 'notfound'})).error, 'Google Chat API error 404: Space not found');
  assert.match((await call('send_message', {spaceId: 'notfound', text: 'Hi'})).error, /404: Space not found \(requestId [0-9a-f-]{36}; reuse it/);
});

test('invalid_grant tells the user to re-run setup', async t => {
  const call = await startServer(t, {'oauth-client.json': desktopClient, 'token.json': {account: ACCOUNT, refresh_token: 'revoked'}});
  assert.match((await call('list_spaces', {})).error, /expired or was revoked.*node setup\.mjs chat/);
});

test('missing token files tell the user to run setup', async t => {
  const call = await startServer(t, {});
  for (const [name, args] of [['list_spaces', {}], ['send_message', {spaceId: 'AAA', text: 'Hi'}]])
    assert.match((await call(name, args)).error, /not set up.*node setup\.mjs chat <email> <client-file>/);
});

// authorize(): the test plays the browser by calling the loopback redirect itself.
async function authorize(t, {client = desktopClient, ...scenario}) {
  const chat = tempChat(t), clientFile = join(chat, '..', 'client.json');
  writeFileSync(clientFile, JSON.stringify(client));
  const {authorize} = await import(pathToFileURL(join(chat, 'auth.mjs')).href);
  const code = Buffer.from(JSON.stringify({email: ACCOUNT.toLowerCase(), refresh_token: 'new-refresh', scope: ALL_SCOPES, ...scenario})).toString('base64url');
  let authUrl, page;
  const log = console.log; console.log = () => {};
  t.after(() => { console.log = log; });
  const result = await authorize({account: ACCOUNT, clientFile, openBrowser: url => {
    authUrl = new URL(url);
    const p = authUrl.searchParams;
    page = fetch(`${p.get('redirect_uri')}/?state=${p.get('state')}&code=${code}`).then(r => r.text());
  }}).catch(error => ({error}));
  return {result, authUrl, page: page && await page, chat};
}

test('authorize saves the token for the right account with PKCE', async t => {
  const before = requests.length;
  const {result, authUrl, page, chat} = await authorize(t, {});
  assert.deepEqual(result, {account: ACCOUNT});
  assert.match(page, /You can close this tab/);
  const p = authUrl.searchParams;
  assert.equal(authUrl.origin + authUrl.pathname, 'https://accounts.google.com/o/oauth2/auth');
  assert.match(p.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/);
  for (const [k, v] of [['access_type', 'offline'], ['prompt', 'consent'], ['login_hint', ACCOUNT], ['code_challenge_method', 'S256'], ['response_type', 'code']]) assert.equal(p.get(k), v);
  assert.match(p.get('scope'), /^openid email .*chat\.messages\.create$/);
  const exchange = new URLSearchParams(requests.slice(before).find(r => r.url === 'https://oauth2.googleapis.com/token').body);
  assert.equal(createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'), p.get('code_challenge'));
  assert.equal(exchange.get('redirect_uri'), p.get('redirect_uri'));
  assert.deepEqual(JSON.parse(readFileSync(join(chat, 'token.json'))), {account: ACCOUNT, refresh_token: 'new-refresh'});
  assert.deepEqual(JSON.parse(readFileSync(join(chat, 'oauth-client.json'))), desktopClient);
  if (process.platform !== 'win32') for (const f of ['token.json', 'oauth-client.json']) assert.equal(statSync(join(chat, f)).mode & 0o777, 0o600);

  const {revoke} = await import(pathToFileURL(join(chat, 'auth.mjs')).href);
  await revoke();
  assert.equal(new URLSearchParams(requests.at(-1).body).get('token'), 'new-refresh');
  assert.ok(!existsSync(join(chat, 'token.json')) && !existsSync(join(chat, 'oauth-client.json')));
});

test('authorize with a different account saves nothing', async t => {
  const {result, page, chat} = await authorize(t, {email: 'someone@gmail.com'});
  assert.match(result.error.message, /Signed in as someone@gmail\.com, but this setup is for/);
  assert.match(page, /failed/);
  assert.ok(!existsSync(join(chat, 'token.json')) && !existsSync(join(chat, 'oauth-client.json')));
});

test('authorize with an unverified email saves nothing', async t => {
  const {result, chat} = await authorize(t, {email_verified: false});
  assert.match(result.error.message, /Signed in as/);
  assert.ok(!existsSync(join(chat, 'token.json')));
});

test('authorize with a missing Chat scope fails', async t => {
  const {result, chat} = await authorize(t, {scope: ALL_SCOPES.replace(' https://www.googleapis.com/auth/chat.messages.create', '')});
  assert.match(result.error.message, /tick all boxes/);
  assert.ok(!existsSync(join(chat, 'token.json')));
});

test('authorize rejects a web-type client before opening the browser', async t => {
  const {result, authUrl} = await authorize(t, {client: {web: desktopClient.installed}});
  assert.match(result.error.message, /"Desktop app"/);
  assert.equal(authUrl, undefined);
});
