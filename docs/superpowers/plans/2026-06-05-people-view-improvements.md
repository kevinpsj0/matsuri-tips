# People View Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin People view trustworthy and more useful: former staff stay visible, owed money shows inline and links to Payouts, names can be renamed/merged, each person drills into their shifts, and trainee rates are labeled.

**Architecture:** Frontend changes in `admin.js` (a new pure aggregation helper moved into `calc.js`, a rewritten `renderPeople`, a rename UI in the staff manager, and click delegation) with styles in `admin.html`. One new backend action `renameStaff` in `apps-script.gs` rewrites the roster, ledger, and payout log under a lock. All visible text goes through `t()` with English and Korean added to `i18n.js`.

**Tech Stack:** Vanilla JS (browser + Node dual-export pattern in `calc.js`), hand-rolled `node` test runner (`calc.test.js`), Google Apps Script backend, bilingual `i18n.js`.

**Backend deploy note:** `renameStaff` (Task 6) only takes effect after the Apps Script project is pushed and redeployed. See the clasp deploy procedure in memory (`reference_clasp-deploy.md`); the remote file is `Code.js`.

---

### Task 1: Add bilingual strings

**Files:**
- Modify: `i18n.js` (English block near line 169; Korean block near line 364)

- [ ] **Step 1: Add the English keys**

In the `en:` map, next to `trainee_tag` / `earnings_by_person`, add:

```js
    former_staff: "Former staff ({n})",
    owed_badge: "owed {amount}",
    trainee_rate_suffix: "(trainee)",
    rename: "Rename",
    save: "Save",
    rename_merge_confirm: "Merge {old} into {new}? Their shifts and payouts will combine.",
    could_not_rename: "Could not rename.",
```

(`cancel` already exists at line 76 — do not re-add it.)

- [ ] **Step 2: Add the Korean keys**

In the `ko:` map, at the mirror location near `trainee_tag` (line 364), add:

```js
    former_staff: "이전 직원 ({n})",
    owed_badge: "미지급 {amount}",
    trainee_rate_suffix: "(수습)",
    rename: "이름 변경",
    save: "저장",
    rename_merge_confirm: "{old}님을 {new}님으로 합칠까요? 근무와 지급 내역이 합쳐집니다.",
    could_not_rename: "이름을 변경하지 못했습니다.",
```

(`cancel` already exists at line 271 — do not re-add it.)

- [ ] **Step 3: Commit**

```bash
git add i18n.js
git commit -m "i18n: strings for People view improvements"
```

---

### Task 2: Pure people-aggregation helper (TDD)

Move the leaderboard aggregation out of `renderPeople` into a pure, testable function in `calc.js`, adding former/active partitioning and per-person shift rows.

**Files:**
- Modify: `calc.js` (add `aggregatePeople`, export in both `window` and `module.exports` blocks)
- Test: `calc.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `calc.test.js` (before the final pass/fail summary print):

```js
const { aggregatePeople } = require("./calc.js");

const erow = (recipient, role, amount, hours, submissionId, traineePct) =>
  ({ recipient, role, amount, hours, submissionId, traineePct: traineePct == null ? null : traineePct, date: "2026-06-01", shift: "Lunch" });

test("aggregatePeople sums totals/hours/shifts per person and ranks by total", () => {
  const rows = [
    erow("Bob", "Server", 50, 5, "s1"),
    erow("Alice", "Server", 80, 4, "s1"),
    erow("Alice", "Server", 40, 3, "s2"),
  ];
  const { active, former, max } = aggregatePeople(rows, new Set(["alice", "bob"]));
  assert.strictEqual(former.length, 0);
  assert.strictEqual(active.length, 2);
  assert.strictEqual(active[0].display, "Alice");
  assert.strictEqual(active[0].total, 120);
  assert.strictEqual(active[0].hours, 7);
  assert.strictEqual(active[0].shifts, 2);
  assert.strictEqual(active[1].display, "Bob");
  assert.strictEqual(max, 120);
});

test("aggregatePeople puts non-active earners in former, merges case-insensitively", () => {
  const rows = [
    erow("alice", "Server", 30, 2, "s1"),
    erow("Alice", "Server", 10, 1, "s2"),
    erow("Cara", "Trainee", 20, 2, "s3", 50),
  ];
  const { active, former } = aggregatePeople(rows, new Set(["alice"]));
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].total, 40); // both alice/Alice spellings merge
  assert.strictEqual(former.length, 1);
  assert.strictEqual(former[0].display, "Cara");
  assert.strictEqual(former[0].traineePct, 50);
  assert.strictEqual(former[0].isFormer, true);
});

