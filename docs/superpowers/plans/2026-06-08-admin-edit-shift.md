# Admin Direct Shift Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the admin edit an existing shift directly from the admin app, applied to the ledger immediately, reusing the staff edit form and the approve-path ledger rewrite.

**Architecture:** Extract the two pieces that already do this work into shared code — the ledger-rewrite block from `handleResolveRequest` becomes a backend helper `applyShiftEdit`, and `today.html`'s edit modal becomes a shared `editform.js`. A new PIN-gated `adminEditShift` action calls the helper directly and logs an audit row. The admin's read-only shift modal gains an Edit button that opens the shared form and saves via the new action.

**Tech Stack:** Vanilla JS (no build step), Google Apps Script backend (`apps-script.gs`, deployed via clasp), static frontend on GitHub Pages, service-worker precache (`sw.js`). Tests: `node --test` for `calc.js` only.

**Reference spec:** `docs/superpowers/specs/2026-06-08-admin-edit-shift-design.md`

**Deploy reminder (from memory):** backend changes go live via clasp push + new deployment (remote file is `Code.js`, preserve `setAdminPin`); frontend ships by committing + bumping the `sw.js` cache and adding any new asset to the precache list. See `reference_clasp-deploy.md`.

---

## File Structure

- **`apps-script.gs`** (modify) — add `applyShiftEdit(ss, sid, proposed, tz)` helper; refactor the approve path of `handleResolveRequest` to call it; add `handleAdminEditShift(payload)`; register the `adminEditShift` action in `doPost`.
- **`editform.js`** (create) — shared shift-edit form: `editFormFieldsHtml()` (markup), `shiftRowsToModel(rows)` (ledger rows → form model), `createEditForm()` (render + read controller). Depends on globals from `calc.js` (`SHIFT_SLOTS`, `getSlot`, `findSlotByTimes`, `firstDuplicateName`, `slotLabel`) and from each page (`escapeHtml`, `t`). Loaded after `calc.js` + `i18n.js`.
- **`today.html`** (modify) — replace the inline edit-form markup and helper functions with the shared module; keep the request-specific chrome (name/note) and the `requestEdit` submit.
- **`admin.html`** (modify) — include `editform.js`; the shift modal gets an Edit button + an edit container.
- **`admin.js`** (modify) — wire the Edit button: open the shared form prefilled from the shift's rows, save via `adminEditShift`.
- **`i18n.js`** (modify) — add three keys (`edit_shift`, `save_changes`, `admin_edit_saved`) to both `en` and `ko`.
- **`sw.js`** (modify) — add `./editform.js` to the precache `ASSETS` and bump the cache version.

---

## Task 1: Extract `applyShiftEdit` backend helper (no behavior change)

**Files:**
- Modify: `apps-script.gs` — `handleResolveRequest` approve block (lines ~942–1037) and add a new function above it.

This task is a pure refactor: move the ledger-rewrite out of `handleResolveRequest` into a reusable function. The existing approve flow must behave identically. There is no Apps Script unit-test harness in this repo, so verification is by careful diff + the manual smoke test in Task 7.

- [ ] **Step 1: Add the `applyShiftEdit` helper function**

Insert this function immediately **before** `function handleResolveRequest(payload) {` (currently line 895). It is the verbatim ledger-rewrite logic from the approve block, with `return jsonResponse({ ok:false, ... })` calls turned into `return { ok:false, ... }` and the success path returning the rollback handles. It assumes the caller has already run `configure(...)`, `applyRosterTrainees(proposed.servers)`, and `validateShiftFields(proposed)`.

