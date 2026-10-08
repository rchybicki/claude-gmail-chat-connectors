# Gmail and Google Chat for Claude

With this tool, Claude Code and the Claude desktop app can work with your work Gmail
and your Google Chat. It was written for colleagues whose company Google Workspace
does not let apps connect to Gmail directly: the Gmail part works through your own browser
instead. Read [SECURITY.md](SECURITY.md) before you install.

You can ask Claude, for example:

- "Find the emails from the payroll team this week and summarise them."
- "Write a draft reply to Anna about the Thursday meeting." Claude saves a draft. You send it.
- "What did people say in the Project Phoenix chat space today?"
- "Search Google Chat for messages about the new rate card."

The two parts are separate. You can install only Gmail, only Google Chat, or both.

| | Gmail (`gmail-chrome`) | Google Chat (`google-chat`) |
|---|---|---|
| How it connects | A Chrome extension uses the Gmail tab that you have open | Google's official Chat API, with your sign-in |
| Claude can | Search, read, write drafts, archive one email at a time | List spaces, read messages, search, send a message |
| Claude cannot | Send, delete, label, read attachments | Delete, edit or react to messages |
| Needs | Chrome open with your Gmail tab, Gmail in English | Nothing open |

## Install with Claude Code (recommended)

Open **Claude Code**: the **Code** tab in the Claude desktop app, or `claude` in a terminal.
Do not use Cowork or a normal chat. They cannot run the installer.

Paste this:

```text
Install the Gmail and Google Chat connectors from https://github.com/rchybicki/claude-gmail-chat-connectors for me.
1. Ask me for my work email address, and which parts I want: Gmail, Google Chat, or both.
2. Check that Node.js 20 or later and git are installed. If one is missing, tell me how to install it and wait.
3. Clone the repo to ~/claude-gmail-chat-connectors (or git pull if it is already there).
4. Before you set anything up, do a full security review of that code. Read SECURITY.md, then check
   setup.mjs, chat/ and gmail/ yourself: what the code can access, where my data goes, what it stores,
   and whether anything differs from SECURITY.md. Run npm ci --ignore-scripts, then npm audit.
   Explain the risks to me in plain words, give me your recommendation, and wait until I say continue.
5. For Google Chat, run: node setup.mjs chat <my email>. It opens a browser and waits up to 5 minutes for me
   to sign in, so run it with a timeout of at least 6 minutes. Before you run it, tell me: choose my work account,
   click "Advanced" and "Go to Claude Connectors (Radek Chybicki) (unsafe)", tick "Select all", click "Continue".
6. For Gmail, run: node setup.mjs gmail <my email>. Then walk me through the Chrome steps it prints
   (Developer mode, "Load unpacked"), and tell me to keep a Gmail tab open and to set Gmail's language to English.
7. Tell me in a few lines what Claude can and cannot do with these connectors (see README.md).
8. Tell me to restart the Claude desktop app and start a new Claude Code session, and to ask:
   "Which Gmail account are you connected to?" or "List my Google Chat spaces."
Never print or copy the files gmail/extension/bridge-local.json or chat/token.json.
```

## Read this first

[SECURITY.md](SECURITY.md) tells what the connectors can reach, where your data goes and which
risks remain. In short:

- **Your data goes to Claude.** When Claude reads an email or a chat message, the text goes
  to Anthropic, the company behind Claude. Work mail can contain personal data about
  candidates, clients and colleagues. Use this only with a Claude account that your company
  allows for this data.
- **Your company's IT has not reviewed or approved this tool.** If your company blocks apps from
  Gmail, the Gmail part works around that block. Check your company's rules before you use it
  with company data. Your company can block the Google Chat part at any time.
- **Claude acts as you.** A Google Chat message that Claude sends shows your name. Claude asks
  before it uses a tool. Read the message before you click "Allow". Do not choose
  "Always allow" for `send_message`.
- **Google shows a warning.** The Google Chat app "Claude Connectors (Radek Chybicki)" is not
  verified by Google, because a person made it, not a company. Google shows the app name and
  the developer address `rchybicki@gmail.com`. Continue only if you trust that person.

## Install by hand

