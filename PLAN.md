# LaunchLog — Project Plan

**Tagline**: Public Changelog & Roadmap for Startups  
**Positioning**: Dead-simple, affordable alternative to Canny/Productboard ($9/mo vs $79+/mo)  
**Distribution mechanic**: Embeddable widget shows LaunchLog branding on free tier — every customer's users become an acquisition channel.

> **Note**: This plan incorporates revisions from the Market Viability Analysis (`MARKET_VIABILITY.md`). Key changes: admin dashboard moved from Flutter → Next.js (saves 3–4 weeks), Pro tier ($19/mo) added and moved to Phase 1.5, free tier limits revised to compete with Featurebase, MVP target compressed to 8 weeks.

---

## Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| Backend API | Node.js + Fastify + TypeScript | Fast, low overhead, great TS support |
| Database | PostgreSQL | Relational integrity for votes, projects, subscriptions |
| ORM | Prisma | Type-safe queries, easy migrations |
| Admin Dashboard | Next.js (SSR) | Same stack as public pages — saves 3–4 weeks vs Flutter |
| Public Page | Next.js (SSR) | SEO-critical — changelogs should be indexable by Google |
| Embeddable Widget | Vanilla JS + iframe | Floating button by default; `mode: "inline"` opt-in |
| Rich Text | TipTap (backend-agnostic JSON) | Stores as JSON, renders anywhere |
| Auth | JWT + Google OAuth (Passport.js) | Per requirement |
| Email | Resend | Simple API, great deliverability |
| Payments | Stripe | Monthly + annual subscriptions |
| File Storage | Cloudflare R2 | Cheap S3-compatible storage for rich text images |
| Cache / Rate Limiting | Redis | Vote deduplication, session store, rate limits |

> **Flutter web** is deferred post-revenue. If a native mobile admin app becomes a genuine customer need, it can be added later without blocking the launch.

---

## Pricing Tiers

| Feature | Free | Starter ($9/mo or $90/yr) | Pro ($19/mo or $180/yr) |
|---|---|---|---|
| Projects | 1 | 3 | Unlimited |
| Changelog posts per project | Unlimited | Unlimited | Unlimited |
| Roadmap items | Unlimited | Unlimited | Unlimited |
| Feature requests | Unlimited | Unlimited | Unlimited |
| Team members | 1 (owner only) | 1 (owner only) | 3 |
| Custom domain | ✗ | ✗ | ✓ |
| Widget branding | LaunchLog branded | White-labeled | White-labeled |
| Email notifications | ✓ | ✓ | ✓ |
| Analytics | ✗ | ✗ | ✓ |
| Integrations (Slack, GitHub, Linear) | ✗ | ✗ | ✓ |
| API access | ✗ | ✗ | ✓ |

**Upgrade logic**:
- Free → Starter: need more than 1 project, or want to remove widget branding
- Starter → Pro: need team members, custom domain, analytics, or integrations
- Pro is the primary revenue driver; target blended ARPU of $14–16/mo across paid tiers

**Kill threshold**: If LaunchLog has not reached 50 paid customers ($450–650 MRR) within 12 months of public launch, evaluate seriously whether to continue or pivot.

---

## Database Schema

```
organizations        id, name, slug, logo_url, plan (free|starter|pro), stripe_customer_id, stripe_subscription_id, created_at
users                id, org_id, email, password_hash, google_id, role (owner|editor), name, avatar_url, created_at
projects             id, org_id, name, slug, description, widget_key (uuid), widget_settings (jsonb), custom_domain, domain_verified (bool), created_at
changelog_entries    id, project_id, title, content (jsonb/tiptap), version, status (draft|published), published_at, author_id, created_at
roadmap_items        id, project_id, title, description, status (planned|in_progress|shipped), display_order, created_by, created_at
feature_requests     id, project_id, title, description, status (open|planned|in_progress|shipped|closed), vote_count, submitter_email, created_at
votes                id, feature_request_id, voter_email, verified (bool), verification_token, ip_hash, created_at
subscribers          id, project_id, email, verified, verification_token, created_at
notification_log     id, subscriber_id, type (changelog_published|feature_shipped|status_changed), reference_id, sent_at
invitations          id, org_id, email, role, token, accepted_at, created_at
analytics_events     id, project_id, type, metadata (jsonb), created_at
```

---

## API Structure

