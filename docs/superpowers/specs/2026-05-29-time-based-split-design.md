# Time-Based Tip Split (v2) Design

**Date:** 2026-05-29
**Goal:** Distribute the server pool by hours worked instead of equally. The server enters a clock-in and clock-out for every person on the shift; each person's share of the 45% server pool is proportional to their effective hours.

## Approved decisions

- Server pool split is **proportional to hours worked** (clock-out minus clock-in, same day).
- **Trainees** discount their hours by their rate: effective minutes = minutes × pct (25/50/75). Regular = 100%.
- Shifts are **same-day only**; clock-out earlier than clock-in is an input error.
- Kitchen 10% and Chefs 45% are unchanged. Chefs absorbs the rounding residual.
- **Multiple trainees** allowed per shift (each person independently markable).
- Ledger starts **fresh** in the new format (no historical data to preserve).

## Split math (deterministic integer cents)

```
T   = round(totalTips * 100)
kitchen = round(T * 0.10)
pool    = round(T * 0.45)
for each person: minutes = (outH*60+outM) - (inH*60+inM); weight = minutes * (trainee ? pct : 100)
totalWeight = sum(weight)
share_i = floor(pool * weight_i / totalWeight)     // 0 if totalWeight == 0
chefs   = T - kitchen - sum(share_i)                // absorbs residual
```

Every cent is accounted for: kitchen + chefs + sum(shares) == T.

## Data model (one row per recipient)

Single ledger sheet (first tab). Each shift produces one row per person plus a Kitchen row and a Chefs row, sharing the same Submission ID. Columns:

| # | Column | Notes |
|---|--------|-------|
| 1 | Date | shift date yyyy-MM-dd (server tz) |
| 2 | Time | entry time HH:mm |
| 3 | Entered by | |
| 4 | Recipient | person name, or "Kitchen" / "Chefs" |
| 5 | Role | Server / Trainee / Kitchen / Chefs |
| 6 | Trainee % | number for trainees, blank otherwise |
| 7 | Time in | HH:mm, blank for Kitchen/Chefs |
| 8 | Time out | HH:mm, blank for Kitchen/Chefs |
| 9 | Hours | decimal, blank for Kitchen/Chefs |
| 10 | Amount $ | this recipient's dollars |
| 11 | Total tips | shift total (reference; repeated per row) |
| 12 | Submission ID | groups a shift's rows; dedup key |

Because every recipient is a row and shares sum to the total, period totals come from summing the Amount column, category totals from filtering Role, and per-person totals from grouping Recipient where Role in (Server, Trainee). The Total tips column is reference only (not summed).

## Entry form

Replaces "number of servers + names + one trainee" with a **list of people**. Each person row: name (custom dropdown), time in / time out (native `<input type="time">`), trainee toggle + level (25/50/75). "Add person" / remove buttons; starts with one row, up to 12. Live preview shows each person's hours and dollar amount, plus Kitchen and Chefs and a total check. Client validates: name present, both times present with out > in, total tips 1..100000.

Payload: `{ submissionId, enteredBy, totalTips, people: [ { name, timeIn, timeOut, trainee, pct } ] }`.

## Server (Apps Script)

- `splitShift` mirrors calc.js byte-for-byte (plus a `minutesWorked` helper).
- `validatePayload` checks the people array (1..12), each name, each HH:mm time with out > in, trainee pct in {25,50,75}.
- `doPost` (submit path): lock, dedup by Submission ID, compute, append the recipient rows in one batch, return `{ ok, dedup, splits:{ kitchen, chefs, people:[...] } }`. Dedup reconstructs splits from the existing rows.
- `handleFetchData` returns the new columns for the admin (PIN-gated, unchanged auth).
- `setupSheet` clears the ledger and writes the new 12-column header (start fresh). `handleFetchStaff`, `setupStaffSheet`, `setAdminPin` unchanged.

## Admin dashboard

Reads the new format. Summary: total = sum(Amount); kitchen/chefs/servers/trainees by Role; shifts = distinct Submission ID; staff = distinct Recipient where Role in (Server, Trainee). Calendar/daily chart: sum(Amount) per date. Shifts tab: group by Submission ID, list recipients with hours and amounts. People tab: group Server/Trainee rows by Recipient with summed hours and earnings.

## Out of scope

Overnight shifts, editing entries from the UI, migrating old-format rows (ledger starts fresh).
