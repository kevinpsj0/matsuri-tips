# Matsuri Tips Admin Dashboard Design

**Date:** 2026-05-28
**Goal:** A PIN-protected, view-only dashboard that reads the existing tip ledger and shows today's totals, date-range trends, a calendar heatmap, per-shift detail, and per-person earnings.

## Context

The tip-entry app (`index.html`) already writes one row per shift to a Google Sheet via an Apps Script web app (`doPost`). This dashboard adds a read path to the same Apps Script and a second static page, reusing the same hosting (GitHub Pages) and the same `/exec` endpoint. No new infrastructure, no external libraries.

## Security model

The dashboard URL is public (GitHub Pages), so protection happens at the data layer:

- The admin enters a 6-digit PIN. It is sent to the Apps Script in the POST body.
- The Apps Script compares it to `ADMIN_PIN`, stored in Script Properties (never in any file that ships to GitHub, never in the public repo).
- Row data is returned **only** when the PIN matches. Nothing sensitive is embedded in the page or returned before the check.
- Wrong-PIN responses sleep ~1s server-side to slow brute force. A 6-digit PIN over network round-trips plus Apps Script quotas makes brute force impractical for this internal tool.
- On the client, a correct PIN is cached in `localStorage` so admins don't retype daily. If the stored PIN later fails (e.g., it was changed), the client clears it and shows the gate again.

## Read endpoint

Add an early branch to `doPost`: when `payload.action === "fetchData"`, handle the read and return before any submission/lock logic.

- Validate `payload.pin` against `ADMIN_PIN`.
- Read rows 2..lastRow, columns A..M.
- Normalize each row to a JSON object. Format `date`/`time` defensively: if a cell is a `Date` object, format it with the spreadsheet timezone (`yyyy-MM-dd` / `HH:mm`); otherwise pass the string through. This avoids timezone drift if Sheets coerced a date string into a date value.
- Numeric fields coerced with `Number(...) || 0`; `traineePct`/`traineeAmt` are `null` when blank.
- No `LockService` (reads don't mutate).

Response shape: `{ ok: true, rows: [ { date, time, enteredBy, totalTips, numServers, serverNames, traineeName, traineePct, kitchen, chefs, perServer, traineeAmt } ] }` or `{ ok: false, error }`.

## Client views

All views derive from one fetch of all rows, filtered client-side. "Today" and range boundaries are computed in the restaurant timezone (`America/Los_Angeles`) via `Intl`, so they line up with how rows are dated server-side. Date strings are ISO (`yyyy-MM-dd`), so range filtering is a lexical comparison.

**Period selector:** Today / This Week (Sun–Sat) / This Month / Custom (two date inputs). Applies to Summary, Shifts, People. Calendar is its own month navigator.

- **Summary** — cards (total tips, kitchen, chefs, servers total, trainees total, # shifts, # distinct staff) plus a hand-drawn SVG bar chart of daily totals across the range.
- **Calendar** — CSS month grid; each day shaded by tip intensity, showing the day number and that day's total. Prev/next month nav.
- **Shifts** — list of each shift in range: date, time, entered by, total, and the split (kitchen / chefs / each server / trainee).
- **People** — per-person totals over the range. Server names are stored comma-separated (`"Alice, Bob"`); each named server is credited `perServer` for that shift, the trainee is credited `traineeAmt`. Names are normalized (trim + case-insensitive) so casing/spacing variations merge; the most frequent original spelling is displayed. Sorted by total descending, with shift counts.

## Per-person without a data change

Per-person analytics is derivable from the existing format: each shift row already carries the server-name list and the per-server amount, and the trainee name + trainee amount. No change to the sheet or the entry app is required.

## Files

- Modify `apps-script.gs` (+ mirror to `gas/Code.js`): add `fetchData` branch and `handleFetchData`.
- Create `admin.html`: shell, PIN gate, tab markup, styles.
- Create `admin.js`: fetch, filtering, view rendering, charts.
- Create `admin.webmanifest`, `icons/icon-admin.svg` + PNGs.
- Modify `sw.js`: cache admin assets, bump cache version, treat `admin.js` as network-first.
- Modify `SETUP.md`: admin section + how to set/change `ADMIN_PIN`.

## Out of scope

Editing data from the dashboard, user accounts/roles, real-time refresh, export. Reads are on-demand (a Refresh button); ~15-min staleness is irrelevant since the fetch is live each visit.