```
POST   /api/v1/auth/register
POST   /api/v1/auth/login
POST   /api/v1/auth/google
POST   /api/v1/auth/refresh
POST   /api/v1/auth/logout

GET    /api/v1/org                          (current org)
PATCH  /api/v1/org                          (update org settings)
GET    /api/v1/org/members
POST   /api/v1/org/invite
DELETE /api/v1/org/members/:userId

GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/:id
PATCH  /api/v1/projects/:id
DELETE /api/v1/projects/:id

GET    /api/v1/projects/:id/changelog
POST   /api/v1/projects/:id/changelog
GET    /api/v1/projects/:id/changelog/:entryId
PATCH  /api/v1/projects/:id/changelog/:entryId
DELETE /api/v1/projects/:id/changelog/:entryId
POST   /api/v1/projects/:id/changelog/:entryId/publish

GET    /api/v1/projects/:id/roadmap
POST   /api/v1/projects/:id/roadmap
PATCH  /api/v1/projects/:id/roadmap/:itemId
DELETE /api/v1/projects/:id/roadmap/:itemId
PATCH  /api/v1/projects/:id/roadmap/reorder

GET    /api/v1/projects/:id/features
POST   /api/v1/projects/:id/features
PATCH  /api/v1/projects/:id/features/:featureId
DELETE /api/v1/projects/:id/features/:featureId

GET    /api/v1/projects/:id/analytics       (Pro only)

-- Public endpoints (no auth, used by widget + public page)
GET    /api/v1/public/:projectKey/changelog
GET    /api/v1/public/:projectKey/roadmap
GET    /api/v1/public/:projectKey/features
POST   /api/v1/public/:projectKey/features        (submit request)
POST   /api/v1/public/:projectKey/features/:id/vote
POST   /api/v1/public/:projectKey/subscribe
GET    /api/v1/public/verify-vote?token=...
GET    /api/v1/public/verify-email?token=...

-- Billing
GET    /api/v1/billing/plans
POST   /api/v1/billing/checkout
POST   /api/v1/billing/portal
POST   /api/v1/billing/webhook           (Stripe webhook)

-- API keys (Pro only)
GET    /api/v1/keys
POST   /api/v1/keys
DELETE /api/v1/keys/:id
```

---

## Widget Architecture

```
Customer's website
│
└── <script src="https://cdn.launchlog.app/widget.js"
         data-key="PROJECT_KEY"
         data-mode="floating"          ← or "inline"
         data-position="bottom-right"> ← configurable
    </script>
         │
         ▼
    widget.js (< 5KB, vanilla JS)
    ├── Injects floating button (or inline container)
    ├── On click → opens iframe pointing to widget.launchlog.app/PROJECT_KEY
    ├── Iframe loads Next.js widget page (changelog + roadmap tabs)
    ├── Free tier: "Powered by LaunchLog" footer in iframe
    └── Starter/Pro tier: branding hidden, custom colors from widget_settings
```

---

## Public Page Architecture

```
next.js app at launchlog.app/[orgSlug]/[projectSlug]
├── SSR: fetches changelog, roadmap, features server-side (SEO-friendly)
├── Tabs: Changelog | Roadmap | Feature Requests
├── Voting inline (email verification flow)
└── Subscribe to updates (email)

Pro tier: custom domain → customer's DNS CNAME → launchlog.app
          Next.js reads Host header → resolves to correct project
```

---

## Monorepo Structure

```
launch_log/
├── backend/          Node.js + Fastify + Prisma
├── web/              Next.js — public pages + widget iframe + admin dashboard
│   ├── app/
│   │   ├── (admin)/          Admin dashboard (auth-gated)
│   │   ├── (public)/[org]/[project]/   Public changelog pages
│   │   └── widget/[key]/     Widget iframe page
├── widget/           Vanilla JS snippet (widget.js, < 5KB)
└── docker-compose.yml
```

---

---

# PHASE 1 — MVP

**Goal**: First paying customer can sign up, create a project, publish a changelog, manage a roadmap, collect feature votes, embed the widget, and subscribe to Starter plan.

**Target**: ~8 weeks solo dev (compressed from original 12-week estimate)

---

## Phase 1.1 — Foundation

### 1.1.1 Project Setup
- [ ] Initialize monorepo: `/backend`, `/web` (Next.js — admin + public + widget), `/widget` (JS snippet)
- [ ] Backend: Fastify + TypeScript + Prisma + PostgreSQL
- [ ] Setup Docker Compose for local dev (Postgres + Redis)
- [ ] Environment config (dotenv), logging (pino)
- [ ] Database: write initial Prisma schema for all core tables
- [ ] Run initial migration

