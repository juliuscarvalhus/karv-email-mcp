/**
 * Messages Mega Tool (KARV fork)
 * Read-and-triage email operations. By design this tool CANNOT delete, archive
 * or move messages to arbitrary folders. The only move allowed is `report_spam`,
 * which sends a message to the Spam/Junk folder.
 */

import type { AccountConfig } from '../helpers/config.js'
import { resolveAccounts, resolveSingleAccount } from '../helpers/config.js'
import { createUnknownActionError, EmailMCPError, withErrorHandling } from '../helpers/errors.js'
import {
  modifyFlags,
  moveEmails,
  readEmail,
  reconcileSent,
  resolveSpamFolder,
  searchEmails
} from '../helpers/imap-client.js'

export interface MessagesInput {
  action: 'search' | 'read' | 'mark_read' | 'mark_unread' | 'flag' | 'unflag' | 'report_spam' | 'reconcile'

  // Target account (optional - defaults to all for search, first for others)
  account?: string

  // Search params
  query?: string
  folder?: string
  limit?: number

  // When true on a `search`, reconcile sent mail first (mark originals in
  // `folder` as answered/forwarded) so the listing reflects what already went out.
  reconcile?: boolean

  // Read/modify params
  uid?: number
  uids?: number[]
}

/**
 * Unified messages tool - handles read and triage operations
 */
export async function messages(accounts: AccountConfig[], input: MessagesInput): Promise<any> {
  return withErrorHandling(async () => {
    switch (input.action) {
      case 'search':
        return await handleSearch(accounts, input)

      case 'read':
        return await handleRead(accounts, input)

      case 'mark_read':
        return await handleMarkRead(accounts, input)

      case 'mark_unread':
        return await handleMarkUnread(accounts, input)

      case 'flag':
        return await handleFlag(accounts, input)

      case 'unflag':
        return await handleUnflag(accounts, input)

      case 'report_spam':
        return await handleReportSpam(accounts, input)

      case 'reconcile':
        return await handleReconcile(accounts, input)

      default:
        throw createUnknownActionError(
          input.action,
          'search, read, mark_read, mark_unread, flag, unflag, report_spam, reconcile'
        )
    }
  })()
}

/**
 * Search emails across accounts
 */
