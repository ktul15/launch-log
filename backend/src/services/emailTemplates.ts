import type {
  SendChangelogEmailOptions,
  SendFeatureShippedEmailOptions,
  SendFeatureStatusChangedEmailOptions,
  SendVoteVerificationEmailOptions,
  SendSubscribeVerificationEmailOptions,
} from './emailService'

// Strips CR/LF from user-controlled strings used in email subject headers to prevent header injection.
export function stripNewlines(s: string): string {
  return s.replace(/[\r\n]/g, '')
}

// Escapes characters that are special in HTML to prevent XSS in email bodies.
// Applied to all user-controlled strings before interpolation into HTML.
// Includes backtick to prevent breakout in template-literal post-processing contexts.
export function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;')
}

// Validates that a URL uses http(s) scheme (blocks javascript: and data: URIs),
// then HTML-escapes the result for safe use in href attributes.
// Returns '#' for any non-http(s) input so links degrade gracefully rather than execute code.
function safeUrl(s: string): string {
  const trimmed = s.trim()
  if (!/^https?:\/\//i.test(trimmed)) return '#'
  return escHtml(trimmed)
}

// Produces an accessible CTA button. Both label and url are sanitised internally;
// callers pass raw user-controlled values.
function ctaButton(label: string, rawUrl: string): string {
  return `<a href="${safeUrl(rawUrl)}" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:15px;line-height:1;">${escHtml(label)}</a>`
}

// Base email layout. Escaping contract:
//   - title: raw string — escaped internally via escHtml before insertion into <title>
//   - content: pre-escaped HTML — interpolated verbatim; callers must sanitise all user values
//   - footer: pre-escaped HTML — interpolated verbatim; callers must sanitise all user values
function baseLayout(opts: { title: string; content: string; footer: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escHtml(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
<tr><td style="padding:32px 16px;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
<tr><td style="padding:20px 32px;border-bottom:1px solid #e5e7eb;">
  <span style="font-size:18px;font-weight:700;color:#111827;letter-spacing:-0.3px;">LaunchLog</span>
</td></tr>
<tr><td style="padding:32px;">
  ${opts.content}
</td></tr>
<tr><td style="padding:16px 32px 24px;border-top:1px solid #e5e7eb;">
  <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">${opts.footer}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}

// ─── HTML templates ───────────────────────────────────────────────────────────

export function changelogTemplate(opts: SendChangelogEmailOptions): string {
  const safeTitle = escHtml(opts.entryTitle)
  // opts.version falsy (null, undefined, or "") → version line suppressed; intentional
  const titleLine = opts.version
    ? `<strong>${safeTitle}</strong> &mdash; <span style="color:#6b7280;">${escHtml(opts.version)}</span>`
    : `<strong>${safeTitle}</strong>`

  const excerptBlock = opts.excerpt
    ? `<p style="margin:0 0 24px;color:#374151;line-height:1.6;">${escHtml(opts.excerpt)}</p>`
    : ''

  const content = `
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#4f46e5;text-transform:uppercase;letter-spacing:0.5px;">New Update</p>
    <p style="margin:0 0 16px;font-size:20px;color:#111827;line-height:1.4;">${titleLine}</p>
    ${excerptBlock}
    ${ctaButton('View Changelog', opts.changelogUrl)}
  `

  const footer = `You received this because you subscribed to updates. &nbsp;<a href="${safeUrl(opts.unsubscribeUrl)}" style="color:#9ca3af;">Unsubscribe</a>`

  return baseLayout({ title: opts.entryTitle, content, footer })
}

export function featureShippedTemplate(opts: SendFeatureShippedEmailOptions): string {
  const safeTitle = escHtml(opts.itemTitle)

  const content = `
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#059669;text-transform:uppercase;letter-spacing:0.5px;">Shipped &#10003;</p>
    <p style="margin:0 0 24px;font-size:20px;font-weight:700;color:#111827;line-height:1.4;">${safeTitle}</p>
    <p style="margin:0 0 24px;color:#374151;line-height:1.6;">A feature you follow has shipped. Check the roadmap for details.</p>
    ${ctaButton('View Roadmap', opts.roadmapUrl)}
  `

  const footer = `You received this because you subscribed to updates. &nbsp;<a href="${safeUrl(opts.unsubscribeUrl)}" style="color:#9ca3af;">Unsubscribe</a>`

  return baseLayout({ title: `Shipped: ${opts.itemTitle}`, content, footer })
}

export function statusUpdateTemplate(opts: SendFeatureStatusChangedEmailOptions): string {
  const safeTitle = escHtml(opts.featureTitle)
  const safeStatus = escHtml(opts.newStatus)

  const content = `
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Status Update</p>
    <p style="margin:0 0 16px;font-size:20px;font-weight:700;color:#111827;line-height:1.4;">${safeTitle}</p>
    <p style="margin:0 0 24px;color:#374151;line-height:1.6;">
      New status: <span style="display:inline-block;padding:3px 10px;background:#ede9fe;color:#5b21b6;border-radius:9999px;font-size:13px;font-weight:600;">${safeStatus}</span>
    </p>
    ${ctaButton('View Feature Requests', opts.featuresUrl)}
  `

  const footer = `You received this because you voted for this feature. To stop receiving these updates, remove your vote.`

  return baseLayout({ title: `Update: ${opts.featureTitle}`, content, footer })
}

export function voteVerificationTemplate(opts: SendVoteVerificationEmailOptions): string {
  const safeTitle = escHtml(opts.featureTitle)

  const content = `
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#4f46e5;text-transform:uppercase;letter-spacing:0.5px;">Verify Your Vote</p>
    <p style="margin:0 0 16px;font-size:20px;font-weight:700;color:#111827;line-height:1.4;">${safeTitle}</p>
    <p style="margin:0 0 24px;color:#374151;line-height:1.6;">Click below to confirm your vote. This link expires in 24 hours.</p>
    ${ctaButton('Verify My Vote', opts.verifyUrl)}
  `

  const footer = `If you did not submit this vote, you can safely ignore this email.`

  return baseLayout({ title: `Verify your vote`, content, footer })
}

export function subscribeVerificationTemplate(opts: SendSubscribeVerificationEmailOptions): string {
  const safeName = escHtml(opts.projectName)

  const content = `
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#4f46e5;text-transform:uppercase;letter-spacing:0.5px;">Confirm Subscription</p>
    <p style="margin:0 0 16px;font-size:20px;font-weight:700;color:#111827;line-height:1.4;">${safeName}</p>
    <p style="margin:0 0 24px;color:#374151;line-height:1.6;">Click below to confirm your subscription to updates from <strong>${safeName}</strong>.</p>
    ${ctaButton('Confirm Subscription', opts.verifyUrl)}
  `

  const footer = `If you did not request this, you can safely ignore this email. &nbsp;<a href="${safeUrl(opts.unsubscribeUrl)}" style="color:#9ca3af;">Unsubscribe</a>`

  return baseLayout({ title: `Confirm your subscription to ${opts.projectName}`, content, footer })
}

// ─── Plain-text bodies ────────────────────────────────────────────────────────
// Exported for testing. stripNewlines applied to all user-controlled strings
// including URLs to prevent body injection via embedded newlines.

export function changelogText(opts: SendChangelogEmailOptions): string {
  const versionSuffix = opts.version ? ` — ${stripNewlines(opts.version)}` : ''
  const excerptLine = opts.excerpt ? `\n\n${stripNewlines(opts.excerpt)}` : ''
  return `New changelog entry: ${stripNewlines(opts.entryTitle)}${versionSuffix}${excerptLine}\n\nView it here: ${stripNewlines(opts.changelogUrl)}\n\nUnsubscribe: ${stripNewlines(opts.unsubscribeUrl)}`
}

export function featureShippedText(opts: SendFeatureShippedEmailOptions): string {
  return `Roadmap item shipped: ${stripNewlines(opts.itemTitle)}\n\nView it here: ${stripNewlines(opts.roadmapUrl)}\n\nUnsubscribe: ${stripNewlines(opts.unsubscribeUrl)}`
}

export function statusUpdateText(opts: SendFeatureStatusChangedEmailOptions): string {
  return `The status of a feature request you voted for has changed:\n\n${stripNewlines(opts.featureTitle)}\n\nNew status: ${stripNewlines(opts.newStatus)}\n\nView feature requests: ${stripNewlines(opts.featuresUrl)}`
}

export function voteVerificationText(opts: SendVoteVerificationEmailOptions): string {
  return `You requested to vote for: ${stripNewlines(opts.featureTitle)}\n\nVerify your vote here: ${stripNewlines(opts.verifyUrl)}\n\nIf you did not submit this vote, you can ignore this email.`
}

export function subscribeVerificationText(opts: SendSubscribeVerificationEmailOptions): string {
  return `You requested to subscribe to updates from ${stripNewlines(opts.projectName)}.\n\nConfirm your subscription here: ${stripNewlines(opts.verifyUrl)}\n\nIf you did not request this, you can ignore this email.\n\nUnsubscribe: ${stripNewlines(opts.unsubscribeUrl)}`
}
