# LaunchLog — MVP Testing Guide

> Goal: every feature in the MVP exercised end-to-end, with happy paths, edge cases, error paths, abuse paths, and multi-actor scenarios.

For what each feature does, see [`FEATURES.md`](./FEATURES.md). For local setup, see [`RUNNING.md`](./RUNNING.md).

---

## How to use this guide

Each section follows the same template:

> **Preconditions** • **Steps** • **Expected** • **How to verify** (browser, DB query, log line, Redis key, Resend dashboard, etc.) • **Automated coverage** • **Cleanup**

Manual scenarios verify user-visible behavior. Automated coverage points at existing Jest tests so you can run `npm test -- <pattern>` instead of clicking through. Both are listed because they catch different bugs:

- Manual catches: layout regressions, real Stripe/Resend integration breaks, browser-specific bugs, copy/clipboard, accessibility.
- Jest catches: branch coverage, race conditions, Zod schema regressions, edge-case math.

### Setup before running anything

Have all four terminals from `RUNNING.md` §7 running. For full coverage you also need Stripe, Resend, R2, and Google OAuth configured. Without those, skip §10 (billing), §12 (email integration parts that need real emails), parts of §5 (image upload), and §2.3 (Google OAuth).

### Test data helpers

Two reusable test users will be referenced throughout:

| Role | Email | Password | Org |
|---|---|---|---|
| Owner A (primary tester) | `owner.a@test.local` | `TestPass123` | "Acme Inc" → slug `acme-inc` |
| Owner B (cross-tenant tests) | `owner.b@test.local` | `TestPass123` | "Other Inc" → slug `other-inc` |

Quick reset:

```bash
npx prisma migrate reset --schema backend/prisma/schema.prisma
```

Open Prisma Studio for inspection: `npx prisma studio --schema backend/prisma/schema.prisma`.

### Running the entire automated suite

```bash
npm test                       # all workspaces
npm test -w backend            # backend only (Jest, Prisma against test DB)
npm test -w web                # web only (Jest + jsdom)
npm test -w widget             # widget only
```

Backend tests use a real Postgres connection — they assume the docker DB is running.

---

## 1. Smoke

### 1.1 Health endpoint

- **Steps**: `curl http://localhost:3001/health`
- **Expected**: `{"status":"ok","timestamp":"..."}`, HTTP 200
- **Automated**: `backend/src/__tests__/health.test.ts` → `npm test -w backend -- health`

### 1.2 Frontend reachable

- **Steps**: open `http://localhost:3000`
- **Expected**: redirects to `/login` (no project / no session)

### 1.3 Plugin/middleware loaded

- **Automated**: `backend/src/__tests__/plugins.test.ts` → `npm test -w backend -- plugins` — confirms helmet, cors, rate-limit, prisma, redis, queue, cookie, passport, jwt, multipart all register without throwing.

### 1.4 Schema integrity

- **Automated**: `backend/src/__tests__/schema.test.ts` → `npm test -w backend -- schema`

---

## 2. Authentication

### 2.1 Email/password registration

#### Happy path
- **Preconditions**: clean DB.
- **Steps**: `/login` → toggle "Register" → fill org name `Acme Inc`, name `Owner A`, email `owner.a@test.local`, password `TestPass123` → Submit.
- **Expected**: HTTP 201, browser receives `access_token` + `refresh_token` cookies (httpOnly, sameSite=lax), redirected to `/onboarding`.
- **How to verify**:
  - DevTools → Application → Cookies: both cookies present, both `HttpOnly`, both `SameSite=Lax`.
  - DB: `SELECT id, plan FROM organizations` shows one row with `plan='free'`. `SELECT email, role FROM users` shows `owner.a@test.local` with role `owner`. `SELECT id FROM projects WHERE org_id=...` shows zero (no project yet).
  - Redis: `KEYS refresh:*` returns one key.
- **Cleanup**: keep this user — used in subsequent sections.

#### Edge cases (manual rerun for each)
| Input | Expected |
|---|---|
| Same email a second time | 409 "Email already registered" |
| Same org name | succeeds — slug auto-suffixed with random hex |
| `password` < 8 chars | 422 "Password must be at least 8 characters" |
| `email` not a real email | 422 "Invalid email address" |
| `orgName` 1 char | 422 "Organisation name must be at least 2 characters" |

- **Automated**: `backend/src/__tests__/auth.test.ts` → `npm test -w backend -- auth.test`

### 2.2 Email/password login

#### Happy path
- **Steps**: log out (from any admin page), `/login`, enter `owner.a@test.local` + `TestPass123`.
- **Expected**: 200, cookies set, redirected to `/dashboard`.
- **How to verify**: `Set-Cookie` headers on the `/api/v1/auth/login` response in Network tab.

#### Edge cases
| Input | Expected | Notes |
|---|---|---|
| Wrong password | 401 "Invalid credentials" | Response time should be similar to happy-path login (constant-time bcrypt) |
| Unknown email | 401 "Invalid credentials" | Same response as wrong password — no enumeration |
| `password` longer than 1024 chars | 422 | Defends against bcrypt CPU exhaustion |
| 11 wrong logins from same IP within a minute | 429 on the 11th | Rate limit caps at 10/min in dev |
| `email` field with `\r\n` injection | 422 (Zod email format) | |

