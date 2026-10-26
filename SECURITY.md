# Security

This page tells what the connectors can reach, where your data goes, what stays on your
computer, and which risks remain. Read it before you install. Ask your own AI agent to check
the code against it.

## Summary

- The connectors run on your computer. They talk only to Google, to your Chrome, and to the
  Claude app that starts them. There is no server in between, and the author gets none of your data.
- Gmail: Claude can search, read, write **unsent** drafts and archive one email. It cannot
  delete or label email. The same extension lets Claude read your Google Calendar. It cannot
  change, delete or answer events.
- Two options are off unless you turn them on in setup: `--allow-send` lets Claude send an email
  as you, and `--allow-calendar-write` lets Claude create events, which invites the guests.
- Google Chat: Claude can read and search your spaces and messages, send a message as you, and
  start a direct message or group chat as you. The Google permissions are exactly: `openid`,
  `email` (to confirm your account), `chat.spaces.readonly`, `chat.memberships.readonly`,
  `chat.messages.readonly`, `chat.messages.create` and `chat.spaces.create`. Google lets
  `chat.spaces.create` also create named spaces; the connector only starts direct messages and
  group chats. Claude can start a chat with any email address, also outside your company, unless
  your company's Google settings block external chats.
- No known security defects. `npm audit` reports no known vulnerabilities.
- Some risks come with any tool of this kind. They are listed below, each with what you can do
  about it.

## Risks you accept when you install

1. **Company approval.** This is a community tool for the time until your company approves an
   official connection. Your company's IT has not reviewed it. The Gmail part does not use the
   Google app access that your company controls: it works through your own signed-in browser.
   Your Google Workspace admins can see that you gave "Claude Connectors (Radek Chybicki)"
   access to Google Chat. Work mail often contains personal data about candidates, clients and
   colleagues, so use it in line with your company's data rules.
2. **Your mail and chat text goes to Anthropic.** When Claude reads an email or a message, the
   text goes to the Claude model. Use a Claude account that your company allows for this data.
