# Messages Tool - Full Documentation

## Overview
Email messages: search, read, mark_read, mark_unread, flag, unflag, report_spam.

> This fork has **no** delete, archive, or generic move — by design (safety). The
> only move available is `report_spam`, which sends a message to the Spam/Junk folder.

## Important
- **search** defaults to all configured accounts. Filter with `account` param.
- **read** returns clean plain text body (HTML stripped for LLM token savings)
- **UIDs are per-account and per-folder** - always specify account for modify operations
- Query language supports compound filters: `UNREAD SINCE 2024-01-01`

## Actions

### search
Search emails across all or filtered accounts.
```json
{"action": "search", "query": "UNREAD", "folder": "INBOX", "limit": 20}
```
```json
{"action": "search", "query": "UNREAD SINCE 2024-06-01", "account": "user@gmail.com"}
```
```json
{"action": "search", "query": "FROM boss@company.com", "limit": 5}
```

Query shortcuts:
- `UNREAD` / `UNSEEN` - unread emails
- `READ` / `SEEN` - read emails
- `FLAGGED` / `STARRED` - flagged emails
- `ALL` / `*` - all emails
- `SINCE YYYY-MM-DD` - emails after date
- `FROM email` - emails from sender
- `SUBJECT text` - emails matching subject
- `UNREAD SINCE YYYY-MM-DD` - compound filter
- `UNREAD FROM email` - compound filter
- Any other text is treated as subject search

### read
Read a single email by UID. Returns full body as clean text.
```json
{"action": "read", "account": "user@gmail.com", "uid": 12345, "folder": "INBOX"}
```

### mark_read
```json
{"action": "mark_read", "account": "user@gmail.com", "uids": [123, 456, 789]}
```

### mark_unread
```json
{"action": "mark_unread", "account": "user@gmail.com", "uid": 123}
```

### flag
Star/flag emails.
```json
{"action": "flag", "account": "user@gmail.com", "uids": [123, 456]}
```

### unflag
Remove star/flag from emails.
```json
{"action": "unflag", "account": "user@gmail.com", "uid": 123}
```

### report_spam
Move emails to the Spam/Junk folder. This is the only move operation available.
```json
{"action": "report_spam", "account": "user@dominio.com.br", "uids": [123, 456]}
```
The Spam folder is detected via the IMAP `\Junk` flag, falling back to provider
defaults (`Junk`, `Junk Email` for Outlook, `[Gmail]/Spam` for Gmail).

## Parameters
- `action` - Action to perform (required)
- `account` - Account email filter (optional for search, required for modify)
- `query` - Search query string (default: UNSEEN)
- `folder` - Mailbox folder (default: INBOX)
- `limit` - Max search results (default: 20)
- `uid` - Single email UID
- `uids` - Multiple email UIDs for batch operations
