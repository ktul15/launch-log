# LaunchLog — Running the project locally

> Goal: take a fresh checkout of this repo and reach the point where you can register an account, create a project, publish a changelog entry, embed the widget on a static page, and complete a Stripe test-mode upgrade — all on `localhost`.

For what each feature does, see [`FEATURES.md`](./FEATURES.md). For test scenarios once you're running, see [`TESTING.md`](./TESTING.md).

---

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Docker Desktop | latest | Used for local Postgres + Redis |
| Node.js | ≥ 18 | Enforced by root `package.json` `engines` |
| npm | ≥ 9 | Bundled with Node 18+; this repo uses npm workspaces |
| `git` | any | |
| `gh` CLI | any | Optional, for issue/PR work |
| Stripe CLI | latest | Optional but required for testing webhooks locally |

macOS/Linux are the supported development platforms. Commands assume `bash` or `zsh`. On Windows, run the same commands inside WSL2.

---

## 2. Clone and install

```bash
git clone <repo-url> launch_log
cd launch_log
git checkout dev
npm install
```

`npm install` from the repo root installs all three workspaces (`backend`, `web`, `widget`).

---

## 3. External service accounts (one-time setup)

The backend will start with **none** of these configured — they are validated lazily, the first time each is used. You can complete the auth and changelog flows without Stripe, R2, Resend, or Google. But to exercise every feature end-to-end you need all four.

### 3.1 Google OAuth (optional — only if you want to test "Sign in with Google")

1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Create a project (or pick an existing one).
3. Configure the OAuth consent screen (External, "Testing" mode is fine for dev).
4. Create credentials → OAuth client ID → "Web application".
5. Authorized redirect URI: `http://localhost:3001/api/v1/auth/google/callback`.
6. Copy the client ID (must end with `.apps.googleusercontent.com` — Zod validates this) and client secret.

### 3.2 Stripe (optional — only if you want to test billing)

