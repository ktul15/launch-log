# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

Pre-development — architecture and planning are complete, no source code exists yet. Phase 1.1 (monorepo setup) is the starting point.

**LaunchLog** is an affordable all-in-one changelog/roadmap/voting/help-center/surveys/chat platform for startups, positioned as a $9/mo alternative to Canny and Featurebase.

## Planned Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Fastify + TypeScript |
| Database | PostgreSQL + Prisma ORM |
| Frontend (admin + public) | Next.js (SSR) |
| Embeddable widget | Vanilla JS < 5KB + iframe |
| Rich text | TipTap (stored as ProseMirror JSON) |
| Auth | JWT + Google OAuth (Passport.js), httpOnly cookies |
| Email | Resend |
| Payments | Stripe |
| File storage | Cloudflare R2 |
| Cache / job queue | Redis + BullMQ |
| Local dev | Docker Compose (Postgres + Redis) |

## Planned Monorepo Structure

```
launch_log/
├── backend/          Fastify + Prisma (routes/, middleware/, services/, jobs/)
├── web/              Next.js — (admin)/ + (public)/[orgSlug]/[projectSlug]/ + widget/[projectKey]/
├── widget/           Vanilla JS snippet (esbuild, target < 5KB)
└── docker-compose.yml
```

## Architecture Patterns

**Routing model**: Every resource is scoped to `org → project`. Public pages live at `/[orgSlug]/[projectSlug]` and are SSR'd for SEO. The widget is a separate iframe at `/widget/[projectKey]` served from Next.js.

**Widget distribution**: Customers paste a `<script data-key="PROJECT_KEY">` tag. The snippet injects an iframe pointing to the widget page. Free tier renders a "Powered by LaunchLog" footer link — this is the primary organic acquisition channel. Widget impressions and link clicks are tracked in `analytics_events` from day one.

**Voting + verification**: Votes are email-verified (token link). Redis tracks per-IP attempt rate. One vote per email per feature enforced at DB level.

**Notification queue**: All outbound emails (vote verification, changelog published, status changes) go through a BullMQ worker — never block API responses.

**Rich text**: TipTap JSON is stored in DB (never HTML). Rendered via `@tiptap/react` on public pages and the widget iframe.

**Tier enforcement**: Middleware checks `org.plan` before resource creation. Limits: Free (1 project, 50 articles, 1 survey), Starter (3 projects, 200 articles, 3 surveys), Pro (unlimited + teams + advanced analytics + custom domains + integrations + API).

## Database Schema (14 tables)

Core: `organizations`, `users`, `projects`, `changelog_entries`, `changelog_categories`, `roadmap_items`, `feature_requests`, `comments`, `votes`, `subscribers`, `help_articles`, `surveys`, `survey_responses`, `conversations`, `messages`, `notification_log`.

Key columns: `organizations.plan` (free|starter|pro), `projects.widget_key` (uuid, public identifier), `projects.widget_settings` + `theme_settings` (jsonb), `changelog_entries.content` + `help_articles.content` (jsonb/tiptap).

Full schema with all fields is in `PLAN.md` (lines ~70–90).

## API Structure

All routes under `/api/v1/`. Key groups:
- `/auth/*` — register, login, google OAuth, refresh, logout
- `/org` + `/org/members/*`
- `/projects/:id/*` — changelog, roadmap, features, articles, analytics, settings
- `/public/:projectKey/*` — unauthenticated, used by widget and public pages
- `/billing/*` — Stripe checkout, portal, webhook
- `/keys` (Pro only)

Full route list in `PLAN.md` (lines ~94–191).

## Development Phases

**Phase 1 (10 weeks)** — MVP core: auth, org/project CRUD, changelog, roadmap Kanban, feature voting, help center, public SSR pages, embeddable widget, basic analytics + RSS + CSV export, custom theming, Stripe billing (Free/Starter/Pro).

**Phase 1.5 (weeks 11–14)** — Live chat (Socket.io), unified inbox, surveys.

**Phase 1.6 (months 5–7)** — Team management, advanced analytics, custom domains, Slack/GitHub/Linear integrations, REST API + keys.

## Git Workflow (STRICT RULE)

**NEVER work directly on `main` or `dev`. Always create a feature branch.**

### Branch structure
- **`main`**: Production branch. Only merged into from `dev` after ALL issues in a phase are completed.
- **`dev`**: Integration branch. Only merged into from feature branches.
- **`feature/*`**: Created from `dev` for every GitHub issue. Format: `feature/issue-<number>-<short-description>`.

Flow: `feature/*` → `dev` → `main`

### Steps for every issue

1. **Move issue to "In Progress"** on the project board
2. `git checkout dev && git pull`
3. `git checkout -b feature/issue-<number>-<short-description>`
4. Do all work on the feature branch
5. **Run the mandatory 3-step review flow** (see Development Workflow below)
6. **Wait for user approval before committing. Do NOT commit until the user explicitly clears it.**
7. Pull latest dev before merging: `git checkout dev && git pull && git checkout - && git merge dev`. Resolve any merge conflicts on the feature branch first.
8. After approval, commit and merge feature branch into `dev` with `--no-ff`
9. **Move issue to "Done"**: `gh issue close <number>` and update project board status

Only after an **entire phase** is complete, merge `dev` into `main`.

## Development Workflow (Mandatory)

After completing every feature, the following 3-step review flow is **strictly required** before merging. Do not skip any step.

### Step 1 — Developer Explanation
Immediately after finishing a feature, provide a detailed explanation:

- What was done, why, and how — describe the feature, its purpose, and the approach taken
- List ALL created/modified files with a one-line purpose for each
- Explain the complete data flow through the system (e.g., UI → Provider → Repository → API/DB and back)

**Wait for the user to review before proceeding to Step 2.**

### Step 2 — Code Review
After the user has reviewed Step 1:

- Launch a `code-reviewer` agent to audit all feature code
- List ALL issues found with their respective file names
- For each issue: explain what it is, why it's a problem, and give a real-world example of the consequence if left unfixed

**Present the full list to the user and wait for their decision before proceeding to Step 3.**

### Step 3 — Fix Approved Issues
After the user has reviewed Step 2:

- Fix only the issues the user has approved — do NOT fix issues the user has not approved
- If fixes are substantial (new files, significant logic changes), repeat from Step 1 for the fixes

## Testing (Mandatory)

Every feature must include unit tests. Tests are written as part of the feature, not after — they are included in the same branch and reviewed in the 3-step review flow above.

## Key Strategic Documents

- **`PLAN.md`** — complete product roadmap, full DB schema, all API routes, phase breakdown
- **`MARKET_VIABILITY.md`** — competitive analysis, pricing rationale, unit economics, kill threshold (50 paid customers / $450–650 MRR within 12 months of launch)