You need Node.js 20 or later ([nodejs.org](https://nodejs.org), "LTS"), git, and for Gmail, Google Chrome.

```
git clone https://github.com/rchybicki/claude-gmail-chat-connectors.git
cd claude-gmail-chat-connectors
npm ci --ignore-scripts
node setup.mjs chat jan.kowalski@example.com
node setup.mjs gmail jan.kowalski@example.com
```

Use your own work email address.

- **Google Chat:** a browser opens. Choose your work account. Click **Advanced** and
  **Go to Claude Connectors (Radek Chybicki) (unsafe)**. Tick **Select all** and click **Continue**.
  When the page says that you can close it, go back to the terminal.
- **Gmail:** in Chrome, go to `chrome://extensions` and turn on **Developer mode** (top right).
  Click **Load unpacked** and select the `gmail/extension` folder. Open Gmail as your work
  account and keep the tab open. In Gmail, go to Settings → See all settings → Language →
  **English (US)**. The extension finds Gmail buttons by their English names.
  If Chrome does not let you turn on Developer mode, your company manages Chrome and blocks
  extensions that you add yourself. Then the Gmail part cannot work for you.

Setup adds the connectors to the Claude desktop app and, if the `claude` command is installed,
to Claude Code. Restart the Claude desktop app and start a new Claude Code session.

Do not move or delete the folder after setup: Claude runs the connectors from it.

## Use it well

- Tell Claude what to look for: a sender, a subject, dates. Gmail search returns only the first
  page of results (at most 50 emails). Use a narrower search to find more.
- Claude reads **unread** emails only if you allow that, because reading marks them as read.
- Claude writes email **drafts** only. Open Gmail → Drafts, check the draft, and send it yourself.
- Google Chat search skips muted spaces and messages from apps. To see everything in one
  space, ask Claude to read that space.
- Only one Claude app can use Gmail at a time. If the desktop app has it, Claude Code says
  that the port is in use, and the other way around.

## Problems

| What you see | What to do |
|---|---|
| "Chrome extension unavailable or operation timed out" | Open Chrome and your Gmail tab. Wait 30 seconds and try again. |
| "Gmail account identity missing or mismatched" | The Gmail tab shows another account, or Gmail is not in English. |
| "Port 3456 is in use" | Another Claude app or session uses Gmail. Close it there and try again. |
| Gmail worked before and now fails | Google changed Gmail's page. Run `git pull` in the folder to get an update. |
| Google Chat says to run setup again | Your Google sign-in expired or was removed. Run `node setup.mjs chat <email>` again. |
| Claude does not show the tools | Restart the Claude desktop app, or start a new Claude Code session. |

After you update Node.js or move the folder, run the setup commands again.

## Update

In the folder, run `git pull` and `npm ci --ignore-scripts`. Check what changed first (`git log -p`), because an update runs new code. For Gmail, also click the reload button of
"Gmail for Claude" at `chrome://extensions`.

## Remove

In the folder, run `node setup.mjs uninstall`. This removes both connectors from Claude, deletes
the local keys and cancels the Google Chat sign-in. Then remove **Gmail for Claude** at
`chrome://extensions`, restart Claude and delete the folder.

## How it works

**Gmail.** Claude starts a small local program (`gmail/server.mjs`). When Claude uses a tool, the
Chrome extension opens a background Gmail tab (you see it briefly in the tab bar), does the action on the page, checks that the tab
shows your account, and sends back the result. The program and the extension talk only on
your computer (`127.0.0.1`). Each message is signed with a random key that setup creates
(`gmail/extension/bridge-local.json`). The key itself is never sent, so websites and other
programs cannot use or imitate this connection. The extension does not copy your Google
password or cookies.

**Google Chat.** Claude starts `chat/server.mjs`. It calls Google's official Chat API with your
sign-in. Setup checks that you signed in with the email address that you typed. Your sign-in
is stored only on your computer, in `chat/token.json`. Nobody else gets it.
`chat/google-client.json` identifies the Google app. Google treats the secret of a desktop app
as not confidential: it ships with the app, and only your own consent gives access to your data.
App pages: [home](https://radekisaprettycoolguy.com/claude-connectors/index.html),
[privacy policy](https://radekisaprettycoolguy.com/claude-connectors/privacy.html),
[terms](https://radekisaprettycoolguy.com/claude-connectors/terms.html).

**Tests.** `npm test` runs the automatic tests. They do not use your mailbox or chat.

## Credits

The Gmail page code comes from [cafferychen777/gmail-mcp](https://github.com/cafferychen777/gmail-mcp)
(MIT licence). It was changed to add a signed local connection, a strict account check and a
short list of actions with no send action. Do not use the original project for work mail:
its local connection has no key and accepts requests from any website.
