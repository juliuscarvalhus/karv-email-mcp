/**
 * Messages Mega Tool (KARV fork)
 * Read-and-triage email operations. By design this tool CANNOT delete, archive
 * or move messages to arbitrary folders. The only move allowed is `report_spam`,
 * which sends a message to the Spam/Junk folder.
 */

import type { AccountConfig } from '../helpers/config.js'
import { resolveAccounts, resolveSingleAccount } from '../helpers/config.js'
import { createUnknownActionError, EmailMCPError, withErrorHandling } from '../helpers/errors.js'
import { modifyFlags, moveEmails, readEmail, resolveSpamFolder, searchEmails } from '../helpers/imap-client.js'

export interface MessagesInput {
  action: 'search' | 'read' | 'mark_read' | 'mark_unread' | 'flag' | 'unflag' | 'report_spam'

  // Target account (optional - defaults to all for search, first for others)
  account?: string

  // Search params
  query?: string
  folder?: string
  limit?: number

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

      default:
        throw createUnknownActionError(
          input.action,
          'search, read, mark_read, mark_unread, flag, unflag, report_spam'
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

  const results = await searchEmails(targetAccounts, query, folder, limit)

  return {
    action: 'search',
    query,
    folder,
    total: results.length,
    accounts_searched: targetAccounts.map((a) => a.email),
    messages: results
  }
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

  const result = await moveEmails(account, uids, folder, spamFolder)

  return {
    action: 'report_spam',
    account: account.email,
    from_folder: folder,
    spam_folder: spamFolder,
    ...result
  }
}