3. **Text in emails, messages or web pages can try to give Claude instructions** ("prompt
   injection"). For example, an email could ask Claude to post your recent mail into a Chat space.
   Without `--allow-send`, Gmail cannot send. Data could leak through `send_message` in Google Chat (also to an outside address after
   `start_chat` opens a chat with it),
   through `send_email` and through the guest list or description of `create_event` if you turned
   them on, and in Claude Code
   also through shell commands, web requests or your other connectors. Setup adds both
   connectors to every Claude Code session on your computer, also to sessions where Claude reads
   untrusted code or web pages. Protections:
   - Gmail has no send tool, and Calendar no create tool, unless you turn them on.
   - Claude asks you before it uses a tool. Read what it wants to do before you click "Allow".
   - Do not choose "Always allow" for `send_message`, `start_chat`, `send_email`, `create_event`,
     `create_email_draft`, `archive_email` or `read_email_and_mark_read`, and do not let Claude Code approve tools or commands
     automatically ("bypass permissions" or auto-approve) while the connectors are on.
   - If you want the smallest risk, install only Gmail, without the two options.
4. **Claude acts as you.** A Google Chat message or new chat, and with the options an email or a calendar
   invitation, that Claude sends shows your name.
5. **The Google app is run by a person, not a company.** "Claude Connectors (Radek Chybicki)"
   is not verified by Google, so Google shows a warning.
   - The code gives the app owner no access to your data or your sign-in. Your sign-in stays in
     `chat/token.json` on your computer, and all calls go from your computer to Google.
   - The owner can disable the app. Then the Google Chat part stops working.
6. **Updates run new code.** When you run `git pull`, you get the author's new code, also for the
   Chrome extension. Chrome loads the changed extension the next time it starts. Check what
   changed (`git log -p`) before you update, or ask your agent to review it.
7. **Dependencies.** There is one direct npm dependency, `@modelcontextprotocol/sdk` (Anthropic's
   official MCP library). With its own dependencies, it is 94 packages. All versions and
   checksums are fixed in `package-lock.json`, and `npm ci --ignore-scripts` installs exactly
   those without running their install scripts.
8. **Gmail needs Chrome's Developer mode.** The extension can read and act in `mail.google.com`
   and `calendar.google.com` tabs and can talk to `127.0.0.1:3456`. The content security policy
   of its own pages (`connect-src` in `manifest.json`) blocks connections from them to any other
   server. Code that the extension runs inside a Calendar tab follows that tab's rules: it calls
   only `clients6.google.com/calendar/v3`, the address that the Calendar web app also uses.
9. **Local files.** Your Google Chat sign-in (`chat/token.json`) and the Gmail key
   (`gmail/extension/bridge-local.json`) are files that only your user account can read (on
   Windows, through the normal permissions of your user folder). A program that already runs as
   you can read them. That is true for every desktop app. Keep your computer locked and its
   disk encrypted.
   `uninstall` deletes them and cancels the Google Chat sign-in.

## Why `chat/google-client.json` contains a "client secret"

A scanner flags this file as a secret. It is not one in this case:

- The file identifies a Google **"Desktop app"** OAuth client. Google requires the secret in the
  sign-in, but for desktop apps Google says that it "is obviously not treated as a secret"
  ([Google: OAuth 2.0 for installed apps](https://developers.google.com/identity/protocols/oauth2)).
  Other desktop tools ship theirs the same way, for example the `gcloud` CLI and `rclone`.
- With this file alone, nobody can read your data. A sign-in needs your consent in your own browser.
  Google then sends the result only to a program that listens on your own computer
  (`127.0.0.1`). The sign-in also uses PKCE and a random `state`.
- The alternative is that each user creates their own Google Cloud project and Chat app.
  That takes about 15 minutes per person and is not safer for you.

## Protections in the code

| Where | Protection |
|---|---|
| Gmail connection (`gmail/server.mjs`, `gmail/extension/background.js`) | Listens only on `127.0.0.1`. Each message is signed (HMAC-SHA256) with a random key that setup creates. The key itself is never sent. The extension runs only requests signed for its own poll. Web pages are refused by `Origin` and `Host` checks. |
| Gmail account (`gmail/extension/page.js`) | Each action first checks that Gmail shows exactly your configured account: in an open Gmail tab, or else in a tab that the extension opens. There is no fallback to another account. |
| Google Calendar (`gmail/extension/calendar.js`) | Calendar API calls (`calendar/v3` at `clients6.google.com`) from a Calendar tab, with that tab's session, as the Calendar web app makes them. Each call first checks that the primary calendar is your configured account. Reads only, except `create_event` when turned on; each create request has a fixed event ID, so a request that is delivered twice cannot create a second copy, and every error names that ID so that Claude can check before it tries again. |
| Gmail actions | No delete, label or attachment tools. Unread mail is opened only by the separate `read_email_and_mark_read` tool. Archive acts on one exact thread and checks the result. `send_email` exists only when turned on: it checks the account, recipient, subject and text before it clicks Send once, refuses when any draft or sent email to that recipient already uses the subject, and confirms the email in Sent. Formatting (bold, italic, http/https/mailto links, lists) is built with DOM methods from a small Markdown subset; no HTML from Claude is inserted, so the text cannot add images, styles or scripts. |
| Options (`gmail/extension/bridge-local.json`) | `allowSend` and `allowCalendarWrite` are off by default. Both the local program and the extension check them, so a tool that is off is not offered and is refused. |
| Google Chat sign-in (`chat/auth.mjs`) | PKCE, random `state`, loopback redirect. The Google addresses are fixed in the code, not read from `google-client.json`. Setup refuses a sign-in with another account or with missing permissions. |
| Google Chat calls (`chat/server.mjs`) | Only `oauth2.googleapis.com` (sign-in refresh) and `chat.googleapis.com`. Every argument is checked. The access token is never logged or returned. |
| Files | Keys and sign-ins are owner-only (`0600`) and ignored by git. Nothing logs mail or chat content. |
| Setup (`setup.mjs`) | In the Claude desktop app settings, changes only the entries `gmail-chrome` and `google-chat`, and keeps a copy of the file from before the first setup (`.bak`). It changes nothing when that file cannot be read. In Claude Code, it adds the same two entries at user scope with `claude mcp add`. |

## Check it yourself

- Read `setup.mjs`, `chat/auth.mjs`, `chat/server.mjs`, `gmail/server.mjs` and
  `gmail/extension/*.js`. Together they are about 850 lines. All network addresses are written in the code.
- `npm ci --ignore-scripts` installs the locked dependency versions and runs no install scripts. `npm audit` checks them for known vulnerabilities.
- `npm test` runs the automatic tests. They use no real mailbox or chat.

## Report a problem

Email Radosław Chybicki at rchybicki@gmail.com.