```javascript
// Rewrite the ledger rows for one shift (submissionId `sid`) to match `proposed`.
// Caller MUST have already run configure(), applyRosterTrainees(proposed.servers),
// and validateShiftFields(proposed), and MUST hold the script lock. Returns the
// rollback handles on success so the caller can undo the write if a later step
// (e.g. a status update) fails.
//   success: { ok:true, ledger, date, time, rowStart, rowCount, savedRows }
//   failure: { ok:false, retryable, error }
function applyShiftEdit(ss, sid, proposed, tz) {
  const ledger = ss.getSheets()[0];
  const lastL = ledger.getLastRow();
  if (lastL < 2) return { ok: false, retryable: false, error: "Shift not found in ledger" };
  const ldata = ledger.getRange(2, 1, lastL - 1, NUM_COLS).getValues();

  const targetRowIdxs = [];
  let preservedDate = "", preservedTime = "";
  for (let i = 0; i < ldata.length; i++) {
    if (ldata[i][COL.SUBMISSION_ID - 1] === sid) {
      targetRowIdxs.push(i + 2);
      if (!preservedDate) {
        const d = ldata[i][COL.DATE - 1], t = ldata[i][COL.TIME - 1];
        preservedDate = (d instanceof Date) ? Utilities.formatDate(d, tz, "yyyy-MM-dd") : String(d || "");
        preservedTime = (t instanceof Date) ? Utilities.formatDate(t, tz, "HH:mm") : String(t || "");
      }
    }
  }
  if (!targetRowIdxs.length) return { ok: false, retryable: false, error: "Shift not found in ledger" };
  const oldStart = Math.min.apply(null, targetRowIdxs);
  const oldCount = targetRowIdxs.length;
  if (Math.max.apply(null, targetRowIdxs) - oldStart + 1 !== oldCount) {
    return { ok: false, retryable: false, error: "Ledger rows for this shift are not contiguous; resolve manually." };
  }

  const splits = splitShift(proposed);
  const shiftLabel = proposed.shiftType === "lunch" ? "Lunch" : "Dinner";
  for (let i = 0; i < ldata.length; i++) {
    if (ldata[i][COL.SUBMISSION_ID - 1] === sid) continue;
    const d2 = ldata[i][COL.DATE - 1];
    const ds2 = (d2 instanceof Date) ? Utilities.formatDate(d2, tz, "yyyy-MM-dd") : String(d2 || "");
    if (ds2 === preservedDate && String(ldata[i][COL.SHIFT - 1] || "") === shiftLabel) {
      return { ok: false, retryable: false, error: "Approving this would create a second " + shiftLabel + " shift for " + preservedDate + "." };
    }
  }

  const enteredBy = safeText(String(proposed.enteredBy).trim());
  const newRows = [];
  function baseRow() {
    const r = new Array(NUM_COLS).fill("");
    r[COL.DATE - 1] = preservedDate;
    r[COL.TIME - 1] = preservedTime;
    r[COL.SHIFT - 1] = shiftLabel;
    r[COL.ENTERED_BY - 1] = enteredBy;
    r[COL.TOTAL_TIPS - 1] = proposed.totalTips;
    r[COL.SUBMISSION_ID - 1] = safeText(sid);
    return r;
  }
  for (const sp of splits.servers) {
    const r = baseRow();
    r[COL.RECIPIENT - 1] = safeText(sp.name.trim());
    r[COL.ROLE - 1] = sp.trainee ? "Trainee" : "Server";
    r[COL.TRAINEE_PCT - 1] = sp.trainee ? sp.pct : "";
    r[COL.SLOT - 1] = safeText(sp.slotLabel);
    r[COL.TIME_IN - 1] = sp.timeIn;
    r[COL.TIME_OUT - 1] = sp.timeOut;
    r[COL.HOURS - 1] = sp.hours;
    r[COL.AMOUNT - 1] = sp.amount;
    newRows.push(r);
  }
  for (const cf of splits.chefs) {
    const r = baseRow();
    r[COL.RECIPIENT - 1] = safeText(cf.name.trim());
    r[COL.ROLE - 1] = "Chef";
    r[COL.AMOUNT - 1] = cf.amount;
    newRows.push(r);
  }
  const k = baseRow();
  k[COL.RECIPIENT - 1] = "Kitchen"; k[COL.ROLE - 1] = "Kitchen"; k[COL.AMOUNT - 1] = splits.kitchen;
  newRows.push(k);

  const savedRows = targetRowIdxs.slice().sort(function (a, b) { return a - b; }).map(function (r) { return ldata[r - 2]; });

  const newStart = ledger.getLastRow() + 1;
  try {
    ledger.getRange(newStart, 1, newRows.length, NUM_COLS).setValues(newRows);
  } catch (writeErr) {
    return { ok: false, retryable: true, error: String(writeErr && writeErr.message || writeErr) };
  }
  try {
    ledger.deleteRows(oldStart, oldCount);
  } catch (delErr) {
    try { ledger.deleteRows(newStart, newRows.length); } catch (rbErr) {
      return { ok: false, retryable: false, error: "CRITICAL: ledger has duplicate rows for " + sid + " and rollback failed. Resolve manually." };
    }
    return { ok: false, retryable: true, error: String(delErr && delErr.message || delErr) };
  }
  return {
    ok: true,
    ledger: ledger,
    date: preservedDate,
    time: preservedTime,
    rowStart: newStart - oldCount, // appended block shifted up by the delete
    rowCount: newRows.length,
    savedRows: savedRows,
  };
}
```

- [ ] **Step 2: Replace the inline approve block with a call to the helper**

In `handleResolveRequest`, the approve branch currently runs `configure`/`applyRosterTrainees`/`validateShiftFields` (lines ~937–940) and then the inline ledger rewrite (lines ~942–1037, which start with `ledger = ss.getSheets()[0];` and end with `ledgerWritten = true;`).

Keep lines 937–940 (the prep + validation) **as-is**. Replace **only** the inline rewrite block (from `ledger = ss.getSheets()[0];` through `ledgerWritten = true;`, i.e. lines ~942–1037) with:

```javascript
      const editRes = applyShiftEdit(ss, sid, proposed, tz);
      if (!editRes.ok) return jsonResponse({ ok: false, retryable: editRes.retryable, error: editRes.error });
      ledger = editRes.ledger;
      ledgerSavedRows = editRes.savedRows;
      approvedRowStart = editRes.rowStart;
      approvedRowCount = editRes.rowCount;
      ledgerWritten = true;
```

Leave the outer `let ledger = null, sid = "";` / `let ledgerWritten = false, ledgerSavedRows = null;` / `let approvedRowStart = -1, approvedRowCount = 0;` declarations (lines ~928–930) untouched — they are still used by the status-write catch block below. Leave everything after `ledgerWritten = true;` (the status write, supersede sweep, recolor) untouched.

- [ ] **Step 3: Confirm `calc.js` tests still pass (sanity; unaffected)**

Run: `node --test calc.test.js`
Expected: all tests pass (this task does not touch `calc.js`; this just confirms the toolchain).

- [ ] **Step 4: Self-check the diff for fidelity**

Re-read the new `applyShiftEdit` against the original approve block. Confirm: every `jsonResponse({ok:false,...})` became `return {ok:false,...}` with the same `retryable` and `error` text; the success return exposes `ledger`, `date`, `time`, `rowStart`, `rowCount`, `savedRows`; and the caller assigns the four rollback vars from it. No other lines changed.

