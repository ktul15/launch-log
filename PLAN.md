# LaunchLog — Project Plan

**Tagline**: Public Changelog, Roadmap, Feedback & Support Hub for Startups  
**Positioning**: Dead-simple, affordable alternative to Canny/Featurebase — matches Featurebase's entire free tier and adds extras they don't offer for free  
**Distribution mechanic**: Embeddable widget shows LaunchLog branding on free tier — every customer's users become an acquisition channel.

> **Note**: This plan incorporates revisions from the Market Viability Analysis (`MARKET_VIABILITY.md`). Key changes: admin dashboard moved from Flutter → Next.js (saves 3–4 weeks), Pro tier ($19/mo) added and moved to Phase 1.6, **free tier expanded to match Featurebase's entire free offering** (changelog, roadmap, feedback, help center, surveys, live chat, unified inbox) **plus extras** (basic analytics, RSS feed, changelog categories, feature request comments, CSV export, custom theming), MVP target: 10 weeks for Phase 1 core + Phase 1.5 (weeks 11–14) for live chat/inbox/surveys.

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
| Changelog categories/tags | ✓ | ✓ | ✓ |
| Roadmap items | Unlimited | Unlimited | Unlimited |
| Feature requests | Unlimited | Unlimited | Unlimited |
| Feature request comments | ✓ | ✓ | ✓ |
| Help Center articles | 50 | 200 | Unlimited |
| Surveys (active) | 1 | 3 | Unlimited |
| Live Chat (conversations) | Unlimited | Unlimited | Unlimited |
| Unified Inbox | ✓ | ✓ | ✓ |
| Team members | 1 (owner only) | 1 (owner only) | 3 |
| RSS Feed | ✓ | ✓ | ✓ |
| CSV Export | ✓ | ✓ | ✓ |
| Basic Analytics (page views, top features) | ✓ | ✓ | ✓ |
| Advanced Analytics (funnels, cohorts, voter insights) | ✗ | ✗ | ✓ |
| Custom public page theming | Basic (colors/logo) | Full | Full |
| Custom domain | ✗ | ✗ | ✓ |
| Widget branding | LaunchLog branded | White-labeled | White-labeled |
| Email notifications | ✓ (100/mo) | ✓ (1,000/mo) | ✓ (5,000/mo) |
| Integrations (Slack, GitHub, Linear) | ✗ | ✗ | ✓ |
| API access | ✗ | ✗ | ✓ |

**Free tier strategy**: Match every Featurebase free tier feature and add extras they don't offer for free. The free tier is the primary acquisition weapon — it must be genuinely compelling with no obvious gaps vs. Featurebase.

**Upgrade logic**:
- Free → Starter: need more than 1 project, want to remove widget branding, need more help center articles (200) or surveys (3), full theming
- Starter → Pro: need team members, custom domain, advanced analytics, integrations, or API access
- Pro is the primary revenue driver; target blended ARPU of $14–16/mo across paid tiers

**Kill threshold**: If LaunchLog has not reached 50 paid customers ($450–650 MRR) within 12 months of public launch, evaluate seriously whether to continue or pivot.

---

## Database Schema

