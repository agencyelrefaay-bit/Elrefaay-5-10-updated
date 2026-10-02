# لعبة الرفاعي — Al-Rifai Data Game

Mobile-first gamified app (PWA) that lives **inside the existing ERP** and works on the same Supabase/PostgreSQL database.
Employees answer one question at a time to verify/complete product data (name, sale price, cost price, category, color, image) and to count stock per location. Open it at **`/game/`** on the same server as the ERP.

## 1. Requirements
- Node.js **18+** (tested syntax on Node 22), npm
- A Supabase (or any PostgreSQL) database — the one the ERP already uses
- HTTPS in production (required for camera access and "Add to Home Screen" on phones; Railway/Render give this by default)

## 2. Install & configure
```bash
npm install
cp .env.example .env      # then fill DATABASE_URL and JWT_SECRET
```
Environment variables: see `.env.example`. **No `SUPABASE_SERVICE_ROLE_KEY` or anon key is used anywhere** — phones only talk to the Node server, and the Node server talks to Postgres via `DATABASE_URL`.

## 3. Database setup
Nothing manual: on start the server runs `supabase/migrations/20260930000000_game_schema.sql` (additive, `IF NOT EXISTS`, never touches existing tables). You can also paste that file into the Supabase SQL editor. Creates 5 tables:

| Table | Why it exists |
|---|---|
| `game_field_state` | "a human verified THIS value" per (product, field). Stores a value snapshot, so if the ERP later changes the value the verification auto-expires. Existing values stay "unverified" until confirmed. |
| `game_task_claims` | Task leases. Tasks are *derived* from unresolved fields (no millions of task rows). A partial unique index allows only one active claim per (product, task). |
| `game_task_skips` | Skip history → per-user cooldown (default 12h) so a skipped task isn't shown again immediately, but stays open for others. |
| `game_actions` | Append-only ledger: XP, streaks, achievements, idempotency (`request_id`), conflict log. XP is written by the server only. |
| `game_achievements` | Unlocked badges (definitions are in code). |

Reused as-is from the ERP: `products`, `categories`, `locations`, `inventory`, `inventory_count_sessions/entries`, `users` (+JWT login), `audit_log`, `/uploads/products` image folder.
RLS is enabled (no policies) on all game tables so Supabase's public REST API can't read/write them.

## 4. Run
```bash
npm start            # http://localhost:5000/game/
```
Log in with an existing ERP user. Roles: data tasks → admin/manager/sales/warehouse; inventory → admin/manager/warehouse; dashboard → admin/manager (override with `GAME_DATA_ROLES` / `GAME_INVENTORY_ROLES`). Cost-price tasks are only given to users who can see cost prices.

### Phones
- **Android:** open `https://<your-domain>/game/` in Chrome → ⋮ → *Install app* / *Add to Home screen*. For local testing on USB: `adb reverse tcp:5000 tcp:5000` then open `http://localhost:5000/game/` (camera needs HTTPS or localhost).
- **iPhone:** open the URL in Safari → Share → *Add to Home Screen*. No Mac/Xcode needed.
- **Why PWA, not React Native/Flutter/Unity:** the ERP is already a Node + vanilla-JS PWA with its own JWT auth and disk image storage; a PWA reuses all of it, ships instantly to every phone, supports camera/gallery, and needs no store builds. A game engine would add weight with no benefit here.
- **APK/AAB/iOS build:** not required. If you ever want a store listing, wrap `/game/` with Capacitor or a Trusted Web Activity.

## 5. Concurrency design (all in the database)
1. `claimNext` runs in one transaction: expire stale leases → resume the user's own active claim → pick candidates ordered by priority → `INSERT … ON CONFLICT (product_id, task_key) WHERE status='active' DO NOTHING`. Whoever inserts first wins; the others move to the next candidate.
2. Answers lock the claim row and product row (`FOR UPDATE`), then check: owner, status, `request_id` (duplicate submit → same stored result), and the `token` (value shown to the user vs current DB value → `STALE_VALUE` if the ERP changed it meanwhile).
3. Abandoned tasks: lease (5 min, heartbeat every 90 s) simply expires.
4. Image upload: server validates magic bytes, saves `p<productId>-<timestamp>-<random>.<ext>`, updates `image_path` in a transaction, deletes the new file if the DB step fails. Old images are never deleted.
5. Inventory: one active session per location (existing unique index), same claim mechanism per `(product, 'count:<location>')`, counts saved as **drafts** in `inventory_count_entries`; real stock only changes when a manager finalizes via the existing ERP count screen (so inventory stays auditable and the ERP's logic isn't duplicated).

Product "complete" = none of the 6 fields needs work (each is verified against its current value; image must exist and be confirmed/uploaded). Completing a product gives a one-time bonus (unique index).

## 6. Tests
```bash
npm run test:unit          # 19 tests, no DB needed (validation, XP, levels, streaks, SQL-shape, service flows with a fake DB)
TEST_DATABASE_URL=postgresql://…/erp_test npm run test:integration   # REAL Postgres concurrency tests
```
⚠️ Use a **separate test database** (its name must contain `test`; the test refuses otherwise). The integration test covers: 10 users claiming at once, duplicate submit, skip, lease expiry, ERP-changes-value invalidation, concurrent inventory.

## 7. Troubleshooting
| Symptom | Fix |
|---|---|
| Server won't start, DB error | Check `DATABASE_URL`; on Supabase use the **session pooler** (port 5432) and `DATABASE_SSL=true`. |
| `permission denied` / RLS error on game tables | The server must connect as the owner (`postgres` user). Don't use the anon/authenticated role. |
| Login says session expired | Token is shared with the ERP (`arToken`); log in again. |
| Camera button opens nothing (iOS) | Page must be HTTPS. |
| Photos vanish after redeploy | Uploads live on local disk (`src/uploads/products`) as in the ERP — mount a persistent volume (Railway/Render) or move to object storage. |
| "طلبات كتير" (429) | Game API limit is 6000 req/15 min per IP; raise `max` in `server.js` (`gameLimiter`) for very large offices. |
| ERP screen shows the game page offline | Fixed: `public/sw.js` now ignores `/game/*`. Hard-refresh once so the new service worker installs. |
