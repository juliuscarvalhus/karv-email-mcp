import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountConfig } from '../helpers/config.js'

// --- Mocks ---
vi.mock('../helpers/imap-client.js', () => ({
  searchEmails: vi.fn(),
  readEmail: vi.fn(),
  modifyFlags: vi.fn(),
  moveEmails: vi.fn(),
  resolveSpamFolder: vi.fn()
}))

import { modifyFlags, moveEmails, readEmail, resolveSpamFolder, searchEmails } from '../helpers/imap-client.js'
import { messages } from './messages.js'

const mockSearchEmails = vi.mocked(searchEmails)
const mockReadEmail = vi.mocked(readEmail)
const mockModifyFlags = vi.mocked(modifyFlags)
const mockMoveEmails = vi.mocked(moveEmails)
const mockResolveSpamFolder = vi.mocked(resolveSpamFolder)

const accounts: AccountConfig[] = [
  {
    id: 'user1_gmail_com',
    email: 'user1@gmail.com',
    password: 'pass1',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true }
  },
  {
    id: 'user2_outlook_com',
    email: 'user2@outlook.com',
    password: 'pass2',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false }
  }
]

beforeEach(() => {
  vi.clearAllMocks()
})

// ============================================================================
// search
// ============================================================================

describe('messages - search', () => {
  it('searches all accounts by default', async () => {
    mockSearchEmails.mockResolvedValue([])

    const result = await messages(accounts, { action: 'search' })

    expect(result.action).toBe('search')
    expect(result.query).toBe('UNSEEN')
    expect(result.folder).toBe('INBOX')
    expect(result.accounts_searched).toHaveLength(2)
    expect(mockSearchEmails).toHaveBeenCalledWith(accounts, 'UNSEEN', 'INBOX', 20)
  })

  it('filters by account when specified', async () => {
    mockSearchEmails.mockResolvedValue([])

    await messages(accounts, { action: 'search', account: 'user1@gmail.com' })

    expect(mockSearchEmails).toHaveBeenCalledWith(
      [accounts[0]],
      expect.any(String),
      expect.any(String),
      expect.any(Number)
    )
  })

  it('uses custom query, folder, and limit', async () => {
    mockSearchEmails.mockResolvedValue([])

    await messages(accounts, { action: 'search', query: 'FLAGGED', folder: 'Sent', limit: 5 })

    expect(mockSearchEmails).toHaveBeenCalledWith(accounts, 'FLAGGED', 'Sent', 5)
  })

  it('throws when account not found', async () => {
    await expect(messages(accounts, { action: 'search', account: 'nonexistent@test.com' })).rejects.toThrow(
      'Account not found'
    )
  })
})

// ============================================================================
// read
// ============================================================================

describe('messages - read', () => {
  it('reads email by UID', async () => {
    mockReadEmail.mockResolvedValue({
      account_id: 'user1_gmail_com',
      account_email: 'user1@gmail.com',
      uid: 42,
      subject: 'Test',
      from: 'sender@test.com',
      to: 'user1@gmail.com',
      date: '2025-01-01',
      flags: ['\\Seen'],
      body_text: 'Hello',
      attachments: []
    })

    const result = await messages(accounts, { action: 'read', uid: 42, account: 'user1@gmail.com' })

    expect(result.action).toBe('read')
    expect(result.uid).toBe(42)
    expect(result.subject).toBe('Test')
  })

  it('throws when uid is missing', async () => {
    await expect(messages(accounts, { action: 'read', account: 'user1@gmail.com' })).rejects.toThrow('uid is required')
  })

  it('throws when multiple accounts match', async () => {
    await expect(messages(accounts, { action: 'read', uid: 1, account: '.com' })).rejects.toThrow(
      'Multiple accounts matched'
    )
  })
})

// ============================================================================
// mark_read / mark_unread
// ============================================================================

describe('messages - mark_read', () => {
  it('adds \\Seen flag', async () => {
    mockModifyFlags.mockResolvedValue({ success: true, modified: 1 })

    const result = await messages(accounts, { action: 'mark_read', uid: 5, account: 'user1@gmail.com' })

    expect(result.action).toBe('mark_read')
    expect(mockModifyFlags).toHaveBeenCalledWith(accounts[0], [5], 'INBOX', ['\\Seen'], 'add')
  })

  it('supports batch uids', async () => {
    mockModifyFlags.mockResolvedValue({ success: true, modified: 3 })

    await messages(accounts, { action: 'mark_read', uids: [1, 2, 3], account: 'user1@gmail.com' })

    expect(mockModifyFlags).toHaveBeenCalledWith(accounts[0], [1, 2, 3], 'INBOX', ['\\Seen'], 'add')
  })

  it('throws when no uids provided', async () => {
    await expect(messages(accounts, { action: 'mark_read', account: 'user1@gmail.com' })).rejects.toThrow(
      'uid or uids required'
    )
  })
})

describe('messages - mark_unread', () => {
  it('removes \\Seen flag', async () => {
    mockModifyFlags.mockResolvedValue({ success: true, modified: 1 })

    await messages(accounts, { action: 'mark_unread', uid: 5, account: 'user1@gmail.com' })

    expect(mockModifyFlags).toHaveBeenCalledWith(accounts[0], [5], 'INBOX', ['\\Seen'], 'remove')
  })
})

// ============================================================================
// flag / unflag
// ============================================================================

describe('messages - flag', () => {
  it('adds \\Flagged flag', async () => {
    mockModifyFlags.mockResolvedValue({ success: true, modified: 1 })

    await messages(accounts, { action: 'flag', uid: 10, account: 'user1@gmail.com' })

    expect(mockModifyFlags).toHaveBeenCalledWith(accounts[0], [10], 'INBOX', ['\\Flagged'], 'add')
  })
})