- [ ] **Step 5: Commit**

```bash
git add apps-script.gs
git commit -m "backend: extract applyShiftEdit helper from resolveRequest approve path"
```

---

## Task 2: Add the `adminEditShift` backend action

**Files:**
- Modify: `apps-script.gs` — add `handleAdminEditShift(payload)`; register `adminEditShift` in `doPost`.

- [ ] **Step 1: Add the `handleAdminEditShift` function**

Insert immediately **after** the `applyShiftEdit` function added in Task 1. It mirrors the PIN check of `handleListRequests`, the prep of the approve path, and the `cleanProposed` shaping of `handleRequestEdit`. The audit-row append and supersede sweep are best-effort: a successful ledger edit is never rolled back just because logging failed.

```javascript
// Admin direct edit: apply a proposed shift to the ledger immediately (no
// request/approve roundtrip) and log an audit row. PIN protected.
function handleAdminEditShift(payload) {
  const storedPin = PropertiesService.getScriptProperties().getProperty("ADMIN_PIN");
  if (!storedPin) return jsonResponse({ ok: false, error: "Admin access is not configured yet." });
  if (typeof payload.pin !== "string" || payload.pin !== storedPin) {
    Utilities.sleep(1000);
    return jsonResponse({ ok: false, error: "Wrong PIN." });
  }
  const sid = typeof payload.submissionId === "string" ? payload.submissionId.trim() : "";
  if (!sid || sid.length > 64) return jsonResponse({ ok: false, error: "Invalid submissionId" });

  // Same prep as the approve path: active slots/kitchen %, roster trainee levels,
  // then field validation (returns an errorCode for unknown_slot).
  configure({ slots: getSlots(), kitchenPct: getKitchenPct() });
  const proposed = payload.proposed;
  if (proposed && typeof proposed === "object") applyRosterTrainees(proposed.servers);
  const validation = validateShiftFields(proposed);
  if (validation) return validationResponse(validation);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonResponse({ ok: false, retryable: true, error: "Busy, try again." });
  try {
    const tz = TZ;
    const editRes = applyShiftEdit(ss, sid, proposed, tz);
    if (!editRes.ok) return jsonResponse({ ok: false, retryable: editRes.retryable, error: editRes.error });

    const nowStr = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm");

    // Audit row in the Edit-requests sheet, pre-resolved as "Admin edit" so it
    // shows in history but is never returned by handleListRequests (Pending only).
    try {
      const sheet = getOrCreateRequestsSheet(ss);
      const cleanProposed = {
        shiftType: proposed.shiftType,
        enteredBy: String(proposed.enteredBy).trim(),
        totalTips: Number(proposed.totalTips),
        servers: proposed.servers.map(function (s) {
          const trainee = !!s.trainee;
          return { name: String(s.name).trim(), slot: String(s.slot), trainee: trainee, pct: trainee ? Number(s.pct) : null };
        }),
        chefs: proposed.chefs.map(function (c) { return { name: String(c.name).trim() }; }),
      };
      const reqId = "ae-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      sheet.appendRow([reqId, nowStr, "admin", safeText(sid), editRes.date, editRes.time, "Admin edit", "", JSON.stringify(cleanProposed), nowStr, "admin"]);
    } catch (e) { /* best effort: the ledger edit already succeeded */ }

    // Supersede any pending staff requests for this shift; they are now stale and
    // approving one later would clobber this edit. Best-effort, per-row isolated.
    try {
      const reqSheet = ss.getSheetByName("Edit requests");
      const freshLast = reqSheet ? reqSheet.getLastRow() : 0;
      const sweep = (freshLast >= 2) ? reqSheet.getRange(2, 1, freshLast - 1, EDIT_REQ_HEADER.length).getValues() : [];
      for (let i = 0; i < sweep.length; i++) {
        const r = sweep[i];
        if (String(r[6] || "") !== "Pending") continue;
        if (String(r[3] || "") !== sid) continue;
        try {
          const keepO = reqSheet.getRange(i + 2, 8, 1, 2).getValues()[0];
          reqSheet.getRange(i + 2, 7, 1, 5).setValues([["Superseded", keepO[0], keepO[1], nowStr, "admin (auto)"]]);
        } catch (e) { /* best effort */ }
      }
    } catch (e) { /* best effort */ }

    try { recolorShifts(); } catch (e) { /* shading is cosmetic */ }
    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, retryable: true, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}
```

- [ ] **Step 2: Register the action in `doPost`**

In `doPost`, after the `resolveRequest` branch (lines ~1292–1294), add:

```javascript
  if (payload && payload.action === "adminEditShift") {
    return handleAdminEditShift(payload);
  }
```

- [ ] **Step 3: Commit**

```bash
git add apps-script.gs
git commit -m "backend: add adminEditShift action (immediate apply + audit row)"
```

---

## Task 3: Create the shared `editform.js` module

**Files:**
- Create: `editform.js`

This module owns the edit-form markup, the ledger-rows→model mapping, and the render/read controller. It uses fixed element ids (`edit-by`, `edit-total`, `edit-shift`, `edit-people`, `edit-add`, `edit-chef-section`, `edit-chef-list`) — safe because each page hosts exactly one edit form. Inner element classes (`.edit-person`, `.ep-row`, `.ep-name`, `.ep-slot`, `.ep-remove`, `.chef-check`, `.add-btn`, `.ep-pct`) match `today.html`'s existing CSS so styling is preserved.

- [ ] **Step 1: Write `editform.js`**

