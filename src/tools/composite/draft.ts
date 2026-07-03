/**
 * Draft Mega Tool (KARV fork)
 * Composes new emails, replies, and forwards — and saves them to the Drafts
 * folder via IMAP APPEND. It NEVER sends. The human reviews the draft in their
 * mail client (webmail/Outlook) and sends it manually.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AccountConfig } from '../helpers/config.js'
import { resolveSingleAccount } from '../helpers/config.js'
import { createUnknownActionError, EmailMCPError, withErrorHandling } from '../helpers/errors.js'
import { appendToFolder, readEmail, resolveDraftsFolder } from '../helpers/imap-client.js'
import { buildRawMessage, textToHtml } from '../helpers/smtp-client.js'

function getCleanEmail(addr: string): string {
  const match = addr.match(/<([^>]+)>/) || addr.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)
  return match ? match[1] || match[0] : addr.trim()
}

function parseAddresses(addrStr: string | undefined): { clean: string; original: string }[] {
  if (!addrStr) return []
  const result: { clean: string; original: string }[] = []
  const parts = addrStr.split(',')
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed) {
      result.push({
        clean: getCleanEmail(trimmed).toLowerCase(),
        original: trimmed
      })
    }
  }
  return result
}

function cleanHtmlSignature(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  if (bodyMatch) return bodyMatch[1].trim()
  return html
    .replace(/<html[^>]*>/gi, '')
    .replace(/<\/html>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<body[^>]*>/gi, '')
    .replace(/<\/body>/gi, '')
    .trim()
}

function getSignature(email: string): { html: string; text: string } {
  try {
    const home = os.homedir()
    const configPath = path.join(home, '.karv', 'email-accounts.json')
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      const accountConfig = (config.accounts || []).find((a: any) => a.email.toLowerCase() === email.toLowerCase())
      if (accountConfig && accountConfig.signaturePath) {
        let sigPath = accountConfig.signaturePath
        if (fs.existsSync(sigPath)) {
          // Allow signaturePath to be a FOLDER: pick a signature file inside it.
          if (fs.statSync(sigPath).isDirectory()) {
            const preferred = ['signature.html', 'assinatura.html', 'signature.htm', 'signature.txt', 'assinatura.txt']
            const pick =
              preferred.map((f) => path.join(sigPath, f)).find((p) => fs.existsSync(p)) ||
              fs
                .readdirSync(sigPath)
                .map((f) => path.join(sigPath, f))
                .find((p) => /\.(html?|txt)$/i.test(p) && fs.statSync(p).isFile())
            if (!pick) return { html: '', text: '' }
            sigPath = pick
          }
          const content = fs.readFileSync(sigPath, 'utf-8')
          const isHtml = /<[a-z][\s\S]*>/i.test(content)
          if (isHtml) {
            return {
              html: cleanHtmlSignature(content),
              text: content
                .replace(/<[^>]*>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
            }
          } else {
            return {
              html: textToHtml(content),
              text: content
            }
          }
        }
      }
    }
  } catch (e) {
    // Ignore error
  }
  return { html: '', text: '' }
}

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
    attachments?: any[]
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

    // Normaliza o fim do corpo (tira linhas em branco sobrando). O espacamento
    // antes da assinatura vem da margem do <p> que o marked gera em textToHtml -
    // por isso NAO adicionamos <br> antes da assinatura (senao dobra).
    input.body = input.body.trimEnd()

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

  // Assinatura do e-mail (mesma logica de reply/forward): sem citacao, vai ao fim do corpo.
  const signature = getSignature(account.email)
  const bodyText = signature.text ? `${input.body}\n\n${signature.text}` : input.body
  // Sem <br> antes da assinatura: a margem do <p> (marked) ja da o espaco unico.
  const bodyHtml = signature.html ? `${textToHtml(input.body)}${signature.html}` : textToHtml(input.body)

  const { saved, drafts_folder } = await saveDraft(account, {
    from: account.email,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: bodyText,
    html: bodyHtml
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
      'Provide the UID of the e-mail to reply to (from search/read)'
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

  // Lógica de "Responder a todos" como padrão
  let replyCc = input.cc
  if (!input.to && !input.cc) {
    const accountEmailClean = account.email.toLowerCase()
    const originalFromList = parseAddresses(original.from)
    const originalFromClean = originalFromList.map((x) => x.clean)
    const toAndCc = [...parseAddresses(original.to), ...parseAddresses(original.cc)]

    const uniqueCc = new Map<string, string>()
    for (const item of toAndCc) {
      if (item.clean !== accountEmailClean && !originalFromClean.includes(item.clean)) {
        uniqueCc.set(item.clean, item.original)
      }
    }
    const ccList = Array.from(uniqueCc.values())
    if (ccList.length > 0) {
      replyCc = ccList.join(', ')
    }
  }

  const baseSubject = input.subject || original.subject
  const subject = baseSubject.startsWith('Re:') ? baseSubject : `Re: ${baseSubject}`

  const originalDate = original.date ? new Date(original.date).toLocaleString('pt-BR') : ''
  const originalSender = original.from || ''

  // Assinatura do e-mail
  const signature = getSignature(account.email)

  // Formata o histórico em texto puro
  const replyPrefix =
    `\n\n${signature.text ? signature.text + '\n\n' : ''}Em ${originalDate}, ${originalSender} escreveu:\n> ` +
    original.body_text.replace(/\r?\n/g, '\n> ')
  const bodyText = `${input.body}${replyPrefix}`

  // Formata o histórico em HTML (Usa o HTML original se disponível, senão converte do texto)
  const originalHtml = original.body_html || textToHtml(original.body_text)
  // Sem <br> inicial: a margem do <p> do corpo ja separa da assinatura/citacao.
  const replyPrefixHtml = `${signature.html ? signature.html + '<br><br>' : ''}Em ${originalDate}, ${originalSender} escreveu:<br><blockquote style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${originalHtml}</blockquote>`
  const bodyHtml = `${textToHtml(input.body)}${replyPrefixHtml}`

  // Anexos no responder: APENAS imagens inline/embedded (cid ou inline)
  const inlineAttachments = (original.raw_attachments || [])
    .filter((att: any) => att.contentId || att.contentDisposition === 'inline')
    .map((att: any) => ({
      filename: att.filename || 'unnamed',
      content: att.content,
      contentType: att.contentType,
      cid: att.contentId,
      contentDisposition: att.contentDisposition || 'inline'
    }))

  const { saved, drafts_folder } = await saveDraft(account, {
    from: account.email,
    to: replyTo,
    cc: replyCc,
    bcc: input.bcc,
    subject,
    text: bodyText,
    html: bodyHtml,
    attachments: inlineAttachments,
    inReplyTo: original.message_id,
    // Proper reply chain = original's References + the original's own Message-ID.
    references: [original.references, original.message_id].filter(Boolean).join(' ') || undefined
  })

  return {
    action: 'reply',
    from: account.email,
    to: replyTo,
    cc: replyCc,
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

  const originalDate = original.date ? new Date(original.date).toLocaleString('pt-BR') : ''
  const originalSender = original.from || ''

  // Assinatura do e-mail
  const signature = getSignature(account.email)

  // Formata o histórico em texto puro
  const forwardHeader = `\n\n${signature.text ? signature.text + '\n\n' : ''}---------- Forwarded message ----------\nDe: ${originalSender}\nData: ${originalDate}\nAssunto: ${original.subject}\nPara: ${original.to}\n\n${original.body_text}`
  const bodyText = `${input.body}${forwardHeader}`

  // Formata o histórico em HTML (Usa HTML original se disponível)
  const originalHtml = original.body_html || textToHtml(original.body_text)
  // Sem <br> inicial: a margem do <p> do corpo ja separa da assinatura/cabecalho.
  const forwardHeaderHtml = `${signature.html ? signature.html + '<br><br>' : ''}---------- Forwarded message ----------<br><b>De:</b> ${originalSender}<br><b>Data:</b> ${originalDate}<br><b>Assunto:</b> ${original.subject}<br><b>Para:</b> ${original.to}<br><br>${originalHtml}`
  const bodyHtml = `${textToHtml(input.body)}${forwardHeaderHtml}`

  // Anexos no encaminhar: TODOS os anexos (inline + anexos de arquivo regulares)
  const allAttachments = (original.raw_attachments || []).map((att: any) => ({
    filename: att.filename || 'unnamed',
    content: att.content,
    contentType: att.contentType,
    cid: att.contentId,
    contentDisposition: att.contentDisposition
  }))

  const { saved, drafts_folder } = await saveDraft(account, {
    from: account.email,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject,
    text: bodyText,
    html: bodyHtml,
    attachments: allAttachments
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
