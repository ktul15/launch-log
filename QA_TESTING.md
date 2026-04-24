# LaunchLog — QA Testing Guide

## Step 0 — Environment Setup

### Prerequisites
- Docker Desktop running
- Node.js 18+ installed

### Start infrastructure
```bash
cd /Users/mobilions/development/launch_log
docker compose up -d
```
Verify: `docker compose ps` — both `postgres` and `redis` show `healthy`.

### Run migrations + generate Prisma client
```bash
cd backend
npm run migrate    # applies all 3 migrations
npm run generate   # generates Prisma client
cd ..
```

### Install all dependencies
```bash
npm install        # from root — installs all workspaces
```

### Start servers (2 terminals)
```bash
# Terminal 1
npm run dev:backend    # Fastify on :3001

# Terminal 2
npm run dev:web        # Next.js on :3000
```

Verify backend: `curl http://localhost:3001/health` → `{"status":"ok",...}`
Verify web: open `http://localhost:3000`

---

## Step 1 — Authentication

### 1a. Registration
1. Go to `http://localhost:3000/login`
2. Toggle to "Register"
3. Fill: org name, your name, email, password
4. Submit → should redirect to `/onboarding` or `/dashboard`

**Check:**
- No error toast
- Redirect happens
- Browser has `access_token` cookie (httpOnly — check via DevTools → Application → Cookies)

### 1b. Login
1. Logout (if logged in)
2. Go to `/login`
3. Enter credentials from step 1a

**Check:**
- Redirects to dashboard
- Cookie renewed

### 1c. Wrong password
1. Login with wrong password

**Check:** Error message shown, no redirect

### 1d. Token refresh (passive)
- Manually clear `access_token` cookie, keep `refresh_token`. Perform any dashboard action.

**Check:** Auto-refresh happens transparently (no logout)

### 1e. Logout
1. Clear cookies manually or click logout
2. Navigate to `/dashboard`

**Check:** Redirects to `/login`

### 1f. Google OAuth — SKIP
Test credentials are fake. OAuth will fail at Google's side.

---

## Step 2 — Onboarding

1. Register a fresh account (new email)
2. Should land on `/onboarding`

**Check:**
- Wizard shows steps (org name, project creation)
- Complete wizard → lands on `/dashboard`

---

## Step 3 — Organization Settings

1. Go to org settings (nav link in dashboard)
2. Update org name or slug

**Check:** PATCH saves, slug change reflects in URL slugs

---

## Step 4 — Projects CRUD

### 4a. Create project
1. Go to `/dashboard/projects`
2. Click "New Project"
3. Fill name, description, submit

**Check:** Project appears in list with widgetKey

### 4b. Edit project
1. Click edit on project
2. Change name/description

**Check:** Changes persist on reload

### 4c. Delete project
1. Click delete → confirm dialog → confirm

**Check:** Project removed from list (soft-deleted, `isActive=false`)

### 4d. Plan limit (Free = 1 project)
1. With Free tier: try creating a 2nd project

**Check:** Error: plan limit message shown

---

## Step 5 — Changelog

Navigate to `/dashboard/projects/[projectId]/changelog`

### 5a. Create draft entry
1. Click "New Entry"
2. Fill title, write rich text in TipTap editor
3. Save as draft

**Check:** Entry appears with "draft" badge

### 5b. Publish entry
1. Open draft → edit
2. Change status to "published" → save

**Check:** Status badge changes to "published"

### 5c. Archive entry
1. Change status to "archived" → save
2. Try editing archived entry → save again

**Check:** Archive saves; further edits blocked (expect error)

### 5d. Filter by status
1. Use status filter dropdown (draft / published / archived)

**Check:** List filters correctly

### 5e. Categories
1. Create a category
2. Assign to an entry
3. Delete the category

**Check:** Attach/detach works

---

## Step 6 — Roadmap

Navigate to `/dashboard/projects/[projectId]/roadmap`

### 6a. Create roadmap items
1. Create items in each column: Planned, In Progress, Shipped

**Check:** Items appear in correct column

### 6b. Edit item
1. Click item → edit modal
2. Change status

