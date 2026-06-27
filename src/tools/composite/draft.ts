/**
 * Draft Mega Tool (KARV fork)
 * Composes new emails, replies, and forwards — and saves them to the Drafts
 * folder via IMAP APPEND. It NEVER sends. The human reviews the draft in their
 * mail client (webmail/Outlook) and sends it manually.
 */

import type { AccountConfig } from '../helpers/config.js'
import { resolveSingleAccount } from '../helpers/config.js'
import { createUnknownActionError, EmailMCPError, withErrorHandling } from '../helpers/errors.js'
import { appendToFolder, readEmail, resolveDraftsFolder } from '../helpers/imap-client.js'
import { buildRawMessage, textToHtml } from '../helpers/smtp-client.js'

export interface DraftInput {
  action: 'new' | 'reply' | 'forward'

  // Required for all
  account: string
  body: string

  // Required for new/forward; optional for reply (auto-derived from original sender)
  to?: string

  // Required for new; optional for reply/forward (auto-derived from original subject)
  subject?: string

  // Optional
  cc?: string
  bcc?: string

  // Reply/Forward - reference to original email
  uid?: number
  folder?: string
}

/**
 * Build the email, append it to the Drafts folder, and report where it landed.
 * Shared by all three actions.
 */
async function saveDraft(
  account: AccountConfig,
  mailOptions: {
    from: string
    to: string
    cc?: string
    bcc?: string
    subject: string
    text: string
    html: string
    inReplyTo?: string
    references?: string
  }
): Promise<{ saved: boolean; drafts_folder: string }> {
  const raw = await buildRawMessage(mailOptions)
  const draftsFolder = await resolveDraftsFolder(account)
  const saved = await appendToFolder(account, draftsFolder, raw, ['\\Draft'])
  return { saved, drafts_folder: draftsFolder }
}

/**
 * Unified draft tool - composes outbound email and stores it for human review.
 */
export async function draft(accounts: AccountConfig[], input: DraftInput): Promise<any> {
  return withErrorHandling(async () => {
    if (!input.account) {
      throw new EmailMCPError(
        'account is required for draft operations',
        'VALIDATION_ERROR',
        'Provide the sender account email address'
      )
    }

    if (!input.body) {
      throw new EmailMCPError('body is required', 'VALIDATION_ERROR', 'Provide the email body text')
    }

    switch (input.action) {
      case 'new':
        return await handleNew(accounts, input)

      case 'reply':
        return await handleReply(accounts, input)

      case 'forward':
        return await handleForward(accounts, input)

      default:
        throw createUnknownActionError(input.action, 'new, reply, forward')
    }
  })()
}

/**
 * Draft a new email
 */
async function handleNew(accounts: AccountConfig[], input: DraftInput): Promise<any> {
  if (!input.to) {
    throw new EmailMCPError('to is required for new email', 'VALIDATION_ERROR', 'Provide the recipient email address')
  }

  if (!input.subject) {
    throw new EmailMCPError('subject is required for new email', 'VALIDATION_ERROR', 'Provide the email subject')
  }

  const account = resolveSingleAccount(accounts, input.account)

  const { saved, drafts_folder } = await saveDraft(account, {
    from: account.email,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.body,
    html: textToHtml(input.body)
  })

  return {
    action: 'new',
    from: account.email,
    to: input.to,
    subject: input.subject,
    saved_to_drafts: saved,
    drafts_folder
  }
}

/**
 * Draft a reply (maintains thread headers).
 * `to` is optional — defaults to the original sender's address.
 */
async function handleReply(accounts: AccountConfig[], input: DraftInput): Promise<any> {
  if (!input.uid) {
    throw new EmailMCPError(
      'uid is required for reply action',
      'VALIDATION_ERROR',
      'Provide the UID of the email to reply to (from search/read)'
    )
  }

  const account = resolveSingleAccount(accounts, input.account)
  const folder = input.folder || 'INBOX'

  // Read original email to get threading headers + auto-derive `to`
  const original = await readEmail(account, input.uid, folder)

  const replyTo = input.to || original.from
  if (!replyTo) {
    throw new EmailMCPError(
      'Could not determine reply-to address',
      'VALIDATION_ERROR',
      'Provide the `to` field explicitly, or ensure the original email has a From address'
    )
  }

  const baseSubject = input.subject || original.subject
  const subject = baseSubject.startsWith('Re:') ? baseSubject : `Re: ${baseSubject}`

  const { saved, drafts_folder } = await saveDraft(account, {
    from: account.email,
    to: replyTo,
    cc: input.cc,
    bcc: input.bcc,
    subject,
    text: input.body,
    html: textToHtml(input.body),
    inReplyTo: original.message_id,
    references: original.references || original.message_id
  })

  return {
    action: 'reply',
    from: account.email,
    to: replyTo,
    subject,
    in_reply_to: original.message_id,
    saved_to_drafts: saved,
    drafts_folder
  }
}

/**
 * Draft a forward (includes the original body).
 */
async function handleForward(accounts: AccountConfig[], input: DraftInput): Promise<any> {
  if (!input.uid) {
    throw new EmailMCPError(
      'uid is required for forward action',
      'VALIDATION_ERROR',
      'Provide the UID of the email to forward (from search/read)'
    )
  }

  if (!input.to) {
    throw new EmailMCPError(
      'to is required for forward action',
      'VALIDATION_ERROR',
      'Provide the recipient email address'
    )
  }

  const account = resolveSingleAccount(accounts, input.account)
  const folder = input.folder || 'INBOX'

  const original = await readEmail(account, input.uid, folder)

  const baseSubject = input.subject || original.subject
  const subject = baseSubject.startsWith('Fwd:') ? baseSubject : `Fwd: ${baseSubject}`
  const body = `${input.body}\n\n---------- Forwarded message ----------\n${original.body_text}`

  const { saved, drafts_folder } = await saveDraft(account, {
    from: account.email,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject,
    text: body,
    html: textToHtml(body)
  })

  return {
    action: 'forward',
    from: account.email,
    to: input.to,
    subject,
    saved_to_drafts: saved,
    drafts_folder
  }
}