test("aggregatePeople ignores chef/kitchen rows and keeps per-person rows", () => {
  const rows = [
    erow("Alice", "Server", 40, 3, "s1"),
    erow("Cho", "Chef", 85, 0, "s1"),
    erow("Kitchen", "Kitchen", 60, 0, "s1"),
  ];
  const { active } = aggregatePeople(rows, new Set(["alice"]));
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].rows.length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node calc.test.js`
Expected: FAIL on the three new tests with "aggregatePeople is not a function".

- [ ] **Step 3: Implement `aggregatePeople` in `calc.js`**

Add this function (place it after `firstDuplicateName` or near the other pure helpers):

```js
// Aggregate ledger rows into per-person earnings for the admin leaderboard.
// Only Server/Trainee rows count (chefs and the Kitchen fund are excluded).
// activeKeys is a Set of lowercased active staff names; anyone earning who is
// not in it is partitioned into `former`. Returns active/former arrays (each
// ranked by total desc) and a shared `max` for comparable bar widths.
function aggregatePeople(rows, activeKeys) {
  const agg = {};
  for (const r of rows) {
    if (r.role !== "Server" && r.role !== "Trainee") continue;
    const name = String(r.recipient || "").trim();
    const key = name.toLowerCase();
    if (!key) continue;
    if (!agg[key]) agg[key] = { key: key, total: 0, hours: 0, shifts: {}, names: {}, traineePct: null, rows: [] };
    const a = agg[key];
    a.total += r.amount || 0;
    a.hours += r.hours || 0;
    if (r.submissionId) a.shifts[r.submissionId] = true;
    a.names[name] = (a.names[name] || 0) + 1;
    if (r.role === "Trainee" && r.traineePct != null) a.traineePct = r.traineePct;
    a.rows.push(r);
  }
  const people = Object.keys(agg).map(function (k) {
    const a = agg[k];
    const display = Object.keys(a.names).sort(function (x, y) { return a.names[y] - a.names[x]; })[0];
    return {
      key: a.key, display: display, total: a.total, hours: a.hours,
      shifts: Object.keys(a.shifts).length, traineePct: a.traineePct,
      rows: a.rows, isFormer: !activeKeys.has(a.key),
    };
  });
  const byTotal = function (x, y) { return y.total - x.total; };
  const active = people.filter(function (p) { return !p.isFormer; }).sort(byTotal);
  const former = people.filter(function (p) { return p.isFormer; }).sort(byTotal);
  const max = Math.max.apply(null, [1].concat(people.map(function (p) { return p.total; })));
  return { active: active, former: former, max: max };
}
```

- [ ] **Step 4: Export it**

In the `window` block add `window.aggregatePeople = aggregatePeople;` and in the `module.exports` object add `aggregatePeople: aggregatePeople,`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node calc.test.js`
Expected: PASS for all tests, existing and new.

- [ ] **Step 6: Commit**

```bash
git add calc.js calc.test.js
git commit -m "calc: add aggregatePeople helper with active/former partition"
```

---

### Task 3: Rewrite renderPeople (former section, owed badge, drill-down, trainee suffix)

**Files:**
- Modify: `admin.js` (`renderPeople`, lines 663-702; add a `shiftRowsHtml` helper)

- [ ] **Step 1: Add the per-shift drill-down helper**

Add above `renderPeople` in `admin.js`:

```js
// One person's shifts for the drill-down, newest first.
function shiftRowsHtml(rows) {
  return rows.slice().sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); })
    .map(function (r) {
      const sh = String(r.shift).toLowerCase() === "lunch" ? t("lunch") : t("dinner");
      const h = r.hours ? r.hours.toFixed(1) + "h" : "—";
      return `<div class="lb-detail-row"><span>${escapeHtml(r.date)} · ${escapeHtml(sh)}</span><span>${h} · ${fmt(r.amount)}</span></div>`;
    }).join("");
}
```

- [ ] **Step 2: Replace the body of `renderPeople`**

Replace the whole function (lines 663-702) with:

```js
function renderPeople(rows) {
  const manager = renderStaffManager();
  const activeKeys = new Set(staffList.filter(function (s) { return s.active; }).map(function (s) { return s.name.toLowerCase(); }));
  const data = aggregatePeople(rows, activeKeys);
  if (!data.active.length && !data.former.length) {
    return manager + emptyState(activeKeys.size ? t("no_earnings_active") : t("add_staff_start"));
  }
  const owedMap = {};
  owedPositive().forEach(function (p) { owedMap[p.name.toLowerCase()] = p.owed; });

  const rowHtml = function (p) {
    const w = p.total > 0 ? Math.max(2, p.total / data.max * 100) : 0;
    const tag = p.traineePct != null ? `<span class="lb-tag"> · ${escapeHtml(t("trainee_tag", { pct: p.traineePct }))}</span>` : "";
    const owed = owedMap[p.key];
    const owedBadge = owed > 0.005 ? `<button type="button" class="lb-owed" data-goto="payouts">${escapeHtml(t("owed_badge", { amount: fmt(owed) }))}</button>` : "";
    const suffix = p.traineePct != null ? " " + escapeHtml(t("trainee_rate_suffix")) : "";
    const rate = p.hours > 0 ? fmt(p.total / p.hours) + "/h" + suffix : "—";
    return `<div class="lb-row" data-person="${escapeHtml(p.key)}">
      <div class="lb-head"><span class="lb-name">${escapeHtml(p.display)}${tag}</span><span class="lb-right">${owedBadge}<span class="lb-earned">${fmt(p.total)}</span></span></div>
      <div class="lb-track">${w ? `<div class="lb-bar" style="width:${w.toFixed(1)}%"></div>` : ""}</div>
      <div class="lb-meta">${p.shifts} ${escapeHtml(shiftWord(p.shifts))} · ${p.hours.toFixed(1)}h · ${rate}</div>
      <div class="lb-detail">${shiftRowsHtml(p.rows)}</div>
    </div>`;
  };

  const activeHtml = data.active.map(rowHtml).join("");
  const formerHtml = data.former.length
    ? `<details class="lb-former"><summary>${escapeHtml(t("former_staff", { n: data.former.length }))}</summary>${data.former.map(rowHtml).join("")}</details>`
    : "";
  return manager + `<div class="panel"><h2>${escapeHtml(t("earnings_by_person"))}</h2>${activeHtml}${formerHtml}</div>`;
}
```

- [ ] **Step 3: Manual check (logic compiles, no test infra for DOM)**

Run: `node -e "require('./calc.js'); console.log('calc loads')"`
Expected: prints `calc loads` (sanity that the shared helper still parses). Full visual verification happens in Task 5 once the click handler and CSS are in.

- [ ] **Step 4: Commit**

```bash
git add admin.js
git commit -m "admin: People leaderboard shows former staff, owed badge, drill-down, trainee rate label"
```

---

### Task 4: Styles for the new leaderboard elements

**Files:**
- Modify: `admin.html` (CSS block near the `.lb-*` rules, around lines 207-215)

- [ ] **Step 1: Add the styles**

After the existing `.lb-meta` rule, add:

```css
  .lb-row { cursor: pointer; }
  .lb-right { display: inline-flex; align-items: center; gap: .4rem; }
  .lb-owed { font-size: .72rem; font-weight: 600; color: #8a6d1a; background: #fff7e6; border: 1px solid #f0d98c; border-radius: 999px; padding: .05rem .45rem; cursor: pointer; }
  .lb-detail { display: none; margin: .35rem 0 .1rem; }
  .lb-row.open .lb-detail { display: block; }
  .lb-detail-row { display: flex; justify-content: space-between; font-size: .78rem; color: var(--muted); padding: .22rem 0; border-top: 1px dashed var(--line); }
  .lb-former { margin-top: .8rem; }
  .lb-former > summary { font-size: .74rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); cursor: pointer; padding: .35rem 0; }
  .lb-former .lb-row { opacity: .6; }
```

- [ ] **Step 2: Commit**

```bash
git add admin.html
git commit -m "admin: styles for owed badge, drill-down, and former-staff section"
```

---

### Task 5: Drill-down toggle in click delegation

The owed badge already jumps to Payouts through the existing `data-goto` handler (admin.js:1014). This task only adds the row-tap toggle for the drill-down.

**Files:**
- Modify: `admin.js` (the `#view` click listener, after the `data-goto` handler at line 1015)

- [ ] **Step 1: Add the toggle handler**

Immediately after the `gotoBtn` block (`if (gotoBtn) { ... return; }`), add:

```js
    const lbRow = e.target.closest(".lb-row[data-person]");
    if (lbRow) { lbRow.classList.toggle("open"); return; }
```

Because the `data-goto` (owed badge) handler runs first and returns, tapping the badge jumps to Payouts; tapping anywhere else on the row toggles its shift list.

- [ ] **Step 2: Manual verification in the admin app**

Open the admin app, enter the PIN, go to the People tab. Verify:
1. A person with multiple shifts in the period expands a dated shift list on tap and collapses on a second tap.
2. Tapping the "owed" badge switches to the Payouts tab instead of expanding.
3. A trainee's per-hour figure reads `$X/h (trainee)`.
4. If anyone earned in the period but is not active, a "Former staff (n)" section appears below, dimmed, and expands.

- [ ] **Step 3: Commit**

```bash
git add admin.js
git commit -m "admin: tap a leaderboard row to drill into that person's shifts"
```

---

### Task 6: Backend renameStaff action

**Files:**
- Modify: `apps-script.gs` (add `handleRenameStaff`, `rewriteRecipient`, `rewritePayoutName`; wire into `doPost` near the other staff actions around line 1227)

- [ ] **Step 1: Add the handler and helpers**

Add near the other staff handlers (after `handleSetStaffTrainee`):

```js
// Admin-only: rename a staff member, rewriting the roster, ledger history, and
// payout log so totals and owed balances follow the new spelling. If the new
// name matches another roster member of the SAME role, the two merge (the
// target row's role/active/trainee settings survive). Cross-role merges are
// rejected. Runs under a lock; mirrors the PIN check used by the other actions.
function handleRenameStaff(payload) {
  const storedPin = PropertiesService.getScriptProperties().getProperty("ADMIN_PIN");
  if (!storedPin) return jsonResponse({ ok: false, error: "Admin access is not configured yet." });
  if (typeof payload.pin !== "string" || payload.pin !== storedPin) {
    Utilities.sleep(1000);
    return jsonResponse({ ok: false, error: "Wrong PIN." });
  }
  const oldName = typeof payload.oldName === "string" ? payload.oldName.trim() : "";
  const newName = typeof payload.newName === "string" ? payload.newName.trim() : "";
  if (!oldName || !newName) return jsonResponse({ ok: false, error: "Both names are required" });
  if (newName.length > 40) return jsonResponse({ ok: false, error: "Name is too long (40 chars max)" });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return jsonResponse({ ok: false, retryable: true, error: "Busy, try again." });
  try {
    const sheet = getOrCreateStaffSheet(ss);
    const rows = readStaffRows(sheet);
    const oldKey = oldName.toLowerCase();
    const newKey = newName.toLowerCase();
    const oldRow = rows.filter(function (s) { return s.name.toLowerCase() === oldKey; })[0];
    if (!oldRow) return jsonResponse({ ok: false, error: oldName + " is not on the roster." });

    if (oldKey === newKey) {
      // Re-capitalization only.
      sheet.getRange(oldRow.rowIdx, 1).setValue(safeText(newName));
    } else {
      const target = rows.filter(function (s) { return s.name.toLowerCase() === newKey; })[0];
      if (target) {
        if (target.role !== oldRow.role) {
          return jsonResponse({ ok: false, error: "That name is already used by a different role. Change the role first." });
        }
        // Merge: target row survives; remove the old row from the roster.
        sheet.getRange(oldRow.rowIdx, 1).setValue("");
      } else {
        sheet.getRange(oldRow.rowIdx, 1).setValue(safeText(newName));
      }
    }

    rewriteRecipient(ss.getSheets()[0], COL.RECIPIENT, oldKey, newName);
    rewritePayoutName(ss, oldKey, newName);
    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, retryable: true, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// Rewrite every ledger recipient cell matching oldKey (case-insensitive) to newName.
function rewriteRecipient(sheet, col, oldKey, newName) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const range = sheet.getRange(2, col, lastRow - 1, 1);
  const vals = range.getValues();
  let changed = false;
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || "").trim().toLowerCase() === oldKey) { vals[i][0] = newName; changed = true; }
  }
  if (changed) range.setValues(vals);
}

// Rewrite payout-log names (Payouts col 2: Date, Name, Amount) matching oldKey.
function rewritePayoutName(ss, oldKey, newName) {
  const sheet = ss.getSheetByName("Payouts");
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const range = sheet.getRange(2, 2, lastRow - 1, 1);
  const vals = range.getValues();
  let changed = false;
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || "").trim().toLowerCase() === oldKey) { vals[i][0] = newName; changed = true; }
  }
  if (changed) range.setValues(vals);
}
```

- [ ] **Step 2: Wire into the dispatch**

In `doPost`, next to the other staff actions (near line 1227), add:

```js
  if (payload && payload.action === "renameStaff") {
    return handleRenameStaff(payload);
  }
```

- [ ] **Step 3: Deploy and manual verification**

Push and redeploy per the clasp procedure in memory (`reference_clasp-deploy.md`; remote file is `Code.js`, preserve `setAdminPin`). Then in the admin app verify in Task 7. Backend-only sanity now: confirm the project saves without a syntax error in the Apps Script editor (or `clasp push` succeeds).

- [ ] **Step 4: Commit**

```bash
git add apps-script.gs
git commit -m "backend: renameStaff rewrites roster, ledger, and payouts (with same-role merge)"
```

---

### Task 7: Rename UI in the staff manager

**Files:**
- Modify: `admin.js` (`renderStaffManager` lines 615-661; add `editingStaff` state and `renameStaff()`; click/keydown handlers; reset on tab switch)
- Modify: `admin.html` (small `.staff-rename` style)

- [ ] **Step 1: Add the editing state**

Near the other top-level state in `admin.js` (e.g. by `let period = "today";`), add:

```js
let editingStaff = null; // name currently being renamed in the staff manager
```

- [ ] **Step 2: Render an inline editor or a Rename button**

In `renderStaffManager`, replace `serverRow` and the shared `row` so an editing row shows the editor. First add a shared editor builder at the top of `renderStaffManager`:

```js
  const renameEditor = (s) => `<div class="staff-rename">
    <input type="text" id="staff-rename-input" value="${escapeHtml(s.name)}" maxlength="40" autocomplete="off" />
    <button type="button" class="staff-btn" data-rename-save="${escapeHtml(s.name)}">${escapeHtml(t("save"))}</button>
    <button type="button" class="staff-btn" data-rename-cancel="1">${escapeHtml(t("cancel"))}</button>
  </div>`;
  const editing = (s) => editingStaff != null && editingStaff.toLowerCase() === s.name.toLowerCase();
```

Change `row` (chefs / inactive) to show the editor when editing and a Rename button otherwise:

```js
  const row = (s, label, action, showRole) => editing(s)
    ? `<div class="staff-row">${renameEditor(s)}</div>`
    : `<div class="staff-row${s.active ? "" : " inactive"}">
    <span class="staff-name">${escapeHtml(s.name)}${showRole && isChef(s) ? " " + escapeHtml(t("chef_suffix")) : ""}</span>
    <span class="staff-actions">${s.active ? `<button type="button" class="staff-btn" data-rename-name="${escapeHtml(s.name)}">${escapeHtml(t("rename"))}</button>` : ""}<button type="button" class="staff-btn" data-staff-action="${action}" data-staff-name="${escapeHtml(s.name)}">${escapeHtml(label)}</button></span>
  </div>`;
```

Change `serverRow` to show the editor when editing and add a Rename button to its top row:

```js
  const serverRow = (s) => {
    if (editing(s)) return `<div class="staff-row staff-server">${renameEditor(s)}</div>`;
    const isTrainee = s.traineePct === 25 || s.traineePct === 50 || s.traineePct === 75;
    return `<div class="staff-row staff-server">
      <div class="staff-server-top">
        <span class="staff-name">${escapeHtml(s.name)}</span>
        <span class="staff-actions">
          <button type="button" class="staff-btn" data-rename-name="${escapeHtml(s.name)}">${escapeHtml(t("rename"))}</button>
          <button type="button" class="staff-btn" data-staff-action="inactivate" data-staff-name="${escapeHtml(s.name)}">${escapeHtml(t("inactivate"))}</button>
        </span>
      </div>
      <div class="staff-trainee">
        <label class="set-switch sm"><input type="checkbox" class="staff-trainee-cb" data-staff-name="${escapeHtml(s.name)}"${isTrainee ? " checked" : ""}><span class="set-slider"></span></label>
        <span class="staff-trainee-lbl">${escapeHtml(t("trainee"))}</span>
        <div class="trainee-pcts${isTrainee ? "" : " hidden"}">${pctBtn(s, 25)}${pctBtn(s, 50)}${pctBtn(s, 75)}</div>
      </div>
    </div>`;
  };
```

- [ ] **Step 3: Add the `renameStaff` network function**

Add near `setStaffActive` in `admin.js`:

```js
async function renameStaff(oldName, newName) {
  if (actionBusy) return;
  newName = (newName || "").trim();
  if (!newName) return;
  if (oldName.toLowerCase() !== newName.toLowerCase()) {
    const clash = staffList.filter(function (s) { return s.name.toLowerCase() === newName.toLowerCase(); })[0];
    if (clash && !window.confirm(t("rename_merge_confirm", { old: oldName, new: newName }))) return;
  }
  actionBusy = true;
  try {
    const res = await fetch(ENDPOINT_URL, {
      method: "POST", mode: "cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "renameStaff", pin: sessionPin, oldName: oldName, newName: newName }),
    });
    const data = await res.json();
    if (!data || !data.ok) { window.alert((data && data.error) || t("could_not_rename")); return; }
    editingStaff = null;
    await refresh();
  } catch (e) {
    window.alert(t("network_retry"));
  } finally { actionBusy = false; }
}
```

- [ ] **Step 4: Wire the click handlers**

In the `#view` click listener, after the `staffBtn` (`data-staff-action`) block, add:

```js
    const renameBtn = e.target.closest("[data-rename-name]");
    if (renameBtn) { editingStaff = renameBtn.dataset.renameName; render(); return; }
    if (e.target.closest("[data-rename-cancel]")) { editingStaff = null; render(); return; }
    const renameSave = e.target.closest("[data-rename-save]");
    if (renameSave) {
      const input = document.getElementById("staff-rename-input");
      renameStaff(renameSave.dataset.renameSave, input ? input.value : "");
      return;
    }
```

Add Enter-to-save in the `#view` keydown listener (next to the add-staff Enter handler):

```js
    if (e.target && e.target.id === "staff-rename-input" && e.key === "Enter") {
      const saveBtn = document.querySelector("[data-rename-save]");
      if (saveBtn) renameStaff(saveBtn.dataset.renameSave, e.target.value);
    }
```

Reset the editor when switching tabs: in the `#tabs` click listener (line 981-987), add `editingStaff = null;` next to `calDay = null;`.

- [ ] **Step 5: Add a small style**

In `admin.html`, near the `.staff-*` rules, add:

```css
  .staff-actions { display: inline-flex; gap: .35rem; }
  .staff-rename { display: flex; gap: .4rem; width: 100%; }
  .staff-rename input { flex: 1; min-width: 0; }
```

- [ ] **Step 6: Manual verification in the admin app**

With the backend from Task 6 deployed, in the People tab:
1. Rename a person to a new spelling: their leaderboard total and owed badge follow the new name; past shifts in the drill-down keep showing.
2. Rename a person to exactly match another active person of the same role: a merge confirm appears; after confirming, the two combine and the survivor keeps the target's role/trainee setting.
3. Attempt to rename a server to an existing chef's name: it is rejected with a clear message.
4. Cancel leaves the name unchanged; Enter in the field saves.

- [ ] **Step 7: Commit**

```bash
git add admin.js admin.html
git commit -m "admin: rename/merge staff from the People tab"
```

---

## Self-Review notes

- **Spec coverage:** Item 1 → Tasks 2-4; Item 2 (owed badge + jump) → Task 3 markup + existing `data-goto` handler; Item 3 (rename/merge) → Tasks 6-7; Item 4 (drill-down) → Tasks 3-5; Item 5 (trainee rate) → Task 3.
- **Types/names consistent:** `aggregatePeople` returns `{active, former, max}` with person fields `key/display/total/hours/shifts/traineePct/rows/isFormer`, used unchanged in `renderPeople`. `renameStaff` payload `{action,pin,oldName,newName}` matches `handleRenameStaff`.
- **No DOM/GAS unit tests** exist in this repo; only the pure `aggregatePeople` is unit-tested (Task 2). Frontend and backend use the manual verification steps above, consistent with the rest of the codebase.
- **Pre-commit:** per project convention, run `/simplify` (or `/code-review --fix`) before the final commit of the batch.