**Check:** Item moves to correct column

### 6c. Reorder items
1. Drag item within same column

**Check:** Order persists on reload

### 6d. Delete item
1. Delete → confirm

**Check:** Removed from board

---

## Step 7 — Feature Requests (Admin)

Navigate to `/dashboard/projects/[projectId]/features`

### 7a. Create feature
1. Create a feature request (title, description, status)

**Check:** Appears in list

### 7b. Filter by status
1. Use status filter (open / planned / in_progress / shipped / closed)

**Check:** Filters work

### 7c. Delete feature
1. Delete → confirm

**Check:** Removed

---

## Step 8 — Public Pages (SSR)

Get `orgSlug` and `projectSlug` from project settings.
Public URL: `http://localhost:3000/[orgSlug]/[projectSlug]`

### 8a. Changelog tab
1. Open public URL → Changelog tab

**Check:**
- Only PUBLISHED entries visible (drafts/archived hidden)
- Rich text rendered correctly
- Expand/collapse works

### 8b. Roadmap tab
1. Click Roadmap tab

**Check:**
- Color-coded Kanban columns (planned / in_progress / shipped)
- Items in correct columns
- Keyboard navigation accessible (Tab/Enter)

### 8c. Features tab
1. Click Features tab

**Check:** Feature list with vote counts, submit form visible

### 8d. SSR verification
1. View page source (`Cmd+U` or `Ctrl+U`)

**Check:** HTML contains actual data (not just `<div id="__next"></div>`) — confirms SSR working

---

## Step 9 — Public Feature Voting Flow

### 9a. Submit a feature (public)
1. Features tab → submit new feature
2. Enter title, description, email

**Check:** Success message, feature appears in list

### 9b. Vote on feature
1. Click upvote → enter email

**Check:** Vote pending verification message shown

### 9c. Verify vote via Prisma Studio (email not configured)
```bash
cd backend
npx prisma studio   # opens http://localhost:5555
# votes table → token column → copy token
```
Then open: `http://localhost:3000/verify/vote?token=YOUR_TOKEN`

**Check:** Success page shown, vote count increments on public page

### 9d. Duplicate vote prevention
1. Vote again from same email

**Check:** Error: already voted

### 9e. Rate limiting
1. Vote 6+ times from same IP within an hour

**Check:** 429 rate limit error

---

## Step 10 — Subscribe Flow

1. On public page, enter email in subscribe input
2. Submit

**Check:** Success message shown

Verify via Prisma Studio → `subscribers` table → row created with token

---

## Step 11 — Widget Embed

### 11a. Verify embed code
1. Public page → Widget tab (if present)
2. Copy the `<script>` snippet
3. Create test HTML file, paste snippet, open in browser

**Check:** iframe loads, "Powered by LaunchLog" footer visible

---

## Step 12 — API Health Check

```bash
curl http://localhost:3001/health
curl http://localhost:3001/api/v1
```

**Check:** Both return JSON `{"status":"ok",...}`

---

## Step 13 — Run Unit Tests

```bash
# Backend tests
cd /Users/mobilions/development/launch_log/backend
npm test

# Web tests
cd /Users/mobilions/development/launch_log/web
npm test
```

**Check:** All tests pass (green)

---

## Step 14 — Protected Routes (Middleware)

1. Open incognito browser (no cookies)
2. Navigate to `http://localhost:3000/dashboard`

**Check:** Redirects to `/login`

---

## Known Limitations During Testing

| Feature | Status | Notes |
|---------|--------|-------|
| Email delivery | Not working | `RESEND_API_KEY` not set — emails queued but not sent. Use Prisma Studio to grab tokens manually. |
| Google OAuth | Not working | Test credentials only |
| R2 image upload | Not working | R2 credentials not set |
| Stripe billing | Not working | Not configured |
| Live chat | Not built | Phase 1.5 |
| Surveys | Not built | Phase 1.5 |

### Prisma Studio (inspect DB directly)
```bash
cd backend
npx prisma studio   # opens http://localhost:5555
```
Use this to grab verification tokens, inspect votes, subscribers, changelog entries, etc.