async function handleSearch(accounts: AccountConfig[], input: MessagesInput): Promise<any> {
  const targetAccounts = resolveAccounts(accounts, input.account)
  const query = input.query || 'UNSEEN'
  const folder = input.folder || 'INBOX'
  const limit = input.limit || 20

  // Optionally reconcile sent mail first so the listing already reflects what was
  // answered/forwarded (matched originals come back with \Answered/$Forwarded set).
  // Token-light by design: emit at most a single `reconciled: <count>` and ONLY
  // when something was newly marked. Best-effort — a reconcile failure must never
  // block the search (it's logged to stderr, never surfaced to the model).
  let reconciledCount = 0
  if (input.reconcile) {
    for (const a of targetAccounts) {
      try {
        const r = await reconcileSent(a, { targetFolder: folder })
        reconciledCount += r.marked.length
      } catch (error: unknown) {
        console.error(`[reconcile] ${a.email}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const results = await searchEmails(targetAccounts, query, folder, limit)

  return {
    action: 'search',
    query,
    folder,
    ...(reconciledCount > 0 ? { reconciled: reconciledCount } : {}),
    total: results.length,
    accounts_searched: targetAccounts.map((a) => a.email),
    messages: results
  }
}

/**
 * Reconcile sent mail: mark originals in `folder` (default INBOX) as
 * answered/forwarded based on what actually went out (the Sent folder).
 * Read + flag only — never moves or deletes.
 */
async function handleReconcile(accounts: AccountConfig[], input: MessagesInput): Promise<any> {
  const targetAccounts = resolveAccounts(accounts, input.account)
  const folder = input.folder || 'INBOX'

  let answered = 0
  let forwarded = 0
  let scanned = 0
  for (const a of targetAccounts) {
    const r = await reconcileSent(a, { targetFolder: folder })
    answered += r.marked.filter((m) => m.flag === '\\Answered').length
    forwarded += r.marked.filter((m) => m.flag === '$Forwarded').length
    scanned += r.scanned
  }

  // Lean by design: counts only (no per-message list).
  return { action: 'reconcile', folder, marked: answered + forwarded, answered, forwarded, scanned }
}

/**
 * Read a single email by UID
 */
async function handleRead(accounts: AccountConfig[], input: MessagesInput): Promise<any> {
  if (!input.uid) {
    throw new EmailMCPError('uid is required for read action', 'VALIDATION_ERROR', 'Provide the email UID from search')
  }

  const account = resolveSingleAccount(accounts, input.account)
  const folder = input.folder || 'INBOX'

  const email = await readEmail(account, input.uid, folder)

  return {
    action: 'read',
    ...email
  }
}

/**
 * Shared helper for flag modification actions (mark_read, mark_unread, flag, unflag)
 */
async function handleFlagModification(
  accounts: AccountConfig[],
  input: MessagesInput,
  action: string,
  flags: string[],
  mode: 'add' | 'remove'
): Promise<any> {
  const uids = input.uids || (input.uid ? [input.uid] : [])
  if (uids.length === 0) {
    throw new EmailMCPError('uid or uids required', 'VALIDATION_ERROR', 'Provide at least one email UID')
  }

  const account = resolveSingleAccount(accounts, input.account)
  const folder = input.folder || 'INBOX'

  const result = await modifyFlags(account, uids, folder, flags, mode)

  return {
    action,
    account: account.email,
    folder,
    ...result
  }
}

/**
 * Mark emails as read
 */
async function handleMarkRead(accounts: AccountConfig[], input: MessagesInput): Promise<any> {
  return handleFlagModification(accounts, input, 'mark_read', ['\\Seen'], 'add')
}

/**
 * Mark emails as unread
 */
async function handleMarkUnread(accounts: AccountConfig[], input: MessagesInput): Promise<any> {
  return handleFlagModification(accounts, input, 'mark_unread', ['\\Seen'], 'remove')
}

/**
 * Flag (star) emails
 */
async function handleFlag(accounts: AccountConfig[], input: MessagesInput): Promise<any> {
  return handleFlagModification(accounts, input, 'flag', ['\\Flagged'], 'add')
}

/**
 * Unflag (unstar) emails
 */
async function handleUnflag(accounts: AccountConfig[], input: MessagesInput): Promise<any> {
  return handleFlagModification(accounts, input, 'unflag', ['\\Flagged'], 'remove')
}

/**
 * Report emails as spam (move to the Spam/Junk folder).
 * This is the ONLY move operation this fork exposes — there is no generic move,
 * archive, trash or delete, by design (safety).
 */
async function handleReportSpam(accounts: AccountConfig[], input: MessagesInput): Promise<any> {
  const uids = input.uids || (input.uid ? [input.uid] : [])
  if (uids.length === 0) {
    throw new EmailMCPError('uid or uids required', 'VALIDATION_ERROR', 'Provide at least one email UID')
  }

  const account = resolveSingleAccount(accounts, input.account)
  const folder = input.folder || 'INBOX'

  const spamFolder = await resolveSpamFolder(account)

  // Mark the message as junk BEFORE moving it. IMAP MOVE preserves keywords, so
  // setting the flag in the source folder carries it to the spam folder. We set
  // `$Junk` (RFC 5788 standard) and `Junk` (what Thunderbird reads) and clear the
  // opposite markers. Best-effort: a server that rejects custom keywords must not
  // block the move, so failures here are swallowed.
  let markedJunk = false
  try {
    await modifyFlags(account, uids, folder, ['$NotJunk', 'NonJunk'], 'remove')
    const flagResult = await modifyFlags(account, uids, folder, ['$Junk', 'Junk'], 'add')
    markedJunk = flagResult.success
  } catch {
    markedJunk = false
  }

  const result = await moveEmails(account, uids, folder, spamFolder)

  return {
    action: 'report_spam',
    account: account.email,
    from_folder: folder,
    spam_folder: spamFolder,
    marked_junk: markedJunk,
    ...result
  }
}
