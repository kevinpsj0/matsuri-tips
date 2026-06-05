# People view improvements

Date: 2026-06-05
Scope: admin app "People" tab. Five changes to make the view trustworthy and more useful for the owner.

All visible text goes through `t()` with English and Korean entries added to `i18n.js`. Frontend lives in `admin.js` (render functions + click delegation) and `admin.html` (styles). One new backend action lives in `apps-script.gs`.

## Current behavior

- `renderPeople(rows)` (admin.js) renders two panels: the Manage Staff roster manager and an "Earnings by Person" leaderboard.
- `rows` is already filtered to the selected period (today / week / month / custom) by `rowsInRange`. The leaderboard respects the period; Manage Staff does not (it is a roster, not a report).
- The leaderboard **filters out anyone not currently active** (`activeSet.has(...)`), so an inactivated earner's money disappears from the view for that period.
- "Owed" money is computed all-time by `computeOwed()` / `owedPositive()` and is only surfaced in the separate Payouts tab.
- Names aggregate by lowercased recipient; the most common spelling wins the display name. There is no way to fix a misspelling or merge two spellings.
- Tapping a person does nothing.

## 1. Former staff in a separate collapsed section

`renderPeople` stops filtering by active status. It aggregates **every** server/trainee row in the period, then partitions the aggregated people into:

- **Active**: name is in the active set. Rendered in the main ranked list as today.
- **Former**: everyone else (inactivated roster members, or names no longer active). Rendered in a collapsed `<details class="lb-former">` group below the active list, ranked by total, dimmed.

Bar widths use a single `max` computed across **both** groups so bars stay comparable. The "Former staff" summary label shows the count. If there are no former earners, the section is omitted. Empty-state logic is unchanged (still keyed on whether any active staff exist).

New string: `former_staff` (e.g. "Former staff ({n})").

## 2. Owed badge + tap to Payouts

Each leaderboard row head gets a small "owed" badge when that person's all-time owed (`computeOwed`) is greater than the half-cent epsilon. The badge:

- shows `owed <amount>` using the existing `fmt`,
- is a distinct tap target carrying `data-jump-payout-name`,
- on tap, switches `activeTab` to `payouts` and re-renders, reusing the same jump the Summary tab already performs. The badge handler calls `stopPropagation` so it does not also trigger the row drill-down.

New string: `owed_badge` (e.g. "owed {amount}"). The Korean entry mirrors it.

## 3. Rename with true merge (backend + frontend)

### Frontend (Manage Staff)
Each active staff row (servers and chefs) gets a small "Rename" control. Tapping it reveals an inline text input prefilled with the current name plus Save / Cancel (no native picker, consistent with the Android dropdown constraint). Saving:

- trims and validates (non-empty, <= 40 chars); a no-op rename (same name) just closes the editor;
- if the new name matches another roster member (case-insensitive), shows a merge confirm before sending;
- calls the new `renameStaff` action with `{ pin, oldName, newName }`, then `refresh()` on success.

New strings: `rename`, `save`, `cancel`, `rename_merge_confirm` ("Merge {old} into {new}? Their shifts and payouts will combine."), plus error surfacing reuse of existing toast/error path.

### Backend (`apps-script.gs`, new `handleRenameStaff`)
Guarded by PIN (same pattern as `handleAddStaff`) and `LockService`. Steps:

1. Validate `oldName`, `newName` (non-empty, <= 40).
2. Read the Staff sheet. Locate the old row. Determine the canonical target:
   - If `newName` lowercased equals `oldName` lowercased: a re-capitalization. Update the old row's name cell to `newName`.
   - If `newName` matches a **different** existing roster row:
     - If roles differ (e.g. server into chef): reject with a clear error; no changes.
     - Else **merge**: the surviving row is the **target (newName) row**; its role, active flag, and trainee % win. Blank out the old row's name (remove it from the roster) so no duplicate remains.
   - If `newName` does not match any roster row: rename in place (update the old row's name cell to `newName`).
3. Rewrite history: in the ledger sheet, read `COL.RECIPIENT` for all data rows; every cell whose value lowercased equals `oldName` lowercased is set to the canonical `newName`. Write the column back in one batched range write.
4. Rewrite the Payouts sheet name column the same way.
5. Return `{ ok: true }`. Errors are retryable where transient (lock contention), following the existing convention.

Wire it into the `doPost` action dispatch next to the other staff actions.

## 4. Drill-down

During aggregation, keep each person's period rows. Each leaderboard row body becomes tappable, toggling an inline `<div class="lb-detail">` that lists that person's shifts, newest first: date, lunch/dinner label, hours, amount. Click handling uses the existing event delegation in `admin.js`; toggling adds/removes an `open` class. The owed badge's `stopPropagation` keeps its tap separate.

No new backend. Reuses existing shift/role label helpers (`shiftWord` and the lunch/dinner labels already used elsewhere).

## 5. Trainee rate clarity

In the leaderboard meta line, when a person is a trainee the per-hour figure gets a short qualifier (e.g. `$X/h (trainee)`) so the reduced share is not misread as an underpaid standard rate. The existing trainee percent tag in the row head is unchanged.

New string: `trainee_rate_suffix` (e.g. "(trainee)").

## Testing

- `calc.test.js` covers split math and is unaffected; no split logic changes here.
- Manual verification in the admin app against the live sheet: confirm a former earner appears dimmed in the collapsed group; an owed badge appears and jumps to Payouts; a rename in place updates the leaderboard and owed totals; a merge combines two people's shifts and payouts and survives with the target's role/trainee settings; cross-role merge is blocked; drill-down lists the right shifts; the trainee qualifier shows only for trainees.

## Out of scope

- Editing shift amounts or hours from the People view.
- Time-range filtering of the owed badge (owed stays all-time by design).
- Deleting staff (inactivate remains the soft-delete).