```javascript
// editform.js — shared shift-edit form for today.html (staff request) and
// admin.html (direct admin edit). Classic global script (no module/IIFE), loaded
// AFTER calc.js + i18n.js. Depends on globals: SHIFT_SLOTS, getSlot,
// findSlotByTimes, firstDuplicateName, slotLabel (calc.js); escapeHtml, t (page).
// The submit action (requestEdit vs adminEditShift), name/note fields, and toasts
// stay in each caller. This module only builds, populates, and reads the fields.

// Inner field markup. Carries data-i18n attributes so a runtime language toggle
// re-translates it. Inject once into a container, then run the page's static-i18n
// pass (or rely on t() already having filled the current language).
function editFormFieldsHtml() {
  return `
    <label for="edit-by" data-i18n="entered_by_label">${escapeHtml(t("entered_by_label"))}</label>
    <input type="text" id="edit-by" maxlength="60" autocomplete="off">

    <label for="edit-total" data-i18n="total_tips_label">${escapeHtml(t("total_tips_label"))}</label>
    <input type="number" id="edit-total" inputmode="decimal" step="0.01" min="1" max="100000">

    <label data-i18n="shift_label">${escapeHtml(t("shift_label"))}</label>
    <div class="ep-pct" id="edit-shift">
      <button type="button" data-shift="lunch" data-i18n="lunch">${escapeHtml(t("lunch"))}</button>
      <button type="button" data-shift="dinner" data-i18n="dinner">${escapeHtml(t("dinner"))}</button>
    </div>

    <label data-i18n="servers_word">${escapeHtml(t("servers_word"))}</label>
    <div id="edit-people"></div>
    <button type="button" class="add-btn" id="edit-add" data-i18n="add_server">${escapeHtml(t("add_server"))}</button>

    <div id="edit-chef-section" class="hidden">
      <label data-i18n="chefs_label">${escapeHtml(t("chefs_label"))}</label>
      <div id="edit-chef-list"></div>
    </div>`;
}

// Ledger rows for one shift -> form model. Both pages pass ledger-shaped rows
// (recipient, role, shift, timeIn, timeOut, enteredBy, totalTips).
function shiftRowsToModel(rows) {
  const first = rows[0] || {};
  const shiftType = String(first.shift || "Dinner").toLowerCase() === "lunch" ? "lunch" : "dinner";
  const servers = rows
    .filter((r) => r.role === "Server" || r.role === "Trainee")
    .map((r) => {
      const slot = findSlotByTimes(shiftType, r.timeIn, r.timeOut);
      return { name: r.recipient || "", slot: slot ? slot.id : "" };
    });
  const chefs = rows.filter((r) => r.role === "Chef").map((r) => ({ name: r.recipient || "" }));
  return {
    enteredBy: first.enteredBy || "",
    totalTips: first.totalTips != null ? first.totalTips : "",
    shiftType: shiftType,
    servers: servers.length ? servers : [{ name: "", slot: "" }],
    chefs: chefs,
  };
}

// Controller over the injected fields. Wires its own add/remove/shift-toggle
// handlers once. Call render() to populate, read() to validate + package.
function createEditForm() {
  let shiftType = "dinner";
  let chefRoster = []; // [{name}]
  const peopleEl = document.getElementById("edit-people");

  function slotOptions(shift, selectedId) {
    return `<option value="">${escapeHtml(t("pick_time"))}</option>` +
      (SHIFT_SLOTS[shift] || []).map((s) =>
        `<option value="${escapeHtml(s.id)}"${s.id === selectedId ? " selected" : ""}>${escapeHtml(slotLabel(s.timeIn, s.timeOut))}</option>`
      ).join("");
  }

  function personRowHtml(p) {
    return `<div class="edit-person">
      <div class="ep-row">
        <input type="text" class="ep-name" maxlength="40" placeholder="${escapeHtml(t("ph_name"))}" value="${escapeHtml(p.name || "")}">
        <button type="button" class="ep-remove" aria-label="${escapeHtml(t("remove"))}">&times;</button>
      </div>
      <div class="ep-row"><select class="ep-slot">${slotOptions(shiftType, p.slot || "")}</select></div>
    </div>`;
  }

  function renderPeople(people) {
    peopleEl.innerHTML = people.map(personRowHtml).join("");
  }

  function renderChefs(checkedNames) {
    const sec = document.getElementById("edit-chef-section");
    const list = document.getElementById("edit-chef-list");
    const checked = checkedNames || [];
    // Union the roster with chefs already on the shift so a slow/failed roster
    // load can't silently drop existing chefs (redistributing their money).
    const names = [], seen = {};
    chefRoster.map((c) => c.name).concat(checked).forEach((n) => {
      const k = String(n).toLowerCase();
      if (k && !seen[k]) { seen[k] = true; names.push(n); }
    });
    if (!names.length) { sec.classList.add("hidden"); list.innerHTML = ""; return; }
    sec.classList.remove("hidden");
    const set = new Set(checked.map((n) => n.toLowerCase()));
    list.innerHTML = names.map((n) =>
      `<label class="chef-check"><input type="checkbox" class="edit-chef-cb" value="${escapeHtml(n)}"${set.has(n.toLowerCase()) ? " checked" : ""}> ${escapeHtml(n)}</label>`
    ).join("");
  }

  function renderShiftToggle() {
    document.querySelectorAll("#edit-shift button").forEach((b) => b.classList.toggle("selected", b.dataset.shift === shiftType));
  }

  function readServers() {
    return Array.from(peopleEl.querySelectorAll(".edit-person")).map((row) => ({
      name: row.querySelector(".ep-name").value.trim(),
      slot: row.querySelector(".ep-slot").value,
      trainee: false, // roster-managed; backend reapplies on save
      pct: null,
    }));
  }

  function readChefs() {
    return Array.from(document.querySelectorAll(".edit-chef-cb")).filter((cb) => cb.checked).map((cb) => ({ name: cb.value }));
  }

  // Handlers (wired once at construction).
  peopleEl.addEventListener("click", (e) => {
    const remove = e.target.closest(".ep-remove");
    if (!remove) return;
    if (peopleEl.querySelectorAll(".edit-person").length <= 1) return; // keep at least one
    remove.closest(".edit-person").remove();
  });
  document.getElementById("edit-add").addEventListener("click", () => {
    if (peopleEl.querySelectorAll(".edit-person").length >= 12) return;
    peopleEl.insertAdjacentHTML("beforeend", personRowHtml({ name: "", slot: "" }));
  });
  document.getElementById("edit-shift").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-shift]");
    if (!b) return;
    shiftType = b.dataset.shift;
    renderShiftToggle();
    peopleEl.querySelectorAll(".ep-slot").forEach((sel) => {
      sel.innerHTML = slotOptions(shiftType, getSlot(shiftType, sel.value) ? sel.value : "");
    });
  });

  function render(model, roster) {
    chefRoster = roster || [];
    shiftType = model.shiftType === "lunch" ? "lunch" : "dinner";
    document.getElementById("edit-by").value = model.enteredBy || "";
    document.getElementById("edit-total").value = (model.totalTips != null && model.totalTips !== "") ? model.totalTips : "";
    renderShiftToggle();
    const servers = (model.servers && model.servers.length) ? model.servers : [{ name: "", slot: "" }];
    renderPeople(servers);
    renderChefs((model.chefs || []).map((c) => c.name || c));
    // Hint when a recorded slot no longer matches a current slot (owner retimed it).
    return servers.some((s) => s.name && !s.slot);
  }

  function read() {
    const enteredBy = document.getElementById("edit-by").value.trim();
    const totalTips = parseFloat(document.getElementById("edit-total").value);
    const servers = readServers();
    const chefs = readChefs();
    if (!enteredBy) return { error: t("err_who_recorded") };
    if (!isFinite(totalTips) || totalTips < 1 || totalTips > 100000) return { error: t("err_total_range2") };
    if (!servers.length) return { error: t("err_one_server") };
    for (let i = 0; i < servers.length; i++) {
      if (!servers[i].name) return { error: t("err_server_name_n", { n: i + 1 }) };
      if (!getSlot(shiftType, servers[i].slot)) return { error: t("err_server_slot_n", { n: i + 1 }) };
    }
    const dupServer = firstDuplicateName(servers.map((s) => s.name));
    if (dupServer) return { error: t("err_two_servers_same", { name: dupServer }) };
    const dupChef = firstDuplicateName(chefs.map((c) => c.name));
    if (dupChef) return { error: t("err_dup_chef", { name: dupChef }) };
    return { proposed: { shiftType: shiftType, enteredBy: enteredBy, totalTips: totalTips, servers: servers, chefs: chefs } };
  }

  return { render: render, read: read };
}
```