### 1.1.2 Authentication
- [ ] Email/password registration + login (bcrypt, JWT access + refresh tokens)
- [ ] Google OAuth (Passport.js google-oauth20 strategy)
- [ ] Auth middleware (JWT verification on protected routes)
- [ ] Next.js admin: login page, Google Sign-In button, JWT stored in httpOnly cookie
- [ ] Next.js admin: auth state via middleware (redirect unauthenticated to /login)

### 1.1.3 Organization & User Setup
- [ ] On registration: create org + owner user record
- [ ] Org settings API (name, slug, logo upload → R2)
- [ ] Next.js admin: onboarding flow (org name → first project)

---

## Phase 1.2 — Core Features

### 1.2.1 Project Management
- [ ] Project CRUD API
- [ ] Free tier enforcement: max 1 project; Starter: max 3; Pro: unlimited (middleware check)
- [ ] Generate unique `widget_key` (UUID) per project on creation
- [ ] Next.js admin: projects list page, create/edit project form

### 1.2.2 Changelog
- [ ] Changelog entry CRUD API (draft/published states)
- [ ] Published entries sort by `published_at` desc
- [ ] No post limit on any tier (unlimited posts on free/starter/pro)
- [ ] Next.js admin: changelog list page
- [ ] Next.js admin: rich text editor using TipTap (bold, italic, links, images, code blocks)
- [ ] Version number field (optional, freeform string e.g. "v2.3.1")
- [ ] Publish / Unpublish action
- [ ] Image upload in editor → Cloudflare R2

### 1.2.3 Roadmap
- [ ] Roadmap item CRUD API
- [ ] Kanban columns: Planned → In Progress → Shipped
- [ ] Drag-to-reorder within columns (`display_order` field, reorder endpoint)
- [ ] Moving item to "Shipped" triggers notification job (see 1.4.2)
- [ ] Next.js admin: Kanban board UI with drag-and-drop (`@dnd-kit/core`)
- [ ] Status change dropdown per card

### 1.2.4 Feature Requests & Voting
- [ ] Feature request CRUD API (admin can create, edit, change status, delete)
- [ ] Public endpoint: submit feature request (email required, no login)
- [ ] Public endpoint: upvote (email required)
- [ ] Email verification flow for votes: send token → click link → vote recorded
- [ ] Vote deduplication: one vote per email per feature (Redis or DB unique constraint)
- [ ] `vote_count` counter column (increment on verified vote)
- [ ] Next.js admin: feature requests list, status management, vote counts visible

---

## Phase 1.3 — Public Presence

### 1.3.1 Public Page (Next.js)
- [ ] Route: `launchlog.app/[orgSlug]/[projectSlug]`
- [ ] SSR: fetch changelog, roadmap, features from API at request time
- [ ] Tab navigation: Changelog | Roadmap | Feature Requests
- [ ] Changelog tab: list of entries, click to expand full rich text (render TipTap JSON via `@tiptap/react`)
- [ ] Roadmap tab: Kanban columns (read-only)
- [ ] Feature requests tab: list sorted by votes, submit button, upvote button
- [ ] Inline voting flow: enter email → verify email → vote confirmed
- [ ] Subscribe to updates: email input → verify → stored as subscriber
- [ ] Responsive design, clean minimal UI
- [ ] SEO: proper `<title>`, `<meta description>`, OG tags per project

### 1.3.2 Embeddable Widget
- [ ] `widget.js` vanilla JS (< 5KB minified, no dependencies)
  - Reads `data-key`, `data-mode`, `data-position` from script tag
  - Floating mode: injects button fixed bottom-right, opens iframe on click
  - Inline mode: injects iframe into parent element
  - iframe src: `widget.launchlog.app/[projectKey]`
- [ ] Widget iframe page (Next.js route at `widget.launchlog.app`):
  - Same tabs as public page but compact (fits 400px wide panel)
  - Full voting + subscribe flow inline
  - Free tier: "Powered by LaunchLog" footer link
- [ ] Next.js admin: Widget settings panel (position, colors, show/hide tabs)
- [ ] Next.js admin: Copy embed snippet UI with live preview
- [ ] **Instrument from day 1**: track widget impressions + "Powered by" link clicks in analytics_events

