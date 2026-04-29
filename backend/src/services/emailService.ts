import { Resend } from 'resend'
import { env } from '../config/env'
import {
  stripNewlines,
  changelogTemplate,
  changelogText,
  featureShippedTemplate,
  featureShippedText,
  statusUpdateTemplate,
  statusUpdateText,
  voteVerificationTemplate,
  voteVerificationText,
  subscribeVerificationTemplate,
  subscribeVerificationText,
} from './emailTemplates'

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

export type SendFeatureStatusChangedEmailOptions = {
  to: string
  featureTitle: string
  newStatus: string
  featuresUrl: string
  unsubscribeUrl: string
}

export type SendVoteVerificationEmailOptions = {
  to: string
  featureTitle: string
  verifyUrl: string
}

export type SendSubscribeVerificationEmailOptions = {
  to: string
  projectName: string
  verifyUrl: string
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
      html: changelogTemplate(opts),
      text: changelogText(opts),
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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
      html: featureShippedTemplate(opts),
      text: featureShippedText(opts),
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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
      html: statusUpdateTemplate(opts),
      text: statusUpdateText(opts),
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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
      html: voteVerificationTemplate(opts),
      text: voteVerificationText(opts),
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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
      html: subscribeVerificationTemplate(opts),
      text: subscribeVerificationText(opts),
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
