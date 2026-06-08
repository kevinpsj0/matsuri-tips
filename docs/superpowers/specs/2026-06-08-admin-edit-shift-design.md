# Admin direct shift editing — design

Date: 2026-06-08

## Problem

The admin can *approve* a staff-initiated edit (the Requests tab → `resolveRequest`)
but cannot *initiate* an edit themselves. The admin's shift drill-down
(`openShiftModal`) is read-only. We want the admin to edit an existing shift's
contents directly, with the change applied immediately.

## Decisions

- **Apply model:** apply immediately. No approval roundtrip — the admin is the
  authority. PIN-gated via the existing `sessionPin`.
- **Scope:** edit only. Deleting a whole shift is out of scope.
- **Audit:** every admin edit leaves a resolved record in the existing
  "Edit requests" sheet (status `Admin edit`), so there is a history of what
  changed and when.
- **Form reuse (Approach A):** extract `today.html`'s edit modal into a shared
  `editform.js` used by both the staff (`today.html`) and admin (`admin.html`)
  flows — one source of truth, no drift.

## Backend (`apps-script.gs`)

### 1. Extract a shared rewrite helper

Pull the ledger-rewrite block currently inline in `handleResolveRequest`
(approx. lines 942–1037) into a standalone function:

```
applyShiftEdit(ss, sid, proposed, tz)
  → { ok: true, rowStart, rowCount, savedRows }
  | { ok: false, error, retryable }
```

Behavior is exactly what approve does today:
- Find the target shift's rows for `sid`; require they are a contiguous block
  (else error, no write).
- Guard: reject an edit that would create a second shift of the same type on
  the same date.
- Compute `splitShift(proposed)`, append the new rows, delete the old block,
  with the existing append-then-delete rollback semantics.

`handleResolveRequest` is refactored to *call* this helper on the approve path.
No behavior change for the existing request/approve flow — just deduplicated.

### 2. New action `adminEditShift`

PIN-gated (matches `sessionPin` like other admin actions), runs under the same
script lock. Steps mirror the approve prep:

1. Validate PIN and inputs (`submissionId`, `proposed`).
2. `configure({ slots: getSlots(), kitchenPct: getKitchenPct() })`.
3. `applyRosterTrainees(proposed.servers)` so roster-managed trainee levels are
   respected.
4. `validateShiftFields(proposed)`.
5. `applyShiftEdit(ss, sid, proposed, tz)`.
6. On success, append a resolved row to the Edit-requests sheet:
   - status `Admin edit`, `requestedBy` = `admin`, `resolvedBy` = `admin`,
     the cleaned `proposed` JSON, request + resolved timestamps.
   - `handleListRequests` only returns `Pending` rows, so this never clutters
     the pending queue — it is history only.

Register the action in `doPost` alongside the other `payload.action` branches.

## Shared edit form (`editform.js`)

Extract from `today.html` and parameterize by container elements (rather than
today.html's hard-coded IDs):

- `slotOptions(shift, selectedId)`
- `personRowHtml(p)`, `renderEditPeople(container, people)`
- `readEditServers(container)`
- `renderEditChefs(...)`, `readEditChefs(...)` (keep the roster ∪ existing-chefs
  union so a slow roster load can't silently drop chefs)
- `renderEditShiftToggle(...)`
- people add/remove delegated handlers (wired by each caller to its container)
- `buildProposed(...)` — validate and package `{ shiftType, enteredBy,
  totalTips, servers, chefs }`, returning `{ proposed }` or `{ error }`.

The **submit action stays in each caller**:
- `today.html` → `requestEdit` (unchanged, with name/note fields).
- `admin.html` → `adminEditShift` with `sessionPin` (no name/note; admin known).

Both pages load `editform.js` before their own page logic.

## Admin integration (`admin.js` / `admin.html`)

- Add an **Edit** button to the read-only shift modal (`openShiftModal`).
- Tapping Edit swaps the modal body to the shared edit form, prefilled from the
  shift's ledger rows using the same mapping `today.html` uses: recipients →
  server rows with slots matched via `findSlotByTimes`, checked chefs, shift
  toggle from the first row's shift. Surface the "slot retimed" hint when a
  recorded slot no longer matches a current slot.
- **Save** calls `adminEditShift`; on success: close modal, `loadData()`
  refetch, re-render, show a success toast. On `unknown_slot`/error, show the
  inline error and let the admin refresh.

## Edge cases (covered by the reused logic)

- Non-contiguous ledger rows for the shift → error, no write.
- Edit colliding with an existing same-type shift that day → rejected.
- Roster-managed trainee levels reapplied on save.
- Concurrent edits serialized by the script lock.

## Testing

- `calc.test.js` is unaffected (pure split math).
- Manual verification:
  1. Staff edit-request flow in `today.html` still works after the extraction.
  2. Admin edit applies to the ledger immediately and re-renders.
  3. The `Admin edit` audit row appears in the Edit-requests sheet and does not
     show in the pending queue.
  4. Duplicate same-type-shift guard fires on an offending edit.
- Bump `sw.js` cache version and add `editform.js` to the precache `ASSETS`
  list so it ships to installed devices.

## Out of scope

- Deleting an entire shift.
- Any change to the staff request/approve UX beyond the internal extraction.
