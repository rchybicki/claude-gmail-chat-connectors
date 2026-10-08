# Randstad Gmail and Google Chat for the Claude desktop app

With this tool, the Claude desktop app can work with your Randstad Gmail and your
Randstad Google Chat. You can ask Claude, for example:

- "Find the emails from the payroll team this week and summarise them."
- "Write a draft reply to Anna about the Thursday meeting." Claude saves a draft. You send it.
- "What did people say in the Project Phoenix chat space today?"
- "Search Google Chat for messages about the new rate card."

The two parts are separate. You can install only Gmail, only Google Chat, or both.

| | Gmail | Google Chat |
|---|---|---|
| How it connects | A Chrome extension uses the Gmail tab that you have open | Google's official Chat API, with your sign-in |
| Claude can | Search, read, write drafts, archive one email at a time | List spaces, read messages, search, send a message |
| Claude cannot | Send, delete, label, read attachments | Delete, edit or react to messages |
| Needs | Chrome open with your Randstad Gmail tab | Nothing open |

## Read this first

- **Your data goes to Claude.** When Claude reads an email or a chat message,
  the text goes to Anthropic, the company behind Claude. Randstad mail can contain
  personal data about candidates, clients and colleagues. Use this only with a
  Claude account that Randstad allows for this data.
- **Randstad IT did not approve this tool.** Gmail access works through your own
  browser. Google Chat access works through an app that Randstad's Google settings
  allow today. Randstad can block the Google Chat part at any time.
- **Claude acts as you.** A Google Chat message that Claude sends shows your name.
  Claude asks before it uses a tool. Read the message before you click "Allow".
  Do not choose "Always allow" for `send_message`.

## What you need

- A Mac or a Windows computer.
- The [Claude desktop app](https://claude.ai/download), signed in.
- Node.js 20 or later. Download the "LTS" installer from [nodejs.org](https://nodejs.org)
  and install it with the default settings.
- For Gmail: Google Chrome, and Gmail in English. In Gmail, go to
  Settings (gear) → See all settings → Language → **English (US)**.
  The extension finds Gmail buttons by their English names.
- For Google Chat: the file `randstad-chat-client.json`. Get it from the person who
  shared this tool with you. (To make your own, see [Your own Google Chat app](#your-own-google-chat-app).)

## Install

### 1. Get the files

Download this project as a ZIP file and unzip it to a folder that you keep, for
example `Documents/randstad-claude-connectors`. Do not delete or move this folder later:
Claude runs the tool from it.

### 2. Open a terminal in that folder

- **Mac:** open Finder, right-click the folder, and choose **New Terminal at Folder**.
- **Windows:** open the folder in File Explorer, right-click an empty area, and
  choose **Open in Terminal**.

### 3. Install the parts that the tool needs

Type this and press Enter:

```
npm install
```

### 4. Set up Gmail

Type this with **your own** Randstad email address:

```
node setup.mjs gmail jan.kowalski@randstad.com
```

Then do the steps that the setup shows:

1. In Chrome, go to `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select the `gmail/extension` folder in this project.
3. Open Gmail in Chrome as your Randstad account. Keep this tab open while you use Claude.

If Chrome does not let you turn on Developer mode, Randstad manages your Chrome
and blocks extensions that you add yourself. Then the Gmail part cannot work for you.
The Google Chat part still works.

### 5. Set up Google Chat

Put `randstad-chat-client.json` in your Downloads folder and type:

```
node setup.mjs chat jan.kowalski@randstad.com ~/Downloads/randstad-chat-client.json
```

On Windows, type:

```
node setup.mjs chat jan.kowalski@randstad.com "$env:USERPROFILE\Downloads\randstad-chat-client.json"
```

A browser window opens:

1. Choose your Randstad account.
2. Google says **"Google hasn't verified this app"**. It shows the app name and the
   email address of the person who made the app. Make sure that they are the ones the
   person who shared this tool told you about. Then click **Advanced** and
   **Go to … (unsafe)**. This warning shows because a person, not a company, made the app.
3. Click **Continue**. If Google shows boxes, tick **all** of them and click **Continue**.
4. When the page says that you can close it, go back to the terminal. It says
   "Google Chat setup done".

### 6. Restart Claude

Quit Claude completely (Mac: Claude menu → Quit; Windows: right-click the Claude icon
near the clock → Quit) and open it again.

To check, ask Claude: **"Which Randstad Gmail account are you connected to?"** or
**"List my Google Chat spaces."**

## Use it well

- Tell Claude what to look for: a sender, a subject, dates. Gmail search returns
  only the first page of results (at most 50 emails). Use a narrower search to find more.
- Claude reads **unread** emails only if you allow that, because reading marks them
  as read in Gmail.
- Claude writes email **drafts** only. Open Gmail → Drafts, check the draft, and send it yourself.
- Google Chat search skips muted spaces and messages from apps. To see everything
  in one space, ask Claude to read that space.
- Do not use the Gmail part from Claude desktop and Claude Code (or another app)
  at the same time. Only one app can run it.

## Problems

| What you see | What to do |
|---|---|
| "Chrome extension unavailable or operation timed out" | Open Chrome and your Randstad Gmail tab. Wait 30 seconds and try again. |
| "Randstad account identity missing or mismatched" | The Gmail tab shows another account, or Gmail is not in English. |
| "Port 3456 is in use" | Another app runs the Gmail part. Close it, or restart the computer. |
| Gmail worked before and now fails | Google changed Gmail's page. Ask for an update of this tool. |
| Google Chat says to run setup again | Your Google sign-in expired or was removed. Do step 5 again. |
| Claude does not show the tools | Quit Claude completely and open it again. Do step 4 or 5 again. |

After you update Node.js or move this folder, do step 4 and step 5 again.

## Remove

In the terminal in this folder, type:

```
node setup.mjs uninstall
```

This removes both parts from Claude, deletes the local keys and cancels the Google Chat
sign-in. Then remove **Randstad Gmail for Claude** at `chrome://extensions`,
restart Claude and delete this folder.

## How it works

**Gmail.** Claude starts a small local program (`gmail/server.mjs`). The program
gives Claude six tools. When Claude uses a tool, the Chrome extension
opens a hidden Gmail tab, does the action on the page, checks that the tab shows your
account, and sends back the result. The program and the extension talk only
on your computer (`127.0.0.1`). Each message is signed with a random key that setup
creates (`gmail/extension/bridge-local.json`). The key itself is never sent, so websites
and other programs cannot use or imitate this connection. The extension does not copy
your Google password or cookies.

**Google Chat.** Claude starts `chat/server.mjs`. It calls Google's official
Chat API with your sign-in. Setup checks that you signed in with the email address that
you typed. Your sign-in is stored only on your computer in `chat/token.json`.
Nobody else gets it.

**Tests.** `npm test` runs the automatic tests. They do not use your mailbox or chat.

### Your own Google Chat app

If you cannot get `randstad-chat-client.json`, make your own with a personal Google account:

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project.
2. Enable the **Google Chat API**. On its **Configuration** page, give an app name,
   an avatar URL and a description, and turn off **Interactive features**.
3. Go to **Google Auth Platform**. Set the audience to **External**. Add your Randstad
   address as a **test user**.
4. Under **Clients**, create a client of type **Desktop app** and download its JSON file.
5. Use that file in step 5.

## Credits

The Gmail page code comes from [cafferychen777/gmail-mcp](https://github.com/cafferychen777/gmail-mcp)
(MIT licence), changed to add a key-protected local connection, a strict account
check and a short list of actions with no send action. Do not use the original
project for Randstad mail. Its local connection has no key and accepts requests from any website.