- [ ] **Step 2: Commit**

```bash
git add editform.js
git commit -m "feat: shared editform.js (markup + rows-to-model + render/read controller)"
```

---

## Task 4: Refactor `today.html` to use `editform.js`

**Files:**
- Modify: `today.html` — markup (lines ~129–148), script include (line ~161), helper functions (lines ~280–410), open handler (lines ~356–388), submit handler `buildProposed`/`reqSend` (lines ~394–441), and the element-ref declarations (lines ~181–190).

The goal: `today.html` keeps its request-only chrome (name/note/sub/err/cancel/send, toast, `requestEdit` POST) and delegates all field logic to the shared module. Verify the staff flow still works afterward.

- [ ] **Step 1: Add the script include**

After `<script src="calc.js"></script>` (line 161), add:

```html
<script src="editform.js"></script>
```

- [ ] **Step 2: Replace the inline field markup with a container**

Replace lines ~129–148 (from `<label for="edit-by" ...>` through the closing `</div>` of `#edit-chef-section`) with:

```html
    <div id="edit-fields"></div>
```

Keep the surrounding chrome: the `<h2>`, `#edit-sub`, `#req-name`, `#req-note`, the `<hr class="sep">` + `#edit-hint`, and below the container the `#req-err` + `.modal-actions` (cancel/send).

- [ ] **Step 3: Remove now-shared helper functions and add the controller**

Delete these functions from `today.html`'s script (they now live in `editform.js`): `slotOptions`, `personRowHtml`, `renderEditPeople`, `readEditServers`, `renderEditChefs`, `readEditChefs`, `renderEditShiftToggle`, `buildProposed`, the `editPeople` click handler, the `editAdd` click handler, and the `#edit-shift` click handler (lines ~280–354 and ~394–411).

Also delete the now-unused element refs `editPeople`, `editAdd`, and the `editShift` / `editChefRoster` state declarations (lines ~183–190 for `editPeople`/`editAdd`, plus the `let editShift` / `let editChefRoster`). Keep `currentSid`.

Inject the fields and build the controller once, near where the page initializes (right after `escapeHtml`/`t` are available and before the open handler runs). Add:

