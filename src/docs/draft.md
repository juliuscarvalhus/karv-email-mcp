# Draft Tool - Full Documentation

## Overview
Compose new emails, replies, and forwards, and save them to the **Drafts** folder
via IMAP APPEND. This tool **never sends**. The person reviews the draft in their
own mail client (webmail / Outlook) and sends it manually.

## Important
- **reply** automatically sets In-Reply-To and References headers for threading
- **forward** includes the original email body with a separator
- `account` specifies which configured email the draft is composed from
- HTML is auto-generated from the plain text body (basic markdown support)

## Actions

### new
Draft a new email.
```json
{"action": "new", "account": "user@dominio.com.br", "to": "recipient@example.com", "subject": "Hello", "body": "Hi there!"}
```
```json
{"action": "new", "account": "user@dominio.com.br", "to": "a@example.com", "subject": "Update", "body": "See details.", "cc": "b@example.com", "bcc": "c@example.com"}
```

### reply
Draft a reply. Reads the original email to set threading headers and auto-derive the recipient.
```json
{"action": "reply", "account": "user@dominio.com.br", "body": "Thanks!", "uid": 12345}
```
```json
{"action": "reply", "account": "user@dominio.com.br", "to": "sender@example.com", "subject": "Re: Custom subject", "body": "Got it.", "uid": 12345, "folder": "INBOX"}
```

### forward
Draft a forward. The original body is appended with a separator.
```json
{"action": "forward", "account": "user@dominio.com.br", "to": "colleague@example.com", "body": "FYI, see below.", "uid": 12345}
```

## Parameters
- `action` - Action to perform (required): new, reply, forward
- `account` - Account the draft is composed from (required)
- `to` - Recipient email address (required for new/forward, optional for reply - auto-derived from original sender)
- `subject` - Email subject (required for new, optional for reply/forward)
- `body` - Email body text (required)
- `cc` - CC recipients (comma-separated, optional)
- `bcc` - BCC recipients (comma-separated, optional)
- `uid` - Original email UID (required for reply/forward)
- `folder` - Folder of original email (default: INBOX, for reply/forward)

## Response Fields
- `saved_to_drafts` - Whether the message was stored in the Drafts folder via IMAP APPEND
- `drafts_folder` - The resolved Drafts folder path where the draft was saved

## Drafts Folder Detection
The Drafts folder is detected via the IMAP `\Drafts` special-use flag, falling
back to provider defaults (`Drafts`, or `[Gmail]/Drafts` for Gmail). The draft is
appended with the `\Draft` flag so mail clients show it as an editable draft.

## Notes
- Reply subject auto-prepends "Re:" if not already present
- Forward subject auto-prepends "Fwd:" if not already present
- Body supports basic markdown: `# heading`, `## heading`, `- list item`, `**bold**`
- There is no send capability in this fork — review and send happens in the user's mail client