- **Automated**: `backend/src/__tests__/auth.test.ts` (login suite)

### 2.3 Google OAuth

> Skip this section if Google OAuth env vars are not set. Backend returns 503 from `/auth/google` in that case.

#### Happy path
- **Preconditions**: Google client configured per `RUNNING.md` §3.1.
- **Steps**: `/login` → "Sign in with Google" → consent at Google → returns to `${FRONTEND_URL}/dashboard`.
- **Expected**: cookies set, dashboard renders.
- **How to verify**: `users` row created with `googleId` set and `passwordHash` null.

#### Edge cases
| Action | Expected |
|---|---|
| Cancel at Google's consent screen | redirect to `/login?error=oauth` |
| Pre-existing Google account, sign in again | same `users` row, no duplicate |
| Pre-existing email-password account, sign in via Google with the same email | new account is created in a new org (MVP doesn't auto-link Google to existing email accounts — confirm by inspecting `googleId` column) |

- **Automated**: `backend/src/__tests__/auth-google.test.ts` → `npm test -w backend -- auth-google`

### 2.4 Token refresh

#### Happy path (silent refresh)
- **Steps**: log in → DevTools → delete only `access_token` cookie (keep `refresh_token`) → reload `/dashboard`.
- **Expected**: page renders normally, new `access_token` cookie issued.
- **How to verify**: Network tab shows the Next.js middleware fires `POST /api/v1/auth/refresh` and the response has `Set-Cookie: access_token=...`.
- **Automated**: `web/src/__tests__/middleware.test.ts` → `npm test -w web -- middleware`

#### Edge cases
| Action | Expected |
|---|---|
| Delete both cookies, visit `/dashboard` | redirect to `/login` |
| Tamper with refresh token (change a char) | redirect to `/login` (signature fails) |
| Refresh token expires in DB but not in cookie (delete the Redis `refresh:*` key) | redirect to `/login` (Redis check fails) |
| Manually expire access token (wait 16 minutes or set `JWT_ACCESS_EXPIRES_IN=10s` and wait 11s) | silently refreshed |

### 2.5 Logout

- **Steps**: from dashboard, trigger logout → confirm both cookies cleared.
- **Expected**: `/dashboard` now redirects to `/login`.
- **How to verify**: Redis `GET refresh:<userId>` returns nil after logout.

### 2.6 Authenticated middleware

- **Automated**: `backend/src/__tests__/auth-middleware.test.ts` → `npm test -w backend -- auth-middleware`. Manual: hit any `/api/v1/projects` endpoint without cookies → 401 "Unauthorized"; with a tampered access token → 401 "Unauthorized" (no information leak).

---

## 3. Organization & onboarding

### 3.1 First-run redirect to onboarding

- **Steps**: register fresh, complete registration, then **without** completing onboarding, navigate manually to `/dashboard`.
- **Expected**: redirected to `/onboarding` (because `projectCount === 0`).
- **Automated**: `web/src/__tests__/OnboardingWizard.test.tsx` → `npm test -w web -- OnboardingWizard`

### 3.2 Onboarding wizard creates first project

- **Steps**: in `/onboarding`, complete the wizard (project name + slug).
- **Expected**: redirect to `/dashboard`. Project appears under `/dashboard/projects`.
- **How to verify**: DB `projects` has one row with `widgetKey` set.

### 3.3 Update org settings

- **Steps**: hit `PATCH /api/v1/org` with `{ "name": "Acme Inc 2", "slug": "acme-2" }`.
- **Expected**: 200, public URL changes from `/acme-inc/...` to `/acme-2/...`.
- **Edge cases**:
  - Updating slug to one already taken in another org → 409.
  - Updating logoUrl to an `http://` URL → 422 "logoUrl must use HTTPS".
  - Updating logoUrl to an HTTPS URL not on `R2_PUBLIC_URL` → 422 (when R2 configured).
  - Editor (non-owner) attempts patch → 403.
- **Automated**: `backend/src/__tests__/org.test.ts` → `npm test -w backend -- org`

---

## 4. Projects

### 4.1 Create project

#### Happy path (Free tier)
- **Steps**: `/dashboard/projects` → "New project" → name `Test Product` → Submit.
- **Expected**: 201, project appears in list with auto-generated slug `test-product`, `widgetKey` UUID assigned.

#### Plan-limit edge cases
| Setup | Action | Expected |
|---|---|---|
| Free, already has 1 project | Create 2nd | 403 `{"error":"PLAN_LIMIT_REACHED","resource":"projects"}` (admin UI shows upgrade prompt) |
| Starter, has 3 projects | Create 4th | 403 same shape |
| Pro, has 50 projects | Create 51st | succeeds |
| Free, two concurrent create requests racing the limit | Both submitted simultaneously | one succeeds (201), the other gets 403 (planLimitCheck) or 409 "Request conflicted, please retry" (serializable transaction abort, P2034) |

To force the racing case, run two `curl` commands with the same cookies in `&`-backgrounded shells.

- **Automated**: `backend/src/__tests__/projects.test.ts`, `backend/src/__tests__/planLimit.middleware.test.ts`, `backend/src/__tests__/planLimits.test.ts` → `npm test -w backend -- projects planLimit`

#### Slug edge cases
| Input | Expected |
|---|---|
| `slug = "Test Product"` (uppercase + space) | 422 (regex requires lowercase alphanumeric + hyphens) |
| `slug = "-test"` | 422 (no leading hyphen) |
| Auto-gen collides 5 times in a row | 409 "Could not generate a unique slug" |

### 4.2 Read project

- **Steps**: open project detail. Confirm `widgetKey` is shown on settings page.
- **Cross-tenant**: as Owner B, hit `GET /api/v1/projects/<owner-A's project id>` → 404. **Critical**: must be 404 not 403 (no information leak about existence).

### 4.3 Update project

- **Steps**: change name, save → reflected. Change slug → public URL changes.
- **Edge cases**: `widgetSettings` with all three tabs disabled → 422 "At least one tab must be enabled". Unknown key in `widgetSettings` → 422 (`.strict()` Zod). Color not 6-digit hex → 422.

### 4.4 Delete project

- **Steps**: delete a project that has changelog entries, roadmap items, features, votes.
- **Expected**: 204, all child rows removed (cascade).
- **How to verify**: Prisma Studio — `changelog_entries WHERE project_id=...` returns 0.
- **Cross-tenant**: deleting another org's project ID → 404.

---

## 5. Changelog

### 5.1 Create draft

- **Steps**: project detail → Changelog → "New entry". TipTap editor with title `Release v0.1`, content "First release", optional version `v0.1.0`.
- **Save**: stays as `status='draft'`. Visible only in admin list.

### 5.2 Publish + notification email

#### Happy path
- **Preconditions**: have ≥ 1 verified subscriber (see §8.5).
- **Steps**: open the draft → Publish.
- **Expected**:
  - 200, list now shows `published`, `publishedAt` set.
  - Public page (`/orgSlug/projectSlug`) shows the entry.
  - Within seconds, all verified non-unsubscribed subscribers receive an email with subject `New update: Release v0.1`.
- **How to verify**:
  - Resend dashboard → "Emails" tab → see the deliveries.
  - DB: `SELECT * FROM notification_logs WHERE type='changelog_published'` has one row per recipient.
  - BullMQ: `redis-cli -a launchlog LRANGE bull:email-notifications:completed 0 -1` shows the job.

#### Edge cases
| Action | Expected |
|---|---|
| Publish, then unpublish, then publish again | Subscribers do **not** get a duplicate email (notificationLog dedup). One row in `notification_logs` per (subscriber, entry) |
| Publish with zero verified subscribers | Job runs, returns immediately, no emails |
| Publish while Redis is down | Backend returns 500 (await failed) — entry stays in draft state. After Redis recovers, retry the publish manually |
| Publish with `RESEND_API_KEY` unset | Worker logs `email send failed`, BullMQ retries 3× with exponential backoff, then dead-letters. Confirm in `redis-cli -a launchlog LRANGE bull:email-notifications:failed 0 -1` |
| Publish entry with version `null` | Email subject still works; version line in body is suppressed |
| Publish entry with very long content | Email excerpt is truncated to ~200 chars at code-point boundaries (no broken emoji) |

- **Automated**: `backend/src/__tests__/changelog.test.ts` (publish/unpublish), `backend/src/__tests__/notificationWorker.test.ts` (dedup, retry), `backend/src/__tests__/emailService.test.ts`, `backend/src/__tests__/emailTemplates.test.ts` → `npm test -w backend -- changelog notificationWorker emailService emailTemplates`

### 5.3 Edit published entry

- **Steps**: edit a published entry, change title.
- **Expected**: changes saved. **No new notification email** is sent (only first-publish triggers the job).

### 5.4 Unpublish

- **Steps**: unpublish a published entry.
- **Expected**: status flips to `draft`, `publishedAt = null`. Entry no longer on public page.

### 5.5 TipTap rich text

For each formatting feature, save and then verify it round-trips via `RichTextViewer` on the public page:

| Feature | Manual check |
|---|---|
| Bold, italic, underline | Marks render |
| Headings (H1, H2, H3) | Render with correct sizes |
| Bullet & ordered lists | Render with bullets/numbers |
| Code blocks | Monospace, no syntax highlighting (intentional for MVP) |
| Inline links | `<a href="...">` with target attributes |
| Inline images | Image renders from R2 public URL |
| Paste `<script>alert(1)</script>` into the editor | Plain text is captured; no script tag is stored |

- **Automated**: `web/src/__tests__/RichTextEditor.test.tsx`

### 5.6 Image upload to R2

- **Preconditions**: R2 vars configured.
- **Steps**: in the TipTap editor, drop or paste an image (`.jpg`, `.png`, `.gif`, or `.webp`).
- **Expected**: presigned URL fetched, image uploaded directly to R2, public URL embedded into the doc.
- **How to verify**: Network tab shows `POST /api/v1/projects/.../changelog/image-upload-url` then a `PUT https://<account>.r2.cloudflarestorage.com/...`. R2 dashboard shows the new object under `projects/<id>/images/<timestamp>.<ext>`.
- **Edge cases**:
  - Upload a `.svg` (not on allowlist) → 422 "Allowed types: image/jpeg, image/png, image/gif, image/webp".
  - Upload over the multipart size limit → 413 (configured in `plugins/multipart.ts`).
  - R2 returns 403 because of CORS → image fails silently in editor; check Network tab.

### 5.7 Delete entry

- **Steps**: delete a published entry.
- **Expected**: 204, gone from admin list and public page.

### 5.8 List ordering

- **Steps**: create 3 entries — drafts and published with different `publishedAt` values.
- **Expected**: list ordered by `publishedAt DESC NULLS LAST, createdAt DESC`. Drafts appear after all published entries.

---

## 6. Roadmap

### 6.1 Create item in each column

- **Steps**: roadmap → New item. Status `planned`, `in_progress`, `shipped` (one of each).
- **Expected**: cards appear in correct columns. `displayOrder` assigned in creation order.

### 6.2 Drag within a column

- **Steps**: drag the second card above the first within "Planned".
- **Expected**: order persists across reload. Backend logs `PATCH /roadmap/reorder`. DB `display_order` updated.
- **Automated**: `web/src/__tests__/RoadmapClient.test.tsx`, `backend/src/__tests__/roadmap.test.ts` → `npm test -w web -- RoadmapClient`, `npm test -w backend -- roadmap`

### 6.3 Drag across columns (status change)

- **Steps**: drag a "Planned" card to "In Progress".
- **Expected**: status updates. Public roadmap reflects.

### 6.4 Status to "Shipped" → notification

- **Preconditions**: ≥ 1 verified subscriber.
- **Steps**: drag a card to "Shipped", or use the dropdown.
- **Expected**:
  - Status updates.
  - All verified non-unsubscribed subscribers receive `Shipped: <title>` email.
  - `notification_logs` rows of type `feature_shipped` for each recipient.
- **Edge cases**:
  - Move to Shipped, then back to In Progress, then to Shipped again → no duplicate email (dedup keyed on `(type, referenceId, subscriberId)`).
  - Move from In Progress to In Progress (no change) — no email (the trigger fires only on transition).

### 6.5 Status dropdown matches DnD

- Keyboard-only test: tab to a card, open the dropdown, change status. Outcome must match drag behavior.

### 6.6 Public roadmap (read-only)

- Public page Roadmap tab shows all items grouped by status, ordered by `displayOrder`.

### 6.7 Delete item

- **Steps**: delete a card.
- **Expected**: 204, gone.
- **Cross-tenant**: delete a card with another project's projectId in URL → 404.

---

## 7. Feature requests & voting

### 7.1 Admin create feature

- **Steps**: admin Features tab → New → fill title and description.
- **Expected**: 201, vote count starts at 0, status `open`.

### 7.2 Admin update feature status → notify voters

- **Preconditions**: feature has 2 verified voters with `notifyOnStatusChange=true`.
- **Steps**: change status from `open` to `planned`.
- **Expected**:
  - 200.
  - Each voter receives email subject `Update on "<title>"` with new-status badge.
  - `notification_logs` has rows with `type='status_changed'` and `referenceId='<voteId>:<newStatus>'`.
- **Edge cases**:
  - Change status to the same value → no email (status didn't change).
  - Toggle status open → planned → open → planned within seconds → only first transition emails (deterministic `jobId=fsc:<featureId>:<status>` dedups in BullMQ).
  - Voter set `notifyOnStatusChange=false` (via voter-unsubscribe) → not emailed.

### 7.3 Public submit a feature

- **Steps**: public page → Features tab → "Submit a feature" → email + title + description.
- **Expected**:
  - 201, feature appears as `open` with vote count 0 (the implicit vote is unverified).
  - Submitter receives `Verify your vote for: <title>` email.
- **Edge cases**:
  - Missing email → 400.
  - `email` with uppercase → stored lowercase.

### 7.4 Public upvote with verification

- **Steps**: another user with a different email upvotes an existing feature.
- **Expected**:
  - 200 `{ message: 'Verification email sent' }`.
  - Vote row created with `verified=false`, `voteCount` unchanged until verification.
  - Email arrives.
- **Click verification link**: voteCount increments by 1, vote `verified=true`.

### 7.5 Vote dedup

| Scenario | Expected |
|---|---|
| Same email votes for same feature twice (already verified) | 409 "You have already voted for this feature." |
| Same email votes again before verifying first vote | 409 "A verification email has already been sent. Please check your inbox." |
| Same email votes for a different feature | succeeds |
| Different email votes for the same feature | succeeds |

- **Automated**: `backend/src/__tests__/public-features.test.ts` → `npm test -w backend -- public-features`

### 7.6 Vote rate limits

| Setup | Action | Expected |
|---|---|---|
| 4 votes from same IP in 1 hour | 6th submit | 429 (per-IP `PUBLIC_RATE_LIMIT=5/hour`) |
| 4 votes from same email (rotating IPs) in 1 hour | 4th submit | 429 (per-email Redis counter, 3/hour) — note: this is independent of IP |
| Redis is down | 1st submit | succeeds (per-email check fails open) |

To exercise the per-email check without rotating IPs, hit the endpoint via `curl` from the same host (Redis still keys on email-hash regardless).

### 7.7 Verify with bad token

| Token | Expected |
|---|---|
| Random UUID not in DB | 400 "Invalid or expired token" |
| Token from a vote created > 48h ago | 400 "Invalid or expired token" — the unverified vote is also deleted so user can re-vote |
| Empty/missing token | 400 "Token is required" |
| Same valid token clicked twice | 200 "Already verified" (no double-increment) |

### 7.8 Voter unsubscribe (per-feature)

- **Steps**: from a status-change email, click the "Unsubscribe" link.
- **Expected**: 200 `{ unsubscribed: true }`. Future status changes for that feature do not email this voter. Project-level subscription is unaffected.
- **Idempotency**: clicking again returns the same payload, no error.

### 7.9 Public list ordering

- Verify `/api/v1/public/<projectKey>/features` returns features ordered by `voteCount DESC`, with `closed` and `shipped` excluded.

### 7.10 Editor doesn't see submitter PII

- **Preconditions**: needs an editor user (not yet possible via UI in MVP — to test, manually flip a user's role to `editor` in DB, or skip).
- **Expected**: editor's `GET /features` response does NOT include `submitterEmail`. Owner's response does.

---

## 8. Public pages

### 8.1 SSR returns real content

- **Steps**: `curl -s http://localhost:3000/<orgSlug>/<projectSlug> | grep -i "<your changelog title>"`.
- **Expected**: the title appears in the raw HTML (not just after hydration).

### 8.2 SEO meta

- **Steps**: view source.
- **Expected**:
  - `<title>{project.name} — {org.name}</title>`
  - `<meta name="description" content="...">`
  - `<meta property="og:title" ...>` etc.
  - `<script type="application/ld+json">` with `SoftwareApplication` + `BreadcrumbList`. Confirm `<`, `>`, `&` in the JSON are unicode-escaped.

### 8.3 404 for bad slug

- **Steps**: visit `/no-such-org/no-such-project`.
- **Expected**: Next.js 404 page. `robots: noindex` in metadata.

### 8.4 Tab switching

- **Steps**: click each tab.
- **Expected**: URL updates with `?tab=changelog|roadmap|features`. Direct visit with `?tab=...` lands on that tab.

### 8.5 Subscribe flow (full)

- **Happy path**:
  1. Public page → "Subscribe" → enter `subscriber.a@test.local`.
  2. UI shows confirmation. `subscribers` row created with `verified=false`.
  3. Email arrives with subject `Confirm your subscription to <project>`. Click link.
  4. `/verify/subscribe?token=...` page confirms. DB row now `verified=true`.

- **Edge cases**:
  - Subscribe with same email twice (still unverified) → second submit re-issues a verification email.
  - Subscribe → verify → subscribe again with same email → API returns `{ status: 'already_subscribed' }`.
  - Unsubscribe → resubscribe with same email → flow completes; soft-deletion `unsubscribedAt` is cleared.

- **Automated**: `backend/src/__tests__/public-subscribe.test.ts` → `npm test -w backend -- public-subscribe`

### 8.6 Mobile responsiveness

- Chrome DevTools → device toolbar → 320 px.
- **Expected**: no horizontal scrollbar, tabs scrollable, cards stack vertically.

### 8.7 Public page renders with one endpoint failing

- **Steps**: temporarily break one of `/changelog`, `/roadmap`, `/features` (e.g., kill backend mid-render).
- **Expected**: hard error boundary catches it because the public page treats all three as critical (it `throw`s on any non-OK). The widget iframe page (§9.4) is more lenient. This asymmetry is intentional: the public page is the canonical SEO surface, while the widget is meant to degrade gracefully.

---

## 9. Embeddable widget

### 9.1 Build size guard

- **Steps**: `npm run build -w widget`.
- **Expected**: prints `[LaunchLog] widget.js: <size> bytes ✓` with `<size> ≤ 5120`. Build fails non-zero if size exceeds 5120.

### 9.2 Floating mode embed

- **Preconditions**: project's widget key copied; static test page served (see `RUNNING.md` §9).
- **Steps**: load the test page.
- **Expected**:
  - Floating button visible at bottom-right (52 px circle, indigo background, message-icon SVG).
  - Click → 400 × 600 iframe panel appears. Contains 3 tabs.
  - `Esc` → closes panel, button regains focus.
  - Click outside the button + panel → closes.
  - Button has `aria-expanded` toggling true/false; panel has `id="launchlog-panel"`, `role="region"`, `aria-label="LaunchLog"`.
- **Automated**: `widget/src/__tests__/widget.test.js` → `npm test -w widget`

### 9.3 Position variants

- For each `data-position` (`bottom-left`, `bottom-right`, `top-left`, `top-right`): button anchors at the correct corner with 24 px offset.
- Invalid `data-position` → console warns and falls back to `bottom-right`.

### 9.4 Inline mode

- **Steps**: place script tag inside a `<div>` and set `data-mode="inline"`.
- **Expected**: iframe renders in place of the script tag, no floating button.
- **Edge case**: script in `<head>` with no `defer` attribute → console warns "Widget script must be placed before </body> or loaded with defer."

### 9.5 Bad project key

- `data-key=""`, missing, too short, too long, or containing forbidden chars (`%`, `<`, etc.) → console warns, no network request fired.
- Valid format but unknown to backend → iframe loads, calls `/info`, gets 404, page shows "Not found" content (no crash).

### 9.6 Free-tier branding visible

- **Preconditions**: project's org plan = `free`.
- **Expected**: iframe footer shows "Powered by LaunchLog" link.
- **Click branding link**: opens LaunchLog homepage in new tab. Backend records `analytics_events` row with `type='powered_by_click'`.

### 9.7 Branding hidden on paid plans

- **Steps**: upgrade org to Starter (see §10) → reload widget.
- **Expected**: footer link gone.

### 9.8 Widget settings panel

- **Steps**: dashboard → project → Settings.
- **Expected**:
  - Toggle `Show Changelog`/`Show Roadmap`/`Show Features` — confirm at least one stays on (UI prevents all-off).
  - Change `primaryColor` and `backgroundColor` via picker.
  - Change `buttonPosition` via dropdown.
  - Save → settings persist. Reload widget iframe → reflects new settings.
  - Live preview iframe updates without save? — depends on implementation; verify behavior.
- **Automated**: `web/src/__tests__/WidgetSettingsClient.test.tsx`

### 9.9 Embed snippet copy

- **Steps**: in Settings → click "Copy embed snippet".
- **Expected**: clipboard contains exactly `<script src="https://widget.launchlog.app/widget.js" data-key="<this project's key>" data-mode="floating" data-position="<configured>"></script>` (or whatever the UI generates).
- **How to verify**: paste into a text editor.

### 9.10 Analytics events recorded

- **Steps**: load the embedded test page once, then click "Powered by LaunchLog".
- **Expected**:
  - `SELECT type, COUNT(*) FROM analytics_events WHERE project_id='<id>' GROUP BY type` returns at minimum `widget_impression: 1`, `powered_by_click: 1`.
- **Edge cases**:
  - Reload the test page 70 times in an hour → 60 records, then 429 from rate limit (`ANALYTICS_RATE_LIMIT=60/hour`).
  - Submit `metadata` with 11 keys → 400.
  - Submit `metadata` value > 256 chars → 400.
- **Automated**: `backend/src/__tests__/public-analytics.test.ts` → `npm test -w backend -- public-analytics`

---

## 10. Stripe billing

> Skip if Stripe not configured. All test cards from [Stripe docs](https://docs.stripe.com/testing).

### 10.1 Upgrade Free → Starter (monthly)

- **Preconditions**: `stripe listen` running per `RUNNING.md` §7. Org currently on `free`.
- **Steps**: dashboard → Billing → "Upgrade to Starter" → choose monthly → Stripe Checkout loads → use test card `4242 4242 4242 4242`, any future date, any CVC, any ZIP → submit → land back at `success_url`.
- **Expected**:
  - `stripe listen` terminal logs `checkout.session.completed` then `customer.subscription.updated` (or `.created`).
  - DB: `organizations.plan = 'starter'`, `stripeCustomerId` set, `stripeSubscriptionId` set.
  - Billing page shows "Starter" plan and `nextBillingDate`.
  - Now able to create up to 3 projects.
- **Automated**: `backend/src/__tests__/billing.test.ts` → `npm test -w backend -- billing`

### 10.2 Upgrade to Pro (annual)

- **Steps**: same flow, choose Pro + annual.
- **Expected**: plan = `pro`, project limit = `null` (unlimited).

### 10.3 Customer portal

- **Steps**: Billing → "Manage subscription" → portal opens → cancel subscription.
- **Expected**:
  - Stripe shows "Will cancel at period end".
  - In `GET /api/v1/billing` response, `nextBillingDate` is now `null` (cancel_at_period_end true).
  - At period end (use Stripe's "advance test clock" or wait), webhook fires `customer.subscription.deleted` → DB plan flips to `free`, `stripeSubscriptionId` cleared. `stripeCustomerId` retained so re-subscription works without duplicating customer.

### 10.4 Plan switch via portal

- **Steps**: portal → "Update plan" → switch from Starter to Pro.
- **Expected**: webhook `customer.subscription.updated` updates DB. Project limit changes to unlimited.

### 10.5 Card declined

- **Test card**: `4000 0000 0000 0002`.
- **Expected**: Stripe Checkout shows error, user remains on Free tier, no DB change.

### 10.6 3DS challenge

- **Test card**: `4000 0027 6000 3184`.
- **Expected**: Stripe presents 3D-Secure challenge. Successful auth → upgrade succeeds.

### 10.7 Webhook signature mismatch

- **Steps**: stop `stripe listen`. Manually `curl -X POST` the webhook endpoint with a body that has a fake `Stripe-Signature` header.
- **Expected**: 400 "Invalid signature". No DB change.

### 10.8 Concurrent checkout requests

- **Steps**: from two tabs, click "Upgrade" near-simultaneously.
- **Expected**: at most one Stripe customer is created (`updateMany WHERE stripeCustomerId IS NULL` is the dedup gate). Both Checkout sessions succeed but reuse the same customer.

### 10.9 Already-subscribed checkout

- **Steps**: while on Starter, hit `/api/v1/billing/checkout` directly.
- **Expected**: 409 "Organisation already has an active subscription". (UI hides the upgrade button in this state.)

### 10.10 Forbidden return URLs

- Submit `success_url` or `return_url` not on `FRONTEND_URL` origin → 422 "Redirect URLs must be on the application domain".

---

## 11. Plan-limit enforcement (sweep)

For each tier, sweep these endpoints and confirm 403 vs 201 behavior:

| Endpoint | Free | Starter | Pro |
|---|---|---|---|
| `POST /projects` (1st) | 201 | 201 | 201 |
| `POST /projects` (2nd) | 403 | 201 | 201 |
| `POST /projects` (4th) | — | 403 | 201 |
| `POST /projects` (50th) | — | — | 201 |

Confirm the UI's upgrade prompt fires from the 403 response shape `{"error":"PLAN_LIMIT_REACHED","resource":"projects"}`.

---

## 12. Notifications and email (deeper)

### 12.1 All five email types render correctly

- For each type, trigger the email and inspect in Resend dashboard:
  - `vote_verification` (§7.4)
  - `subscribe_verification` (§8.5)
  - `changelog_published` (§5.2)
  - `feature_shipped` (§6.4)
  - `feature_status_changed` (§7.2)
- **Manual checklist**:
  - Subject is correct.
  - HTML renders with no broken tags in Gmail web preview.
  - Plain-text body present (read by clients that don't render HTML).
  - All links work.
  - Unsubscribe link present in every type except `vote_verification` (which doesn't have a recipient subscription).

### 12.2 XSS / header injection in email

- **Steps**: register an org with name `<script>alert(1)</script>` and a project with title `Hello\r\nBcc: attacker@evil.com`.
- **Trigger an email**: subscribe + verify, publish a changelog entry whose title is `<script>alert(1)</script>`.
- **Expected**:
  - HTML body shows the literal string, no script execution.
  - Plain-text and subject have CRLF stripped (`stripNewlines`).
  - URL fields with `javascript:`/`data:` schemes render as `#` (per `safeUrl`).

### 12.3 One-click unsubscribe (subscriber)

- **Steps**: click "Unsubscribe" in any subscriber email.
- **Expected**:
  - Page confirms unsubscribed.
  - DB: `subscribers.unsubscribedAt` set, `verified=false`. Row not deleted.
  - Subsequent publishes for that project do **not** email this address.
- **Edge case**: re-subscribe with the same email → flow restarts; old `notification_logs` rows are preserved so they aren't re-sent for past entries.

### 12.4 Notification dedup across retries

- **Steps**: simulate a worker crash mid-batch. Set `RESEND_API_KEY` to an invalid key, publish an entry with 3 verified subscribers. Wait for 3 retries to fail. Now restore the key, publish a new entry — confirm only the new entry's emails are sent (the old failed job's batch should be in DLQ).
- **Alternative (cleaner)**: temporarily set up a Resend test domain that simulates failure on certain addresses. Recipients with successful first-try send don't get a second email even if other recipients in the batch fail and the job retries.

### 12.5 BullMQ failure path

- **Steps**: stop Redis (`docker compose stop redis`).
- **Action**: try to publish a changelog entry.
- **Expected**: `POST /publish` returns 500 (the `await ... .add(...)` rejects). Entry remains in draft. Restart Redis and retry the publish.
- **Restore**: `docker compose start redis`.

### 12.6 Worker tests

- **Automated**: `backend/src/__tests__/notificationWorker.test.ts` → `npm test -w backend -- notificationWorker`. Covers dispatch, dedup, retry-on-fail, excerpt extraction edge cases.

---

## 13. Security & abuse

### 13.1 Cross-org isolation

- **Steps**: as Owner B, attempt every `:projectId`-scoped admin route with one of Owner A's project IDs.
- **Expected**: 404 for every route. Never 403, never 200, never 500.
- **Coverage**: projects, changelog (list, get, create, update, delete, publish, unpublish), roadmap, features, settings, billing.

### 13.2 Public endpoints scoped by widget key

- **Steps**: with a UUID that is not a real `widgetKey`, hit `/public/<key>/changelog`, `/info`, `/roadmap`, `/features`, `/events`, `/subscribe`, `/features/.../vote`.
- **Expected**: 404 for each. Long inputs (> 64 chars) return 404 without DB lookup.

### 13.3 CORS

- **Steps**: from a browser console on `https://example.com`, run `fetch('http://localhost:3001/api/v1/projects', { credentials: 'include' })`.
- **Expected**: blocked by browser (preflight rejected — `CORS_ORIGIN` doesn't include example.com).

### 13.4 Helmet headers

- **Steps**: `curl -i http://localhost:3001/health | grep -iE 'x-content-type|x-frame|content-security|strict-transport'`.
- **Expected**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` etc. (HSTS only in prod).

### 13.5 Rate limits (auth)

- **Steps**: hammer `/api/v1/auth/login` with wrong password 11 times in a minute.
- **Expected**: 11th request returns 429 with retry-after.

### 13.6 Rate limits (public)

- **Steps**: hammer `/api/v1/public/<key>/features` (submit) 6 times in an hour.
- **Expected**: 6th returns 429.

### 13.7 File upload security

- **Steps**: `POST /projects/<id>/changelog/image-upload-url` with `mimeType: "application/pdf"`.
- **Expected**: 422.

- **Steps**: presigned URL in hand, attempt to PUT a 50 MB PNG.
- **Expected**: succeeds at R2 layer (no server-side size guard via presigning), but you should confirm the multipart route limits backend POSTs (see `plugins/multipart.ts`).

### 13.8 SQL injection (regression)

- **Steps**: register with email `' OR 1=1 --@evil.com`.
- **Expected**: 422 from Zod email format. If somehow accepted, Prisma parameterizes — no SQL injection should be possible.

### 13.9 XSS in user content

- **Steps**: paste `<script>alert(1)</script>` into the changelog editor and the feature request title.
- **Expected**: stored as plain text, rendered as text on public page (TipTap doesn't accept raw HTML; React escapes).

### 13.10 Token tamper

- **Steps**: take a valid `access_token` cookie, change one character, replay.
- **Expected**: 401 "Unauthorized" (signature fails).

### 13.11 Open-redirect protection in OAuth callback

- **Steps**: confirm the OAuth callback only redirects to `${FRONTEND_ORIGIN}` — try setting `CORS_ORIGIN` to a list with malicious entries first; the env validator rejects entries with paths.

### 13.12 Unsubscribe enumeration

- **Steps**: hit `/api/v1/public/unsubscribe?token=<random non-UUID string>`.
- **Expected**: 200 `{ unsubscribed: true }` always. No DB row touched. Cannot enumerate active tokens.

---

## 14. Performance baselines (lightweight)

These are sanity checks, not load tests:

| Surface | Local target |
|---|---|
| `/health` | < 50 ms |
| Public SSR page (warm) | < 300 ms TTFB |
| Public API (`/public/<key>/changelog`) | < 100 ms |
| Widget bundle | ≤ 5120 bytes (enforced by build) |
| Admin pages first-load | < 1.5 s on a typical dev machine |

If TTFB on the public page is consistently > 1 s, check Postgres connection pool size and Redis health (BullMQ on the same Redis can starve).

---

## 15. Test data setup helpers

### Quick-fixture SQL (after `prisma migrate reset`)

The simplest way to set up multiple users/orgs is via the UI register flow. If you need scripted fixtures, this snippet creates a second project for owner A:

```sql
INSERT INTO projects (id, "orgId", name, slug, "widgetKey")
VALUES (
  gen_random_uuid(),
  (SELECT id FROM organizations WHERE slug = 'acme-inc' LIMIT 1),
  'Second Project',
  'second-project',
  gen_random_uuid()
);
```

You'll need to first upgrade the org to Starter or Pro for this to be allowed via the API; via direct SQL you bypass the limit.

### curl recipes

Login + list projects (cookie jar):

```bash
curl -c cookies.txt -X POST http://localhost:3001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner.a@test.local","password":"TestPass123"}'

curl -b cookies.txt http://localhost:3001/api/v1/projects | jq
```

Verify a vote without clicking the email (grab the token from `votes.verificationToken`):

```bash
TOKEN=$(docker compose exec -T postgres psql -U launchlog -d launchlog_dev -tA \
  -c "SELECT verificationToken FROM votes WHERE voterEmail='alice@test.local' LIMIT 1")
curl "http://localhost:3001/api/v1/public/verify-vote?token=$TOKEN"
```

---

## 16. Per-feature-coverage cheat sheet

| Feature | FEATURES.md ref | Manual section | Backend Jest | Web Jest | Widget Jest |
|---|---|---|---|---|---|
| Auth (email/pass) | §4 | §2.1, §2.2 | `auth.test.ts` | `LoginForm.test.tsx` | — |
| Auth (Google) | §4 | §2.3 | `auth-google.test.ts` | — | — |
| Auth (middleware) | §4 | §2.4, §2.6 | `auth-middleware.test.ts` | `middleware.test.ts` | — |
| Org | §5 | §3 | `org.test.ts` | `OnboardingWizard.test.tsx` | — |
| Projects | §6 | §4 | `projects.test.ts`, `planLimit.middleware.test.ts`, `planLimits.test.ts`, `slug.test.ts` | `ProjectsClient.test.tsx`, `ProjectFormModal.test.tsx` | — |
| Changelog | §7 | §5 | `changelog.test.ts` | `ChangelogClient.test.tsx`, `ChangelogEntryForm.test.tsx`, `RichTextEditor.test.tsx` | — |
| Roadmap | §8 | §6 | `roadmap.test.ts` | `RoadmapClient.test.tsx`, `RoadmapItemModal.test.tsx` | — |
| Features (admin) | §9 | §7.1, §7.2, §7.10 | `features.test.ts` | `FeaturesClient.test.tsx` | — |
| Features (public + voting) | §9 | §7.3–§7.9 | `public-features.test.ts` | `FeaturesTab.test.tsx`, `PublicPageClient.test.tsx` | — |
| Public pages (SSR) | §10 | §8 | `public-page.test.ts` | `PublicPageClient.test.tsx` | — |
| Subscribe / unsubscribe | §10, §12 | §8.5, §12.3 | `public-subscribe.test.ts` | — | — |
| Widget | §11 | §9 | `public-analytics.test.ts` | `WidgetClient.test.tsx`, `WidgetSettingsClient.test.tsx` | `widget.test.js` |
| Notifications | §12 | §5.2, §6.4, §7.2, §12 | `notificationWorker.test.ts`, `emailService.test.ts`, `emailTemplates.test.ts` | — | — |
| Stripe billing | §13 | §10 | `billing.test.ts` | — | — |
| Plan limits | §2 | §11 | `planLimit.middleware.test.ts`, `planLimits.test.ts` | — | — |
| Env validation | — | (auto on startup) | `env.test.ts` | — | — |
| Plugins | §14 | §1.3 | `plugins.test.ts`, `redis-state-store.test.ts` | — | — |
| Schema | §3 | §1.4 | `schema.test.ts` | — | — |

To run all tests in one go: `npm test`.