```
organizations        id, name, slug, logo_url, plan (free|starter|pro), stripe_customer_id, stripe_subscription_id, created_at
users                id, org_id, email, password_hash, google_id, role (owner|editor), name, avatar_url, created_at
projects             id, org_id, name, slug, description, widget_key (uuid), widget_settings (jsonb), theme_settings (jsonb), custom_domain, domain_verified (bool), created_at
changelog_entries    id, project_id, title, content (jsonb/tiptap), version, category_id, status (draft|published), published_at, author_id, created_at
changelog_categories id, project_id, name, slug, color, display_order, created_at
roadmap_items        id, project_id, title, description, status (planned|in_progress|shipped), display_order, created_by, created_at
feature_requests     id, project_id, title, description, status (open|planned|in_progress|shipped|closed), vote_count, submitter_email, created_at
comments             id, feature_request_id, author_email, author_name, content, is_admin (bool), created_at
votes                id, feature_request_id, voter_email, verified (bool), verification_token, ip_hash, created_at
subscribers          id, project_id, email, verified, verification_token, created_at
notification_log     id, subscriber_id, type (changelog_published|feature_shipped|status_changed), reference_id, sent_at
invitations          id, org_id, email, role, token, accepted_at, created_at
analytics_events     id, project_id, type, metadata (jsonb), created_at
help_articles        id, project_id, title, slug, content (jsonb/tiptap), category, display_order, published (bool), author_id, created_at, updated_at
surveys              id, project_id, title, description, questions (jsonb), status (draft|active|closed), created_by, created_at, updated_at
survey_responses     id, survey_id, answers (jsonb), respondent_email, created_at
conversations        id, project_id, visitor_email, visitor_name, status (open|resolved|closed), channel (live_chat|email), created_at, updated_at
messages             id, conversation_id, sender_type (visitor|admin), sender_id, content, created_at
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

GET    /api/v1/projects/:id/analytics       (basic: all tiers; advanced: Pro only)

GET    /api/v1/projects/:id/features/:featureId/comments
POST   /api/v1/projects/:id/features/:featureId/comments

GET    /api/v1/projects/:id/categories
POST   /api/v1/projects/:id/categories
PATCH  /api/v1/projects/:id/categories/:catId
DELETE /api/v1/projects/:id/categories/:catId

GET    /api/v1/projects/:id/articles
POST   /api/v1/projects/:id/articles
GET    /api/v1/projects/:id/articles/:articleId
PATCH  /api/v1/projects/:id/articles/:articleId
DELETE /api/v1/projects/:id/articles/:articleId

GET    /api/v1/projects/:id/surveys
POST   /api/v1/projects/:id/surveys
GET    /api/v1/projects/:id/surveys/:surveyId
PATCH  /api/v1/projects/:id/surveys/:surveyId
DELETE /api/v1/projects/:id/surveys/:surveyId
GET    /api/v1/projects/:id/surveys/:surveyId/responses

GET    /api/v1/projects/:id/conversations
GET    /api/v1/projects/:id/conversations/:convId
POST   /api/v1/projects/:id/conversations/:convId/messages
PATCH  /api/v1/projects/:id/conversations/:convId          (update status)

-- Public endpoints (no auth, used by widget + public page)
GET    /api/v1/public/:projectKey/changelog
GET    /api/v1/public/:projectKey/changelog/rss            (RSS/Atom feed)
GET    /api/v1/public/:projectKey/roadmap
GET    /api/v1/public/:projectKey/features
POST   /api/v1/public/:projectKey/features                 (submit request)
POST   /api/v1/public/:projectKey/features/:id/vote
GET    /api/v1/public/:projectKey/features/:id/comments
POST   /api/v1/public/:projectKey/features/:id/comments
GET    /api/v1/public/:projectKey/articles
GET    /api/v1/public/:projectKey/articles/:slug
GET    /api/v1/public/:projectKey/surveys/:surveyId
POST   /api/v1/public/:projectKey/surveys/:surveyId/respond
POST   /api/v1/public/:projectKey/conversations            (start chat)
POST   /api/v1/public/:projectKey/conversations/:id/messages
GET    /api/v1/public/:projectKey/export/features.csv      (CSV export)
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

**Goal**: First paying customer can sign up, create a project, publish a changelog, manage a roadmap, collect feature votes, manage a help center, view basic analytics, embed the widget, and subscribe to Starter plan. Free tier matches Featurebase's core features and adds extras (analytics, RSS, categories, comments, export, theming).

**Target**: ~10 weeks solo dev for Phase 1 core. Phase 1.5 (live chat, inbox, surveys) follows in weeks 11–14 to complete Featurebase free tier parity.

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

### 1.2.5 Help Center
- [ ] Help article CRUD API (title, slug, content as TipTap JSON, category, published flag)
- [ ] Free tier enforcement: max 50 articles; Starter: 200; Pro: unlimited
- [ ] Help article display order (drag-to-reorder)
- [ ] Next.js admin: help center management page — article list, create/edit with TipTap editor
- [ ] Next.js admin: article categories (optional grouping)

### 1.2.6 Changelog Categories & Feature Request Comments
- [ ] Changelog categories CRUD API (name, slug, color)
- [ ] Associate changelog entries with categories (foreign key to `changelog_categories`)
- [ ] Next.js admin: category management, category selector on changelog create/edit
- [ ] Feature request comments API (public: submit with email; admin: reply with `is_admin` flag)
- [ ] Next.js admin: comment thread view on each feature request

### 1.2.7 Basic Analytics & Quick Wins
- [ ] Track page views (public page + widget) per project — store in `analytics_events`
- [ ] Basic analytics dashboard: page views (last 30 days), top features by votes, subscriber count
- [ ] Available on all tiers (advanced analytics like funnel, cohort, voter insights → Pro only)
- [ ] RSS feed endpoint: `/api/v1/public/:projectKey/changelog/rss` (auto-generated Atom/RSS XML)
- [ ] CSV export endpoint: `/api/v1/public/:projectKey/export/features.csv` (feature requests + votes)
- [ ] Next.js admin: basic analytics page (visible on free tier with upgrade prompt for advanced metrics)

### 1.2.8 Custom Public Page Theming (Basic)
- [ ] Store theme settings on project: `theme_settings` jsonb (primary color, accent color, logo URL)
- [ ] Public page reads theme settings and applies custom colors/logo
- [ ] Next.js admin: theming panel with color pickers and logo upload
- [ ] Free tier: basic colors + logo; Starter/Pro: full theming (fonts, custom CSS)

---

## Phase 1.3 — Public Presence

### 1.3.1 Public Page (Next.js)
- [ ] Route: `launchlog.app/[orgSlug]/[projectSlug]`
- [ ] SSR: fetch changelog, roadmap, features, help articles from API at request time
- [ ] Tab navigation: Changelog | Roadmap | Feature Requests | Help Center
- [ ] Changelog tab: list of entries with category filter, click to expand full rich text (render TipTap JSON via `@tiptap/react`)
- [ ] Roadmap tab: Kanban columns (read-only)
- [ ] Feature requests tab: list sorted by votes, submit button, upvote button, comment thread under each request
- [ ] Help Center tab: searchable article list with category grouping, full article view
- [ ] Inline voting flow: enter email → verify email → vote confirmed
- [ ] Subscribe to updates: email input → verify → stored as subscriber
- [ ] RSS feed link in page header/footer for changelog
- [ ] Apply custom theming from project's `theme_settings` (colors, logo)
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
  - Help Center search inline
  - Full voting + subscribe + comment flow inline
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

## Phase 1.5 — Free Tier Parity Completion: Live Chat, Inbox & Surveys (Weeks 11–14)

**Goal**: Complete Featurebase free tier feature parity by adding live chat, unified inbox, and surveys. These features are more complex than the Phase 1 quick wins and require WebSocket infrastructure.

### 1.5.1 Live Chat
- [ ] WebSocket server (Socket.io) for real-time messaging, integrated into Fastify backend
- [ ] Chat widget: integrated into existing widget iframe (new "Chat" tab)
- [ ] Visitor starts conversation: enters name/email → opens chat thread
- [ ] Admin dashboard: real-time chat interface with typing indicators and conversation list
- [ ] Offline mode: if admin is offline, chat falls back to email collection ("Leave a message, we'll reply by email")
- [ ] Chat history persisted in `conversations` + `messages` tables
- [ ] Free tier: unlimited conversations (matching Featurebase)

### 1.5.2 Unified Inbox
- [ ] Aggregate view of all conversations across channels (live chat, feature request submissions)
- [ ] Status management: Open → Resolved → Closed
- [ ] Next.js admin: inbox page with conversation list, filters (status, channel), and reply interface
- [ ] Quick actions: convert conversation to feature request, link to existing request
- [ ] Assign conversations to team members (Pro tier only — single owner on Free/Starter)

### 1.5.3 Surveys
- [ ] Survey CRUD API (title, questions as JSON array, status: draft/active/closed)
- [ ] Question types: multiple choice, rating (1–5), free text, NPS (0–10)
- [ ] Free tier enforcement: 1 active survey; Starter: 3; Pro: unlimited
- [ ] Unlimited responses on all tiers (matching Featurebase)
- [ ] Survey response API (public: submit responses; admin: view results)
- [ ] Next.js admin: survey builder UI with drag-to-reorder questions, response dashboard with summary charts
- [ ] Public page: survey tab (visible only if an active survey exists)
- [ ] Widget: survey display inline (optional, configurable per project)

---

## Phase 1.6 — Pro Tier (Month 5–7)

**Goal**: Launch Pro tier at $19/mo with the features that drive upgrades from Starter. This phase is intentionally early — Pro is the primary revenue driver.

### 1.6.1 Team Management
- [ ] Invitation flow: owner sends invite by email → invitee gets link → accepts → joins org
- [ ] Roles: Owner (full access) | Editor (manage content, no billing/members)
- [ ] Pro tier enforcement: max 3 members including owner (Starter: owner only)
- [ ] Next.js admin: team members page (invite, remove, role display)
- [ ] Remove member → revoke tokens

### 1.6.2 Advanced Analytics Dashboard
- [ ] Extends basic analytics (free tier, Phase 1.2.7) with advanced Pro-only metrics
- [ ] Advanced metrics: changelog engagement (open rates, read time), widget impression → signup funnel, voter insights (who voted for what), survey result deep-dives
- [ ] Cohort analysis: feature request → roadmap → shipped correlation
- [ ] Next.js admin: advanced analytics page — engagement charts, funnel visualization, voter breakdown
- [ ] Pro-only gate with upgrade prompt for free/starter tier (basic analytics remains free)

### 1.6.3 Custom Domains
- [ ] Allow Pro customers to add a custom domain (e.g., `updates.acme.com`)
- [ ] Store `custom_domain` on project, verify via DNS TXT record check
- [ ] Next.js: read `Host` header in SSR → resolve to correct project
- [ ] SSL: auto-provision via Cloudflare or Let's Encrypt
- [ ] Next.js admin: custom domain setup UI with DNS instructions + verification status

### 1.6.4 Integrations (Pro only)
- [ ] **Slack**: post to a channel when changelog is published or feature ships
- [ ] **GitHub**: link roadmap items to GitHub issues/PRs; auto-move to "Shipped" when PR merges
- [ ] **Linear**: sync feature requests to Linear issues bidirectionally
- [ ] Integration settings UI in Next.js admin per project
- [ ] Gate all integrations behind Pro plan check

### 1.6.5 API Access (Pro only)
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
- [ ] **Private roadmap** (share via secret link, not publicly indexed)
- [ ] **Zapier / Make webhooks** (triggers for changelog published, status changed)
- [ ] **Advanced survey logic** (conditional questions, branching, skip logic)
- [ ] **Canned responses** for live chat (saved reply templates)
- [ ] **Chat routing rules** (auto-assign based on keywords or project)
- [ ] **Chat transcripts** (auto-email conversation transcript to visitor on close)

> **Note**: Changelog categories, feature request comments, and CSV export moved to Phase 1.2 (free tier). Voter insights moved to Phase 1.6.2 (Pro tier advanced analytics).

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

Before considering Phase 1 MVP "shippable to first paying customer":

- [ ] Auth (email + Google) working end-to-end
- [ ] Free tier: 1 project limit enforced; Starter: 3 projects
- [ ] Changelog: create, edit (rich text + version + category), publish — unlimited posts on all tiers
- [ ] Changelog categories: create, assign to posts, filter on public page
- [ ] Roadmap: Kanban board, drag-to-reorder, status changes
- [ ] Feature requests: submit (public), vote (email verified), admin manage status
- [ ] Feature request comments: submit (public with email), admin reply, threaded display
- [ ] Help Center: create/edit/publish articles (50 limit on free tier), searchable public page
- [ ] Basic analytics: page views, top features, subscriber count — visible on all tiers
- [ ] RSS feed for changelog working
- [ ] CSV export for feature requests working
- [ ] Custom public page theming (colors/logo) applied
- [ ] Public page live at `launchlog.app/[slug]/[projectSlug]` with SSR (all tabs: Changelog, Roadmap, Features, Help Center)
- [ ] Widget: floating button embeds on external site, shows changelog + roadmap + features + help center
- [ ] "Powered by LaunchLog" link instrumented (impressions + clicks tracked)
- [ ] Stripe checkout working (Free → Starter and Free → Pro)
- [ ] Stripe webhook handles subscription lifecycle
- [ ] Email notifications sent on: changelog publish, feature shipped, status change
- [ ] Unsubscribe works
- [ ] Starter tier removes branding from widget; Pro adds team + advanced analytics
- [ ] Mobile-responsive public page
- [ ] Annual pricing shown as default on upgrade screens

Phase 1.5 completion checklist (Featurebase free tier parity):
- [ ] Live chat: widget integration, real-time messaging via WebSocket, offline fallback
- [ ] Unified inbox: aggregate conversations, status management, reply interface
- [ ] Surveys: builder UI, 1 active survey on free tier, response dashboard with charts

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
- **Live chat WebSocket**: Socket.io integrated into Fastify backend. Chat widget rendered inside existing widget iframe as a new tab. Offline fallback collects email — no message is lost.
- **Help Center search**: client-side full-text search over article titles and content (pre-loaded on page). No Elasticsearch needed at launch scale (<50 articles on free tier).
- **Survey question storage**: questions stored as JSON array in `surveys.questions` column. Each question object: `{ type, label, options?, required }`. Responses stored similarly in `survey_responses.answers`.
- **Free tier parity strategy**: the free tier is the acquisition weapon. Every feature Featurebase offers for free, LaunchLog offers for free plus extras. The "Powered by" widget is the distribution engine. Upgrade hooks: multiple projects, white-label widget, team seats, advanced analytics, integrations, API.
