# LaunchLog — MVP Features

> Scope: every feature delivered by closed `phase: mvp` GitHub issues (#1–#59). Anything not listed here belongs to a later phase (`phase: pro-tier`, `phase: growth`, `phase: enterprise`) and is not part of the MVP.

This document is technical. For a runnable setup walkthrough see [`RUNNING.md`](./RUNNING.md). For end-to-end test scenarios see [`TESTING.md`](./TESTING.md).

---

## 1. Overview

LaunchLog is a SaaS changelog / roadmap / feature-voting tool. Customers create an organization, add a project, publish updates and roadmap items, collect feature requests with email‑verified voting, and embed a small JavaScript widget on their site to surface all of the above. The free tier is the primary acquisition channel — it carries a "Powered by LaunchLog" link visible on every embedded widget.

### Architecture

```
                          ┌────────────────────────────┐
   end-user browser ─────►│ Next.js 14 App Router      │
   (admin + public + iframe)│  web/  (port 3000)         │
                          └─────────────┬──────────────┘
                                        │  fetch (server-side from SSR pages,
                                        │   client-side with httpOnly cookies)
                                        ▼
                          ┌────────────────────────────┐
                          │ Fastify 4                  │
                          │  backend/  (port 3001)     │
                          └──┬───────────┬─────────────┘
                             │           │
                ┌────────────┘           └────────────┐
                ▼                                     ▼
       ┌────────────────┐            ┌──────────────────────────┐
       │ PostgreSQL 16  │            │ Redis 7                  │
       │ Prisma client  │            │ - JWT refresh-token store│
       │                │            │ - Per-IP/email rate limit│
       │                │            │ - BullMQ queues (×3)     │
       └────────────────┘            └──────────────────────────┘

       External services (called from backend):
       - Stripe         (billing, checkout, portal, webhooks)
       - Resend         (transactional email)
       - Cloudflare R2  (S3-compatible image/logo hosting via presigned PUT)
       - Google OAuth   (Passport.js authorization-code flow)

       Embeddable widget:
       - widget.js (vanilla JS, < 5 KB minified) injects an iframe pointing
         at /widget/[projectKey] (served by Next.js)
```

### Tech stack

| Layer | Technology |
|---|---|
| Backend | Fastify 4 + TypeScript (`ts-node-dev` in dev, `tsc` for prod) |
| ORM / DB | Prisma 5 + PostgreSQL 16 |
| Cache / queue | Redis 7 + BullMQ 5 (3 separate queues) |
| Frontend | Next.js 14 (App Router) + React 18 + Tailwind 4 |
| Rich text | TipTap 3 (`@tiptap/starter-kit`, `image`, `link`, `underline`) — stored as ProseMirror JSON, never HTML |
| Drag-and-drop | `@dnd-kit/core` + `@dnd-kit/sortable` (roadmap Kanban) |
| Widget bundle | esbuild — build script enforces `< 5120` bytes |
| Auth | bcrypt, `@fastify/jwt`, `@fastify/cookie`, Passport + `passport-google-oauth20` |
| Validation | Zod (every route body and query) |
| Logging | Pino (`pino-pretty` in dev, JSON in prod) |
| Files | `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` against Cloudflare R2 |
| Email | `resend` SDK |
| Billing | `stripe` SDK 16 |

### Monorepo layout (npm workspaces)

```
backend/   Fastify API, Prisma schema/migrations, BullMQ workers, Stripe setup script
web/       Next.js admin UI, public SSR pages, widget iframe page
widget/    Vanilla JS embed snippet (compiled by esbuild)
```

---

## 2. Plan tiers and limit enforcement

Plans are stored as a `Plan` enum on `organizations.plan`. Source of truth: `backend/src/utils/planLimits.ts`.

| Plan | Monthly | Annual | Project limit | Widget branding |
|---|---|---|---|---|
| `free` | $0 | $0 | 1 | "Powered by LaunchLog" footer link visible |
| `starter` | $9 (`STRIPE_STARTER_MONTHLY_PRICE_ID`, `unit_amount=900`) | $90 (`STRIPE_STARTER_ANNUAL_PRICE_ID`, `unit_amount=9000`) | 3 | Hidden |
| `pro` | $19 (`STRIPE_PRO_MONTHLY_PRICE_ID`, `unit_amount=1900`) | $180 (`STRIPE_PRO_ANNUAL_PRICE_ID`, `unit_amount=18000`) | unlimited | Hidden |

Enforcement is two-layer to avoid races on concurrent requests:

1. **Fast-fail**: `planLimitCheck('projects')` middleware reads the count and rejects with `403 PLAN_LIMIT_REACHED` before opening a transaction (`backend/src/middleware/planLimit.ts`).
2. **Atomic guard**: inside a `Serializable` transaction in `routes/projects.ts`, `assertPlanLimit('projects', plan, count)` re-checks. If two concurrent requests both pass step 1, Postgres serialization fails one of them with `P2034`, surfaced to the client as a `409` retry.

`PLAN_LIMITS.helpArticles` and `PLAN_LIMITS.surveys` exist in the table but are not yet wired up — those features are post‑MVP.

`requirePlan(minPlan)` is available for gating Pro-only routes but is not used in any MVP route (Pro-only API gating belongs to later phases).

---

## 3. Database schema

Source of truth: `backend/prisma/schema.prisma`. There are 5 migrations applied (`20260420094345_init` through `20260429000001_soft_delete_and_voter_unsubscribe`).

Tables used by the MVP:

| Table | Purpose | Notable columns |
|---|---|---|
| `organizations` | Tenant root. Auto-created on first registration. | `slug` unique varchar(100), `plan`, `stripeCustomerId`, `stripeSubscriptionId` |
| `users` | One owner per org for MVP. | `(orgId, email)` unique, `googleId` globally unique, `role` (`owner`/`editor`) |
| `projects` | Org → Project. | `(orgId, slug)` unique, `widgetKey` UUID unique, `widgetSettings` jsonb, `themeSettings` jsonb, `isActive` (soft delete flag) |
| `changelog_entries` | TipTap doc + status. | `content` jsonb, `status` enum, `publishedAt`, `categoryId` nullable |
| `changelog_categories` | Per-project categories. | `(projectId, slug)` unique, `color`, `displayOrder` — schema present but admin UI is partial; treat as MVP-shipped DB scaffolding |
| `roadmap_items` | Kanban cards. | `status` (`planned`/`in_progress`/`shipped`), `displayOrder` |
| `feature_requests` | Public + admin requests. | `status` (`open`/`planned`/`in_progress`/`shipped`/`closed`), `voteCount` (atomic increment), `submitterEmail` (PII, owners only) |
| `votes` | Email-verified votes. | `(featureRequestId, voterEmail)` unique, `verificationToken` unique, `unsubscribeToken` unique, `notifyOnStatusChange`, `verified`, `ipHash` |
| `subscribers` | Public subscribe-to-updates emails. | `(projectId, email)` unique, `verified`, `verificationToken`, `unsubscribeToken`, `unsubscribedAt` (soft delete) |
| `notification_logs` | Per-recipient dedup record. | `(type, referenceId)` indexed; prevents duplicate sends across job retries |
| `analytics_events` | Widget impressions and powered-by clicks. | `type` varchar(100), `metadata` jsonb, `ipHash` |

Tables defined in schema but **not used by the MVP** (reserved for later phases): `comments`, `invitations`, `help_articles`, `surveys`, `survey_responses`, `conversations`, `messages`. They exist so future migrations don't have to redesign foreign keys.

Cascade behavior: deleting an org cascades to users, projects, and everything below. Deleting a project cascades to changelog, roadmap, features, votes, subscribers, analytics_events. Author/creator FKs use `onDelete: SetNull` so removing a user does not destroy their content.

---

## 4. Authentication

Source: `backend/src/routes/auth.ts`, `backend/src/middleware/authenticate.ts`, `backend/src/plugins/jwt.ts`, `backend/src/plugins/passport.ts`, `web/src/middleware.ts`, `web/src/app/login/`.

### Email/password (`POST /api/v1/auth/register`, `POST /api/v1/auth/login`)

- Bcrypt hash with 10 rounds.
- Registration is atomic: `organization` and owner `user` are created in a single Prisma transaction. On slug collision, the org slug is suffixed with 4 random hex bytes; up to 5 attempts before failing with 409.
- Email uniqueness is checked globally before insert, even though the DB constraint is per-org — this avoids login becoming non-deterministic when the same email exists in multiple orgs.
- Login uses a precomputed `DUMMY_HASH` so `bcrypt.compare` runs in constant time regardless of whether the email exists. This prevents timing-based account enumeration.
- Rate limit: 10 requests / minute / IP (`AUTH_RATE_LIMIT`); raised to 100,000 in `NODE_ENV=test`.

### Google OAuth (`GET /api/v1/auth/google`, `GET /api/v1/auth/google/callback`)

- `passport-google-oauth20` with state stored in Redis (see `plugins/passport.ts` and `plugins/redis-state-store` integration).
- Callback URL must be registered in Google Cloud Console: `${APP_URL}/api/v1/auth/google/callback`.
- On success, redirects to `${FRONTEND_ORIGIN}/dashboard` with cookies set. On any error: `${FRONTEND_ORIGIN}/login?error=oauth`.
- Returns 503 if `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are unset.

### JWT model

- Two tokens: 15-minute `access_token`, 7-day `refresh_token`. Both issued via `@fastify/jwt` namespaces (`fastify.access`, `fastify.refresh`).
- Both tokens are httpOnly cookies with `sameSite=lax`, `secure` in production. Tokens are never returned in JSON bodies — XSS in the admin app cannot read them.
- Refresh token is also stored in Redis under `refresh:${userId}` so that logout (or future server-side revocation) can invalidate.
- `POST /api/v1/auth/refresh` verifies the cookie's refresh token, constant-time-compares it to the Redis copy, and re-signs a fresh access token.
- `POST /api/v1/auth/logout` deletes the Redis refresh entry (when it matches) and clears both cookies. Idempotent for already-expired or tampered tokens.

### Backend middleware

`backend/src/middleware/authenticate.ts` runs `req.accessVerify()` (cookie-path JWT verify) and rejects with `401 TOKEN_EXPIRED` when expired so the frontend middleware can decide to refresh. Rejects with plain `401 Unauthorized` for tampered or malformed tokens.

### Frontend middleware

`web/src/middleware.ts` protects `/dashboard`, `/onboarding`, `/billing`, `/account`, `/team` (allowlist; new admin sections must be added explicitly). Behavior on each request:

1. If `access_token` cookie is structurally valid and `exp - 10s` is still in the future, pass through.
2. Otherwise, if `refresh_token` is structurally valid, call `POST /api/v1/auth/refresh` (5s timeout). If the response includes a new `Set-Cookie`, parse and re-emit it through `NextResponse.cookies.set()` (never forward raw `Set-Cookie` strings — defends against header injection from a compromised backend).
3. Otherwise, redirect to `/login`.

### Why httpOnly cookies, not localStorage

XSS in the admin SPA cannot exfiltrate the session. Combined with `sameSite=lax`, this is the MVP's CSRF defense for state‑changing endpoints (admin endpoints check for a JSON body, which `<form>`-based CSRF cannot send cross-origin without a preflight that CORS will block).

---

## 5. Organizations

Source: `backend/src/routes/org.ts`, `web/src/app/(admin)/layout.tsx`, `web/src/app/(onboarding)/onboarding/`.

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /api/v1/org` | Read current org settings + `projectCount` of active projects | Auth required (owner or editor) |
| `PATCH /api/v1/org` | Update `name`, `slug`, `logoUrl` | Owner only. Logo URL must use HTTPS and (when R2 is configured) be served from `R2_PUBLIC_URL` to prevent SSRF via SSR fetches |
| `POST /api/v1/org/logo-upload-url` | Presigned R2 PUT for logo upload | Owner only. 503 when R2 unconfigured |

The `(admin)/layout.tsx` SSR layout calls `GET /api/v1/org` to render nav and to enforce a "first-run" redirect: if `projectCount === 0` the user is bounced to `/onboarding`. The `OnboardingWizard` (client component) walks the user through naming the org and creating their first project.

A backend (non-401) error in the layout fetch surfaces to the Next.js error boundary rather than silently logging out the user — this prevents a backend outage from showing the user a login form.

---

## 6. Projects

Source: `backend/src/routes/projects.ts`, `web/src/app/(admin)/dashboard/projects/`.

| Endpoint | Purpose | Notes |
|---|---|---|
| `POST /api/v1/projects` | Create project (owner) | Plan limit enforced at fast-fail and inside a serializable transaction. Auto‑generates slug from `name`; on slug collision retries with `-2`, `-3` up to 5 times |
| `GET /api/v1/projects` | List active projects + counts | |
| `GET /api/v1/projects/:id` | Get one (incl. `widgetKey`, `widgetSettings`, `themeSettings`) | |
| `PATCH /api/v1/projects/:id` | Update name/slug/description/widgetSettings (owner) | `widgetSettings` is `.strict()` Zod — unknown keys rejected, full object always sent (no partial merges). At least one tab (changelog/roadmap/features) must remain enabled |
| `DELETE /api/v1/projects/:id` | Hard delete (owner) | Cascade deletes everything project-scoped |

`widgetKey` is a UUID auto-generated at creation, exposed publicly, and is the only identifier the public API and widget iframe see. The internal `id` is never sent to a public route.

`widgetSettings` schema (kept in lockstep with `web/src/lib/widgetSettings.ts`):
```ts
{ showChangelog: boolean, showRoadmap: boolean, showFeatures: boolean,
  buttonPosition: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right',
  primaryColor: '#RRGGBB', backgroundColor: '#RRGGBB' }
```

Admin UI: `dashboard/projects` lists projects with inline create/edit modal (`ProjectFormModal`). A project detail layout (`projects/[projectId]/layout.tsx`) wraps a sub-nav (`ProjectNav`) for changelog, roadmap, features, settings.

---

## 7. Changelog

Source: `backend/src/routes/changelog.ts`, `web/src/app/(admin)/dashboard/projects/[projectId]/changelog/`, `web/src/components/RichTextEditor.tsx`, `web/src/components/RichTextViewer.tsx`.

### Authoring

- Entries have `title`, `content` (TipTap doc JSON), optional `version`, optional `categoryId`, `status`, `publishedAt`, `authorId`.
- Content is validated as `{ type: 'doc', content: [...] }`. Anything else is rejected — ensures the renderer never gets unrenderable JSON.
- Image upload: `POST /api/v1/projects/:projectId/changelog/image-upload-url` returns a 5‑minute presigned R2 PUT URL plus the public URL the client should embed into the TipTap doc. The MIME type must be on the allowlist (`image/jpeg`, `image/png`, `image/gif`, `image/webp` from `plugins/multipart.ts`'s `ALLOWED_IMAGE_TYPES`).

### Lifecycle

| Endpoint | Behavior |
|---|---|
| `POST /:projectId/changelog` | Create draft (owner) |
| `GET /:projectId/changelog?status=` | List, ordered by `publishedAt DESC NULLS LAST, createdAt DESC` |
| `GET /:projectId/changelog/:entryId` | Read |
| `PATCH /:projectId/changelog/:entryId` | Update (owner). Archived entries cannot be edited (`409`). Cross-project category IDs rejected (`422`) |
| `DELETE /:projectId/changelog/:entryId` | Delete (owner) |
| `POST /:projectId/changelog/:entryId/publish` | Set `status='published'`, set `publishedAt=now()` if previously null, **enqueue `changelog_published` job to BullMQ** if it was a true first publish (or first publish after unpublish — see below) |
| `POST /:projectId/changelog/:entryId/unpublish` | Revert to draft, **clear `publishedAt`** |

Re-publish behavior: unpublish clears `publishedAt`, so a subsequent publish is treated as a "first publish" again and re-enqueues the notification job. The notification worker then dedups against `notification_logs` so subscribers who already received an email do not get a second one.

### Public surface

`GET /api/v1/public/:projectKey/changelog` returns the most recent 50 published entries (without the heavy `content` blob). `GET /api/v1/public/:projectKey/changelog/:entryId` returns full content. The public page lazy-loads content per entry as the user expands it.

---

## 8. Roadmap

Source: `backend/src/routes/roadmap.ts`, `web/src/app/(admin)/dashboard/projects/[projectId]/roadmap/`.

Three columns: `planned` → `in_progress` → `shipped`. `displayOrder` is assigned at creation as the current item count, so new items append.

| Endpoint | Behavior |
|---|---|
| `POST /:projectId/roadmap` | Create (owner) |
| `GET /:projectId/roadmap?status=` | List, ordered by `displayOrder ASC, createdAt ASC` |
| `GET /:projectId/roadmap/:itemId` | Read |
| `PATCH /:projectId/roadmap/reorder` | Bulk update `displayOrder` (owner). Registered before `:itemId` so "reorder" is not interpreted as an itemId. `updateMany` is per-row scoped to `projectId` — items from another project are silently skipped |
| `PATCH /:projectId/roadmap/:itemId` | Update title/description/status (owner). When status transitions `* → shipped`, enqueue `feature_shipped` job |
| `DELETE /:projectId/roadmap/:itemId` | Delete (owner) |

Public surface: `GET /api/v1/public/:projectKey/roadmap` returns up to 50 items ordered by `(status, displayOrder)`.

Admin UI uses `@dnd-kit/core` for both within-column reorder and across-column status change. Each card has a status dropdown for keyboard/screen-reader users.

---

## 9. Feature requests and voting

Source: `backend/src/routes/features.ts` (admin), `backend/src/routes/public.ts` (public), `web/src/components/FeaturesTab.tsx`, `web/src/app/verify/vote/`.

### Admin (authenticated)

| Endpoint | Behavior |
|---|---|
| `GET /:projectId/features?status=` | List with vote counts. **`submitterEmail` is included only when the requester role is `owner`** — editors don't see PII |
| `POST /:projectId/features` | Create (owner) |
| `PATCH /:projectId/features/:featureId` | Update (owner). When `status` changes, enqueue `feature_status_changed` job with deterministic `jobId=fsc:${featureId}:${newStatus}` so duplicate status flips don't enqueue duplicate jobs |
| `DELETE /:projectId/features/:featureId` | Delete (owner) |

### Public submit (`POST /api/v1/public/:projectKey/features`)

- Anonymous, requires `email` + `title`. Email is lowercased.
- Atomically creates the `FeatureRequest` and an unverified `Vote` (since the submitter is implicitly voting for their own request).
- Enqueues `vote_verification` job. The submitter receives a verification email; clicking it both verifies the vote and increments `voteCount`.
- Rate limit: 5 / hour / IP (`PUBLIC_RATE_LIMIT`).

### Public upvote (`POST /api/v1/public/:projectKey/features/:featureId/vote`)

- Requires `email`. Status must not be `closed` or `shipped` (404 otherwise).
- Per-email rate limit: 3 / hour, keyed on `HMAC-SHA256(JWT_SECRET, email)` in Redis. Fails open if Redis is unavailable so a Redis outage doesn't block voting.
- Per-IP rate limit: 5 / hour.
- Existing-vote check returns differentiated 409 messages: `"You have already voted for this feature."` vs `"A verification email has already been sent. Please check your inbox."` — these are the same status code so an attacker cannot use the response code alone to enumerate addresses, but the per-email rate limit prevents probing via repeated requests.
- Uniqueness is also enforced at the DB level (`@@unique([featureRequestId, voterEmail])`); a race between the pre-check and the insert is caught (`P2002`) and returned the same way as the pre-check path.

### Vote verification (`GET /api/v1/public/verify-vote?token=...`)

- Token TTL: 48 hours. Expired votes are deleted so the user can revote with a fresh token.
- Verification is atomic: the `UPDATE WHERE verified=false AND createdAt >= threshold` clause ensures only one concurrent request "wins" — repeated clicks return `"Already verified"` rather than double-incrementing the count.

### Voter unsubscribe

`GET /api/v1/public/voter-unsubscribe?token=...` flips `notifyOnStatusChange=false` for the matching `Vote.unsubscribeToken`. Idempotent. Each notification email contains this link so a voter can opt out of future status-change emails for that one feature without unsubscribing from project announcements.

### Public list (`GET /api/v1/public/:projectKey/features`)

Returns up to 50 features with `status NOT IN ('closed', 'shipped')` ordered by `voteCount DESC`.

---

## 10. Public pages (SSR)

Source: `web/src/app/(public)/[orgSlug]/[projectSlug]/` (page, client, error, loading), `web/src/components/SubscribeForm.tsx`, `web/src/components/FeaturesTab.tsx`, `web/src/components/RichTextViewer.tsx`.

### Routing

URL: `/[orgSlug]/[projectSlug]?tab=changelog|roadmap|features`. Default tab is `changelog`. The page is fully SSR'd — `view-source` shows real content, not a hydration shell.

Backend resolves `(orgSlug, projectSlug) → widgetKey` via `GET /api/v1/public/resolve/:orgSlug/:projectSlug`. The page then fetches three lists in parallel with `widgetKey`. All three fetches use a 5s `AbortSignal.timeout` and 60s `next.revalidate`; absolute backend URL comes from `BACKEND_URL` (server-only — never `NEXT_PUBLIC_API_URL` in this path, to avoid SSR routing through the public internet).

### Tabs

- **Changelog**: list of cards, click to expand. Expanded content lazy-fetches the full TipTap doc and renders via `RichTextViewer` (a `@tiptap/react` instance configured to be read‑only and to extend `StarterKit + Image + Link + Underline`).
- **Roadmap**: read-only Kanban grouped by status. Color-coded headers.
- **Features**: cards sorted by votes. Each card has an inline upvote button that opens the email-verification flow without leaving the page.

### Subscribe-to-updates

`SubscribeForm` posts to `POST /api/v1/public/:projectKey/subscribe`. Rate limit: 5 / hour / IP. Backend behavior:

- If the email is already verified and not unsubscribed, returns `{ status: 'already_subscribed' }`.
- Otherwise upserts the row (clearing `unsubscribedAt` on a previously-unsubscribed email) and enqueues `subscribe_verification`.

Verification redemption page: `web/src/app/verify/subscribe/page.tsx` calls `GET /api/v1/public/verify-subscribe?token=...`.

### SEO

`generateMetadata` produces:
- `<title>`: `"{project.name} — {org.name}"`
- `<meta description>`: `project.description` or a generated fallback
- OpenGraph (`type: website`, `siteName: 'LaunchLog'`, default OG image at `/og-default.png`)
- Twitter card (`summary_large_image`)
- JSON-LD `SoftwareApplication` + `BreadcrumbList`. The JSON is XSS-escaped (`<`, `>`, `&` → `\\u00xx`) before being injected via `dangerouslySetInnerHTML`.

404s and metadata fetch failures set `robots: { index: false }` so dead URLs don't end up in search indexes.

### Responsiveness

Layout is mobile-first; smallest verified breakpoint is 320 px.

---

## 11. Embeddable widget

Source: `widget/src/index.js`, `web/src/app/widget/[projectKey]/`, `web/src/app/(admin)/dashboard/projects/[projectId]/settings/`.

### `widget.js` (vanilla, no deps)

The customer pastes:
```html
<script src="https://widget.launchlog.app/widget.js"
        data-key="<projectKey>"
        data-mode="floating"
        data-position="bottom-right"></script>
```

Behavior:
- `data-key` validated as 8–64 chars of `[a-zA-Z0-9_-]`. Bad keys log a warning and abort — they never reach the network.
- `data-mode`: `floating` (default) or `inline`. Anything else falls back to `floating` with a warning.
- `data-position`: one of `bottom-right` (default), `bottom-left`, `top-right`, `top-left`.
- **Floating** mode appends a 52 px fixed-position button at 24 px from the chosen edge. Click toggles a 400 × 600 iframe panel anchored at button + 12 px gap. Clicking outside or pressing `Escape` closes the panel and returns focus to the button.
- **Inline** mode appends the iframe to the script's `parentElement`.
- Iframe attributes: `title="LaunchLog Widget"`, `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"` (compromised iframe cannot navigate the parent), `allow="clipboard-write"`.
- The icon is built via `document.createElementNS` (SVG DOM), not `innerHTML` — immune to mutation-XSS even if a future edit changes the markup.
- ARIA: button has `aria-label`, `aria-expanded`, `aria-controls`. Panel is `role="region"` with `aria-label`.

The build script in `widget/package.json` runs esbuild with `--minify` and a postcheck that `fs.statSync('dist/widget.js').size > 5120` fails the build with a non-zero exit. This guarantees the bundle stays under the 5 KB acquisition target.

### `/widget/[projectKey]` (Next.js page)

Server-side fetches `GET /api/v1/public/:projectKey/info` to get `name`, `orgName`, `plan`, `widgetSettings`. If 404, the page returns Next's `notFound()`. Then fetches changelog/roadmap/features in parallel; each individual fetch failure falls back to `[]` so one degraded endpoint doesn't blank the entire widget. `robots: { index: false }` on every iframe response.

The client component (`WidgetClient`) renders a 3-tab compact view (Changelog, Roadmap, Features) honoring `widgetSettings.showChangelog/showRoadmap/showFeatures` so the customer can hide individual tabs.

### "Powered by LaunchLog" branding

Visible in the iframe footer when `project.org.plan === 'free'`. Hidden on `starter` and `pro`. The link click is recorded as a `powered_by_click` analytics event on the backend.

### Admin settings panel (`projects/[projectId]/settings`)

`WidgetSettingsClient` provides:
- Toggle each tab's visibility (validates that at least one tab remains).
- Color pickers for primary and background (validates `#RRGGBB`).
- Position dropdown (4 corners).
- A live preview iframe.

### Embed snippet copy UI

Below the settings panel, `dashboard/projects/[projectId]/settings` renders the exact `<script ... data-key="{widgetKey}" ...>` snippet with a one-click clipboard copy button.

### Analytics events (`POST /api/v1/public/:projectKey/events`)

Two event types are accepted (`widget_impression`, `powered_by_click`). Optional `metadata` object is bounded: ≤10 keys, key length ≤64, value length ≤256, only `string|number|boolean`. Rate limit: 60 / hour / IP. Stores `ipHash` (HMAC-SHA256 keyed on `JWT_SECRET`) — the raw IP is never persisted.

> **Note**: the MVP only stores events. There is no admin analytics dashboard yet; that is `phase: pro-tier` (issues #65–#68). To inspect, query the `analytics_events` table directly or use Prisma Studio.

---

## 12. Notifications and email

Source: `backend/src/jobs/index.ts` (queue factories), `backend/src/workers/notificationWorker.ts` (worker logic), `backend/src/services/emailService.ts` (Resend wrapper), `backend/src/services/emailTemplates.ts` (HTML + plain-text bodies), `backend/src/routes/public.ts` (unsubscribe endpoints).

### Three queues

| Queue name | Job types | Concurrency | Retries |
|---|---|---|---|
| `email-notifications` | `changelog_published`, `feature_shipped`, `feature_status_changed` | 5 | 3, exponential backoff `delay=2000` |
| `vote-verification` | `vote_verification` | 5 | 3, exponential |
| `subscription-verification` | `subscribe_verification` | 5 | 3, exponential |

Each worker holds its own `IORedis` connection (per BullMQ requirement — sharing connections starves `BLPOP`). Workers are spun up by `backend/src/index.ts` after `buildApp()` and torn down before `app.close()` on `SIGTERM`/`SIGINT`.

### Five email types

All emails go through Resend (`from = RESEND_FROM_EMAIL`, must be on a verified domain). Each has both HTML and plain-text bodies. User-controlled strings are HTML-escaped (`escHtml`) and stripped of `\r\n` before inclusion in headers/text. URLs are validated to use `http(s)://` — anything else (`javascript:`, `data:`) is replaced with `#`.

| Type | Trigger | Recipients | Subject template |
|---|---|---|---|
| `changelog_published` | First publish (or first publish after unpublish) of an entry | All verified, non-unsubscribed subscribers of that project | `New update: {title}` |
| `feature_shipped` | Roadmap item transitions `* → shipped` | All verified, non-unsubscribed subscribers | `Shipped: {title}` |
| `feature_status_changed` | Feature request `status` changes | All `verified=true` voters with `notifyOnStatusChange=true` | `Update on "{title}"` |
| `vote_verification` | New vote needs verification | The voter only | `Verify your vote for: {title}` |
| `subscribe_verification` | New subscription needs verification | The subscriber only | `Confirm your subscription to {project name}` |

### Deduplication

`notification_logs` records each successful send. The dedup key varies by job:
- `changelog_published` and `feature_shipped`: keyed on `(subscriberId, type, referenceId)` so a single subscriber gets at most one email per entry/item.
- `feature_status_changed`: keyed on `referenceId = "{voteId}:{newStatus}"` so each voter gets at most one email per status transition.
- `vote_verification` and `subscribe_verification`: keyed on `(type, referenceId)` where `referenceId` is the vote/subscriber ID. Skips if a log row already exists (covers retries after the email succeeded but the BullMQ ack was lost).

If `notificationLog.create` fails after the email was sent, the worker logs `error` (not `warn`) so duplicate-risk events are visible in alerting. On retry the dedup will skip already-notified recipients.

If any per-recipient send fails inside a batch, the worker throws so BullMQ retries the whole job. The notification log dedup ensures that already-successful recipients are skipped on retry — only the failures get re-attempted.

### Excerpt extraction

For changelog emails, the worker walks the TipTap doc with `extractExcerpt()` to produce a ~200-character plain-text preview. Block-level nodes (paragraph, heading, listItem, codeBlock, etc.) are joined with a single space. The slice respects Unicode code points so emoji are not split.

### One-click unsubscribe (subscribers)

Each notification email contains a per-subscriber `unsubscribeToken` link to `GET /api/v1/public/unsubscribe?token=...`. Behavior:
- Soft-delete: sets `unsubscribedAt = now()`, `verified = false`. Does **not** delete the row, so `notification_logs` dedup history is preserved across resubscribe cycles — a re-subscriber never receives a duplicate of an entry they already saw.
- Idempotent and silent (always returns `{ unsubscribed: true }`, even for unknown tokens), so token enumeration cannot be used to discover subscribed addresses.

### One-click voter unsubscribe (per-feature)

Status-change emails include a per-voter `unsubscribeToken` to `GET /api/v1/public/voter-unsubscribe?token=...` which flips `notifyOnStatusChange=false` for that single vote, leaving the project subscription intact.

---

## 13. Stripe billing

Source: `backend/src/routes/billing.ts`, `backend/scripts/stripe-setup.ts`, `web/src/app/(admin)/dashboard/billing/`.

### One-time setup

`npm run stripe:setup -w backend` is idempotent (it looks up products by `metadata.slug` and prices by `lookup_key`). It creates:
- Three products: `LaunchLog Free`, `LaunchLog Starter`, `LaunchLog Pro` (Free is metadata-only — never billed).
- Four prices: starter monthly/annual, pro monthly/annual.

The script prints the four price IDs to copy into `.env`.

### Endpoints

| Endpoint | Behavior |
|---|---|
| `POST /api/v1/billing/checkout` | Owner only. Validates that `success_url`/`cancel_url` are same-origin as `FRONTEND_URL` (origin compare, not `startsWith` — defends against subdomain prefix bypass). Rejects with 409 if org already has a non-free plan. Creates a Stripe `Customer` lazily; concurrent requests cannot create duplicates because the `updateMany` is conditional on `stripeCustomerId IS NULL` |
| `POST /api/v1/billing/portal` | Owner only. Same-origin check on `return_url`. Returns 422 if org has no `stripeCustomerId` |
| `GET /api/v1/billing` | Owner or editor. Returns `{ plan, projectCount, projectLimit, nextBillingDate }`. `projectLimit` is `null` for Pro (unlimited). `nextBillingDate` is `null` if subscription is `cancel_at_period_end=true` (the period end is the cancellation date, not a billing date) or for free plans |
| `POST /api/v1/billing/webhook` | Public. Raw-body content-type parser registered in a child scope so Stripe's signature verification has the exact bytes that were signed. Three event types handled (see below). Other events return 200 (acknowledged but no-op) |

### Webhook handlers

- `checkout.session.completed`: stores `stripeSubscriptionId` on the org. Plan is **not** updated here — `customer.subscription.updated` fires immediately after with the authoritative state, so doing both would create two independent failure points for the same payment.
- `customer.subscription.updated`: maps `items[0].price.id` back to `'starter'|'pro'` via `planFromPriceId()`. Sets `plan` to the mapped value when subscription is `active`/`trialing`, otherwise to `'free'`. Updates `stripeSubscriptionId` to the current value.
- `customer.subscription.deleted`: drops to `'free'` and clears `stripeSubscriptionId`. **Retains `stripeCustomerId`** so the customer can re-subscribe via the portal without creating a duplicate Stripe customer record.
- Signature mismatch → `400`, no DB change.
- Webhook secret missing → `503` (so misconfiguration surfaces during development rather than silently dropping events).

### Admin billing page

`dashboard/billing` (SSR) calls `GET /api/v1/billing` and renders current plan, project count vs limit, and either "Upgrade" buttons (Free) or a "Manage subscription" link to the portal (paid). Both buttons POST to `/checkout` or `/portal` respectively from the client component and `window.location` to the returned URL.

---

## 14. Observability and operational concerns

- **Logging**: pino. `LOG_LEVEL` configurable per environment; `pino-pretty` in dev, JSON in prod, `silent` in `NODE_ENV=test`. The error handler in `backend/src/index.ts` only surfaces error messages to clients for 4xx; 5xx returns a generic message and the real error is logged.
- **Trust proxy**: `trustProxy: true` so `req.ip` is resolved from `X-Forwarded-For` for accurate rate-limit keying behind Nginx/Cloudflare.
- **Prisma error normalization**: `P2002` → `409`, `P2025` → `404` from a global error handler. Internal table/column names are never returned to clients.
- **Validation**: Every route body and query goes through Zod. Unknown fields are stripped by default; `widgetSettings` and feature requests use `.strict()` to reject unknown keys outright.
- **CORS**: `CORS_ORIGIN` is a comma-separated allowlist of origins. Each entry must be `scheme://host[:port]` (no path/query/hash), validated at startup.
- **Helmet**: standard security headers (`X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security` in prod, etc.).
- **Rate limiting**: Per-route via `@fastify/rate-limit`. Test mode raises caps to 100 000 so feature tests still exercise the config block. Some routes also have a Redis-backed per-email or per-token counter on top.

---

## 15. Complete API surface (MVP)

> All routes prefixed `/api/v1`. Auth = httpOnly access cookie. "Public" = no auth, scoped by `widgetKey`.

| Method | Path | Auth | Source |
|---|---|---|---|
| `POST` | `/auth/register` | none | `routes/auth.ts` |
| `POST` | `/auth/login` | none | `routes/auth.ts` |
| `GET` | `/auth/google` | none | `routes/auth.ts` |
| `GET` | `/auth/google/callback` | none | `routes/auth.ts` |
| `POST` | `/auth/refresh` | refresh-cookie | `routes/auth.ts` |
| `POST` | `/auth/logout` | refresh-cookie (best-effort) | `routes/auth.ts` |
| `GET` | `/org` | auth | `routes/org.ts` |
| `PATCH` | `/org` | owner | `routes/org.ts` |
| `POST` | `/org/logo-upload-url` | owner | `routes/org.ts` |
| `POST` | `/projects` | owner | `routes/projects.ts` |
| `GET` | `/projects` | auth | `routes/projects.ts` |
| `GET` | `/projects/:id` | auth | `routes/projects.ts` |
| `PATCH` | `/projects/:id` | owner | `routes/projects.ts` |
| `DELETE` | `/projects/:id` | owner | `routes/projects.ts` |
| `GET` | `/projects/:projectId/changelog` | auth | `routes/changelog.ts` |
| `POST` | `/projects/:projectId/changelog` | owner | `routes/changelog.ts` |
| `POST` | `/projects/:projectId/changelog/image-upload-url` | owner | `routes/changelog.ts` |
| `GET` | `/projects/:projectId/changelog/:entryId` | auth | `routes/changelog.ts` |
| `PATCH` | `/projects/:projectId/changelog/:entryId` | owner | `routes/changelog.ts` |
| `DELETE` | `/projects/:projectId/changelog/:entryId` | owner | `routes/changelog.ts` |
| `POST` | `/projects/:projectId/changelog/:entryId/publish` | owner | `routes/changelog.ts` |
| `POST` | `/projects/:projectId/changelog/:entryId/unpublish` | owner | `routes/changelog.ts` |
| `GET` | `/projects/:projectId/roadmap` | auth | `routes/roadmap.ts` |
| `POST` | `/projects/:projectId/roadmap` | owner | `routes/roadmap.ts` |
| `GET` | `/projects/:projectId/roadmap/:itemId` | auth | `routes/roadmap.ts` |
| `PATCH` | `/projects/:projectId/roadmap/reorder` | owner | `routes/roadmap.ts` |
| `PATCH` | `/projects/:projectId/roadmap/:itemId` | owner | `routes/roadmap.ts` |
| `DELETE` | `/projects/:projectId/roadmap/:itemId` | owner | `routes/roadmap.ts` |
| `GET` | `/projects/:projectId/features` | auth | `routes/features.ts` |
| `POST` | `/projects/:projectId/features` | owner | `routes/features.ts` |
| `GET` | `/projects/:projectId/features/:featureId` | auth | `routes/features.ts` |
| `PATCH` | `/projects/:projectId/features/:featureId` | owner | `routes/features.ts` |
| `DELETE` | `/projects/:projectId/features/:featureId` | owner | `routes/features.ts` |
| `GET` | `/public/resolve/:orgSlug/:projectSlug` | public | `routes/public.ts` |
| `GET` | `/public/:projectKey/info` | public | `routes/public.ts` |
| `GET` | `/public/:projectKey/changelog` | public | `routes/public.ts` |
| `GET` | `/public/:projectKey/changelog/:entryId` | public | `routes/public.ts` |
| `GET` | `/public/:projectKey/roadmap` | public | `routes/public.ts` |
| `GET` | `/public/:projectKey/features` | public | `routes/public.ts` |
| `POST` | `/public/:projectKey/features` | public | `routes/public.ts` |
| `POST` | `/public/:projectKey/features/:featureId/vote` | public | `routes/public.ts` |
| `GET` | `/public/verify-vote?token=` | public | `routes/public.ts` |
| `POST` | `/public/:projectKey/subscribe` | public | `routes/public.ts` |
| `GET` | `/public/verify-subscribe?token=` | public | `routes/public.ts` |
| `GET` | `/public/unsubscribe?token=` | public | `routes/public.ts` |
| `GET` | `/public/voter-unsubscribe?token=` | public | `routes/public.ts` |
| `POST` | `/public/:projectKey/events` | public | `routes/public.ts` |
| `POST` | `/billing/checkout` | owner | `routes/billing.ts` |
| `POST` | `/billing/portal` | owner | `routes/billing.ts` |
| `GET` | `/billing` | auth | `routes/billing.ts` |
| `POST` | `/billing/webhook` | Stripe signature | `routes/billing.ts` |
| `GET` | `/health` | none | `backend/src/index.ts` |

---

## 16. What is intentionally NOT in the MVP

These have GitHub issues open in later phase labels and will not appear in the running app:

- Help center articles (`HelpArticle` table exists, no routes/UI). Issues #99–#103, #108.
- Threaded comments on feature requests (`Comment` table exists). Issue #86.
- Admin analytics dashboard (`analytics_events` is populated; UI is not built). Issues #65–#68.
- Surveys (`Survey`, `SurveyResponse` tables). Issues #117–#124.
- Live chat / inbox (`Conversation`, `Message` tables). Issues #109–#116.
- Team invitations beyond the single owner (`Invitation` table). Issues #60–#64.
- RSS feed for changelog. Issue #104.
- CSV export of feature requests. Issue #88.
- Custom domains, integrations (Slack/GitHub/Linear), API keys, advanced analytics, white-labeling. Issues #69–#80, #125+.

Trying to use any of these will return a 404 — they are not regressions.
