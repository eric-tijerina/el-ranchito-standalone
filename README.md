# El Ranchito RV Park — off Render (Cloudflare Pages + D1)

Site + record-book backend together, in one Cloudflare Pages project.
No Render, no free-hours suspension, no bridge dependency.

## What moved

- `public/index.html` — marketing homepage (unchanged, was on Render static site)
- `public/manage/index.html` — manager app (one line changed: `API_BASE` from
  `https://mini-tollbooth.onrender.com/park` → `/park`, same-domain)
- `functions/park/auth.js` + `functions/park/state.js` — the `/park` backend,
  same behavior as old `park-sync.js`:
  - `POST /park/auth {password}` → `{token}` | 401 | 503
  - `GET /park/state` (Bearer) → `{state, updatedAt}`
  - `POST /park/state` (Bearer, `{state, updatedAt}`) → last-write-wins
  - 30-day HMAC tokens, 10 auth attempts / IP / min, 5 MB bodies, CORS for elranchitorvpark.com
- `functions/_lib.js` — auth/state helpers. Auth is PBKDF2-SHA256 (WebCrypto,
  100k iters). Old backend used scrypt; the *password stays the same* — the new
  backend re-derives a PBKDF2 hash from `PARK_PASSWORD` on first setup.
- `schema.sql` — D1 tables `park_state` (single row id=1) + `park_meta` (auth hash + token secret)
- `wrangler.toml` — Pages project `el-ranchito-rv-park`

## Data migration (no server copy needed)

The old bridge `/park` state is unreachable while the bridge is suspended, and
Render ephemeral disk is not the source of truth anyway. The phones are:

1. Deploy new backend with empty D1.
2. Eric (or Andrea) opens `elranchitorvpark.com/manage/` on the phone that has
   the freshest record book, enters the SAME park password.
3. The manager app loads the phone's localStorage copy, sees server is older,
   and pushes it up (existing `loadSharedState` logic). Record book restored.
4. Second phone then pulls from server. Verify a tenant row + a payment row match.

Do NOT wipe phone localStorage before step 2-3 verify.

## Deploy (his-hands: Cloudflare account + DNS)

Mini prepared everything. Eric does the account + DNS steps — Cloudflare
signup needs his email verification, and DNS points his domain.

1. **Cloudflare account** (his hands): sign up at dash.cloudflare.com, verify email.
   Free plan is enough. No card needed for Pages + Workers + D1 free tiers.
2. **Create D1**: `npx wrangler d1 create el-ranchito-park` → paste `database_id`
   into `wrangler.toml` (replace PLACEHOLDER). Then:
   `npx wrangler d1 execute el-ranchito-park --file=./schema.sql --remote`
3. **Deploy**: `npx wrangler pages deploy public`
   (or: Cloudflare dashboard → Pages → Create → Upload assets → upload `public/`
   + `functions/`, connect D1 binding `PARK_DB`.)
4. **Set one-time password**: Dashboard → Pages → el-ranchito-rv-park →
   Settings → Variables → Add `PARK_PASSWORD` = the SAME park password Eric +
   Andrea already use. Never put it in chat/files. After first successful login,
   DELETE `PARK_PASSWORD` from env (hash is now in D1).
5. **Point domain**: In Cloudflare (or Namecheap, wherever DNS lives):
   `elranchitorvpark.com` → Cloudflare Pages custom domain. Add custom domain
   in Pages → Custom domains → `elranchitorvpark.com` + `www` if used.
   Wait for SSL (usually minutes). Verify homepage + `/manage/` load over HTTPS.
6. **Verify**: open `/manage/`, log in with same password, confirm record book
   pushed from phone, then open on second phone and confirm it pulls.
7. **Retire Render**: only AFTER verify passes — leave the old Render static
   site + bridge `/park` alone for a week as rollback, then suspend/delete the
   Render static site (NOT the bridge — bridge is separate).

## Rollback

If anything fails in step 5-6: point DNS back to Render. Old site + old
`/park` still exist until step 7. Phone localStorage is untouched by the move.

## Costs

$0 on Cloudflare free tiers (Pages + Workers + D1) at park scale.
No card required for these tiers.

## What Mini did NOT do

- No DNS change, no Cloudflare account created, no password seen or stored.
- No deploy run — deploy needs Eric's Cloudflare login / token.
- Old Render site left running as rollback until Eric says to retire it.
