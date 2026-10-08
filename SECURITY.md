# Security

This page tells what the connectors can reach, where your data goes, what stays on your
computer, and which risks remain. Read it before you install. Ask your own AI agent to check
the code against it.

## Summary

- The connectors run on your computer. They talk only to Google, to your Chrome, and to the
  Claude app that starts them. There is no server in between, and the author gets none of your data.
- Gmail: Claude can search, read, write **unsent** drafts and archive one email. It cannot send,
  delete or label email.
- Google Chat: Claude can read and search your spaces and messages, and send a message as you.
- No known security defects. Two independent reviews by a different AI model found
  nine issues, and all of them are fixed. `npm audit` reports no known vulnerabilities.
- Some risks come with any tool of this kind. They are listed below.

## Risks you accept when you install

1. **Your mail and chat text goes to Anthropic.** When Claude reads an email or a message, the
   text goes to the Claude model. Use a Claude account that your company allows for this data.
2. **Text in emails and messages can try to give Claude instructions** ("prompt injection").
   Someone could write a message that asks Claude to do something else. Protections:
   - Gmail has no send tool.
   - Claude asks you before it uses a tool. Read what it wants to do before you click "Allow".
   - Do not choose "Always allow" for `send_message`, `create_email_draft`, `archive_email` or
     `read_email_and_mark_read`.
3. **Claude acts as you in Google Chat.** A message that Claude sends shows your name.
4. **The Google app is run by a person, not a company.** "Claude Connectors (Radek Chybicki)"
   is not verified by Google, so Google shows a warning.
   - The app owner cannot see your data or your sign-in. In Google Cloud, the owner sees only
     usage counts.
   - The owner can disable the app. Then the Google Chat part stops working.
5. **Updates run new code.** When you run `git pull`, you get the author's new code. Check what
   changed (`git log -p`) before you update, or ask your agent to review it.
6. **Dependencies.** There is one direct npm dependency, `@modelcontextprotocol/sdk` (Anthropic's
   official MCP library). It brings about 150 packages. All versions are fixed in
   `package-lock.json`, and `npm ci` installs exactly those.
7. **Gmail needs Chrome's Developer mode.** The extension can read and act in `mail.google.com`
   tabs and can talk to `127.0.0.1`. It cannot reach other websites.
8. **Local files.** Your Google Chat sign-in (`chat/token.json`) and the Gmail key
   (`gmail/extension/bridge-local.json`) are files that only your user account can read. A
   program that already runs as you can read them. That is true for every desktop app.
9. **Company rules.** Your company's IT has not reviewed this tool. Follow your company's rules.

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
| Gmail account (`gmail/extension/page.js`) | Each action first checks that the Gmail tab shows exactly your configured account. There is no fallback to another account. |
| Gmail actions | No send, delete, label or attachment tools. Unread mail is opened only by the separate `read_email_and_mark_read` tool. Archive acts on one exact thread and checks the result. |
| Google Chat sign-in (`chat/auth.mjs`) | PKCE, random `state`, loopback redirect. Setup refuses a sign-in with another account or with missing permissions. |
| Google Chat calls (`chat/server.mjs`) | Only `chat.googleapis.com`. Every argument is checked. The access token is never logged or returned. |
| Files | Keys and sign-ins are owner-only (`0600`) and ignored by git. Nothing logs mail or chat content. |
| Setup (`setup.mjs`) | Changes only the Claude settings entries `gmail-chrome` and `google-chat`, and keeps a backup (`.bak`). It changes nothing when the Claude settings file cannot be read. |

## Check it yourself

- Read `setup.mjs`, `chat/auth.mjs`, `chat/server.mjs`, `gmail/server.mjs` and
  `gmail/extension/*.js`. Together they are about 700 lines.
- `npm ci --ignore-scripts` installs the locked dependency versions and runs no install scripts. `npm audit` checks them for known vulnerabilities.
- `npm test` runs the automatic tests. They use no real mailbox or chat.

## Report a problem

Email Radosław Chybicki at rchybicki@gmail.com.
