import { Resend } from 'resend'
import { env } from '../config/env'

export type SendChangelogEmailOptions = {
  to: string
  entryTitle: string
  version?: string | null
  excerpt?: string
  changelogUrl: string
  unsubscribeUrl: string
}

export type SendFeatureShippedEmailOptions = {
  to: string
  itemTitle: string
  roadmapUrl: string
  unsubscribeUrl: string
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
  // changelogUrl and unsubscribeUrl are built from env.FRONTEND_URL + slugs; escape for href attribute context
  const safeUrl = escHtml(opts.changelogUrl)
  const safeUnsubUrl = escHtml(opts.unsubscribeUrl)
  const lines = ['<p>A new changelog entry has been published:</p>']
  if (opts.version) {
    lines.push(`<p><strong>${safeTitle}</strong> &mdash; ${escHtml(opts.version)}</p>`)
  } else {
    lines.push(`<p><strong>${safeTitle}</strong></p>`)
  }
  if (opts.excerpt) {
    lines.push(`<p>${escHtml(opts.excerpt)}</p>`)
  }
  lines.push(`<p><a href="${safeUrl}">View the full changelog</a></p>`)
  lines.push(`<p style="font-size:12px;color:#888;"><a href="${safeUnsubUrl}">Unsubscribe</a></p>`)
  return lines.join('\n')
}

function buildText(opts: SendChangelogEmailOptions): string {
  const versionSuffix = opts.version ? ` — ${stripNewlines(opts.version)}` : ''
  const excerptLine = opts.excerpt ? `\n\n${stripNewlines(opts.excerpt)}` : ''
  return `New changelog entry: ${opts.entryTitle}${versionSuffix}${excerptLine}\n\nView it here: ${opts.changelogUrl}\n\nUnsubscribe: ${opts.unsubscribeUrl}`
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
  const safeUnsubUrl = escHtml(opts.unsubscribeUrl)
  return [
    '<p>A roadmap item has shipped:</p>',
    `<p><strong>${safeTitle}</strong></p>`,
    `<p><a href="${safeUrl}">View the roadmap</a></p>`,
    `<p style="font-size:12px;color:#888;"><a href="${safeUnsubUrl}">Unsubscribe</a></p>`,
  ].join('\n')
}

function buildFeatureShippedText(opts: SendFeatureShippedEmailOptions): string {
  return `Roadmap item shipped: ${opts.itemTitle}\n\nView it here: ${opts.roadmapUrl}\n\nUnsubscribe: ${opts.unsubscribeUrl}`
}

export type SendFeatureStatusChangedEmailOptions = {
  to: string
  featureTitle: string
  newStatus: string
  featuresUrl: string
}

export async function sendFeatureStatusChangedEmail(opts: SendFeatureStatusChangedEmailOptions): Promise<SendResult> {
  const client = getResendClient()
  if (!client) {
    return { ok: false, error: 'Resend not configured — RESEND_API_KEY missing' }
  }
  try {
    await client.emails.send({
      from: env.RESEND_FROM_EMAIL,
      to: opts.to,
      subject: `Update on "${stripNewlines(opts.featureTitle)}"`,
      html: buildFeatureStatusChangedHtml(opts),
      text: buildFeatureStatusChangedText(opts),
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function buildFeatureStatusChangedHtml(opts: SendFeatureStatusChangedEmailOptions): string {
  const safeTitle = escHtml(opts.featureTitle)
  const safeStatus = escHtml(opts.newStatus)
  const safeUrl = escHtml(opts.featuresUrl)
  return [
    `<p>The status of a feature request you voted for has changed:</p>`,
    `<p><strong>${safeTitle}</strong></p>`,
    `<p>New status: <strong>${safeStatus}</strong></p>`,
    `<p><a href="${safeUrl}">View feature requests</a></p>`,
  ].join('\n')
}

function buildFeatureStatusChangedText(opts: SendFeatureStatusChangedEmailOptions): string {
  return `The status of a feature request you voted for has changed:\n\n${stripNewlines(opts.featureTitle)}\n\nNew status: ${stripNewlines(opts.newStatus)}\n\nView feature requests: ${opts.featuresUrl}`
}

export type SendVoteVerificationEmailOptions = {
  to: string
  featureTitle: string
  verifyUrl: string
}

export async function sendVoteVerificationEmail(opts: SendVoteVerificationEmailOptions): Promise<SendResult> {
  const client = getResendClient()
  if (!client) {
    return { ok: false, error: 'Resend not configured — RESEND_API_KEY missing' }
  }
  try {
    await client.emails.send({
      from: env.RESEND_FROM_EMAIL,
      to: opts.to,
      subject: `Verify your vote for: ${stripNewlines(opts.featureTitle)}`,
      html: buildVoteVerificationHtml(opts),
      text: buildVoteVerificationText(opts),
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function buildVoteVerificationHtml(opts: SendVoteVerificationEmailOptions): string {
  const safeTitle = escHtml(opts.featureTitle)
  const safeUrl = escHtml(opts.verifyUrl)
  return [
    '<p>You requested to vote for a feature. Click the link below to verify your vote:</p>',
    `<p><strong>${safeTitle}</strong></p>`,
    `<p><a href="${safeUrl}">Verify my vote</a></p>`,
    '<p>If you did not submit this vote, you can ignore this email.</p>',
  ].join('\n')
}

function buildVoteVerificationText(opts: SendVoteVerificationEmailOptions): string {
  return `You requested to vote for: ${stripNewlines(opts.featureTitle)}\n\nVerify your vote here: ${stripNewlines(opts.verifyUrl)}\n\nIf you did not submit this vote, you can ignore this email.`
}

export type SendSubscribeVerificationEmailOptions = {
  to: string
  projectName: string
  verifyUrl: string
  unsubscribeUrl: string
}

export async function sendSubscribeVerificationEmail(opts: SendSubscribeVerificationEmailOptions): Promise<SendResult> {
  const client = getResendClient()
  if (!client) {
    return { ok: false, error: 'Resend not configured — RESEND_API_KEY missing' }
  }
  try {
    await client.emails.send({
      from: env.RESEND_FROM_EMAIL,
      to: opts.to,
      subject: `Confirm your subscription to ${stripNewlines(opts.projectName)}`,
      html: buildSubscribeVerificationHtml(opts),
      text: buildSubscribeVerificationText(opts),
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function buildSubscribeVerificationHtml(opts: SendSubscribeVerificationEmailOptions): string {
  const safeName = escHtml(opts.projectName)
  const safeVerifyUrl = escHtml(opts.verifyUrl)
  const safeUnsubUrl = escHtml(opts.unsubscribeUrl)
  return [
    `<p>You requested to subscribe to updates from <strong>${safeName}</strong>.</p>`,
    `<p>Click the link below to confirm your subscription:</p>`,
    `<p><a href="${safeVerifyUrl}">Confirm subscription</a></p>`,
    '<p>If you did not request this, you can ignore this email.</p>',
    `<p style="font-size:12px;color:#888;"><a href="${safeUnsubUrl}">Unsubscribe</a></p>`,
  ].join('\n')
}

function buildSubscribeVerificationText(opts: SendSubscribeVerificationEmailOptions): string {
  return `You requested to subscribe to updates from ${opts.projectName}.\n\nConfirm your subscription here: ${opts.verifyUrl}\n\nIf you did not request this, you can ignore this email.\n\nUnsubscribe: ${opts.unsubscribeUrl}`
}