```javascript
document.getElementById("edit-fields").innerHTML = editFormFieldsHtml();
const editForm = createEditForm();
let editChefRoster = []; // populated by loadChefRoster(); passed into editForm.render
```

(`editChefRoster` is still loaded by the existing `loadChefRoster()` — keep that function and its assignment to `editChefRoster`.)

- [ ] **Step 4: Rewrite the open handler to use the controller**

Replace the body of the `content` click handler (lines ~356–388) that builds the form with:

```javascript
content.addEventListener("click", (e) => {
  const btn = e.target.closest(".req-btn");
  if (!btn) return;
  const card = btn.closest(".shift");
  const sid = card.dataset.sid;
  const sh = shiftsMap[sid];
  if (!sh) { alert(t("shift_gone")); return; }
  currentSid = sid;
  editSub.textContent = t("edit_sub_tpl", { date: sh.date, time: sh.time, amount: fmt(sh.totalTips) });
  reqName.value = getMe();
  reqNote.value = "";
  reqErr.textContent = "";
  const retimed = editForm.render(shiftRowsToModel(sh.recipients), editChefRoster);
  reqErr.textContent = retimed ? t("slot_retimed_hint") : "";
  modal.classList.remove("hidden");
  reqName.focus();
});
```

- [ ] **Step 5: Rewrite the submit handler to read from the controller**

Replace the `reqSend` click handler (lines ~413–441) with:

```javascript
reqSend.addEventListener("click", async () => {
  const name = reqName.value.trim();
  const note = reqNote.value.trim();
  if (!name) { reqErr.textContent = t("err_enter_name"); reqName.focus(); return; }
  const built = editForm.read();
  if (built.error) { reqErr.textContent = built.error; return; }
  reqErr.textContent = "";
  reqSend.disabled = true; reqSend.textContent = t("sending");
  try {
    const res = await fetch(ENDPOINT_URL, {
      method: "POST", mode: "cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "requestEdit", submissionId: currentSid, requestedBy: name, note: note, proposed: built.proposed }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.ok) {
      if (data.errorCode === "unknown_slot") { reqErr.textContent = t("slots_changed_refresh"); await loadChefRoster(); load(); return; }
      throw new Error(data.error || "send failed");
    }
    setMe(name);
    modal.classList.add("hidden");
    showToast(t("edit_sent_toast"));
  } catch (err) {
    reqErr.textContent = t("could_not_send_prefix") + (err && err.message || t("try_again"));
  } finally {
    reqSend.disabled = false; reqSend.textContent = t("send_request");
  }
});
```

- [ ] **Step 6: Verify the staff flow manually**

Serve the folder locally so the relative `<script src>` files load (the entry/today pages talk to the deployed Apps Script endpoint):

Run: `python -m http.server 8000`
Then open `http://localhost:8000/today.html`.

Verify, with the Apps Script endpoint reachable:
1. The list of today's shifts renders (or "no shifts today").
2. Tapping "Request edit" opens the modal with name/note + the fields prefilled (entered-by, total, shift toggle highlighted, server rows with slots selected, chef checkboxes for chefs on the shift).
3. Adding/removing a server row works; switching the shift toggle re-fills the slot dropdowns.
4. Submitting a valid edit shows the "edit sent" toast; an invalid one (blank server name) shows the inline error.
5. The language toggle still re-translates the field labels.

Expected: all of the above behave exactly as before the refactor. Open the browser console and confirm no `ReferenceError` for removed functions.

- [ ] **Step 7: Commit**

```bash
git add today.html
git commit -m "today: use shared editform.js for the request-edit modal"
```

---

## Task 5: Add the admin Edit button and wire `adminEditShift`

**Files:**
- Modify: `admin.html` — include `editform.js` (after line ~406); add an edit container + buttons inside the shift modal card (lines ~398–402).
- Modify: `admin.js` — `openShiftModal` (lines ~445–450); the modal click handler (lines ~1105–1107); add edit open/save logic.
- Modify: `i18n.js` — Task 6.

- [ ] **Step 1: Include `editform.js` in `admin.html`**

After `<script src="calc.js"></script>` (line 406) and **before** `<script src="admin.js"></script>`, add:

```html
<script src="editform.js"></script>
```

- [ ] **Step 2: Add the edit container + actions to the shift modal**

Replace the shift-modal markup (lines ~398–402):

```html
<div id="shift-modal" class="modal hidden">
  <div class="modal-card">
    <button type="button" class="modal-close" id="modal-close" aria-label="Close">&times;</button>
    <div id="modal-body"></div>
  </div>
</div>
```

with:

