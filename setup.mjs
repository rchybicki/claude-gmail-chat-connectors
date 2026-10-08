// Adds the connectors to the Claude desktop app and, when the claude command exists, to Claude Code. Usage:
//   node setup.mjs gmail <your email>
//   node setup.mjs chat <your email>
//   node setup.mjs uninstall
import { readFileSync, writeFileSync, existsSync, chmodSync, copyFileSync, rmSync, mkdirSync, accessSync, statSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const claudeConfig = process.platform === 'win32'
  ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  : join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const bridgeFile = join(here, 'gmail', 'extension', 'bridge-local.json');
const servers = {gmail: ['gmail-chrome', join(here, 'gmail', 'server.mjs')], chat: ['google-chat', join(here, 'chat', 'server.mjs')]};
// The node on PATH is a stable link; process.execPath can be a versioned folder that an update removes.
const runnable = file => { try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } };
const node = (process.env.PATH || '').split(delimiter).map(d => join(d, process.platform === 'win32' ? 'node.exe' : 'node'))
  .find(runnable) || process.execPath;
const fail = message => { console.error('\n' + message + '\n'); process.exit(1); };
const writePrivate = (file, data) => { writeFileSync(file, JSON.stringify(data, null, 2) + '\n', {mode: 0o600}); chmodSync(file, 0o600); };

// Read and check Claude's settings before anything else changes, so a bad file changes nothing.
function readClaude() {
  if (!existsSync(claudeConfig)) return {};
  let config;
  try { config = JSON.parse(readFileSync(claudeConfig, 'utf8')); } catch { /* Reported below. */ }
  const plain = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!plain(config) || (config.mcpServers !== undefined && !plain(config.mcpServers)))
    fail('Cannot read ' + claudeConfig + '. Fix or remove that file, then run setup again. Nothing was changed.');
  return config;
}
function writeClaude(config, change) {
  if (existsSync(claudeConfig)) copyFileSync(claudeConfig, claudeConfig + '.bak');
  else mkdirSync(dirname(claudeConfig), {recursive: true});
  config.mcpServers ??= {};
  change(config.mcpServers);
  writeFileSync(claudeConfig, JSON.stringify(config, null, 2) + '\n');
}
// Claude Code keeps its own list. Without the claude command, print what to run instead.
function claudeCode(key, add) {
  const [name, file] = servers[key];
  spawnSync('claude', ['mcp', 'remove', '--scope', 'user', name], {stdio: 'ignore'});
  if (!add) return;
  const args = ['mcp', 'add', '--scope', 'user', name, '--', node, file];
  if (spawnSync('claude', args, {stdio: 'ignore'}).status === 0) console.log(`Added ${name} to Claude Code.`);
  else console.log(`To use it in Claude Code too, run: claude ${args.map(a => JSON.stringify(a)).join(' ')}`);
}
function register(config, key) {
  writeClaude(config, s => { s[servers[key][0]] = {command: node, args: [servers[key][1]]}; });
  claudeCode(key, true);
}

const [command, emailArg] = process.argv.slice(2);
const email = (emailArg || '').trim().toLowerCase();
if (['gmail', 'chat'].includes(command) && !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email))
  fail('Give your work email address, for example: node setup.mjs ' + command + ' jan.kowalski@example.com');
if (!existsSync(join(here, 'node_modules', '@modelcontextprotocol', 'sdk'))) fail('Run "npm install" in this folder first.');
const claude = readClaude();

if (command === 'gmail') {
  let token;
  try { token = JSON.parse(readFileSync(bridgeFile, 'utf8')).token; } catch { /* First setup. */ }
  // Keep an existing token so an installed extension does not need a reload.
  if (!/^[a-f0-9]{64}$/.test(token || '')) token = randomBytes(32).toString('hex');
  writePrivate(bridgeFile, {account: email, token, port: 3456});
  register(claude, 'gmail');
  console.log(`
Gmail setup done for ${email}.
Next:
  1. In Chrome, open chrome://extensions and turn on "Developer mode" (top right).
  2. Click "Load unpacked" and select this folder:
       ${join(here, 'gmail', 'extension')}
     If the extension was already loaded, click its reload button instead.
  3. Open Gmail as ${email} in the same Chrome profile and keep that tab open.
  4. Quit the Claude desktop app completely and start it again, or start a new Claude Code session.`);
} else if (command === 'chat') {
  const { authorize } = await import('./chat/auth.mjs');
  const openBrowser = url => {
    const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['open', [url]];
    spawn(cmd, args, {stdio: 'ignore', detached: true}).on('error', () => {}).unref();
  };
  console.log('A browser window opens. Sign in as ' + email + ' and allow all requested Google Chat access.');
  try { await authorize({account: email, openBrowser}); } catch (error) { fail('Chat setup failed: ' + error.message); }
  register(claude, 'chat');
  console.log(`\nGoogle Chat setup done for ${email}.\nNext: quit the Claude desktop app completely and start it again, or start a new Claude Code session.`);
} else if (command === 'uninstall') {
  writeClaude(claude, s => { for (const [name] of Object.values(servers)) delete s[name]; });
  for (const key of Object.keys(servers)) claudeCode(key, false);
  rmSync(bridgeFile, {force: true});
  const { revoke } = await import('./chat/auth.mjs');
  const revoked = await revoke();
  console.log(revoked ? '\nRemoved both connectors from Claude, deleted the local keys and cancelled the Google Chat sign-in.'
    : '\nRemoved both connectors from Claude and deleted the Gmail key.\n' +
      'Could not reach Google to cancel the Google Chat sign-in. Run "node setup.mjs uninstall" again later,\n' +
      'or remove the app at https://myaccount.google.com/connections');
  console.log(`Finish by hand:
  1. In Chrome, open chrome://extensions and remove "Gmail for Claude".
  2. Quit and restart Claude.
  3. ${revoked ? 'Delete this folder: ' + here : 'Keep this folder until the Google Chat sign-in is cancelled.'}`);
} else fail('Usage:\n  node setup.mjs gmail <email>\n  node setup.mjs chat <email>\n  node setup.mjs uninstall');
