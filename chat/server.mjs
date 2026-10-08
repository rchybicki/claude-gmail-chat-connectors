import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const load = name => { try { return JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')); } catch { return null; } };
const token = load('token.json'), client = load('oauth-client.json')?.installed;
const SETUP = 'Google Chat is not set up on this computer. In the connector folder, run: node setup.mjs chat <email> <client-file>';
let cached = null;
async function accessToken() {
  if (cached && Date.now() < cached.expires) return cached.value;
  const res = await fetch(client.token_uri, {method: 'POST', signal: AbortSignal.timeout(30_000), body: new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: client.client_id, client_secret: client.client_secret})});
  const data = await res.json().catch(() => ({}));
  if (data.error === 'invalid_grant') throw new Error('Google Chat access expired or was revoked. In the connector folder, run the chat setup again: node setup.mjs chat <email> <client-file>');
  if (!res.ok || !data.access_token) throw new Error(`Google sign-in failed (${data.error || `HTTP ${res.status}`})`);
  cached = {value: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000};
  return cached.value;
}
async function api(method, path, query, body) {
  const url = new URL(`https://chat.googleapis.com/v1/${path}`);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, {method, signal: AbortSignal.timeout(30_000), body: body && JSON.stringify(body),
    headers: {Authorization: `Bearer ${await accessToken()}`, ...(body && {'Content-Type': 'application/json'})}});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Chat API error ${res.status}: ${data.error?.message || res.statusText}`);
  return data;
}
const e = encodeURIComponent;
const spaceId = {type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$', description: 'Space ID without the "spaces/" prefix'};
const pageSize = (maximum, def) => ({type: 'integer', minimum: 1, maximum, ...(def && {default: def})});
const pageToken = {type: 'string', maxLength: 4096, description: 'nextPageToken from the previous page'};
const filter = {type: 'string', maxLength: 2000, description: 'Google Chat API filter'};
const tools = [
  {name: 'list_spaces', description: 'List the Google Chat spaces, group chats and direct messages the user belongs to.',
    properties: {pageSize: pageSize(1000, 100), pageToken, filter}, run: a => api('GET', 'spaces', a)},
  {name: 'get_space', description: 'Get details of one Google Chat space.', properties: {spaceId}, required: ['spaceId'],
    run: a => api('GET', `spaces/${e(a.spaceId)}`, {})},
  {name: 'list_members', description: 'List the members of a Google Chat space.', properties: {spaceId, pageSize: pageSize(1000), pageToken}, required: ['spaceId'],
    run: ({spaceId, ...q}) => api('GET', `spaces/${e(spaceId)}/members`, q)},
  {name: 'list_messages', description: 'List messages in a Google Chat space, newest first by default. Use this for the complete history of a known space.',
    properties: {spaceId, pageSize: pageSize(1000, 25), pageToken, orderBy: {type: 'string', enum: ['createTime DESC', 'createTime ASC'], default: 'createTime DESC'}, filter}, required: ['spaceId'],
    run: ({spaceId, ...q}) => api('GET', `spaces/${e(spaceId)}/messages`, q)},
  {name: 'get_message', description: 'Get one Google Chat message by its full resource name.', required: ['name'],
    properties: {name: {type: 'string', pattern: '^spaces/[A-Za-z0-9_-]{1,128}/messages/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$', description: 'spaces/{space}/messages/{message}'}},
    run: a => api('GET', a.name.split('/').map(e).join('/'), {})},
  {name: 'search_messages', description: 'Search Google Chat messages across spaces. Results are in results[].message. Search excludes muted spaces, blocked senders and app messages; use list_messages for the complete history of a known space. To continue, call again with nextPageToken and the same query and pageSize.',
    properties: {query: {type: 'string', minLength: 1, maxLength: 1000, description: 'Search query'}, pageSize: pageSize(100, 25), pageToken}, required: ['query'],
    run: a => api('POST', 'spaces/-/messages:search', {}, {filter: a.query, pageSize: a.pageSize, pageToken: a.pageToken})},
  {name: 'send_message', write: true, description: 'Send a text message to a Google Chat space AS THE USER. Before calling, confirm the space and the exact text with the user. The result includes requestId; after a timeout or error, never retry with a new requestId (reuse the same one, or check the space first).',
    properties: {spaceId, text: {type: 'string', minLength: 1, maxLength: 32000}, threadName: {type: 'string', pattern: '^spaces/[A-Za-z0-9_-]{1,128}/threads/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$', description: 'Reply in this thread (spaces/{space}/threads/{thread}); must belong to spaceId'},
      requestId: {type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', description: 'UUID for safe retries; generated if omitted'}}, required: ['spaceId', 'text'],
    run: async ({spaceId, text, threadName, requestId = randomUUID()}) => {
      if (threadName && !threadName.startsWith(`spaces/${spaceId}/threads/`)) throw new Error('threadName must belong to spaceId');
      try {
        return {requestId, message: await api('POST', `spaces/${e(spaceId)}/messages`, {requestId, messageReplyOption: threadName && 'REPLY_MESSAGE_OR_FAIL'},
          {text, ...(threadName && {thread: {name: threadName}})})};
      } catch (error) { throw new Error(`${error.message} (requestId ${requestId}; reuse it for any retry)`); }
    }}
];
const schema = t => ({type: 'object', properties: t.properties, required: t.required, additionalProperties: false});
const server = new Server({name: 'randstad-google-chat', version: '1.0.0'}, {capabilities: {tools: {}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: tools.map(t => ({name: t.name, description: t.description, inputSchema: schema(t),
  annotations: t.write ? {readOnlyHint: false, destructiveHint: false, openWorldHint: true} : {readOnlyHint: true}}))}));
server.setRequestHandler(CallToolRequestSchema, async ({params}) => {
  try {
    const tool = tools.find(t => t.name === params.name);
    if (!tool) throw new Error('Unknown tool');
    if (!token?.refresh_token || !client) throw new Error(SETUP);
    const args = params.arguments || {};
    for (const k of Object.keys(args)) if (!Object.hasOwn(tool.properties, k)) throw new Error(`Unknown argument: ${k}`);
    for (const k of tool.required || []) if (args[k] === undefined) throw new Error(`Missing argument: ${k}`);
    for (const [k, v] of Object.entries(args)) {
      const s = tool.properties[k];
      if (s.type === 'integer' ? !(Number.isInteger(v) && v >= s.minimum && v <= s.maximum)
        : typeof v !== 'string' || v.length < (s.minLength ?? 1) || v.length > (s.maxLength ?? Infinity) || (s.pattern && !new RegExp(s.pattern).test(v)) || (s.enum && !s.enum.includes(v)))
        throw new Error(`Invalid ${k}`);
    }
    const defaults = Object.fromEntries(Object.entries(tool.properties).filter(([, s]) => s.default !== undefined).map(([k, s]) => [k, s.default]));
    return {content: [{type: 'text', text: JSON.stringify(await tool.run({...defaults, ...args}))}]};
  } catch (error) { return {isError: true, content: [{type: 'text', text: error.message}]}; }
});
await server.connect(new StdioServerTransport());
