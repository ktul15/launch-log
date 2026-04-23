import { Resend } from 'resend'
import { env } from '../config/env'

export type SendChangelogEmailOptions = {
  to: string
  entryTitle: string
  changelogUrl: string
}

export type SendFeatureShippedEmailOptions = {
  to: string
  itemTitle: string
  roadmapUrl: string
}

export type SendResult = { ok: true } | { ok: false; error: string }

// Cached per process — undefined means not yet resolved, null means no API key
let resendClient: Resend | null | undefined

function getResendClient(): Resend | null {
  if (resendClient !== undefined) return resendClient
  if (!env.RESEND_API_KEY) {
    resendClient = null
    return null
  }
  resendClient = new Resend(env.RESEND_API_KEY)
  return resendClient
}

export async function sendChangelogEmail(opts: SendChangelogEmailOptions): Promise<SendResult> {
  const client = getResendClient()
  if (!client) {
    return { ok: false, error: 'Resend not configured — RESEND_API_KEY missing' }
  }
  try {
    await client.emails.send({
      from: env.RESEND_FROM_EMAIL,
      to: opts.to,
      subject: `New update: ${stripNewlines(opts.entryTitle)}`,
      html: buildHtml(opts),
      text: buildText(opts),
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// Strips CR/LF from user-controlled strings used in email subject headers to prevent header injection.
function stripNewlines(s: string): string {
  return s.replace(/[\r\n]/g, '')
}

// Escapes characters that are special in HTML to prevent XSS in email bodies.
// Applied to all user-controlled strings before interpolation into HTML.
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildHtml(opts: SendChangelogEmailOptions): string {
  const safeTitle = escHtml(opts.entryTitle)
  // changelogUrl is built from env.FRONTEND_URL + project slug; escape for href attribute context
  const safeUrl = escHtml(opts.changelogUrl)
  return [
    '<p>A new changelog entry has been published:</p>',
    `<p><strong>${safeTitle}</strong></p>`,
    `<p><a href="${safeUrl}">View the full changelog</a></p>`,
  ].join('\n')
}

function buildText(opts: SendChangelogEmailOptions): string {
  return `New changelog entry: ${opts.entryTitle}\n\nView it here: ${opts.changelogUrl}`
}

export async function sendFeatureShippedEmail(opts: SendFeatureShippedEmailOptions): Promise<SendResult> {
  const client = getResendClient()
  if (!client) {
    return { ok: false, error: 'Resend not configured — RESEND_API_KEY missing' }
  }
  try {
    await client.emails.send({
      from: env.RESEND_FROM_EMAIL,
      to: opts.to,
      subject: `Shipped: ${stripNewlines(opts.itemTitle)}`,
      html: buildFeatureShippedHtml(opts),
      text: buildFeatureShippedText(opts),
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function buildFeatureShippedHtml(opts: SendFeatureShippedEmailOptions): string {
  const safeTitle = escHtml(opts.itemTitle)
  const safeUrl = escHtml(opts.roadmapUrl)
  return [
    '<p>A roadmap item has shipped:</p>',
    `<p><strong>${safeTitle}</strong></p>`,
    `<p><a href="${safeUrl}">View the roadmap</a></p>`,
  ].join('\n')
}

function buildFeatureShippedText(opts: SendFeatureShippedEmailOptions): string {
  return `Roadmap item shipped: ${opts.itemTitle}\n\nView it here: ${opts.roadmapUrl}`
}
