# Configurable Slots + Kitchen % (and bundled hardening) Design

**Date:** 2026-06-04
**Goal:** Let the owner configure the lunch/dinner time slots and the kitchen cut from the admin Settings tab, instead of those being hardcoded in source. Bundle in five hardening/robustness fixes found in review (formula injection, edit-request locking, fail-open show-split, approve-path crash safety, dead code).

**Revision note:** v3 incorporates two multi-agent review rounds. v2 changes from v1: a single `configure()` setter; `getSlots`/`getKitchenPct` validate-on-read with default fallback; `getSlotByLabel` removed; `slotLabel` as the snapshot writer + dropdown labeler; precise contiguous-block approve rewrite (#7); `setSlots` reconstructs from validated fields. v3 changes from v2: `configure()`/`resetConfig()` mirror to `window.*` for the entry/today pages' direct `SHIFT_SLOTS` reads (and calc.js stays a classic script); explicit backend `configure()` call sites and ordering (before slot validation); `deleteRows(start,count)` (single atomic call, no loops) in the approve path and its rollbacks; client-side slot shape-validation with default fallback; `safeText` simplified to `/^[=+\-@\t\r\n]/` (text columns only); machine-readable `unknown_slot` error code + retimed-slot edit hint; global slot-id uniqueness; status-write rollback documented as relocate-to-bottom with best-effort recolor; manual-sheet-sort operational constraint; an extra lunch+chefs+non-15% test.

## Approved decisions

- Configurable from Settings: **the time slots** (per lunch/dinner) and **the kitchen cut %**. Trainee levels (25/50/75) and the lunch/dinner pool-split formula stay hardcoded.
- Slot **labels are auto-generated from the times** (e.g. `11a–4:30p`). No manual label field. This means dinner slots now show a real end time (e.g. `9:30p`) instead of the old literal "close" word; this is an accepted, owner-visible change for new entries only.
- **Past shifts are frozen.** Editing or removing a slot only affects new entries; recorded rows keep their stored times/hours/amounts/label and are never rewritten.
- Storage is **Script Properties** (same place as `ADMIN_PIN` and `SHOW_SPLIT`).
- When nothing is stored, the backend falls back to the **current hardcoded slots and 15%**, so an existing deployment is byte-for-byte unchanged until the owner edits something.

## Storage model (Script Properties)

Two new keys, both read through accessors that validate and fall back:

- `SLOTS` — JSON string: `{ "lunch": [ {id, timeIn, timeOut} ... ], "dinner": [ ... ] }`. No `label` stored; it is derived. `id` is an opaque immutable string assigned by the backend.
- `KITCHEN_PCT` — string holding an integer, e.g. `"15"`.

Accessors (used by the public read paths and the write/approve paths):

- `getSlots()` → `JSON.parse(SLOTS)`, then run the **full `validateSlots`** on the parsed value. On missing/blank/parse-error/**any validation failure**, return a deep copy of `DEFAULT_SLOTS`. The returned object is normalized (only `{id,timeIn,timeOut}` per slot). This strictness on *read* is the safety net: a corrupt property can never reach `splitShift` or the entry form. Returns plain numbers/strings only (no prototype surprises).
- `getKitchenPct()` → parse as integer; if not an integer in `[0,50]`, return `15`.

`DEFAULT_SLOTS` is the current hardcoded table (ids `L1100`, `L1200`, `D1530`, `D1630`, `D1730`, `D1800`), kept in code as the fallback only.

## calc.js parameterization (the verbatim core)

`calc.js` is the pure core mirrored verbatim into `apps-script.gs`. Today `splitShift` reads a `SHIFT_SLOTS` const and a literal `0.15`. Both become module state with defaults, plus one setter:

```
// --- BEGIN VERBATIM MIRROR (keep byte-identical in apps-script.gs) ---
var DEFAULT_SLOTS = { lunch:[...], dinner:[...] };   // current tables, ids L1100.. D1800
var DEFAULT_KITCHEN_PCT = 15;
var SHIFT_SLOTS = DEFAULT_SLOTS;     // active table; replaced (never mutated in place) by configure()
var KITCHEN_PCT = DEFAULT_KITCHEN_PCT;
function configure(cfg) {            // single mechanism for clients, tests, backend
  if (cfg && cfg.slots) SHIFT_SLOTS = cfg.slots;
  if (cfg && typeof cfg.kitchenPct === "number") KITCHEN_PCT = cfg.kitchenPct;
  // The window guard is intentional and mirror-safe: in apps-script.gs `typeof
  // window` is "undefined", so the branch is skipped. DO NOT remove it from the
  // Apps Script copy thinking it is dead code — it keeps the two files byte-identical.
  if (typeof window !== "undefined") { window.SHIFT_SLOTS = SHIFT_SLOTS; window.KITCHEN_PCT = KITCHEN_PCT; }
}
function resetConfig() {
  SHIFT_SLOTS = DEFAULT_SLOTS; KITCHEN_PCT = DEFAULT_KITCHEN_PCT;
  if (typeof window !== "undefined") { window.SHIFT_SLOTS = SHIFT_SLOTS; window.KITCHEN_PCT = KITCHEN_PCT; }
}
function getSlot(...) { ... }        // unchanged, reads SHIFT_SLOTS
function findSlotByTimes(...) { ... }// unchanged, reads SHIFT_SLOTS
function minutesWorked(...) { ... }  // unchanged
function slotLabel(timeIn, timeOut) { ... }   // NEW, see Labels
function splitShift(input) { ... }   // kitchenCents = round(T*KITCHEN_PCT/100); slotLabel(...) for snapshot
// --- END VERBATIM MIRROR ---
```

- `getSlotByLabel` is **removed** from both files and from the exports (dead after fix #8; nothing calls it once `splitsFromRows` reads stored times).
- `splitShift` change 1: `var kitchenCents = Math.round(T * KITCHEN_PCT / 100);`. `KITCHEN_PCT` is always a Number (the accessor parses it; `configure` only accepts a number).
- `splitShift` change 2: in `enriched.map`, set `slotLabel: slot ? slotLabel(slot.timeIn, slot.timeOut) : ""` (was `slot.label`). All other `splitShift` logic is unchanged.
- The browser/Node export tails live **outside** the verbatim block. Browser exports `window.configure`, `window.resetConfig`, `window.slotLabel`, `window.SHIFT_SLOTS` (default), etc. Node `module.exports` adds `configure`, `resetConfig`, `slotLabel`, `DEFAULT_SLOTS`, `DEFAULT_KITCHEN_PCT`. `getSlotByLabel` is dropped from both.

**Why mutation, not parameter-passing:** keeping the helper signatures (`getSlot`, `findSlotByTimes`, `splitShift`) unchanged minimizes mirror-drift surface, and Apps Script executions are process-isolated (concurrent requests get separate instances; a warm instance is reused only sequentially, never preempted mid-execution), so reassigning the module var is process-local and race-free. `configure` reassigns the same lexical binding the helpers close over.

**Browser live-binding (must-fix from review):** the entry/today pages read `SHIFT_SLOTS[shift]` directly (bare global) in `populateSlotSelect`/`slotOptions`, not only through `getSlot`. `calc.js` is and must remain a **classic, non-module, non-IIFE script** (top-level `var SHIFT_SLOTS` therefore *is* `window.SHIFT_SLOTS`), and `configure()`/`resetConfig()` additionally assign `window.SHIFT_SLOTS`/`window.KITCHEN_PCT` so those direct reads always see the post-`configure()` value regardless of that subtlety. Assigning `window.SHIFT_SLOTS` from outside `calc.js` is *not* the mechanism; callers must use `configure()`.

**Read-only defaults (footgun guard):** `DEFAULT_SLOTS`/`DEFAULT_KITCHEN_PCT` are treated as read-only after load. Code must change the active config only via `configure()` (which replaces the reference), never by mutating `SHIFT_SLOTS`'s arrays in place, or it would corrupt the fallback. The admin Settings editor works on a deep clone of the slots (never the live `SHIFT_SLOTS`).

Because `DEFAULT_SLOTS` equals the old table and the default pct is 15, existing `calc.test.js` cases and `_smokeTest` pass unchanged as long as tests `resetConfig()` between cases.

## Labels (auto from times)

`slotLabel(timeIn, timeOut)` formats each `HH:MM` to 12-hour using the **exact rule already in `admin.js` `fmtClock`** (so noon/midnight are correct), drops `:00`, single-letter meridiem, joined by an en dash:

- hour rule: `hh = h % 12; if (hh === 0) hh = 12;` meridiem `a` when `h < 12` else `p`.
- `11:00`→`11a`, `16:30`→`4:30p`, `15:30`→`3:30p`, `21:30`→`9:30p`, `12:00`→`12p`, `00:00`→`12a`, `12:30`→`12:30p`, `00:30`→`12:30a`.
- Slot `{11:00,16:30}` → `11a–4:30p`.

Used by: `splitShift` (the `COL.SLOT` snapshot), the entry-form slot dropdown, the today-page edit dropdown, and the admin Settings per-row preview.

Display of stored ledger rows (today page, admin) continues to use the **stored snapshot** `localizeSlotLabel(r.slot)`. New rows hold a numeric label (passes through untranslated, correct in EN/KO); legacy rows hold the old `"3:30 – close"` string (still translated by `localizeSlotLabel`). No display code changes for this; `localizeSlotLabel` stays as a passthrough/legacy translator.

## Ledger interaction and reverse-mapping (folds in fix #8)

Ledger columns are unchanged (14-column v3 layout). On write, `COL.SLOT` stores the `slotLabel` snapshot (wrapped in `safeText`, see #1). No consumer reverse-maps via that stored label anymore:

- `splitsFromRows` (dedup reconstruction) reads `timeIn`/`timeOut`/`hours` **directly from the stored row columns**. It no longer calls `getSlotByLabel`. For the response it sets `slotLabel` = the stored `COL.SLOT` string (the snapshot), and `slot` (id) = best-effort `findSlotByTimes(...)?.id || ""`. `slotLabel(timeIn,timeOut)` is not recomputed here (the stored snapshot already has it, and is guaranteed non-throwing). The dedup response's `slot` id is not consumed by the client confirmation; it is populated only for shape parity.
- The today-page edit modal pre-selects via `findSlotByTimes(shift, timeIn, timeOut)` (stored times). If an admin has since retimed/removed that slot, no current slot matches and the dropdown shows the empty "pick a time" option, which is correct: the editor picks a current slot. Unchanged slots still match and pre-select.

Net effect: renaming/removing/retiming a slot can never corrupt how a historical shift reads or reconstructs.

## Backend API

Extend `configObject()` to:

```
{ showSplit: <bool>, kitchenPct: getKitchenPct(), slots: getSlots() }
```

Returned by `handleFetchData`, `handleFetchToday`, and (for `showSplit` only, unchanged) the `doPost` write response. The entry form and today page receive `slots`/`kitchenPct` via their existing `fetchToday` call; admin via `fetchData`. Shipping slots+kitchenPct to the public is not a leak (times and one integer are operational, already visible via the dropdown/preview); the PIN, staff flags, and submission ids are not added.

**Backend `configure()` call site and ordering (must-fix from review).** The backend computes on the module-level `SHIFT_SLOTS`/`KITCHEN_PCT`, which default to 15/`DEFAULT_SLOTS` until something calls `configure`. So the two handlers that run `splitShift`/`getSlot` must call `configure({ slots: getSlots(), kitchenPct: getKitchenPct() })` first:
  - `doPost` write branch: call `configure(...)` **only after the action-dispatch block** (i.e. on the direct shift-write path, not at the top of `doPost` before routing — action handlers like `fetchToday` don't need it), and **before `validatePayload`** (which calls `getSlot` to validate the chosen slot) so a freshly-added slot is accepted, and before `splitShift`. Note `validatePayload` runs before the lock; `configure` runs there too (process-isolated, so safe).
  - `handleResolveRequest` approve: call `configure(...)` inside the lock before `validateShiftFields`/`splitShift`.
  - `handleRequestEdit`: calls `validateShiftFields` (→`getSlot`), so it also `configure(...)`s first.
  Read-only handlers (`handleFetchData`/`handleFetchToday`) do not need `configure`; they return `getSlots()`/`getKitchenPct()` directly in `configObject()` and never call `splitShift`.

Two PIN-protected write actions (same auth + 1s wrong-PIN sleep as the other admin handlers, each under the shared script lock):

- `setKitchenPct` — `{ pin, kitchenPct }`. Requires `typeof kitchenPct === "number"`, `Number.isInteger`, `0 <= pct <= 50`. Persists `KITCHEN_PCT`. Returns `{ ok, config }`.
- `setSlots` — `{ pin, slots: { lunch:[{id?,timeIn,timeOut}], dinner:[...] } }`. Runs `validateSlots`; on success **reconstructs** the persisted object from validated fields only (exactly like `handleRequestEdit` rebuilds `cleanProposed`), assigning ids to new slots and preserving supplied valid ids, then persists that normalized JSON. Never `JSON.stringify`s the raw client object. Returns `{ ok, config }`.

`setKitchenPct` is kept separate from the existing show-split `setConfig` handler for clarity.

### `validateSlots(slots)` (shared by setSlots and getSlots)

Defensive, mirroring `validateShiftFields` style (check types before indexing):

- `slots` is a non-null object; `slots.lunch` and `slots.dinner` are both arrays (`Array.isArray`). No other top-level keys are persisted (reconstruction drops them).
- Each array has **1–8** entries; each entry is a non-null object.
- Each slot: `timeIn`, `timeOut` valid `HH:MM` (reuse `isValidTime`, which fix #10 keeps for this); `timeOut` strictly after `timeIn` in same-day minutes; duration between **30 minutes and 16 hours** (rejects absurd or accidental same-minute slots). After-midnight closes (negative minutes) are rejected; the Settings UI states "end must be later the same day."
- No two slots in the same shift share the same `(timeIn, timeOut)` pair.
- `id`, if present, must match `^[A-Za-z0-9_-]{1,32}$`; otherwise it is dropped and a new id assigned. Ids are assigned backend-side as `sl-` + a short random suffix, uniqueness-checked **globally across the combined lunch+dinner set** (one `seen` map during reconstruction), so no consumer can assume per-shift-only uniqueness. Ids are not historical keys (nothing keys off them across config versions; the edit modal re-derives via `findSlotByTimes`); they exist only so the Settings UI can track a row across an edit.

Returns an error string or null, like `validateShiftFields`.

## Admin Settings UI (`admin.js` `renderSettings`)

Add to the existing Settings panel, below language and show-split. **Every interpolated value goes through `escapeHtml`** (ids in `data-` attributes, time values in `value=`), since the renderer treats config as untrusted data:

- **Kitchen cut (%)**: a number input seeded from a `kitchenPctConfig` mirror (sibling of `showSplitConfig`), saved on `change` (mirrors the show-split toggle: optimistic "Saving…/Saved/Couldn't save", revert on failure). On-change is fine for a single scalar; the slot editor uses an explicit Save because it batches multiple rows.
- **Time slots**: two labeled groups, Lunch and Dinner. Each group lists its slots as rows of `[start <input type=time>] [end <input type=time>] [auto-label preview] [× remove]`, a `+ Add slot` button, and a single **Save slots** button. The × remove is **disabled when a group has only one slot** (the 1-slot floor). Editing is on a local working copy; nothing is sent until Save. Save calls `setSlots` with the whole `{lunch,dinner}`; on success it mirrors the returned `config` and re-renders; on failure it shows the inline error and keeps the user's edits.
- Wiring extends the existing delegated listeners on `#view`: the `change` delegate gains `#set-kitchen-pct` and the time inputs; the `click` delegate gains `+ Add slot`, `× remove`, and `Save slots` (via `data-*` hooks).

Time inputs use native `<input type="time">` (this surface is the owner's own device; the prior Android caveat was about `<datalist>`, not the time picker). New i18n keys (EN + KO) for the labels, buttons, validation, and status strings, following the `i18n.js` pattern.

## Client config caching (folds in fix #6)

Entry (`index.html`) and today (`today.html`) cache the last good `config` in `localStorage` under `CONFIG_KEY`, with a small `CONFIG_CACHE_VERSION` integer; if the stored version differs, the cache is ignored (guards against a shape change deserializing garbage). On load they seed `showSplit`/`slots`/`kitchenPct` from the cache via `configure(...)` for an instant, offline-capable first paint. **When no usable cache exists, `showSplit` defaults to `false` (hidden)** rather than the current fail-open `true`, so a config-fetch failure can never reveal the per-person split. (Accepted trade-off: a brand-new device shows "split hidden" for one round-trip on first load; the cache means it is seen at most once per device. The server-authoritative `response.showSplit` on the submit/dedup path is unaffected and is *not* fail-closed.)

**Client-side config validation (must-fix from review).** The backend read path is fail-safe (`getSlots` validates), but the clients also run `splitShift` for the live preview, so they must not trust a cached blob blindly. On cache load and on every `configure({slots})` from cache or network, do a minimal shape check — `slots.lunch`/`slots.dinner` are arrays of objects with `HH:MM` `timeIn`/`timeOut` — and fall back to `DEFAULT_SLOTS` if it fails. `kitchenPct` must be a number or it is ignored (leaving the default). This mirrors the backend strictness on the one other surface that computes splits.

After a successful `fetchToday`: call `configure({slots, kitchenPct})`, overwrite the cache, and **rebuild the slot dropdowns** — re-run `populateSlotSelect`/`slotOptions` on every slot `<select>`, preserving the current selection only if it is still a valid slot (`getSlot(...)`), then `updatePreview()`. This mirrors the existing `applyLang()` repopulation precedent.

**Unknown-slot rejection (machine-readable).** When `validateShiftFields`/`getSlot` rejects a slot, the server returns a stable `errorCode: "unknown_slot"` alongside the human message. This is emitted uniformly from **both** the `doPost` write path **and** `handleRequestEdit` (the today edit-modal submission path validates `proposed` server-side), so both client surfaces can branch on it. The entry form and the today edit modal branch on that code to show a "the time slots changed — tap Refresh" prompt rather than the generic per-field error, so a stale cached option is a clear recoverable state, not a dead end. The today edit modal additionally shows a small inline hint when a pre-selected server slot comes back blank because its slot was retimed/removed ("a slot was changed; re-pick the time"), instead of only surfacing the generic slot error on Save.

## Bundled hardening fixes

- **#1 Formula injection.** In `doPost` write, wrap `enteredBy` with `safeText` (the approve path already does). Add `safeText` on `submissionId` at every write site (ledger write, edit-requests append, approve `baseRow`) **and** restrict `submissionId` in `validatePayload` to `^[A-Za-z0-9_-]{1,64}$` (belt and suspenders). Wrap the `slotLabel` snapshot in `safeText` on write too, so injection safety does not rest on the formatter always starting with a digit. Extend `safeText` to quote a value whose first non-whitespace char is a formula trigger, or that begins with a control char: `(/^[\s]*[=+\-@]/.test(str) || /^[\t\r\n]/.test(str)) ? "'" + str : str`. Rationale: while the live Google Sheet via `setValues` only auto-evaluates a formula at position 0, the owner can **export the ledger to CSV/Excel**, where a leading-whitespace `" =FORMULA"` *is* evaluated — so the whitespace-tolerant form is the safer choice. Under the text-columns-only invariant below the only "false positives" are names/notes whose first non-space char is `= + - @`, which are exactly the values worth quoting, so the cost is nil. **Invariant:** `safeText` is for text columns only; it must never wrap numeric columns (Amount, Total tips, Hours, Trainee %), since prefixing a `'` would store a number as text.
- **#3 Edit-request lock.** `handleRequestEdit` acquires the shared script lock (`tryLock`, ~10s) around the **ledger lookup and the requests-sheet append together** (so a concurrent approve cannot delete the shift between lookup and append), returning the standard `retryable` busy response on contention. Note: this is the single `LockService.getScriptLock()` shared with all writers; concurrent staff edits may occasionally get a retryable busy response, which clients already handle.
- **#6 Fail-open show-split.** Covered under Client config caching above.
- **#7 Approve crash safety (append-then-delete).** Rewrite `handleResolveRequest`'s approve transaction. Relies on the invariant that a shift's ledger rows are a **contiguous block** (always written/rewritten as one batch). Steps:
  1. Build `newRows`, run the existing same-day duplicate-shift guard and validation — all before any write.
  2. Locate the old block by `submissionId`: collect indices, assert they are **contiguous**, defined precisely as `max(idx) - min(idx) + 1 === idx.length` (a consecutive run, no gaps). If it fails, return a clear non-retryable error ("rows for this shift are not contiguous; resolve manually" — only reachable if the ledger was manually re-sorted/edited). Record `oldStart = min(idx)`, `oldCount`, and the saved old contents.
  3. **Append** `newRows` in one `setValues` at `newStart = getLastRow()+1`. On failure: nothing was deleted, nothing landed (single atomic call) — return `retryable`, ledger intact.
  4. **Delete** the old block with a single `Sheet.deleteRows(oldStart, oldCount)` (the two-argument form, one atomic call — **not** a `deleteRow` loop, which can partially delete on a hard kill). Valid because appends went to the bottom and did not shift earlier rows. On failure: the appended rows are still at `newStart` (delete did not run); roll back with a single `deleteRows(newStart, newRows.length)`; if that succeeds, rethrow → outer catch → `retryable`; if rollback also fails, return CRITICAL non-retryable naming the duplicated `submissionId`.
  5. After a successful delete, the appended block has shifted up by `oldCount`, so its position is `approvedRowStart = newStart - oldCount` (deterministic, no re-lookup), `approvedRowCount = newRows.length`. These feed the status-write-failure rollback, which uses a single `deleteRows(approvedRowStart, approvedRowCount)` (again, not a loop), then re-appends the saved old rows at the bottom. **Note:** that rollback restores content and contiguity but **not the original position** (the block lands at the end), and `recolorShifts` does not run on the failure path; call `recolorShifts()` best-effort after a rollback so shading is not left stale. On any rollback, **do not run the auto-supersede sweep** — the ledger was restored, the request stays "Pending," and nothing was approved. The normal-success auto-supersede sweep and `recolorShifts` run afterward, unchanged.

  Documented trade-off: between steps 3 and 4 a reader not holding the lock can momentarily observe both old and new rows for the shift; it self-corrects on the next refresh and is preferable to silent row loss.
- **#10 Dead code.** Delete `enumerateDays` from `admin.js` (confirmed no callers in the repo). Keep `isValidTime` in `apps-script.gs` (now used by `validateSlots`).

## Implementation sequencing

To limit blast radius (the config feature is additive and low-risk; the ledger-integrity changes are delicate), implement and verify in two stages within the one plan:

1. **Stage A — config feature + cheap fixes:** calc.js `configure`/`slotLabel`/`KITCHEN_PCT`; backend accessors, `validateSlots`, `setSlots`/`setKitchenPct`, `configObject` + the `configure()` call sites; client config fetch/cache/repopulate (#6); admin Settings UI; fix #1; fix #10. Remove `getSlotByLabel` in the **same commit** as the `splitsFromRows` rewrite (#8) so nothing references it mid-change. Verify (tests + manual) before Stage B.
2. **Stage B — ledger integrity:** fix #3 (edit-request lock) and fix #7 (approve append-then-delete), each with focused concurrency/rollback verification.

## Testing

- `calc.test.js` (Node, automated): existing cases unchanged (defaults preserve them); add a `resetConfig()` in the test harness between cases. Add cases for `slotLabel` (incl. `12:00`, `00:00`, `12:30`, `00:30`); for `splitShift` with `configure({kitchenPct:0})` and a non-15 pct (assert kitchen and the sum invariant); a combined case with a **non-15 pct + chefs on a lunch shift** (exercises the kitchen-round + lunch-50%-round intersection, locking the sum invariant on the double-round path); and `splitShift` against a custom `SHIFT_SLOTS` via `configure({slots:...})`.
- Backend (manual, run from the Apps Script editor — there is no Node harness for `apps-script.gs`): a `_smokeTestConfig` that round-trips `validateSlots`/kitchen-pct happy paths and a few rejections, confirms `getSlots`/`getKitchenPct` fall back to defaults when the property is unset *and when it is set but corrupt*, and `resetConfig()`s afterward. Extend/guard `_smokeTest` to `resetConfig()` first so a configured pct can't break its 15%-based assertions.
- Manual end-to-end: add a slot, enter a shift using it, edit/remove the slot, confirm history is untouched and still displays; change kitchen %, confirm a new shift uses it while old shifts are unchanged; corrupt `SLOTS` by hand and confirm the entry form falls back to defaults rather than breaking.

## Operational constraints

- **Do not manually sort or reorder the ledger sheet.** A shift's rows must stay a contiguous block; the approve path (#7) refuses rather than risk corrupting unrelated rows if it finds a shift's rows scattered. Sorting the sheet by a column in Google Sheets would scatter every multi-row shift and make edit-approval fail until rows are regrouped by Submission ID. This was implicitly true before (shading already assumes grouping) but is now a hard dependency; note it in the admin/owner docs.

## Out of scope

- Configurable trainee levels or lunch/dinner pool-split ratios.
- Removing or adding whole shift types (lunch/dinner remain fixed; each keeps ≥1 slot).
- Overnight / after-midnight slots, per-slot capacity, or day-of-week slot variation.
- Rewriting or migrating historical ledger rows.
- PIN brute-force throttling/lockout (pre-existing; the new write endpoints reuse the same 1s-sleep check and do not worsen it).
