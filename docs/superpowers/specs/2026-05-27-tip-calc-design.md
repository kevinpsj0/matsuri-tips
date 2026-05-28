# Sushi Restaurant Tip Calculator — Design Spec

**Date:** 2026-05-27
**Status:** Approved for implementation (revised after round 1 review)

## Problem

A sushi restaurant has no server-side computers. After each shift, servers need a way (from their own phones) to record shift info and have the tip pool split automatically. The owner needs a single ledger of all shifts.

## Goals

1. Server enters shift data on phone in under 30 seconds
2. Tip split is calculated correctly and shown before submission
3. Every shift is recorded permanently in a place the owner controls (Google Sheet)
4. Zero ongoing cost, zero server infrastructure to maintain
5. Deployable in one day with no developer tooling at the restaurant

## Non-Goals

- User accounts, authentication, role-based access (small trusted team)
- Editing or deleting past shift records from the form (owner edits the Sheet directly)
- Reporting, charts, analytics (Sheets handles that)
- Offline mode (the form needs network to post to the Sheet)

## Tip Split Rules

Given a total tip amount `T` (in cents, integer math):

| Bucket | Amount |
|--------|--------|
| Kitchen | `round(T * 0.10)` |
| Chefs | initially `round(T * 0.45)`, plus residual cents (see Rounding) |
| Server pool | `T * 0.45` |

Server pool is split by **fractional shares**.

**Units note:** The trainee level is sent on the wire and stored in the sheet as an integer (25, 50, or 75). For the math below, `trainee_pct` is the decimal form — wire 25 becomes `0.25`, wire 50 becomes `0.50`, wire 75 becomes `0.75`.

- Each full server counts as 1 share
- A trainee counts as `trainee_pct` shares (0.25, 0.50, or 0.75)
- `total_shares = num_servers + (trainee_pct if trainee_present else 0)`
- `per_share = server_pool / total_shares`
- `each_server_gets = per_share`
- `trainee_gets = per_share * trainee_pct`

**Example:** Tips = $1000, 2 servers + 1 trainee at 50%

- Kitchen: $100, Chefs: $450, Server pool: $450
- Shares: 1 + 1 + 0.5 = 2.5
- Per share: $180; each server $180; trainee $90
- Sum: 100 + 450 + 180 + 180 + 90 = 1000

### Rounding (deterministic)

Compute in **integer cents** throughout. All payouts in the ledger are whole cents.

`T_cents = Math.round(totalTips * 100)` — the server normalizes here, so a client that sends 100.005 still gets sane math.

1. `kitchen_cents = Math.round(T_cents * 0.10)` (JavaScript half-up rounding)
2. `pool_cents = Math.round(T_cents * 0.45)`
3. `per_server_cents = Math.floor(pool_cents / total_shares)` for a full server (1 share)
4. `trainee_cents = Math.floor(pool_cents * trainee_pct / total_shares)` if trainee
5. `chefs_cents = T_cents - kitchen_cents - (num_servers * per_server_cents) - (trainee_cents if trainee else 0)`

Chefs absorb every cent of residual (including the rounding remainder from steps 1-4). This keeps:
- Every individual server's payout equal (column K is a single value)
- Trainee's payout proportional to their level, within 1 cent of `per_server * trainee_pct`
- The ledger sum exactly equal to `T_cents`

This rule is the same on the client (live preview) and on the server (authoritative computation). The script is the source of truth; the client preview is a UX echo. Two implementations of the same algorithm always agree because the inputs are integer cents and the operations are deterministic.

## Architecture

```
+--------------------+        +-----------------------+        +---------------+
|  index.html        |  POST  | Google Apps Script    | append |               |
|  (Netlify-hosted   | -----> | web app (doPost):     | -----> | Google Sheet  |
|   form on phone)   |   JSON | validate, compute,    |   row  |   (ledger)    |
|  raw inputs +      |        | dedupe, lock, write   |        |               |
|  submissionId      |        |                       |        |               |
+--------------------+        +-----------------------+        +---------------+
```

**Source-of-truth principle:** the script computes the splits and writes them. The HTML form only sends raw inputs. The form computes the same numbers locally for a live preview, but those numbers are never persisted; the script's response is what gets shown after submit.

### Component 1: `index.html`

Single static page. No build step, no framework. Vanilla HTML + CSS + JS.

**Responsibilities:**
- Render mobile-first form
- Compute the same split locally to drive a live preview
- Validate inputs before submit
- Generate a `submissionId` (UUID) on form load
- POST JSON (raw inputs + submissionId) to the Apps Script endpoint
- Show server-returned splits in the confirmation; on error keep form populated