```html
<div id="shift-modal" class="modal hidden">
  <div class="modal-card">
    <button type="button" class="modal-close" id="modal-close" aria-label="Close">&times;</button>
    <div id="modal-body"></div>
    <div class="modal-actions" id="shift-view-actions">
      <button type="button" class="btn-secondary" id="shift-edit-btn" data-i18n="edit_shift">Edit shift</button>
    </div>
    <div id="shift-edit-wrap" class="hidden">
      <div class="sub" id="shift-edit-sub"></div>
      <div id="edit-fields"></div>
      <div class="err" id="shift-edit-err"></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="shift-edit-cancel" data-i18n="cancel">Cancel</button>
        <button type="button" class="btn-primary" id="shift-edit-save" data-i18n="save_changes">Save changes</button>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Initialize the shared form once and track the open shift**

Near the top of `admin.js` state (after `let allRows = [];` on line 12), add:

```javascript
let editForm = null;       // created lazily after editFormFieldsHtml() is injected
let editingSid = null;     // submissionId currently being edited in the shift modal
```

Add a helper (place it just above `openShiftModal`, line ~445):

```javascript
// Lazily inject the shared edit fields + build the controller (one-time).
function ensureEditForm() {
  if (editForm) return editForm;
  document.getElementById("edit-fields").innerHTML = editFormFieldsHtml();
  applyStaticI18n(); // translate the freshly injected data-i18n labels
  editForm = createEditForm();
  return editForm;
}
```

Note: `applyStaticI18n` is provided by `i18n.js` (used elsewhere in the app to translate `data-i18n` nodes). If the admin app uses a differently named static-i18n pass, call that instead.

- [ ] **Step 4: Reset the modal to view mode when opening a shift**

Replace `openShiftModal` (lines ~445–450):

```javascript
function openShiftModal(sid) {
  const shiftRows = allRows.filter((r) => (r.submissionId || (r.date + r.time)) === sid);
  if (!shiftRows.length) return;
  editingSid = sid;
  document.getElementById("modal-body").innerHTML = shiftCardsHtml(shiftRows);
  // Always open in view mode (Edit button visible, edit form hidden).
  document.getElementById("shift-edit-wrap").classList.add("hidden");
  document.getElementById("shift-view-actions").classList.remove("hidden");
  document.getElementById("shift-modal").classList.remove("hidden");
}
```

- [ ] **Step 5: Wire the Edit / Cancel / Save buttons**

In the modal click handler (lines ~1105–1107), it currently closes on backdrop/`#modal-close`. Extend that handler so Edit/Cancel/Save are handled and the close also resets `editingSid`:

```javascript
  const modal = document.getElementById("shift-modal");
  modal.addEventListener("click", (e) => {
    if (e.target === modal || e.target.closest("#modal-close")) {
      modal.classList.add("hidden");
      editingSid = null;
      return;
    }
    if (e.target.closest("#shift-edit-btn")) { openShiftEdit(); return; }
    if (e.target.closest("#shift-edit-cancel")) {
      document.getElementById("shift-edit-wrap").classList.add("hidden");
      document.getElementById("shift-view-actions").classList.remove("hidden");
      return;
    }
    if (e.target.closest("#shift-edit-save")) { saveShiftEdit(); return; }
  });
```