describe('messages - unflag', () => {
  it('removes \\Flagged flag', async () => {
    mockModifyFlags.mockResolvedValue({ success: true, modified: 1 })

    await messages(accounts, { action: 'unflag', uid: 10, account: 'user1@gmail.com' })

    expect(mockModifyFlags).toHaveBeenCalledWith(accounts[0], [10], 'INBOX', ['\\Flagged'], 'remove')
  })
})

// ============================================================================
// report_spam (the only move operation in this fork)
// ============================================================================

describe('messages - report_spam', () => {
  it('moves emails to the resolved spam folder', async () => {
    mockResolveSpamFolder.mockResolvedValue('Junk')
    mockMoveEmails.mockResolvedValue({ success: true, moved: 2 })

    const result = await messages(accounts, {
      action: 'report_spam',
      uids: [1, 2],
      account: 'user1@gmail.com'
    })

    expect(result.action).toBe('report_spam')
    expect(result.spam_folder).toBe('Junk')
    expect(mockMoveEmails).toHaveBeenCalledWith(accounts[0], [1, 2], 'INBOX', 'Junk')
  })

  it('marks the message as junk ($Junk/Junk) in the source folder before moving', async () => {
    mockResolveSpamFolder.mockResolvedValue('Junk')
    mockModifyFlags.mockResolvedValue({ success: true, modified: 1 })
    mockMoveEmails.mockResolvedValue({ success: true, moved: 1 })

    const result = await messages(accounts, {
      action: 'report_spam',
      uid: 5,
      account: 'user1@gmail.com'
    })

    // adds the junk keywords and clears the opposite markers, in the SOURCE folder
    expect(mockModifyFlags).toHaveBeenCalledWith(accounts[0], [5], 'INBOX', ['$NotJunk', 'NonJunk'], 'remove')
    expect(mockModifyFlags).toHaveBeenCalledWith(accounts[0], [5], 'INBOX', ['$Junk', 'Junk'], 'add')
    expect(result.marked_junk).toBe(true)
  })

  it('still moves to spam even if marking junk fails (best-effort)', async () => {
    mockResolveSpamFolder.mockResolvedValue('Junk')
    mockModifyFlags.mockRejectedValue(new Error('keywords not supported'))
    mockMoveEmails.mockResolvedValue({ success: true, moved: 1 })

    const result = await messages(accounts, { action: 'report_spam', uid: 9, account: 'user1@gmail.com' })

    expect(result.marked_junk).toBe(false)
    expect(result.spam_folder).toBe('Junk')
    expect(mockMoveEmails).toHaveBeenCalledWith(accounts[0], [9], 'INBOX', 'Junk')
  })

  it('resolves the spam folder per account (e.g. Outlook Junk Email)', async () => {
    mockResolveSpamFolder.mockResolvedValue('Junk Email')
    mockMoveEmails.mockResolvedValue({ success: true, moved: 1 })

    const result = await messages(accounts, { action: 'report_spam', uid: 7, account: 'user2@outlook.com' })

    expect(result.spam_folder).toBe('Junk Email')
    expect(mockMoveEmails).toHaveBeenCalledWith(accounts[1], [7], 'INBOX', 'Junk Email')
  })

  it('throws when no uids provided', async () => {
    await expect(messages(accounts, { action: 'report_spam', account: 'user1@gmail.com' })).rejects.toThrow(
      'uid or uids required'
    )
  })
})

// ============================================================================
// unknown action
// ============================================================================

describe('messages - unknown action', () => {
  it('throws for unknown action', async () => {
    await expect(messages(accounts, { action: 'unknown_action' as any })).rejects.toThrow()
  })
})

// ============================================================================
// account resolution
// ============================================================================

describe('account resolution', () => {
  it('matches by partial email', async () => {
    mockSearchEmails.mockResolvedValue([])

    await messages(accounts, { action: 'search', account: 'gmail' })

    expect(mockSearchEmails).toHaveBeenCalledWith(
      [accounts[0]],
      expect.any(String),
      expect.any(String),
      expect.any(Number)
    )
  })

  it('matches by account id', async () => {
    mockSearchEmails.mockResolvedValue([])

    await messages(accounts, { action: 'search', account: 'user1_gmail_com' })

    expect(mockSearchEmails).toHaveBeenCalledWith(
      [accounts[0]],
      expect.any(String),
      expect.any(String),
      expect.any(Number)
    )
  })
})

// ============================================================================
// report_spam — extended coverage
// ============================================================================

describe('messages - report_spam (extended)', () => {
  it('supports batch uids', async () => {
    mockResolveSpamFolder.mockResolvedValue('Junk')
    mockMoveEmails.mockResolvedValue({ success: true, moved: 3 })

    const result = await messages(accounts, {
      action: 'report_spam',
      uids: [10, 20, 30],
      account: 'user1@gmail.com'
    })

    expect(result.action).toBe('report_spam')
    expect(mockMoveEmails).toHaveBeenCalledWith(accounts[0], [10, 20, 30], 'INBOX', 'Junk')
  })

  it('accepts a single uid', async () => {
    mockResolveSpamFolder.mockResolvedValue('Spam')
    mockMoveEmails.mockResolvedValue({ success: true, moved: 1 })

    const result = await messages(accounts, { action: 'report_spam', uid: 42, account: 'user1@gmail.com' })

    expect(result.spam_folder).toBe('Spam')
    expect(mockMoveEmails).toHaveBeenCalledWith(accounts[0], [42], 'INBOX', 'Spam')
  })
})