**Form fields:**

| Field | Type | Notes |
|-------|------|-------|
| Your name | text | Required. Free text; identifies who submitted the record. May or may not match a server name below. |
| Total tip amount | number ($) | Required, >= 1.00, two decimals |
| Number of full servers | stepper 1-6 | Count of full servers only. Trainee (if any) is counted separately via the toggle. |
| Server names | N text inputs | One per `Number of full servers`, all required. The entering person types their own name here if they were a server on the shift. |
| Trainee on shift | toggle | If on, reveals next two fields |
| Trainee name | text | Required when toggle on |
| Trainee level | 3 buttons | 25% / 50% / 75%. Defaults to 50% when toggle activates. |

**Preview area** (live, before submit) shows:

```
Kitchen           $XX.XX
Chefs             $XX.XX
[Server name 1]   $XX.XX
[Server name 2]   $XX.XX
[Trainee name]    $XX.XX (50%)
                  ──────
Total             $XX.XX  (matches tip amount)
```

**Submit behavior:**
- Disable button during request
- POST with `Content-Type: text/plain;charset=utf-8` and a JSON string body (skips CORS preflight; see CORS / transport note below)
- On success: show confirmation rendered from the **server's** returned splits. If the response includes `dedup: true`, label the confirmation "Previously recorded shift" so the user knows the row was already in the ledger from a prior attempt. Offer "Record another shift" button that resets the form (and generates a new `submissionId`).
- On error: show one of two messages (see Error Handling). Keep form populated; same `submissionId` is reused on retry (idempotent server).

### Component 2: Google Apps Script (`apps-script.gs`)

Server-side script bound to the Google Sheet. Deployed as a "Web app" with execute-as: me, access: anyone.