---

## Phase 1.4 — Monetization & Notifications

### 1.4.1 Stripe Integration
- [ ] Create Stripe products: Free (no charge), Starter Monthly ($9), Starter Annual ($90), Pro Monthly ($19), Pro Annual ($180)
- [ ] Checkout session endpoint → redirect to Stripe hosted checkout
- [ ] Customer portal endpoint → Stripe billing portal (cancel, update card)
- [ ] Webhook handler (`/api/v1/billing/webhook`):
  - `checkout.session.completed` → activate subscription, update org plan
  - `customer.subscription.updated` → sync plan changes
  - `customer.subscription.deleted` → downgrade to free, enforce limits
- [ ] Next.js admin: billing page (current plan, upgrade CTA, manage subscription button)
- [ ] Plan limit enforcement middleware (projects, team members, feature gates)
- [ ] Display annual pricing as default on upgrade screens ($90/yr vs $108/yr equivalent)

### 1.4.2 Email Notifications
- [ ] BullMQ job queue (Redis-backed) for all email sends
- [ ] Notification queue: when changelog published → query all verified subscribers → batch send via Resend
- [ ] Notification queue: when roadmap item → "Shipped" → notify subscribers
- [ ] Notification queue: when feature request status changes → notify voters on that feature
- [ ] Email templates (HTML): changelog digest, feature shipped, status update, vote verification, subscribe verification
- [ ] Unsubscribe link in every email (one-click, token-based)
- [ ] Notification log to prevent duplicate sends

---

## Phase 1.5 — Pro Tier (Month 4–6)

**Goal**: Launch Pro tier at $19/mo with the features that drive upgrades from Starter. This phase is intentionally early — Pro is the primary revenue driver.

### 1.5.1 Team Management
- [ ] Invitation flow: owner sends invite by email → invitee gets link → accepts → joins org
- [ ] Roles: Owner (full access) | Editor (manage content, no billing/members)
- [ ] Pro tier enforcement: max 3 members including owner (Starter: owner only)
- [ ] Next.js admin: team members page (invite, remove, role display)
- [ ] Remove member → revoke tokens

### 1.5.2 Analytics Dashboard
- [ ] Track events: page views (public page + widget), votes, feature submissions, changelog opens, widget impressions, "Powered by" link clicks
- [ ] Store in `analytics_events` table (project_id, type, metadata, created_at)
- [ ] Aggregate queries: views per day (last 30 days), top features by votes, changelog engagement, widget impression→signup funnel
- [ ] Next.js admin: analytics page — line chart (views over time), top features list, subscriber count, widget funnel metrics
- [ ] Pro-only gate with upgrade prompt for free/starter tier

### 1.5.3 Custom Domains
- [ ] Allow Pro customers to add a custom domain (e.g., `updates.acme.com`)
- [ ] Store `custom_domain` on project, verify via DNS TXT record check
- [ ] Next.js: read `Host` header in SSR → resolve to correct project
- [ ] SSL: auto-provision via Cloudflare or Let's Encrypt
- [ ] Next.js admin: custom domain setup UI with DNS instructions + verification status

### 1.5.4 Integrations (Pro only)
- [ ] **Slack**: post to a channel when changelog is published or feature ships
- [ ] **GitHub**: link roadmap items to GitHub issues/PRs; auto-move to "Shipped" when PR merges
- [ ] **Linear**: sync feature requests to Linear issues bidirectionally
- [ ] Integration settings UI in Next.js admin per project
- [ ] Gate all integrations behind Pro plan check

### 1.5.5 API Access (Pro only)
- [ ] API key management (generate, revoke, scope)
- [ ] Public REST API (same operations as dashboard but via API key)
- [ ] API docs (Swagger/OpenAPI auto-generated from Fastify routes)
- [ ] Rate limiting per API key (Redis)

---

---

# PHASE 2 — Scale & Advanced Features

**Goal**: Increase retention at scale, move upmarket. After Pro tier has traction.

## Phase 2.1 — Widget Customization
- [ ] Per-project widget settings stored in `widget_settings` jsonb:
  - Primary color, background color
  - Which tabs to show (changelog, roadmap, features)
  - Button position (bottom-left, bottom-right, top-right, top-left)
  - Button label text
- [ ] Widget page reads settings from API on load
- [ ] Next.js admin: live preview of widget with settings panel