1. Sign up at [stripe.com](https://stripe.com), keep the dashboard in **Test mode** (toggle in the top-right).
2. Copy your **Secret key** from "Developers → API keys" (starts with `sk_test_`).
3. Add it to `backend/.env` as `STRIPE_SECRET_KEY=sk_test_...`.
4. Run `npm run stripe:setup -w backend`. The script is idempotent (looks up products by metadata slug, prices by lookup key) and prints four price IDs.
5. Copy those four IDs into `backend/.env`:
   ```
   STRIPE_STARTER_MONTHLY_PRICE_ID=price_...
   STRIPE_STARTER_ANNUAL_PRICE_ID=price_...
   STRIPE_PRO_MONTHLY_PRICE_ID=price_...
   STRIPE_PRO_ANNUAL_PRICE_ID=price_...
   ```
6. Install the Stripe CLI (`brew install stripe/stripe-cli/stripe` on macOS, see [docs](https://docs.stripe.com/stripe-cli) elsewhere).
7. `stripe login` once.

The webhook secret comes from `stripe listen` (see §7 below) — copy the line printed at startup into `STRIPE_WEBHOOK_SECRET=whsec_...` in `backend/.env`. Note that `STRIPE_WEBHOOK_SECRET` must literally start with `whsec_` (Zod regex enforces this).

### 3.3 Resend (optional — only if you want emails to actually leave your machine)

1. Sign up at [resend.com](https://resend.com).
2. Verify a domain (`onboarding@resend.dev` works for "from" only with the limited test address — for real testing add a domain you control).
3. Generate an API key.
4. Set in `backend/.env`:
   ```
   RESEND_API_KEY=re_...
   RESEND_FROM_EMAIL=notifications@your-verified-domain.com
   ```

If `RESEND_API_KEY` is unset, every email-sending function returns `{ ok: false, error: 'Resend not configured…' }` and the BullMQ jobs fail and retry — useful to know if you skipped this and notifications appear "stuck".

### 3.4 Cloudflare R2 (optional — only for image upload in changelog and org logo)

1. Cloudflare dashboard → R2 → create a bucket.
2. R2 → Manage R2 API Tokens → create one with "Object Read & Write" on the bucket.
3. Copy access key, secret, the S3-compatible endpoint (`https://<account>.r2.cloudflarestorage.com`), and the public URL (either an `r2.dev` subdomain or a custom domain you set up — this is **not** the same as the API endpoint).
4. Set in `backend/.env`:
   ```
   R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=...
   R2_BUCKET=launchlog-dev
   R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
   R2_PUBLIC_URL=https://pub-xxxxx.r2.dev
   ```
5. Bucket CORS — allow `PUT` from `http://localhost:3000` so the browser can complete the presigned upload:
   ```json
   [{ "AllowedOrigins": ["http://localhost:3000"],
      "AllowedMethods": ["PUT"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"] }]
   ```

The R2 vars are an all-or-nothing group. Setting some without others is a startup error (Zod `superRefine` in `backend/src/config/env.ts`).

---

## 4. Environment variables

```bash
cp backend/.env.example backend/.env
```

`web/` does not currently need its own `.env` — defaults route to `http://localhost:3001` for the backend and `http://localhost:3000` for the frontend. If you change these, set `BACKEND_URL` (server-side, never `NEXT_PUBLIC_API_URL` for SSR-side fetches) before running `npm run dev:web`.

### Generate JWT secrets

`JWT_SECRET` and `JWT_REFRESH_SECRET` must each be ≥ 32 characters or the backend will refuse to start. Generate them once:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run that twice and paste the two values into `backend/.env`.

### Reference table

Required for backend startup:

| Var | Default | Source |
|---|---|---|
| `NODE_ENV` | `development` | leave as default |
| `PORT` | `3001` | |
| `LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error`/`fatal` |
| `DATABASE_URL` | `postgresql://launchlog:launchlog@localhost:5433/launchlog_dev` | matches `docker-compose.yml` |
| `REDIS_URL` | `redis://default:launchlog@localhost:6379` | |
| `REDIS_PASSWORD` | `launchlog` | exposed separately for BullMQ |
| `JWT_SECRET` | — required | generate per above |
| `JWT_REFRESH_SECRET` | — required | generate per above |
| `JWT_ACCESS_EXPIRES_IN` | `15m` | format: `\d+[smhd]` or seconds |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | |
| `CORS_ORIGIN` | `http://localhost:3000` | comma-separated origins, no path/query/hash |
| `APP_URL` | `http://localhost:3001` | public backend URL — used to build the Google OAuth callback |

Required only for specific features (validated lazily):

| Group | Vars | Required when |
|---|---|---|
| Resend | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `FRONTEND_URL` | sending any email |
| Stripe checkout | `STRIPE_SECRET_KEY`, `STRIPE_STARTER_MONTHLY_PRICE_ID`, `STRIPE_STARTER_ANNUAL_PRICE_ID`, `STRIPE_PRO_MONTHLY_PRICE_ID`, `STRIPE_PRO_ANNUAL_PRICE_ID` | hitting `/api/v1/billing/checkout` or `/portal`. All-or-nothing |
| Stripe webhook | `STRIPE_WEBHOOK_SECRET` | only when receiving webhooks (`stripe listen`); requires `STRIPE_SECRET_KEY` |
| R2 | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`, `R2_PUBLIC_URL` | image upload + logo upload. All-or-nothing |
| Google OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | "Sign in with Google" button. All-or-nothing |

If any field-level validation fails the backend exits with a list of issues — it does not start in a half-configured state.

---

## 5. Start infrastructure (Docker)

```bash
docker compose up -d
docker compose ps
```

Both services should report `healthy`:

| Service | Image | Host port |
|---|---|---|
| `postgres` | `postgres:16-alpine` | `127.0.0.1:5433` |
| `redis` | `redis:7-alpine` | `127.0.0.1:6379` |

Note that Postgres is on host port **5433**, not 5432, to avoid collisions with any local Postgres install.

To override credentials, create a root-level `.env` (not the backend one) with `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `REDIS_PASSWORD` — `docker-compose.yml` reads these. The backend's `DATABASE_URL` and `REDIS_URL` then need to match.

---

## 6. Initialize the database

```bash
npm run migrate -w backend     # applies all 5 migrations
npm run generate -w backend    # regenerates the Prisma client
```

There is no seed script — register the first user via the UI. Five migrations exist as of this writing (`20260420094345_init` through `20260429000001_soft_delete_and_voter_unsubscribe`).

If you want to inspect the DB visually:

```bash
npx prisma studio --schema backend/prisma/schema.prisma
```

To start over from scratch (destroys all data):

```bash
npx prisma migrate reset --schema backend/prisma/schema.prisma
```

---

## 7. Run the app

You need three terminals (four with billing tests). Each `npm run dev:*` command persists in its own terminal — do not background them, as you'll want to read their logs.

### Terminal 1 — backend (Fastify on `:3001`)

```bash
npm run dev:backend
```

Confirm:

```bash
curl http://localhost:3001/health
# {"status":"ok","timestamp":"…"}
```

### Terminal 2 — web (Next.js on `:3000`)

```bash
npm run dev:web
```

Open `http://localhost:3000` in a browser. The landing redirects to `/login`.

### Terminal 3 — widget (esbuild, optional)

Only needed when you're iterating on `widget/src/index.js` itself:

```bash
npm run dev:widget
```

This watch-builds `widget/dist/widget.js` (unminified, with sourcemap). For a production build with the 5 KB size guard:

```bash
npm run build -w widget
```

The build script `console.error`s and exits non-zero if the bundle exceeds 5120 bytes.

### Terminal 4 — Stripe webhooks (only when testing billing)

```bash
stripe listen --forward-to localhost:3001/api/v1/billing/webhook
```

Stripe CLI prints `> Ready! Your webhook signing secret is whsec_…` — copy that into `backend/.env` as `STRIPE_WEBHOOK_SECRET=whsec_…` and **restart the backend** (env is read at startup).

---

## 8. Smoke test (5 minutes)

1. Open `http://localhost:3000` → redirects to `/login`.
2. Toggle to "Register". Fill org name, your name, an email, and an 8+ char password.
3. Submit → land on `/onboarding`.
4. Complete the wizard → land on `/dashboard`.
5. Open `/dashboard/projects` → first project is already there.
6. Click into the project → `/dashboard/projects/[projectId]/changelog`. Click "New entry", write something in the TipTap editor, click "Publish".
7. View the public page at `http://localhost:3000/<orgSlug>/<projectSlug>`. The entry is there.

If everything above worked, you have a fully working install. The remaining sections cover building the widget, testing email, and testing Stripe.

---

## 9. Embedding the widget on a test page

Build the widget (or run the watch task in §7) so that `widget/dist/widget.js` exists. Serve it on a static page:

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Widget test</title></head>
<body>
  <h1>Customer site</h1>
  <p>Some content above the widget.</p>
  <script src="http://localhost:8080/widget.js"
          data-key="<paste-widget-key-from-project-detail>"
          data-mode="floating"
          data-position="bottom-right"></script>
</body></html>
```

Quickest way to serve `widget/dist/`:

```bash
cd widget/dist
npx http-server -p 8080 --cors
```

Open the test HTML over `http://localhost:8080/` (or any other origin) — the floating button appears bottom-right and clicking it loads `http://localhost:3000/widget/<projectKey>` in a sandboxed iframe.

The widget's hard-coded `WIDGET_BASE_URL` is `https://widget.launchlog.app`. To point at localhost for development, edit `widget/src/index.js:35` temporarily — there is no env override yet (this is intentional: the snippet is meant to be dropped on customer sites unmodified).

---

## 10. Common operations

### Inspect BullMQ jobs in Redis

```bash
docker compose exec redis redis-cli -a launchlog KEYS "bull:*"
docker compose exec redis redis-cli -a launchlog LRANGE bull:email-notifications:wait 0 -1
```

### Tail backend logs

`pino-pretty` is enabled in development — logs are human-readable in the terminal running `npm run dev:backend`.

### Re-run migrations after a schema change

```bash
npm run migrate -w backend     # creates a new migration if schema differs
npm run generate -w backend    # client out of sync? regenerate it
```

### Build everything for production

```bash
npm run build
```

This runs `tsc` (backend), `next build` (web), and the widget build. To run the compiled backend: `npm start -w backend`.

---

## 11. Production notes

These docs cover local development, not deployment, but the relevant differences:

- `NODE_ENV=production` makes cookies `secure=true` (HTTPS only), Pino emit JSON, and disables `pino-pretty`.
- `CORS_ORIGIN` should be the comma-separated list of real frontend origins.
- `APP_URL` and `FRONTEND_URL` must point to the public domains.
- Stripe live keys (`sk_live_…`) and a live webhook endpoint registered in the Stripe dashboard.
- Resend verified production domain.
- A production R2 bucket with CORS limited to your frontend origin.
- Run `npm run migrate:deploy -w backend` (not `migrate dev`) — it applies migrations without prompting.

---

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Backend exits immediately with "Invalid or missing environment variables" | `.env` is missing required vars or formatted incorrectly | Read the printed list — each issue is `path: message`. Common: `JWT_SECRET` shorter than 32 chars, `STRIPE_*` partial group |
| Backend logs `EADDRINUSE :::3001` | Another process on port 3001 | `lsof -i :3001` and kill, or change `PORT` |
| `docker compose up` hangs / `port is already allocated` on 5433/6379 | Local Postgres or Redis on those ports | Stop them, or change ports in `docker-compose.yml` and `DATABASE_URL`/`REDIS_URL` |
| Cannot register: 503 from `/auth/google` | `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` unset | Either set them or use email/password registration. Google sign-in is optional |
| OAuth redirects fail with `redirect_uri_mismatch` | Google Cloud Console authorized redirect URI doesn't match `${APP_URL}/api/v1/auth/google/callback` | Update either side |
| Notification emails never arrive | `RESEND_API_KEY` unset, or `RESEND_FROM_EMAIL` on an unverified domain (silent fail) | Set the API key and verify the domain |
| Image upload returns 503 | R2 vars unset | Configure all 5 R2 vars |
| Image upload returns 200 from backend but PUT to R2 returns 403 | R2 token doesn't have write permission, or bucket CORS blocks `PUT` from `localhost:3000` | Re-issue token with write scope; add CORS rule (§3.4) |
| Stripe checkout returns 503 | `STRIPE_SECRET_KEY` unset | Run setup script per §3.2 |
| Stripe webhook returns 400 "Invalid signature" | `STRIPE_WEBHOOK_SECRET` doesn't match the secret printed by `stripe listen` | Copy the secret again, restart backend |
| `(admin)/layout.tsx` redirects you to `/login` even when logged in | Backend is unreachable from Next.js (timeout) | Check `BACKEND_URL` (only set if you moved the backend off `:3001`); confirm backend is running |
| Public page returns 500 | Backend `/public/resolve/...` 5xx, often R2/DB unreachable | Check backend logs; restart docker services if Postgres/Redis are unhealthy |
| Tests pass locally but rate-limit-related assertions fail intermittently | Stale Redis state across runs | `docker compose restart redis` and re-run |
| Prisma client throws `did not initialize yet` after schema change | Generated client is stale | `npm run generate -w backend` |

If something else breaks, the backend pino log line for the failing request (look for `level=50` or `error` entries) almost always names the root cause directly. Internal errors are normalized to a generic message in the HTTP response (don't expect 5xx response bodies to contain useful detail).