**Responsibilities (in order):**
1. Parse and validate the JSON payload shape. On validation failure, return `{ ok: false, retryable: false, error }` immediately (no lock needed).
2. Acquire `LockService.getScriptLock()` with a 10-second timeout. If the lock cannot be acquired, return `{ ok: false, retryable: true, error: "Sheet busy, please try again." }` — the client treats this like a network error (retryable), not like a validation error.
3. Scan column M for `submissionId`. If found, read the existing row's columns I/J/K/L, **release the lock**, and return `{ ok: true, dedup: true, splits: { kitchen: I, chefs: J, perServer: K, trainee: L (omit if blank) } }`. Capture the row index during the scan so it's a single pass.
4. Compute the canonical splits (same algorithm as the client preview), using `T_cents = Math.round(totalTips * 100)` so a non-2-decimal client input still produces clean integer math.
5. Append a row with date/time (in the Sheet's spreadsheet timezone), inputs, splits (as dollars with two decimals), and `submissionId`.
6. Release the lock; return `{ ok: true, dedup: false, splits }`.
7. On any unexpected exception, **release the lock if held** and return `{ ok: false, retryable: true, error: "<short message>" }`. Implementation tip: wrap steps 2-6 in `try { ... } finally { lock.releaseLock(); }` so the lock is always released exactly once on every exit path (early return, success, or exception).

**Lock release invariant:** the lock must be released on every exit path after step 2 — dedup hit, normal success, and exception. Use `try`/`finally` to enforce this in code; the spec calls it out explicitly because a missed release holds concurrent submitters in the 10-second wait unnecessarily.

**Payload shape (client → server):**

```json
{
  "submissionId": "b3a1-0c4d-...",
  "enteredBy": "Kevin",
  "totalTips": 1000.00,
  "serverNames": ["Alice", "Bob"],
  "trainee": { "name": "Charlie", "pct": 50 }
}
```

Notes:
- `numServers` is **not** sent; it is `serverNames.length` by construction
- `trainee.pct` is an integer (25, 50, or 75), same units as column H
- `trainee` is `null` when no trainee on shift

**Response shape (server → client):**

```json
{
  "ok": true,
  "dedup": false,
  "splits": {
    "kitchen": 100.00,
    "chefs": 450.00,
    "perServer": 180.00,
    "trainee": 90.00
  }
}
```

`splits.trainee` omitted when no trainee. `dedup: true` means this `submissionId` was already recorded; the existing splits are reconstructed from columns I (kitchen), J (chefs), K (perServer), L (trainee, omitted if blank). Error response shape: `{ ok: false, retryable: bool, error: "..." }` — `retryable` is `true` for transient conditions (lock timeout, exceptions) and `false` for validation failures.

**Server-side validation (reject with `{ ok: false, retryable: false, error }`):**
- `submissionId` is a non-empty string, max 64 chars
- `enteredBy` non-empty, max 60 chars
- `totalTips` is a finite number, >= 1.00, <= 100000 (server normalizes to integer cents via `Math.round(totalTips * 100)` regardless of how many decimals the client sent)
- `serverNames` is an array of 1-6 non-empty strings, each max 40 chars
- `trainee` is either `null` or `{ name: non-empty string max 40, pct: 25|50|75 }`

**CORS / transport note:** Google Apps Script web apps deployed as `/exec` issue a redirect to a `googleusercontent.com` URL on POST. To avoid a CORS preflight (which would fail), the client posts with `Content-Type: text/plain;charset=utf-8` and a JSON string body. The script reads `e.postData.contents` and `JSON.parse`s it. Apps Script returns its own ContentService JSON response with CORS-friendly defaults.

### Component 3: Google Sheet

Header row is row 1. Each shift appends one row. Date/time use the spreadsheet's timezone (`File → Settings → Time zone`); document this in `SETUP.md`.

```
A: Date          (e.g., 2026-05-27)
B: Time          (e.g., 22:45)
C: Entered by
D: Total tips
E: # of full servers
F: Server names  (comma-separated)
G: Trainee name  (blank if none)
H: Trainee %     (integer 25, 50, or 75; blank if none)
I: Kitchen $
J: Chefs $
K: Per-server $
L: Trainee $     (blank if none)
M: Submission ID
```

## Deployment

Documented in `SETUP.md`:

1. Create a Google Sheet with the header row above. Set the spreadsheet timezone (`File → Settings → Time zone`) to the restaurant's local timezone.
2. Extensions → Apps Script → paste `apps-script.gs`. Save.
3. Deploy → New deployment → Web app → Execute as: me; Anyone has access. Copy the deployment URL.
4. Open `index.html` in any text editor, paste the URL into the `ENDPOINT_URL` constant near the top.
5. Go to netlify.com/drop, drag the project folder onto the page, get a public URL.
6. Bookmark the URL on each server's phone.

Total time: about 10-15 minutes.

## Validation

**Client-side (block submit, show inline error):**
- `Your name` non-empty
- `Total tips` is a number, >= 1.00 and <= 100000 (matches server bounds; prevents a wasted round-trip)
- Each visible server-name field non-empty
- If trainee toggle on: trainee name non-empty (level always has a default)
- Server count 1-6 (enforced by stepper bounds)

**Server-side:** see Component 2. Server is the authority — client validation is UX-only.

## Error Handling

| Failure | Behavior |
|---------|----------|
| Local validation fails | Inline field error. Submit button disabled until fixed. |
| Network error / non-2xx HTTP / no response | Show "Could not save. Check your connection and tap Submit again." Keep form. Retry reuses the same `submissionId`, so a re-submit after a partial success is safe. |
| Server returns `{ ok: false, retryable: true, error }` | Same retryable banner as a network error: "Could not save. Try again in a few seconds." (Lock-timeout and unexpected exceptions fall here.) Same `submissionId` reused. |
| Server returns `{ ok: false, retryable: false, error }` | Show "Something was wrong with your entry: <error>." Keep form. User must fix and try again. |

## Concurrency and Idempotency

- **Concurrent submits:** Two phones submitting simultaneously each acquire `LockService.getScriptLock()` before the dedup check and append. If a 10-second wait elapses without the lock, the script returns `{ ok: false, retryable: true, error: "Sheet busy, please try again." }` and the client treats this like a network error.
- **Retries after network loss:** Each form load generates a fresh `submissionId`. The script checks column M for that ID before writing; if found, it reconstructs splits from columns I/J/K/L and returns them with `dedup: true`. The UI surfaces this as "Previously recorded shift" so the user is not confused. The same submissionId is reused across all retries of the same shift; pressing "Record another shift" generates a new one.

## Out of Scope (Confirmed)

- Authentication
- Editing past records from the app
- Offline queue
- Multi-restaurant or multi-tenant features
- Custom split percentages per shift (10/45/45 is hard-coded; rule change = code change)
- More than one trainee per shift

## File Layout

```
tip-calc/
├── index.html              # the form
├── apps-script.gs          # paste into Apps Script
├── SETUP.md                # owner-facing setup walkthrough
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-05-27-tip-calc-design.md   # this file
```

## Open Questions

None.