(If lines ~1105–1107 already attach a handler to `modal`, replace that handler's body with the above rather than adding a second listener.)

- [ ] **Step 6: Add `openShiftEdit` and `saveShiftEdit`**

Add these functions next to `openShiftModal`:

```javascript
function openShiftEdit() {
  if (!editingSid) return;
  const rows = allRows.filter((r) => (r.submissionId || (r.date + r.time)) === editingSid);
  if (!rows.length) return;
  const form = ensureEditForm();
  const chefRoster = staffList.filter((s) => s.role === "Chef").map((s) => ({ name: s.name }));
  const first = rows[0];
  document.getElementById("shift-edit-sub").textContent = `${first.date || ""} ${first.time || ""}`;
  document.getElementById("shift-edit-err").textContent = "";
  const retimed = form.render(shiftRowsToModel(rows), chefRoster);
  if (retimed) document.getElementById("shift-edit-err").textContent = t("slot_retimed_hint");
  document.getElementById("shift-view-actions").classList.add("hidden");
  document.getElementById("shift-edit-wrap").classList.remove("hidden");
}

async function saveShiftEdit() {
  const errEl = document.getElementById("shift-edit-err");
  const built = ensureEditForm().read();
  if (built.error) { errEl.textContent = built.error; return; }
  errEl.textContent = "";
  const saveBtn = document.getElementById("shift-edit-save");
  saveBtn.disabled = true; saveBtn.textContent = t("sending");
  try {
    const res = await fetch(ENDPOINT_URL, {
      method: "POST", mode: "cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "adminEditShift", pin: sessionPin, submissionId: editingSid, proposed: built.proposed }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.ok) {
      if (data.errorCode === "unknown_slot") { errEl.textContent = t("slots_changed_refresh"); return; }
      throw new Error(data.error || "save failed");
    }
    document.getElementById("shift-modal").classList.add("hidden");
    editingSid = null;
    window.alert(t("admin_edit_saved"));
    const refreshed = await fetchData(sessionPin);
    if (refreshed && refreshed.ok) {
      allRows = refreshed.rows || []; staffList = refreshed.staff || []; payoutList = refreshed.payouts || [];
      mirrorConfig(refreshed.config);
      render();
    }
  } catch (err) {
    errEl.textContent = (err && err.message) || t("network_retry");
  } finally {
    saveBtn.disabled = false; saveBtn.textContent = t("save_changes");
  }
}
```

Note: confirm the exact name of the data-refresh used elsewhere (line ~282 uses `fetchData(sessionPin)` then assigns `allRows`/`staffList`/`payoutList` and calls `mirrorConfig` + `render`). Match whatever helper the existing "refresh" button uses; if there's a single `reload()`-style function, call that instead of duplicating the assignment.

- [ ] **Step 7: Verify the admin flow manually**

Run (if not already): `python -m http.server 8000`
Open `http://localhost:8000/admin.html`, enter the PIN.

Verify:
1. Open a shift (tap a calendar day segment / drill-down) → the read-only cards show, with an "Edit shift" button.
2. Tap "Edit shift" → cards hide, the edit form appears prefilled (entered-by, total, shift toggle, server rows + slots, chef checkboxes).
3. Change the total tips, tap "Save changes" → alert "Shift updated.", modal closes, the view re-renders with the new amounts.
4. Re-open the same shift → the edit is reflected.
5. Invalid edit (blank server name) → inline error, no save.
6. Cancel returns to the read-only view without saving.

Expected: edits apply immediately; numbers update after the refetch.

- [ ] **Step 8: Commit**

```bash
git add admin.html admin.js
git commit -m "admin: Edit shift button in the shift modal (immediate apply via adminEditShift)"
```

---

## Task 6: Add i18n keys

**Files:**
- Modify: `i18n.js` — add three keys to both the `en` and `ko` blocks.

- [ ] **Step 1: Confirm the keys don't already exist**

Run: `grep -n "edit_shift\|save_changes\|admin_edit_saved" i18n.js`
Expected: no matches.

- [ ] **Step 2: Add keys to the `en` block**

In the English dictionary (near the other admin keys, e.g. after `save: "Save",` on line ~176), add:

```javascript
    edit_shift: "Edit shift",
    save_changes: "Save changes",
    admin_edit_saved: "Shift updated.",
```

- [ ] **Step 3: Add keys to the `ko` block**

In the Korean dictionary (near `save: "저장",` on line ~380), add:

```javascript
    edit_shift: "시프트 수정",
    save_changes: "변경 사항 저장",
    admin_edit_saved: "시프트가 수정되었습니다.",
```

- [ ] **Step 4: Commit**

```bash
git add i18n.js
git commit -m "i18n: add edit_shift, save_changes, admin_edit_saved (en + ko)"
```

---

## Task 7: Service worker + deploy

**Files:**
- Modify: `sw.js` — add `./editform.js` to `ASSETS`; bump `CACHE`.

- [ ] **Step 1: Add `editform.js` to the precache list**

In `sw.js`, in the `ASSETS` array (begins line 2), add `"./editform.js",` next to `"./calc.js"`.

- [ ] **Step 2: Bump the cache version**

Change `const CACHE = "matsuri-tips-v54";` (line 1) to `const CACHE = "matsuri-tips-v55";`.

- [ ] **Step 3: Run the simplify pass before committing (per project rule)**

Per CLAUDE.md, run `/simplify` over the full change set, apply or note findings, then commit.

- [ ] **Step 4: Commit the frontend**

```bash
git add sw.js
git commit -m "sw: precache editform.js; cache v55"
```

- [ ] **Step 5: Deploy the backend (Apps Script via clasp)**

Follow `reference_clasp-deploy.md`: push `apps-script.gs` to the script (remote file is `Code.js`; preserve `setAdminPin`) and create/redeploy the prod deployment. The frontend `adminEditShift` calls will 4xx/`action` no-op until the backend is live, so deploy the backend before (or together with) pushing the frontend.

- [ ] **Step 6: Push the frontend**

```bash
git push origin master
```

GitHub Pages redeploys automatically. The new `editform.js` ships and the v55 service worker re-caches it on next load.

- [ ] **Step 7: Post-deploy smoke test**

On the live site: as admin, edit a shift's total and a server's slot; confirm the ledger row amounts change and the calendar re-renders. Open the Google Sheet "Edit requests" tab and confirm a new `Admin edit` row was appended with the proposed JSON. Confirm the staff `today.html` request-edit flow still works end to end.

---

## Self-Review

**Spec coverage:**
- Apply immediately, PIN-gated → Task 2 (`handleAdminEditShift` PIN check + direct `applyShiftEdit`). ✓
- Edit only, no delete → no delete path anywhere. ✓
- Audit row in Edit-requests sheet, never Pending → Task 2 (`"Admin edit"` status; `handleListRequests` returns only `Pending`). ✓
- Approach A: shared edit form + shared rewrite helper → Task 1 (`applyShiftEdit`), Task 3 (`editform.js`), Tasks 4–5 (both pages consume them). ✓
- Edit button on the admin read-only shift modal, prefilled, refetch on save → Task 5. ✓
- Edge cases (non-contiguous rows, duplicate same-type shift, roster trainee reapply, lock) → inherited by reusing `applyShiftEdit` + the same prep. ✓
- Supersede stale pending requests after an admin edit → Task 2 sweep (safeguard noted in spec rationale). ✓
- `sw.js` cache bump + new asset → Task 7. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The two "confirm the exact name" notes (admin static-i18n pass; admin refresh helper) point at concrete existing call sites (`applyStaticI18n`, `fetchData`+assignment at admin.js:282) with explicit fallbacks, not deferred work.

**Type/name consistency:** `applyShiftEdit` returns `{ ok, ledger, date, time, rowStart, rowCount, savedRows }`; Task 1 caller reads `editRes.ledger/savedRows/rowStart/rowCount`; Task 2 reads `editRes.date/time`. `editFormFieldsHtml`, `shiftRowsToModel`, `createEditForm` (→ `{ render, read }`) are named identically across Tasks 3/4/5. Element ids (`edit-by`, `edit-total`, `edit-shift`, `edit-people`, `edit-add`, `edit-chef-section`, `edit-chef-list`) match between `editFormFieldsHtml` and the controller. i18n keys used in code (`edit_shift`, `save_changes`, `admin_edit_saved`) are the ones added in Task 6; all other keys referenced (`entered_by_label`, `total_tips_label`, `shift_label`, `servers_word`, `add_server`, `chefs_label`, `pick_time`, `ph_name`, `remove`, `err_*`, `slot_retimed_hint`, `slots_changed_refresh`, `sending`, `network_retry`) already exist in `i18n.js`.