## Phase 2.2 — Advanced Features
- [ ] **Changelog categories/tags** (filter by category on public page)
- [ ] **Private roadmap** (share via secret link, not publicly indexed)
- [ ] **Feature request comments** (threaded discussion under each request)
- [ ] **Voter insights** (see which users voted for what — Pro tier)
- [ ] **Export** (CSV export of feature requests + votes)
- [ ] **Zapier / Make webhooks** (triggers for changelog published, status changed)

## Phase 2.3 — Business Tier ($49/mo)
- [ ] Business tier: SSO/SAML, priority support, SLA, unlimited team members, white-glove onboarding
- [ ] Stripe: add Business product
- [ ] Feature gate SSO behind Business plan

## Phase 2.4 — Multi-language
- [ ] i18n for widget + public page (at minimum: EN, ES, FR, DE)
- [ ] Language detection from browser Accept-Language header

---

---

# PHASE 3 — Enterprise

**Goal**: Upmarket expansion for teams needing compliance and advanced workflows.

## Phase 3.1 — SSO / SAML
- [ ] SAML 2.0 integration for enterprise accounts
- [ ] Identity provider setup UI

## Phase 3.2 — Advanced Analytics
- [ ] Cohort analysis (feature request → roadmap → shipped correlation)
- [ ] Subscriber growth over time
- [ ] Widget engagement benchmarks vs. similar products

## Phase 3.3 — White-label
- [ ] Remove all LaunchLog branding from public pages (for Business+ tier)
- [ ] Custom email sender domain (send notifications from `changelog@acme.com`)

---

---

# MVP Launch Checklist

Before considering MVP "shippable to first paying customer":

- [ ] Auth (email + Google) working end-to-end
- [ ] Free tier: 1 project limit enforced; Starter: 3 projects
- [ ] Changelog: create, edit (rich text + version), publish — unlimited posts on all tiers
- [ ] Roadmap: Kanban board, drag-to-reorder, status changes
- [ ] Feature requests: submit (public), vote (email verified), admin manage status
- [ ] Public page live at `launchlog.app/[slug]/[projectSlug]` with SSR
- [ ] Widget: floating button embeds on external site, shows changelog + roadmap + features
- [ ] "Powered by LaunchLog" link instrumented (impressions + clicks tracked)
- [ ] Stripe checkout working (Free → Starter and Free → Pro)
- [ ] Stripe webhook handles subscription lifecycle
- [ ] Email notifications sent on: changelog publish, feature shipped, status change
- [ ] Unsubscribe works
- [ ] Starter tier removes branding from widget; Pro adds team + analytics
- [ ] Mobile-responsive public page
- [ ] Annual pricing shown as default on upgrade screens

---

# Key Technical Decisions & Notes

- **Single Next.js app**: Admin dashboard, public pages, and widget iframe all live in one Next.js app under different route groups — `(admin)`, `(public)`, and `widget`. Auth middleware protects `(admin)` routes. This eliminates context-switching between Flutter and React and dramatically reduces build surface area.
- **Widget iframe origin**: serve widget page from `widget.launchlog.app` subdomain (different from main app) to allow cookie isolation and CSP control.
- **Vote integrity**: IP hash stored on vote for abuse detection, but email verification is the primary guard. Redis tracks recent vote attempts per IP for rate limiting.
- **TipTap JSON**: rich text stored as TipTap/ProseMirror JSON in PostgreSQL jsonb column. Render everywhere using `@tiptap/react` — consistent across admin, public pages, and widget.
- **Slug uniqueness**: org slugs and project slugs unique at the DB level. Auto-generated from name, manually editable once.
- **Notification batching**: BullMQ + Redis job queue for email sends — avoids blocking API responses, handles retries, prevents duplicate sends.
- **Stripe webhook security**: verify `Stripe-Signature` header on all webhook events before processing.
- **Free → paid downgrade**: when subscription lapses, enforce limits gracefully — existing content stays (including extra projects), but creating new content above limits is blocked. Never delete customer data on downgrade.
- **Widget distribution measurement**: track every widget impression and "Powered by LaunchLog" link click in `analytics_events` from day 1. Review widget attribution numbers at the 6-month mark — if below threshold, revisit free tier economics.
- **Annual as default**: all billing screens should display annual pricing first. $90/yr vs $108/yr (monthly equivalent) is a compelling frame. Annual plans reduce churn mechanically.
