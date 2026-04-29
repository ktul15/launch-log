import {
  escHtml,
  stripNewlines,
  changelogTemplate,
  featureShippedTemplate,
  statusUpdateTemplate,
  voteVerificationTemplate,
  subscribeVerificationTemplate,
  changelogText,
  featureShippedText,
  statusUpdateText,
  voteVerificationText,
  subscribeVerificationText,
} from '../services/emailTemplates'

describe('escHtml', () => {
  it('escapes all special HTML characters including backtick', () => {
    expect(escHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
    expect(escHtml('`')).toBe('&#96;')
  })
  it('leaves safe strings unchanged', () => {
    expect(escHtml('hello world')).toBe('hello world')
  })
})

describe('stripNewlines', () => {
  it('removes CR and LF', () => {
    expect(stripNewlines('foo\r\nbar\nbaz\r')).toBe('foobarbaz')
  })
})

// ─── changelogTemplate ────────────────────────────────────────────────────────

describe('changelogTemplate', () => {
  const baseOpts = {
    to: 'user@example.com',
    entryTitle: 'Dark Mode',
    changelogUrl: 'https://example.com/changelog/1',
    unsubscribeUrl: 'https://example.com/unsub?token=abc',
  }

  it('produces full HTML document', () => {
    const html = changelogTemplate(baseOpts)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('</html>')
    expect(html).toContain('LaunchLog')
  })

  it('contains entry title', () => {
    expect(changelogTemplate(baseOpts)).toContain('Dark Mode')
  })

  it('contains changelog URL', () => {
    expect(changelogTemplate(baseOpts)).toContain('https://example.com/changelog/1')
  })

  it('contains unsubscribe link', () => {
    const html = changelogTemplate(baseOpts)
    expect(html).toContain('https://example.com/unsub?token=abc')
    expect(html).toContain('Unsubscribe')
  })

  it('includes version when provided', () => {
    expect(changelogTemplate({ ...baseOpts, version: 'v2.1.0' })).toContain('v2.1.0')
  })

  it('includes excerpt when provided', () => {
    expect(changelogTemplate({ ...baseOpts, excerpt: 'Now with dark mode.' })).toContain('Now with dark mode.')
  })

  it('renders cleanly without version or excerpt', () => {
    const html = changelogTemplate(baseOpts)
    expect(html).toContain('Dark Mode')
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('null')
  })

  it('treats version: null same as omitted', () => {
    const html = changelogTemplate({ ...baseOpts, version: null })
    expect(html).not.toContain('null')
    expect(html).not.toContain('undefined')
  })

  it('treats version: "" same as omitted', () => {
    const html = changelogTemplate({ ...baseOpts, version: '' })
    expect(html).not.toContain('&mdash; <span') // version span not rendered
  })

  it('escapes XSS in title', () => {
    const html = changelogTemplate({ ...baseOpts, entryTitle: '<script>alert(1)</script>' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes XSS in version', () => {
    const html = changelogTemplate({ ...baseOpts, version: '<b>bad</b>' })
    expect(html).not.toContain('<b>bad</b>')
    expect(html).toContain('&lt;b&gt;bad&lt;/b&gt;')
  })

  it('escapes XSS in excerpt', () => {
    const html = changelogTemplate({ ...baseOpts, excerpt: '<img src=x onerror=alert(1)>' })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('blocks javascript: URI in changelogUrl', () => {
    const html = changelogTemplate({ ...baseOpts, changelogUrl: 'javascript:alert(1)' })
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="#"')
  })

  it('blocks javascript: URI in unsubscribeUrl', () => {
    const html = changelogTemplate({ ...baseOpts, unsubscribeUrl: 'javascript:void(0)' })
    expect(html).not.toContain('javascript:')
  })

  it('renders with empty title without throwing', () => {
    const html = changelogTemplate({ ...baseOpts, entryTitle: '' })
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).not.toContain('undefined')
  })
})

// ─── featureShippedTemplate ───────────────────────────────────────────────────

describe('featureShippedTemplate', () => {
  const baseOpts = {
    to: 'user@example.com',
    itemTitle: 'CSV Export',
    roadmapUrl: 'https://example.com/roadmap',
    unsubscribeUrl: 'https://example.com/unsub?token=xyz',
  }

  it('produces full HTML document', () => {
    const html = featureShippedTemplate(baseOpts)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('</html>')
  })

  it('contains item title', () => {
    expect(featureShippedTemplate(baseOpts)).toContain('CSV Export')
  })

  it('contains roadmap URL', () => {
    expect(featureShippedTemplate(baseOpts)).toContain('https://example.com/roadmap')
  })

  it('contains unsubscribe link', () => {
    const html = featureShippedTemplate(baseOpts)
    expect(html).toContain('https://example.com/unsub?token=xyz')
    expect(html).toContain('Unsubscribe')
  })

  it('escapes XSS in title', () => {
    const html = featureShippedTemplate({ ...baseOpts, itemTitle: '<script>xss</script>' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('blocks javascript: URI in roadmapUrl', () => {
    const html = featureShippedTemplate({ ...baseOpts, roadmapUrl: 'javascript:alert(1)' })
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="#"')
  })

  it('renders with empty title without throwing', () => {
    const html = featureShippedTemplate({ ...baseOpts, itemTitle: '' })
    expect(html).toContain('<!DOCTYPE html>')
  })
})

// ─── statusUpdateTemplate ─────────────────────────────────────────────────────

describe('statusUpdateTemplate', () => {
  const baseOpts = {
    to: 'voter@example.com',
    featureTitle: 'Offline Mode',
    newStatus: 'In Progress',
    featuresUrl: 'https://example.com/features',
    unsubscribeUrl: 'https://example.com/api/v1/public/voter-unsubscribe?token=vote-tok-1',
  }

  it('produces full HTML document', () => {
    const html = statusUpdateTemplate(baseOpts)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('</html>')
  })

  it('contains feature title and new status', () => {
    const html = statusUpdateTemplate(baseOpts)
    expect(html).toContain('Offline Mode')
    expect(html).toContain('In Progress')
  })

  it('contains features URL', () => {
    expect(statusUpdateTemplate(baseOpts)).toContain('https://example.com/features')
  })

  it('contains voter unsubscribe link', () => {
    const html = statusUpdateTemplate(baseOpts)
    expect(html).toContain('voter-unsubscribe')
    expect(html).toContain('vote-tok-1')
  })

  it('blocks javascript: URI in unsubscribeUrl', () => {
    const html = statusUpdateTemplate({ ...baseOpts, unsubscribeUrl: 'javascript:alert(1)' })
    expect(html).not.toContain('javascript:')
  })

  it('escapes XSS in feature title', () => {
    const html = statusUpdateTemplate({ ...baseOpts, featureTitle: '<script>xss</script>' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes XSS in status', () => {
    const html = statusUpdateTemplate({ ...baseOpts, newStatus: '<b>hacked</b>' })
    expect(html).not.toContain('<b>hacked</b>')
    expect(html).toContain('&lt;b&gt;hacked&lt;/b&gt;')
  })

  it('blocks javascript: URI in featuresUrl', () => {
    const html = statusUpdateTemplate({ ...baseOpts, featuresUrl: 'javascript:alert(1)' })
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="#"')
  })

  it('renders with empty fields without throwing', () => {
    const html = statusUpdateTemplate({ ...baseOpts, featureTitle: '', newStatus: '' })
    expect(html).toContain('<!DOCTYPE html>')
  })
})

// ─── voteVerificationTemplate ─────────────────────────────────────────────────

describe('voteVerificationTemplate', () => {
  const baseOpts = {
    to: 'voter@example.com',
    featureTitle: 'Multi-language Support',
    verifyUrl: 'https://example.com/verify-vote?token=tok123',
  }

  it('produces full HTML document', () => {
    const html = voteVerificationTemplate(baseOpts)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('</html>')
  })

  it('contains feature title', () => {
    expect(voteVerificationTemplate(baseOpts)).toContain('Multi-language Support')
  })

  it('contains verify URL', () => {
    expect(voteVerificationTemplate(baseOpts)).toContain('https://example.com/verify-vote?token=tok123')
  })

  it('does NOT contain a formal unsubscribe link', () => {
    expect(voteVerificationTemplate(baseOpts)).not.toMatch(/href="[^"]*unsub/)
  })

  it('escapes XSS in feature title', () => {
    const html = voteVerificationTemplate({ ...baseOpts, featureTitle: '<script>alert(1)</script>' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('blocks javascript: URI in verifyUrl', () => {
    const html = voteVerificationTemplate({ ...baseOpts, verifyUrl: 'javascript:alert(1)' })
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="#"')
  })

  it('renders with empty title without throwing', () => {
    const html = voteVerificationTemplate({ ...baseOpts, featureTitle: '' })
    expect(html).toContain('<!DOCTYPE html>')
  })
})

// ─── subscribeVerificationTemplate ───────────────────────────────────────────

describe('subscribeVerificationTemplate', () => {
  const baseOpts = {
    to: 'sub@example.com',
    projectName: 'Acme Changelog',
    verifyUrl: 'https://example.com/verify-sub?token=sub123',
    unsubscribeUrl: 'https://example.com/unsub?token=unsub456',
  }

  it('produces full HTML document', () => {
    const html = subscribeVerificationTemplate(baseOpts)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('</html>')
  })

  it('contains project name', () => {
    expect(subscribeVerificationTemplate(baseOpts)).toContain('Acme Changelog')
  })

  it('contains verify URL', () => {
    expect(subscribeVerificationTemplate(baseOpts)).toContain('https://example.com/verify-sub?token=sub123')
  })

  it('contains unsubscribe link', () => {
    const html = subscribeVerificationTemplate(baseOpts)
    expect(html).toContain('https://example.com/unsub?token=unsub456')
    expect(html).toContain('Unsubscribe')
  })

  it('escapes XSS in project name', () => {
    const html = subscribeVerificationTemplate({ ...baseOpts, projectName: '<script>xss</script>' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('blocks javascript: URI in verifyUrl', () => {
    const html = subscribeVerificationTemplate({ ...baseOpts, verifyUrl: 'javascript:alert(1)' })
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="#"')
  })

  it('blocks javascript: URI in unsubscribeUrl', () => {
    const html = subscribeVerificationTemplate({ ...baseOpts, unsubscribeUrl: 'javascript:void(0)' })
    expect(html).not.toContain('javascript:')
  })

  it('renders with empty project name without throwing', () => {
    const html = subscribeVerificationTemplate({ ...baseOpts, projectName: '' })
    expect(html).toContain('<!DOCTYPE html>')
  })
})

// ─── Plain-text builders ──────────────────────────────────────────────────────

describe('changelogText', () => {
  const baseOpts = {
    to: 'user@example.com',
    entryTitle: 'Dark Mode',
    changelogUrl: 'https://example.com/changelog/1',
    unsubscribeUrl: 'https://example.com/unsub?token=abc',
  }

  it('includes title, url, and unsubscribe', () => {
    const text = changelogText(baseOpts)
    expect(text).toContain('Dark Mode')
    expect(text).toContain('https://example.com/changelog/1')
    expect(text).toContain('https://example.com/unsub?token=abc')
  })

  it('includes version and excerpt when provided', () => {
    const text = changelogText({ ...baseOpts, version: 'v2.0', excerpt: 'Big release.' })
    expect(text).toContain('v2.0')
    expect(text).toContain('Big release.')
  })

  it('strips newlines from URLs to prevent body injection', () => {
    const text = changelogText({ ...baseOpts, changelogUrl: 'https://example.com/\nBcc: evil@x.com' })
    // \n stripped → injected text merges onto the URL line instead of becoming a separate header
    expect(text).not.toContain('https://example.com/\nBcc:')
    expect(text).toContain('https://example.com/Bcc:')
  })

  it('strips newlines from title', () => {
    const text = changelogText({ ...baseOpts, entryTitle: 'Foo\r\nBar' })
    expect(text).not.toContain('Foo\r\nBar')
    expect(text).toContain('FooBar')
  })
})

describe('featureShippedText', () => {
  const baseOpts = {
    to: 'user@example.com',
    itemTitle: 'CSV Export',
    roadmapUrl: 'https://example.com/roadmap',
    unsubscribeUrl: 'https://example.com/unsub?token=xyz',
  }

  it('includes title, url, and unsubscribe', () => {
    const text = featureShippedText(baseOpts)
    expect(text).toContain('CSV Export')
    expect(text).toContain('https://example.com/roadmap')
    expect(text).toContain('Unsubscribe')
  })

  it('strips newlines from URLs', () => {
    const text = featureShippedText({ ...baseOpts, roadmapUrl: 'https://example.com/\nX-Injected: yes' })
    expect(text).not.toContain('https://example.com/\nX-Injected:')
    expect(text).toContain('https://example.com/X-Injected:')
  })
})

describe('statusUpdateText', () => {
  const baseOpts = {
    to: 'voter@example.com',
    featureTitle: 'Offline Mode',
    newStatus: 'In Progress',
    featuresUrl: 'https://example.com/features',
    unsubscribeUrl: 'https://example.com/api/v1/public/voter-unsubscribe?token=vote-tok-1',
  }

  it('includes title, status, url, and unsubscribe url', () => {
    const text = statusUpdateText(baseOpts)
    expect(text).toContain('Offline Mode')
    expect(text).toContain('In Progress')
    expect(text).toContain('https://example.com/features')
    expect(text).toContain('voter-unsubscribe')
  })

  it('strips newlines from URLs', () => {
    const text = statusUpdateText({ ...baseOpts, featuresUrl: 'https://example.com/\nX-Injected: yes' })
    expect(text).not.toContain('https://example.com/\nX-Injected:')
    expect(text).toContain('https://example.com/X-Injected:')
  })
})

describe('voteVerificationText', () => {
  const baseOpts = {
    to: 'voter@example.com',
    featureTitle: 'Multi-language Support',
    verifyUrl: 'https://example.com/verify?token=tok123',
  }

  it('includes title and verify url', () => {
    const text = voteVerificationText(baseOpts)
    expect(text).toContain('Multi-language Support')
    expect(text).toContain('https://example.com/verify?token=tok123')
  })

  it('strips newlines from verifyUrl', () => {
    const text = voteVerificationText({ ...baseOpts, verifyUrl: 'https://example.com/\nX-Header: injected' })
    expect(text).not.toContain('https://example.com/\nX-Header:')
    expect(text).toContain('https://example.com/X-Header:')
  })
})

describe('subscribeVerificationText', () => {
  const baseOpts = {
    to: 'sub@example.com',
    projectName: 'Acme',
    verifyUrl: 'https://example.com/verify-sub?token=abc',
    unsubscribeUrl: 'https://example.com/unsub?token=def',
  }

  it('includes project name, verify url, and unsubscribe url', () => {
    const text = subscribeVerificationText(baseOpts)
    expect(text).toContain('Acme')
    expect(text).toContain('https://example.com/verify-sub?token=abc')
    expect(text).toContain('https://example.com/unsub?token=def')
  })

  it('strips newlines from URLs', () => {
    const text = subscribeVerificationText({ ...baseOpts, verifyUrl: 'https://example.com/\nX-Injected: yes' })
    expect(text).not.toContain('https://example.com/\nX-Injected:')
    expect(text).toContain('https://example.com/X-Injected:')
  })
})
