import crypto from 'crypto'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Collision-proof run prefix — avoids Date.now() sub-ms collision in CI watch mode (#14)
const RUN = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

function slug(label: string) {
  return `test-${RUN}-${label}`
}

// Asserts a Prisma unique-constraint violation on the expected field (#5, #6)
// Works regardless of whether meta.target is a string or array.
function expectP2002(field: string, err: unknown) {
  const e = err as any
  expect(e?.code).toBe('P2002')
  expect(JSON.stringify(e?.meta?.target ?? '')).toMatch(field)
}

// Clean up any stale test orgs left by crashed previous runs (#1)
beforeAll(async () => {
  await prisma.organization.deleteMany({ where: { slug: { startsWith: 'test-' } } })
})

afterAll(async () => {
  // Primary cleanup — cascades to most child tables via Cascade policy
  await prisma.organization.deleteMany({ where: { slug: { startsWith: 'test-' } } })

  // NotificationLog uses SetNull (not Cascade), so rows survive org deletion with null FKs.
  // Delete orphaned test rows as a safety net — only safe against a dedicated test DB. (#4)
  await prisma.notificationLog.deleteMany({ where: { subscriberId: null, changelogEntryId: null } })

  await prisma.$disconnect()
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeOrg(label: string) {
  return prisma.organization.create({ data: { name: `Test Org ${label}`, slug: slug(label) } })
}

async function makeUser(orgId: string, email: string) {
  return prisma.user.create({ data: { orgId, email, name: 'Test User' } })
}

async function makeProject(orgId: string, label: string) {
  return prisma.project.create({ data: { orgId, name: `Project ${label}`, slug: slug(`proj-${label}`) } })
}

async function makeFeatureRequest(projectId: string) {
  return prisma.featureRequest.create({ data: { projectId, title: 'Test Feature' } })
}

// ─── Core chain creation ───────────────────────────────────────────────────────

describe('Core chain creation', () => {
  it('creates Org → User → Project successfully', async () => {
    const org = await makeOrg('chain')
    const user = await makeUser(org.id, 'user@chain.test')
    const project = await makeProject(org.id, 'chain')

    expect(org.id).toBeTruthy()
    expect(user.orgId).toBe(org.id)
    expect(project.orgId).toBe(org.id)
  })

  it('auto-generates a UUID widgetKey on Project', async () => {
    const org = await makeOrg('wk')
    const project = await makeProject(org.id, 'wk')

    expect(project.widgetKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  })
})

// ─── Unique constraints ────────────────────────────────────────────────────────

describe('Unique constraints', () => {
  it('rejects duplicate org slug', async () => {
    await prisma.organization.create({ data: { name: 'Dup Org', slug: slug('duporg') } })
    const err = await prisma.organization
      .create({ data: { name: 'Dup Org 2', slug: slug('duporg') } })
      .catch((e: unknown) => e)
    expectP2002('slug', err)
  })

  it('rejects duplicate user email within same org', async () => {
    const org = await makeOrg('dupemail')
    await makeUser(org.id, 'dup@same.test')
    const err = await makeUser(org.id, 'dup@same.test').catch((e: unknown) => e)
    expectP2002('email', err)
  })

  it('allows same email in different orgs', async () => {
    const orgA = await makeOrg('emailorgA')
    const orgB = await makeOrg('emailorgB')
    const userA = await makeUser(orgA.id, 'shared@orgs.test')
    const userB = await makeUser(orgB.id, 'shared@orgs.test')
    expect(userA.id).not.toBe(userB.id)
  })

  it('rejects duplicate project slug within same org', async () => {
    const org = await makeOrg('dupslug')
    await prisma.project.create({ data: { orgId: org.id, name: 'P1', slug: slug('dupslug-p') } })
    const err = await prisma.project
      .create({ data: { orgId: org.id, name: 'P2', slug: slug('dupslug-p') } })
      .catch((e: unknown) => e)
    expectP2002('slug', err)
  })

  it('allows same project slug in different orgs', async () => {
    const orgA = await makeOrg('pslugA')
    const orgB = await makeOrg('pslugB')
    const sharedSlug = slug('shared-p')
    const pA = await prisma.project.create({ data: { orgId: orgA.id, name: 'P', slug: sharedSlug } })
    const pB = await prisma.project.create({ data: { orgId: orgB.id, name: 'P', slug: sharedSlug } })
    expect(pA.id).not.toBe(pB.id)
  })

  it('rejects a second vote from same email on same feature', async () => {
    const org = await makeOrg('vote')
    const project = await makeProject(org.id, 'vote')
    const feature = await makeFeatureRequest(project.id)
    await prisma.vote.create({
      data: { featureRequestId: feature.id, voterEmail: 'voter@test.test', verificationToken: `${RUN}-v1` },
    })
    const err = await prisma.vote
      .create({
        data: { featureRequestId: feature.id, voterEmail: 'voter@test.test', verificationToken: `${RUN}-v2` },
      })
      .catch((e: unknown) => e)
    expectP2002('voterEmail', err)
  })

  it('allows same email to vote on different features', async () => {
    const org = await makeOrg('vote2')
    const project = await makeProject(org.id, 'vote2')
    const f1 = await makeFeatureRequest(project.id)
    const f2 = await makeFeatureRequest(project.id)
    const v1 = await prisma.vote.create({
      data: { featureRequestId: f1.id, voterEmail: 'multi@test.test', verificationToken: `${RUN}-mv1` },
    })
    const v2 = await prisma.vote.create({
      data: { featureRequestId: f2.id, voterEmail: 'multi@test.test', verificationToken: `${RUN}-mv2` },
    })
    expect(v1.id).not.toBe(v2.id)
  })

  it('rejects duplicate Vote.verificationToken', async () => {
    const org = await makeOrg('vtok')
    const project = await makeProject(org.id, 'vtok')
    const feature = await makeFeatureRequest(project.id)
    const token = `${RUN}-vtok-shared`
    await prisma.vote.create({
      data: { featureRequestId: feature.id, voterEmail: 'vtok1@test.test', verificationToken: token },
    })
    const err = await prisma.vote
      .create({
        data: { featureRequestId: feature.id, voterEmail: 'vtok2@test.test', verificationToken: token },
      })
      .catch((e: unknown) => e)
    expectP2002('verificationToken', err)
  })

  it('rejects duplicate subscriber email per project', async () => {
    const org = await makeOrg('sub')
    const project = await makeProject(org.id, 'sub')
    await prisma.subscriber.create({
      data: { projectId: project.id, email: 'sub@test.test', verificationToken: `${RUN}-s1` },
    })
    const err = await prisma.subscriber
      .create({
        data: { projectId: project.id, email: 'sub@test.test', verificationToken: `${RUN}-s2` },
      })
      .catch((e: unknown) => e)
    expectP2002('email', err)
  })

  it('rejects duplicate Subscriber.verificationToken', async () => {
    const org = await makeOrg('stok')
    const project = await makeProject(org.id, 'stok')
    const token = `${RUN}-stok-shared`
    await prisma.subscriber.create({
      data: { projectId: project.id, email: 'stok1@test.test', verificationToken: token },
    })
    const err = await prisma.subscriber
      .create({
        data: { projectId: project.id, email: 'stok2@test.test', verificationToken: token },
      })
      .catch((e: unknown) => e)
    expectP2002('verificationToken', err)
  })

  it('rejects duplicate ChangelogCategory slug within same project', async () => {
    const org = await makeOrg('catslug')
    const project = await makeProject(org.id, 'catslug')
    await prisma.changelogCategory.create({
      data: { projectId: project.id, name: 'Cat A', slug: slug('cat'), color: '#000' },
    })
    const err = await prisma.changelogCategory
      .create({ data: { projectId: project.id, name: 'Cat B', slug: slug('cat'), color: '#111' } })
      .catch((e: unknown) => e)
    expectP2002('slug', err)
  })

  it('allows same ChangelogCategory slug in different projects', async () => {
    const org = await makeOrg('catslug2')
    const pA = await makeProject(org.id, 'catslug2A')
    const pB = await makeProject(org.id, 'catslug2B')
    const sharedSlug = slug('shared-cat')
    const cA = await prisma.changelogCategory.create({
      data: { projectId: pA.id, name: 'Cat', slug: sharedSlug, color: '#000' },
    })
    const cB = await prisma.changelogCategory.create({
      data: { projectId: pB.id, name: 'Cat', slug: sharedSlug, color: '#000' },
    })
    expect(cA.id).not.toBe(cB.id)
  })

  it('rejects duplicate HelpArticle slug within same project', async () => {
    const org = await makeOrg('haslug')
    const project = await makeProject(org.id, 'haslug')
    await prisma.helpArticle.create({
      data: { projectId: project.id, title: 'A1', slug: slug('ha'), content: {} },
    })
    const err = await prisma.helpArticle
      .create({ data: { projectId: project.id, title: 'A2', slug: slug('ha'), content: {} } })
      .catch((e: unknown) => e)
    expectP2002('slug', err)
  })

  it('allows same HelpArticle slug in different projects', async () => {
    const org = await makeOrg('haslug2')
    const pA = await makeProject(org.id, 'haslug2A')
    const pB = await makeProject(org.id, 'haslug2B')
    const sharedSlug = slug('shared-ha')
    const aA = await prisma.helpArticle.create({
      data: { projectId: pA.id, title: 'A', slug: sharedSlug, content: {} },
    })
    const aB = await prisma.helpArticle.create({
      data: { projectId: pB.id, title: 'A', slug: sharedSlug, content: {} },
    })
    expect(aA.id).not.toBe(aB.id)
  })

  it('rejects duplicate Invitation token', async () => {
    const org = await makeOrg('invtok')
    const token = `${RUN}-inv-shared`
    await prisma.invitation.create({
      data: { orgId: org.id, email: 'inv1@test.test', role: 'editor', token, expiresAt: new Date(Date.now() + 86400000) },
    })
    const err = await prisma.invitation
      .create({
        data: { orgId: org.id, email: 'inv2@test.test', role: 'editor', token, expiresAt: new Date(Date.now() + 86400000) },
      })
      .catch((e: unknown) => e)
    expectP2002('token', err)
  })
})

// ─── Cascade deletes ───────────────────────────────────────────────────────────

describe('Cascade deletes', () => {
  it('deleting an Org cascades to its Users and Projects', async () => {
    const org = await makeOrg('cascade-org')
    const user = await makeUser(org.id, 'u@cascade.test')
    const project = await makeProject(org.id, 'cascade-org')

    await prisma.organization.delete({ where: { id: org.id } })

    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull()
    expect(await prisma.project.findUnique({ where: { id: project.id } })).toBeNull()
  })

  it('deleting an Org cascades to Invitations', async () => {
    const org = await makeOrg('cascade-inv')
    const inv = await prisma.invitation.create({
      data: {
        orgId: org.id,
        email: 'inv@cascade.test',
        role: 'editor',
        token: `${RUN}-casc-inv`,
        expiresAt: new Date(Date.now() + 86400000),
      },
    })

    await prisma.organization.delete({ where: { id: org.id } })

    expect(await prisma.invitation.findUnique({ where: { id: inv.id } })).toBeNull()
  })

  it('deleting a Project cascades to ChangelogEntry, RoadmapItem, FeatureRequest, Subscriber, AnalyticsEvent', async () => {
    const org = await makeOrg('cascade-proj')
    const project = await makeProject(org.id, 'cascade-proj')

    const [entry, item, feature, subscriber, event] = await Promise.all([
      prisma.changelogEntry.create({ data: { projectId: project.id, title: 'Entry', content: {} } }),
      prisma.roadmapItem.create({ data: { projectId: project.id, title: 'Item' } }),
      makeFeatureRequest(project.id),
      prisma.subscriber.create({ data: { projectId: project.id, email: 'c@cascade.test', verificationToken: `${RUN}-cs` } }),
      prisma.analyticsEvent.create({ data: { projectId: project.id, type: 'widget_view' } }),
    ])

    await prisma.project.delete({ where: { id: project.id } })

    const [e, i, f, s, a] = await Promise.all([
      prisma.changelogEntry.findUnique({ where: { id: entry.id } }),
      prisma.roadmapItem.findUnique({ where: { id: item.id } }),
      prisma.featureRequest.findUnique({ where: { id: feature.id } }),
      prisma.subscriber.findUnique({ where: { id: subscriber.id } }),
      prisma.analyticsEvent.findUnique({ where: { id: event.id } }),
    ])

    expect(e).toBeNull()
    expect(i).toBeNull()
    expect(f).toBeNull()
    expect(s).toBeNull()
    expect(a).toBeNull()
  })

  it('deleting a Project cascades to ChangelogCategory', async () => {
    const org = await makeOrg('cascade-cat')
    const project = await makeProject(org.id, 'cascade-cat')
    const cat = await prisma.changelogCategory.create({
      data: { projectId: project.id, name: 'Cat', slug: slug('casc-cat'), color: '#000' },
    })

    await prisma.project.delete({ where: { id: project.id } })

    expect(await prisma.changelogCategory.findUnique({ where: { id: cat.id } })).toBeNull()
  })
})

// ─── SetNull behaviors ─────────────────────────────────────────────────────────

describe('SetNull behaviors', () => {
  it('sets ChangelogEntry.authorId to null when author User is deleted', async () => {
    const org = await makeOrg('nullauthor')
    const user = await makeUser(org.id, 'author@null.test')
    const project = await makeProject(org.id, 'nullauthor')
    const entry = await prisma.changelogEntry.create({
      data: { projectId: project.id, title: 'With Author', content: {}, authorId: user.id },
    })

    await prisma.user.delete({ where: { id: user.id } })

    const updated = await prisma.changelogEntry.findUnique({ where: { id: entry.id } })
    if (!updated) throw new Error('ChangelogEntry was unexpectedly deleted when its author was removed') // (#13)
    expect(updated.authorId).toBeNull()
  })

  it('sets HelpArticle.authorId to null when author User is deleted', async () => {
    const org = await makeOrg('nullauthor2')
    const user = await makeUser(org.id, 'author2@null.test')
    const project = await makeProject(org.id, 'nullauthor2')
    const article = await prisma.helpArticle.create({
      data: { projectId: project.id, title: 'Article', slug: slug('ha-null'), content: {}, authorId: user.id },
    })

    await prisma.user.delete({ where: { id: user.id } })

    const updated = await prisma.helpArticle.findUnique({ where: { id: article.id } })
    if (!updated) throw new Error('HelpArticle was unexpectedly deleted when its author was removed') // (#13)
    expect(updated.authorId).toBeNull()
  })

  it('sets RoadmapItem.createdBy to null when creator User is deleted', async () => {
    const org = await makeOrg('nullcreator-rm')
    const user = await makeUser(org.id, 'rm-creator@null.test')
    const project = await makeProject(org.id, 'nullcreator-rm')
    const item = await prisma.roadmapItem.create({
      data: { projectId: project.id, title: 'Item', createdBy: user.id },
    })

    await prisma.user.delete({ where: { id: user.id } })

    const updated = await prisma.roadmapItem.findUnique({ where: { id: item.id } })
    if (!updated) throw new Error('RoadmapItem was unexpectedly deleted when its creator was removed')
    expect(updated.createdBy).toBeNull()
  })

  it('sets Survey.createdBy to null when creator User is deleted', async () => {
    const org = await makeOrg('nullcreator-sv')
    const user = await makeUser(org.id, 'sv-creator@null.test')
    const project = await makeProject(org.id, 'nullcreator-sv')
    const survey = await prisma.survey.create({
      data: { projectId: project.id, title: 'Survey', createdBy: user.id },
    })

    await prisma.user.delete({ where: { id: user.id } })

    const updated = await prisma.survey.findUnique({ where: { id: survey.id } })
    if (!updated) throw new Error('Survey was unexpectedly deleted when its creator was removed')
    expect(updated.createdBy).toBeNull()
  })

  it('sets ChangelogEntry.categoryId to null when ChangelogCategory is deleted', async () => {
    const org = await makeOrg('nullcat')
    const project = await makeProject(org.id, 'nullcat')
    const cat = await prisma.changelogCategory.create({
      data: { projectId: project.id, name: 'Cat', slug: slug('nullcat-c'), color: '#000' },
    })
    const entry = await prisma.changelogEntry.create({
      data: { projectId: project.id, title: 'With Cat', content: {}, categoryId: cat.id },
    })

    await prisma.changelogCategory.delete({ where: { id: cat.id } })

    const updated = await prisma.changelogEntry.findUnique({ where: { id: entry.id } })
    if (!updated) throw new Error('ChangelogEntry was unexpectedly deleted when its category was removed')
    expect(updated.categoryId).toBeNull()
  })

  it('orphans NotificationLog row (sets subscriberId to null) when linked Subscriber is cascade-deleted', async () => {
    const org = await makeOrg('notiflog')
    const project = await makeProject(org.id, 'notiflog')
    const subscriber = await prisma.subscriber.create({
      data: { projectId: project.id, email: 'notif@test.test', verificationToken: `${RUN}-nl` },
    })
    const log = await prisma.notificationLog.create({
      data: { subscriberId: subscriber.id, type: 'subscribe_verification' },
    })

    await prisma.project.delete({ where: { id: project.id } })

    const orphaned = await prisma.notificationLog.findUnique({ where: { id: log.id } })
    if (!orphaned) throw new Error('NotificationLog was unexpectedly deleted instead of being orphaned')
    expect(orphaned.subscriberId).toBeNull()

    // Explicit cleanup — this row has no org link and cannot be caught by the afterAll cascade (#4)
    await prisma.notificationLog.delete({ where: { id: log.id } })
  })
})
