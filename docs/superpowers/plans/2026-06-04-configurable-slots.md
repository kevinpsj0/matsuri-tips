# Configurable Slots + Kitchen % (and bundled hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the lunch/dinner time slots and the kitchen cut % configurable from the admin Settings tab (stored in Script Properties, defaulting to the current hardcoded values), with slot labels auto-derived from times and past shifts frozen; plus bundled hardening fixes (#1 formula injection, #3 edit-request lock, #6 fail-open show-split, #7 approve crash safety, #8 reverse-map by stored times, #10 dead code).

**Architecture:** The pure core `calc.js` is mirrored verbatim into `apps-script.gs`; it now holds mutable `SHIFT_SLOTS`/`KITCHEN_PCT` module state populated through a single `configure()` setter (used by clients, tests, and backend). The backend stores config in Script Properties and validates it on every read with a default fallback, so a corrupt property can never break tip math. Clients fetch config, cache it, and rebuild their slot dropdowns. The admin Settings tab edits a deep clone of the slots and saves the whole set via a PIN-protected endpoint.

**Tech Stack:** Vanilla JS (ES2017, classic non-module scripts), Google Apps Script (V8), Google Sheets as the datastore, `node calc.test.js` for unit tests, PWA service worker.

**Spec:** `docs/superpowers/specs/2026-06-04-configurable-slots-design.md` (read it first; it carries the design rationale and three rounds of review).

**Working rules:** Commit after every task. Run `node calc.test.js` after every `calc.js`/test change. The `calc.js` verbatim block (between the `BEGIN/END VERBATIM MIRROR` markers) must stay byte-identical in `apps-script.gs` — when you change one, copy it to the other in the same task. `calc.js` must remain a classic, non-module, non-IIFE script (top-level `var` is intentionally a `window` global).

---

## Stage A — config feature + cheap fixes

### Task 1: calc.js — mutable config state, `configure()`, `resetConfig()`

**Files:**
- Modify: `calc.js` (the `SHIFT_SLOTS` declaration near the top, and the export tails at the bottom)
- Test: `calc.test.js`

- [ ] **Step 1: Replace the `SHIFT_SLOTS` const block with default + mutable state + setters.**

In `calc.js`, replace the existing `var SHIFT_SLOTS = { ... };` table (lunch/dinner with `label` fields) with this. Note the `BEGIN VERBATIM MIRROR` marker and that `label` is dropped from the slot objects (labels are now derived):

```js
// --- BEGIN VERBATIM MIRROR (keep byte-identical in apps-script.gs) ---
var DEFAULT_SLOTS = {
  lunch: [
    { id: "L1100", timeIn: "11:00", timeOut: "16:30" },
    { id: "L1200", timeIn: "12:00", timeOut: "16:30" },
  ],
  dinner: [
    { id: "D1530", timeIn: "15:30", timeOut: "21:30" },
    { id: "D1630", timeIn: "16:30", timeOut: "21:30" },
    { id: "D1730", timeIn: "17:30", timeOut: "21:30" },
    { id: "D1800", timeIn: "18:00", timeOut: "21:30" },
  ],
};
var DEFAULT_KITCHEN_PCT = 15;
var SHIFT_SLOTS = DEFAULT_SLOTS;     // active table; replaced (never mutated in place) by configure()
var KITCHEN_PCT = DEFAULT_KITCHEN_PCT;
function configure(cfg) {
  if (cfg && cfg.slots) SHIFT_SLOTS = cfg.slots;
  if (cfg && typeof cfg.kitchenPct === "number") KITCHEN_PCT = cfg.kitchenPct;
  // Intentional and mirror-safe: in apps-script.gs `typeof window` is "undefined"
  // so this branch is skipped. DO NOT delete it from the Apps Script copy.
  if (typeof window !== "undefined") { window.SHIFT_SLOTS = SHIFT_SLOTS; window.KITCHEN_PCT = KITCHEN_PCT; }
}
function resetConfig() {
  SHIFT_SLOTS = DEFAULT_SLOTS; KITCHEN_PCT = DEFAULT_KITCHEN_PCT;
  if (typeof window !== "undefined") { window.SHIFT_SLOTS = SHIFT_SLOTS; window.KITCHEN_PCT = KITCHEN_PCT; }
}
```

Leave `getSlot` and `findSlotByTimes` exactly as they are (they read `SHIFT_SLOTS`). The `END VERBATIM MIRROR` marker goes after `splitShift` (added in Task 3).

- [ ] **Step 2: Update the export tails (outside the verbatim block).**

At the bottom of `calc.js`, update the browser and Node exports. Remove `getSlotByLabel` (deleted in Task 3) and add the new names:

```js
if (typeof window !== "undefined") {
  window.SHIFT_SLOTS = SHIFT_SLOTS;
  window.getSlot = getSlot;
  window.findSlotByTimes = findSlotByTimes;
  window.firstDuplicateName = firstDuplicateName;
  window.splitShift = splitShift;
  window.minutesWorked = minutesWorked;
  window.slotLabel = slotLabel;
  window.configure = configure;
  window.resetConfig = resetConfig;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { SHIFT_SLOTS: SHIFT_SLOTS, DEFAULT_SLOTS: DEFAULT_SLOTS, DEFAULT_KITCHEN_PCT: DEFAULT_KITCHEN_PCT, getSlot: getSlot, findSlotByTimes: findSlotByTimes, firstDuplicateName: firstDuplicateName, splitShift: splitShift, minutesWorked: minutesWorked, slotLabel: slotLabel, configure: configure, resetConfig: resetConfig };
}
```

(`slotLabel` is defined in Task 3; this step and Task 3 can be committed together if `node` errors on the missing reference — but the export object only references it lazily at module load, so define `slotLabel` before these tails. Order the file: config state → getSlot → findSlotByTimes → minutesWorked → slotLabel → splitShift → export tails.)

- [ ] **Step 3: Add `resetConfig()` calls to the test harness.**

In `calc.test.js`, change the `test()` helper so each case starts from defaults:

```js
function test(name, fn) {
  try { resetConfig(); fn(); resetConfig(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "\n      " + e.message); }
}
```

And add `resetConfig` to the require destructure at the top:

```js
const { splitShift, minutesWorked, getSlot, findSlotByTimes, SHIFT_SLOTS, firstDuplicateName, slotLabel, configure, resetConfig } = require("./calc.js");
```

- [ ] **Step 4: Run the existing tests to confirm nothing broke.**

Run: `node calc.test.js`
Expected: all existing assertions still PASS (the `slotLabel`/`configure` requires resolve; defaults equal the old table). If `slotLabel` is undefined here, you have not yet done Task 3 — do Task 3 in the same working session before running.

- [ ] **Step 5: Commit.**

```bash
git add calc.js calc.test.js
git commit -m "Add mutable slot/kitchen config state and configure() to calc core"
```

---

### Task 2: calc.js — `slotLabel()` with TDD

**Files:**
- Modify: `calc.js` (add `slotLabel` inside the verbatim block, before `splitShift`)
- Test: `calc.test.js`

- [ ] **Step 1: Write the failing tests.**

Add to `calc.test.js`:

```js
test("slotLabel: drops :00, single-letter meridiem, en dash", () => {
  assert.strictEqual(slotLabel("11:00", "16:30"), "11a–4:30p");
  assert.strictEqual(slotLabel("15:30", "21:30"), "3:30p–9:30p");
});
test("slotLabel: noon and midnight", () => {
  assert.strictEqual(slotLabel("12:00", "12:30"), "12p–12:30p");
  assert.strictEqual(slotLabel("00:00", "00:30"), "12a–12:30a");
});
test("slotLabel: blank times -> empty string", () => {
  assert.strictEqual(slotLabel("", ""), "");
  assert.strictEqual(slotLabel("11:00", ""), "");
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `node calc.test.js`
Expected: FAIL (slotLabel returns undefined / not a function behavior).

- [ ] **Step 3: Implement `slotLabel` (inside the verbatim block, before `splitShift`).**

```js
function slotLabel(timeIn, timeOut) {
  function one(t) {
    var p = String(t).split(":");
    var h = Number(p[0]), m = Number(p[1]);
    if (!isFinite(h) || !isFinite(m)) return String(t || "");
    var ap = h < 12 ? "a" : "p";
    var hh = h % 12; if (hh === 0) hh = 12;
    return hh + (m ? ":" + String(m).padStart(2, "0") : "") + ap;
  }
  if (!timeIn || !timeOut) return "";
  return one(timeIn) + "–" + one(timeOut); // en dash
}
```

- [ ] **Step 4: Run to verify pass.**

Run: `node calc.test.js`
Expected: PASS (all, including the three new `slotLabel` cases).

- [ ] **Step 5: Commit.**

```bash
git add calc.js calc.test.js
git commit -m "Add slotLabel() that derives a label from slot times"
```

---

### Task 3: calc.js — `splitShift` uses `KITCHEN_PCT` + `slotLabel`; remove `getSlotByLabel`

**Files:**
- Modify: `calc.js` (`splitShift`; delete `getSlotByLabel`; add `END VERBATIM MIRROR` marker)
- Test: `calc.test.js`

- [ ] **Step 1: Write failing tests for configurable kitchen % and custom slots.**

Add to `calc.test.js`:

```js
test("kitchenPct=0: kitchen takes nothing, sum invariant holds", () => {
  configure({ kitchenPct: 0 });
  const out = splitShift({ shiftType: "dinner", totalTips: 100, servers: [srv("A", "D1630")], chefs: [] });
  assert.strictEqual(out.kitchen, 0);
  assert.strictEqual(out.servers[0].amount, 100);
  assert.strictEqual(Math.round(sum(out) * 100), 10000);
});
test("kitchenPct=20 dinner with a chef: kitchen=20%, sum invariant holds", () => {
  configure({ kitchenPct: 20 });
  const out = splitShift({ shiftType: "dinner", totalTips: 300, servers: [srv("A", "D1630")], chefs: [{ name: "C" }] });
  assert.strictEqual(out.kitchen, 60); // round(30000*0.20)/100
  assert.strictEqual(Math.round(sum(out) * 100), 30000);
});
test("non-15 pct + chefs on lunch (double-round path) keeps the sum invariant", () => {
  configure({ kitchenPct: 12 });
  const out = splitShift({ shiftType: "lunch", totalTips: 333.33, servers: [srv("A", "L1100"), srv("B", "L1200")], chefs: [{ name: "C" }, { name: "D" }] });
  assert.strictEqual(Math.round(sum(out) * 100), 33333);
});
test("custom slots via configure: getSlot and splitShift use them", () => {
  configure({ slots: { lunch: [{ id: "X", timeIn: "10:00", timeOut: "14:00" }], dinner: [] } });
  assert.strictEqual(getSlot("lunch", "X").timeOut, "14:00");
  const out = splitShift({ shiftType: "lunch", totalTips: 100, servers: [srv("A", "X")], chefs: [] });
  assert.strictEqual(out.servers[0].slotLabel, "10a–2p");
  assert.strictEqual(out.servers[0].hours, 4);
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `node calc.test.js`
Expected: FAIL (kitchen still hardcoded 15%; `slotLabel` not yet used as the snapshot, so `out.servers[0].slotLabel` is `""`).

- [ ] **Step 3: Edit `splitShift` — two changes only.**

Change the kitchen line:

```js
var kitchenCents = Math.round(T * KITCHEN_PCT / 100);
```

In the `enriched = servers.map(...)` return object, change `slotLabel` from `slot ? slot.label : ""` to:

```js
slot: slot ? slot.id : p.slot, slotLabel: slot ? slotLabel(slot.timeIn, slot.timeOut) : "",
```

(Everything else in `splitShift` is unchanged.)

- [ ] **Step 4: Delete `getSlotByLabel` and close the verbatim block.**

Remove the entire `getSlotByLabel` function from `calc.js`. After `splitShift`, add:

```js
// --- END VERBATIM MIRROR ---
```

Confirm `getSlotByLabel` is gone from the export tails (done in Task 1 Step 2).

- [ ] **Step 5: Run to verify pass.**

Run: `node calc.test.js`
Expected: PASS (all, including the four new cases).

- [ ] **Step 6: Commit.**

```bash
git add calc.js calc.test.js
git commit -m "splitShift uses configurable kitchen % and derived slot labels; drop getSlotByLabel"
```

---

### Task 4: apps-script.gs — mirror the verbatim core

**Files:**
- Modify: `apps-script.gs` (the mirrored block near the top: `SHIFT_SLOTS`, `getSlot`, `findSlotByTimes`, `getSlotByLabel`, `minutesWorked`, `splitShift`)

- [ ] **Step 1: Replace the mirrored block to match `calc.js` byte-for-byte.**

Copy the region between `// --- BEGIN VERBATIM MIRROR ---` and `// --- END VERBATIM MIRROR ---` from `calc.js` and paste it over the corresponding functions in `apps-script.gs` (the `var SHIFT_SLOTS = {...}` through `splitShift`). This: drops `label` from the default slots, adds `DEFAULT_SLOTS`/`DEFAULT_KITCHEN_PCT`/`KITCHEN_PCT`/`configure`/`resetConfig`/`slotLabel`, changes the kitchen line and the `slotLabel` snapshot, and **removes `getSlotByLabel`**. Update the descriptive mirror comment in **both** files (the header note at the top of `calc.js`, and the `// MUST match calc.js ...` comment above the block in `apps-script.gs`) to list the current mirrored set (`slotLabel`/`configure`/`resetConfig` added, `getSlotByLabel` removed). Keep the literal `BEGIN/END VERBATIM MIRROR` marker strings appearing **exactly once** per file (the Step 2 identity check splits on them).

- [ ] **Step 2: Verify the mirror is exact.**

Run: `node -e "const a=require('fs').readFileSync('calc.js','utf8');const b=require('fs').readFileSync('apps-script.gs','utf8');const x=s=>s.replace(/\r/g,'').split('BEGIN VERBATIM MIRROR')[1].split('END VERBATIM MIRROR')[0];console.log(x(a)===x(b)?'IDENTICAL':'DIFFERS')"` (the `\r` strip ignores the files' differing CRLF/LF conventions)
Expected: `IDENTICAL`. If `DIFFERS`, diff the two regions and reconcile.

- [ ] **Step 3: Confirm no remaining `getSlotByLabel` reference compiles away.**

Run: `node -e "const b=require('fs').readFileSync('apps-script.gs','utf8');console.log(/getSlotByLabel/.test(b)?'STILL REFERENCED':'clean')"`
Expected: `STILL REFERENCED` for now (because `splitsFromRows` still calls it — fixed in Task 7). Note it; it becomes `clean` after Task 7.

- [ ] **Step 4: Commit.**

```bash
git add apps-script.gs
git commit -m "Mirror configurable-config calc core into apps-script.gs"
```

---

### Task 5: apps-script.gs — config accessors and validators

**Files:**
- Modify: `apps-script.gs` (add near `getShowSplit`/`configObject`)

- [ ] **Step 1: Add `validateKitchenPct`, `validateSlots`, `getSlots`, `getKitchenPct`, and extend `configObject`.**

```js
function deepCopySlots(s) { return JSON.parse(JSON.stringify(s)); }

function validateKitchenPct(n) {
  if (typeof n !== "number" || !isFinite(n) || !Number.isInteger(n) || n < 0 || n > 50) return "Kitchen % must be a whole number from 0 to 50";
  return null;
}

// Returns an error string or null. Shared by handleSetSlots (write) and getSlots (read).
function validateSlots(slots) {
  if (!slots || typeof slots !== "object") return "Invalid slots";
  var shifts = ["lunch", "dinner"];
  for (var s = 0; s < shifts.length; s++) {
    var arr = slots[shifts[s]];
    if (!Array.isArray(arr) || arr.length < 1 || arr.length > 8) return shifts[s] + " must have 1-8 time slots";
    var seenPair = {};
    for (var i = 0; i < arr.length; i++) {
      var slot = arr[i];
      if (!slot || typeof slot !== "object") return "Invalid slot";
      if (!isValidTime(slot.timeIn) || !isValidTime(slot.timeOut)) return "Slot times must be HH:MM";
      var mins = minutesWorked(slot.timeIn, slot.timeOut);
      if (mins < 30) return "Each slot must be at least 30 minutes (the end must be later the same day)";
      if (mins > 16 * 60) return "Each slot must be 16 hours or less";
      var key = slot.timeIn + "-" + slot.timeOut;
      if (seenPair[key]) return "Two " + shifts[s] + " slots have the same times: " + slotLabel(slot.timeIn, slot.timeOut);
      seenPair[key] = true;
      if (slot.id != null && !/^[A-Za-z0-9_-]{1,32}$/.test(String(slot.id))) return "Invalid slot id";
    }
  }
  return null;
}

function getSlots() {
  var raw = PropertiesService.getScriptProperties().getProperty("SLOTS");
  if (!raw) return deepCopySlots(DEFAULT_SLOTS);
  var parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return deepCopySlots(DEFAULT_SLOTS); }
  if (validateSlots(parsed)) return deepCopySlots(DEFAULT_SLOTS);
  // A properly saved SLOTS always has a non-empty id per slot; a hand-edit that
  // dropped one would let getSlot(type,"") match a blank-id slot, so treat any
  // missing id as corrupt and fall back to defaults.
  var allHaveIds = ["lunch", "dinner"].every(function (k) { return parsed[k].every(function (s) { return s.id != null && String(s.id) !== ""; }); });
  if (!allHaveIds) return deepCopySlots(DEFAULT_SLOTS);
  // Normalize: return only {id,timeIn,timeOut}, dropping any extra keys, so the
  // active table never carries hand-edited junk into SHIFT_SLOTS.
  function norm(arr) { return arr.map(function (s) { return { id: String(s.id), timeIn: String(s.timeIn), timeOut: String(s.timeOut) }; }); }
  return { lunch: norm(parsed.lunch), dinner: norm(parsed.dinner) };
}

function getKitchenPct() {
  var raw = PropertiesService.getScriptProperties().getProperty("KITCHEN_PCT");
  if (raw == null || String(raw).trim() === "") return 15;
  var n = Number(raw);
  return (Number.isInteger(n) && n >= 0 && n <= 50) ? n : 15;
}
```

Change `configObject`:

```js
function configObject() {
  return { showSplit: getShowSplit(), kitchenPct: getKitchenPct(), slots: getSlots() };
}
```

- [ ] **Step 2: Add a manual backend smoke test (`_smokeTestConfig`).**

Append to `apps-script.gs`:

```js
// Manual: run from the Apps Script editor; reads the Logger output. Restores config at the end.
function _smokeTestConfig() {
  var props = PropertiesService.getScriptProperties();
  var savedSlots = props.getProperty("SLOTS");
  var savedPct = props.getProperty("KITCHEN_PCT");
  try {
    props.deleteProperty("SLOTS"); props.deleteProperty("KITCHEN_PCT");
    if (getKitchenPct() !== 15) throw new Error("default pct should be 15");
    if (getSlots().lunch.length !== 2) throw new Error("default slots fallback failed");
    props.setProperty("SLOTS", "{not json"); // unparseable
    if (getSlots().lunch.length !== 2) throw new Error("unparseable SLOTS should fall back to defaults");
    props.setProperty("SLOTS", JSON.stringify({ lunch: [{ id: "a", timeIn: "11:00", timeOut: "10:00" }], dinner: [{ id: "b", timeIn: "18:00", timeOut: "21:30" }] })); // parseable but end<start
    if (getSlots().lunch.length !== 2) throw new Error("invalid (end<start) SLOTS should fall back to defaults");
    props.setProperty("SLOTS", JSON.stringify({ lunch: [{ timeIn: "11:00", timeOut: "16:30" }], dinner: [{ id: "b", timeIn: "18:00", timeOut: "21:30" }] })); // missing id
    if (getSlots().lunch[0].id !== "L1100") throw new Error("missing-id SLOTS should fall back to defaults");
    if (validateSlots({ lunch: [{ timeIn: "11:00", timeOut: "11:10" }], dinner: [{ timeIn: "18:00", timeOut: "21:30" }] }) === null) throw new Error("sub-30-min slot should be rejected");
    if (validateKitchenPct(15) !== null) throw new Error("15 should be valid");
    if (validateKitchenPct(51) === null) throw new Error("51 should be rejected");
    if (validateSlots({ lunch: [{ timeIn: "11:00", timeOut: "16:30" }], dinner: [{ timeIn: "18:00", timeOut: "21:30" }] }) !== null) throw new Error("valid slots rejected");
    if (validateSlots({ lunch: [{ timeIn: "11:00", timeOut: "10:00" }], dinner: [{ timeIn: "18:00", timeOut: "21:30" }] }) === null) throw new Error("end-before-start should be rejected");
    Logger.log("smoke config: OK");
  } finally {
    if (savedSlots == null) props.deleteProperty("SLOTS"); else props.setProperty("SLOTS", savedSlots);
    if (savedPct == null) props.deleteProperty("KITCHEN_PCT"); else props.setProperty("KITCHEN_PCT", savedPct);
    resetConfig();
  }
}
```

- [ ] **Step 3: Lint locally (syntax only).**

Run: `node --check apps-script.gs`
Expected: no output (valid syntax). (Apps Script APIs aren't available in node, but `--check` catches syntax errors.)

- [ ] **Step 4: Commit.**

```bash
git add apps-script.gs
git commit -m "Add validated config accessors (getSlots/getKitchenPct) with default fallback"
```

---

### Task 6: apps-script.gs — `setSlots` / `setKitchenPct` write handlers + routing

**Files:**
- Modify: `apps-script.gs` (new handlers; `doPost` action routing)

- [ ] **Step 1: Add the two PIN-protected handlers.**

```js
function handleSetKitchenPct(payload) {
  const storedPin = PropertiesService.getScriptProperties().getProperty("ADMIN_PIN");
  if (!storedPin) return jsonResponse({ ok: false, error: "Admin access is not configured yet." });
  if (typeof payload.pin !== "string" || payload.pin !== storedPin) {
    Utilities.sleep(1000);
    return jsonResponse({ ok: false, error: "Wrong PIN." });
  }
  const err = validateKitchenPct(payload.kitchenPct);
  if (err) return jsonResponse({ ok: false, error: err });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return jsonResponse({ ok: false, retryable: true, error: "Busy, try again." });
  try {
    PropertiesService.getScriptProperties().setProperty("KITCHEN_PCT", String(payload.kitchenPct));
    return jsonResponse({ ok: true, config: configObject() });
  } catch (e) {
    return jsonResponse({ ok: false, retryable: true, error: String(e && e.message || e) });
  } finally { lock.releaseLock(); }
}

function handleSetSlots(payload) {
  const storedPin = PropertiesService.getScriptProperties().getProperty("ADMIN_PIN");
  if (!storedPin) return jsonResponse({ ok: false, error: "Admin access is not configured yet." });
  if (typeof payload.pin !== "string" || payload.pin !== storedPin) {
    Utilities.sleep(1000);
    return jsonResponse({ ok: false, error: "Wrong PIN." });
  }
  const err = validateSlots(payload.slots);
  if (err) return jsonResponse({ ok: false, error: err });

  // Reconstruct from validated fields only; assign globally-unique ids.
  const seen = {};
  // Pass 1: reserve all valid supplied ids across both shifts.
  ["lunch", "dinner"].forEach(function (k) {
    payload.slots[k].forEach(function (s) {
      if (s.id != null && /^[A-Za-z0-9_-]{1,32}$/.test(String(s.id))) seen[String(s.id)] = true;
    });
  });
  function mkId() { var id; do { id = "sl-" + Math.random().toString(36).slice(2, 8); } while (seen[id]); seen[id] = true; return id; }
  function norm(arr) {
    return arr.map(function (s) {
      var id = (s.id != null && /^[A-Za-z0-9_-]{1,32}$/.test(String(s.id))) ? String(s.id) : mkId();
      return { id: id, timeIn: String(s.timeIn), timeOut: String(s.timeOut) };
    });
  }
  const clean = { lunch: norm(payload.slots.lunch), dinner: norm(payload.slots.dinner) };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return jsonResponse({ ok: false, retryable: true, error: "Busy, try again." });
  try {
    PropertiesService.getScriptProperties().setProperty("SLOTS", JSON.stringify(clean));
    return jsonResponse({ ok: true, config: configObject() });
  } catch (e) {
    return jsonResponse({ ok: false, retryable: true, error: String(e && e.message || e) });
  } finally { lock.releaseLock(); }
}
```

- [ ] **Step 2: Route the two new actions in `doPost` (alongside the existing `if (payload && payload.action === ...)` block).**

```js
  if (payload && payload.action === "setSlots") {
    return handleSetSlots(payload);
  }
  if (payload && payload.action === "setKitchenPct") {
    return handleSetKitchenPct(payload);
  }
```

- [ ] **Step 3: Syntax check.**

Run: `node --check apps-script.gs`
Expected: no output.

- [ ] **Step 4: Commit.**

```bash
git add apps-script.gs
git commit -m "Add PIN-protected setSlots/setKitchenPct endpoints"
```

---

### Task 7: apps-script.gs — `splitsFromRows` reads stored times (#8); backend `configure()` call sites

**Files:**
- Modify: `apps-script.gs` (`splitsFromRows`; `doPost` write branch; `handleRequestEdit`)

- [ ] **Step 1: Rewrite `splitsFromRows` to read stored times (drops `getSlotByLabel`).**

Change the signature to accept `tz` and coerce time cells (which Sheets may return as `Date`):

```js
function splitsFromRows(rows, tz) {
  const asTimeStr = (v) => (v instanceof Date) ? Utilities.formatDate(v, tz, "HH:mm") : String(v || "");
  const out = { shiftType: "", kitchen: 0, servers: [], chefs: [] };
  for (const row of rows) {
    const role = String(row[COL.ROLE - 1]);
    const amount = Number(row[COL.AMOUNT - 1]) || 0;
    if (!out.shiftType) out.shiftType = String(row[COL.SHIFT - 1] || "").toLowerCase();
    if (role === "Kitchen") out.kitchen = amount;
    else if (role === "Chef") out.chefs.push({ name: String(row[COL.RECIPIENT - 1] || ""), amount: amount });
    else {
      var tIn = asTimeStr(row[COL.TIME_IN - 1]);
      var tOut = asTimeStr(row[COL.TIME_OUT - 1]);
      var sSlot = findSlotByTimes(out.shiftType, tIn, tOut);
      out.servers.push({
        name: String(row[COL.RECIPIENT - 1] || ""),
        trainee: role === "Trainee",
        pct: row[COL.TRAINEE_PCT - 1] === "" ? null : Number(row[COL.TRAINEE_PCT - 1]),
        slot: sSlot ? sSlot.id : "",
        slotLabel: String(row[COL.SLOT - 1] || ""),
        timeIn: tIn,
        timeOut: tOut,
        hours: Number(row[COL.HOURS - 1]) || 0,
        amount: amount,
      });
    }
  }
  return out;
}
```

- [ ] **Step 2: Update the dedup call site in `doPost` and add the write-branch `configure()`.**

In `doPost`, the write branch currently runs `validatePayload(payload)` after the action routing, then takes the lock. Insert `configure(...)` immediately **after** the action-routing block and **before** `const validationError = validatePayload(payload);`:

```js
  // Load the active slot table + kitchen % before validation (getSlot) and split.
  configure({ slots: getSlots(), kitchenPct: getKitchenPct() });

  const validationError = validatePayload(payload);
```

Then, inside the lock, the dedup branch must pass `tz`. Compute `tz` before the dedup check and update the call:

```js
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheets()[0];
    const tz = ss.getSpreadsheetTimeZone();

    const existing = findRowsBySubmissionId(sheet, payload.submissionId);
    if (existing.length) {
      return jsonResponse({ ok: true, dedup: true, splits: splitsFromRows(existing, tz), showSplit: getShowSplit() });
    }
```

This **relocates** the single existing `const tz = ss.getSpreadsheetTimeZone();` (currently declared lower in the `try`, just before `dateStr`/`timeStr`) up to here. There is only one `tz` in `doPost` — move it, do not add a second. Delete only that one `const tz =` line from its old spot; leave `now`/`dateStr`/`timeStr` where they are (they will read the hoisted `tz`).

**Paired-update checklist:** the `splitsFromRows` signature (Step 1) and this call site (Step 2) must change together in the same commit. A one-arg call to the two-arg function passes `undefined` for `tz`, and `Utilities.formatDate(dateValue, undefined, ...)` throws on any `Date`-typed time cell.

- [ ] **Step 3: Add `configure()` to `handleRequestEdit` before it validates.**

At the top of `handleRequestEdit`, before the `validateShiftFields(payload.proposed)` call:

```js
  configure({ slots: getSlots(), kitchenPct: getKitchenPct() });
```

- [ ] **Step 4: Guard `_smokeTest` so configured state can't break its 15% assertions.**

`_smokeTest` asserts hardcoded 15%-based amounts and now runs `doPost`, which calls `configure(...)` from Script Properties. Prepend a reset so the assertions are deterministic regardless of stored config or leftover module state. Add as the first line of `_smokeTest`:

```js
  resetConfig();
```

- [ ] **Step 5: Confirm `getSlotByLabel` is now gone everywhere.**

Run: `node -e "const b=require('fs').readFileSync('apps-script.gs','utf8');console.log(/getSlotByLabel/.test(b)?'STILL REFERENCED':'clean')"`
Expected: `clean`.

- [ ] **Step 6: Syntax check.**

Run: `node --check apps-script.gs`
Expected: no output.

- [ ] **Step 7: Commit.**

```bash
git add apps-script.gs
git commit -m "splitsFromRows reads stored times; configure() the active config before split/validate"
```

---

### Task 8: apps-script.gs — fix #1 (formula injection) + `unknown_slot` error code

**Files:**
- Modify: `apps-script.gs` (`safeText`, `doPost` write rows, `validatePayload`, `validateShiftFields`, `handleRequestEdit`)

- [ ] **Step 1: Make `safeText` whitespace-tolerant (covers CSV/Excel export).**

```js
function safeText(s) {
  const str = String(s == null ? "" : s);
  // Quote if the first non-whitespace char is a formula trigger, or it starts
  // with a control char. Text columns only — never wrap numeric columns.
  return (/^[\s]*[=+\-@]/.test(str) || /^[\t\r\n]/.test(str)) ? "'" + str : str;
}
```

This whitespace-tolerant form (matching the spec) is deliberate: it guards the CSV/Excel-export path, where a leading-space `" =FORMULA"` *is* evaluated even though `setValues` would not. It only quotes values whose first non-whitespace char is `= + - @` (e.g. `" =x"`), so a benign name like `" Eve"` is **not** quoted — there are no harmful false positives. Do not simplify it back to a position-0-only class.

- [ ] **Step 2: Wrap `enteredBy`, `submissionId`, and the slot label snapshot at every write site.**

In `doPost`'s write branch, change the `enteredBy` assignment and `baseRow`:

```js
    const enteredBy = safeText(payload.enteredBy.trim());
    // ... in baseRow():
    row[COL.SUBMISSION_ID - 1] = safeText(payload.submissionId);
```

And where server rows are written in `doPost`, wrap the slot label (chef/kitchen rows have no slot label; leave them):

```js
      row[COL.SLOT - 1] = safeText(sp.slotLabel);
```

In `handleRequestEdit`'s `appendRow`, wrap the `sid` cell:

```js
  sheet.appendRow([reqId, now, safeText(by), safeText(sid), shiftDate, shiftTime, "Pending", safeText(note), JSON.stringify(cleanProposed), "", ""]);
```

In the `handleResolveRequest` approve `baseRow`, wrap the submission id:

```js
        r[COL.SUBMISSION_ID - 1] = safeText(sid);
```

(Note: Task 15 later replaces the entire approve branch — including this `baseRow` — with a version that already contains `safeText(sid)` and `safeText(sp.slotLabel)`. So this Task 8 edit will be overwritten by Task 15; that is expected and harmless. Do not edit the approve-path `COL.SLOT` line here — Task 15 handles it.)

- [ ] **Step 3: Restrict `submissionId` in `validatePayload`.**

```js
function validatePayload(p) {
  if (!p || typeof p !== "object") return "Invalid payload";
  if (typeof p.submissionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(p.submissionId)) return "Invalid submissionId";
  return validateShiftFields(p);
}
```

- [ ] **Step 4: Add the `unknown_slot` marker to slot validation, and surface the code.**

In `validateShiftFields`, the slot check currently returns a plain string. Keep the string but make it identifiable by prefixing a stable token the handlers can detect:

```js
    if (!getSlot(p.shiftType, s.slot)) return "unknown_slot:Invalid time slot for " + (s.name || "server");
```

Add a small helper and use it where validation errors are returned to the client in `doPost` and `handleRequestEdit`:

```js
function validationResponse(msg) {
  if (typeof msg === "string" && msg.indexOf("unknown_slot:") === 0) {
    return jsonResponse({ ok: false, retryable: false, errorCode: "unknown_slot", error: msg.slice("unknown_slot:".length) });
  }
  return jsonResponse({ ok: false, retryable: false, error: msg });
}
```

In `doPost`, change the existing `if (validationError) { return jsonResponse({ ok:false, retryable:false, error: validationError }); }` to `if (validationError) { return validationResponse(validationError); }`.
In `handleRequestEdit`, change the existing `if (validation) return jsonResponse({ ok:false, error: validation });` to `if (validation) return validationResponse(validation);`.
In `handleResolveRequest` approve, the proposal is server-trusted (it can only carry `unknown_slot:` if the config changed between the request and the approval); keep a plain message and strip the leading token for readability: `return jsonResponse({ ok:false, error: "Proposal invalid: " + validation.replace("unknown_slot:", "") });`.

(`validationResponse` is a hoisted `function` declaration, so calling it from `handleRequestEdit` — which appears earlier in the file — is fine. Place the function near `jsonResponse`.)

- [ ] **Step 5: Syntax check.**

Run: `node --check apps-script.gs`
Expected: no output.

- [ ] **Step 6: Commit.**

```bash
git add apps-script.gs
git commit -m "Harden against formula injection; add unknown_slot error code"
```

---

### Task 9: i18n.js — new keys (EN + KO)

**Files:**
- Modify: `i18n.js`

- [ ] **Step 1: Add the keys to both the `en` and `ko` dictionaries.**

Add these entries (EN shown; provide natural KO translations alongside, matching the file's existing style). Use the existing `{n}`-style interpolation where shown:

```
settings_kitchen_pct: "Kitchen cut (%)"            // KO: "주방 몫 (%)"
settings_time_slots: "Time slots"                  // KO: "시간대"
slots_lunch: "Lunch"                               // KO: "점심"
slots_dinner: "Dinner"                             // KO: "저녁"
slot_add: "+ Add slot"                             // KO: "+ 시간대 추가"
slot_save: "Save slots"                            // KO: "시간대 저장"
slot_start: "Start"                                // KO: "시작"
slot_end: "End"                                    // KO: "종료"
slot_saved: "Saved"                                // KO: "저장됨"
slot_saving: "Saving…"                             // KO: "저장 중…"
slot_save_fail: "Couldn't save. Try again."        // KO: "저장하지 못했습니다. 다시 시도하세요."
slot_min_one: "Keep at least one slot per shift."  // KO: "교대마다 최소 1개의 시간대가 필요합니다."
slots_changed_refresh: "The time slots changed. Tap Refresh and pick again."  // KO: "시간대가 변경되었습니다. 새로고침 후 다시 선택하세요."
slot_retimed_hint: "A slot was changed; re-pick the time."  // KO: "시간대가 변경되었습니다. 시간을 다시 선택하세요."
kitchen_pct_saved: "Saved"                         // KO: "저장됨"
```

- [ ] **Step 2: Confirm the file still parses.**

Run: `node --check i18n.js`
Expected: no output.

- [ ] **Step 3: Commit.**

```bash
git add i18n.js
git commit -m "Add i18n keys for slot/kitchen settings and slot-change prompts"
```

---

### Task 10: admin.js — Settings UI (kitchen % + slot editor), wiring, remove dead code (#10)

**Files:**
- Modify: `admin.js` (`renderSettings`, `wireEvents`, network helpers, state; delete `enumerateDays`)

- [ ] **Step 1: Add config mirror state and delete `enumerateDays` (#10).**

Near the other `let` state at the top, add:

```js
let kitchenPctConfig = 15; // mirrored from the backend (Settings tab)
let slotsConfig = null;    // working source from backend; editor uses a deep clone
```

Set them wherever `showSplitConfig` is set (in `tryPin` and `refresh`):

```js
if (data.config) {
  if (typeof data.config.showSplit === "boolean") showSplitConfig = data.config.showSplit;
  if (typeof data.config.kitchenPct === "number") kitchenPctConfig = data.config.kitchenPct;
  if (data.config.slots) slotsConfig = data.config.slots;
}
```

Delete the entire `enumerateDays` function (it has no callers).

- [ ] **Step 2: Replace `renderSettings` to add the kitchen % field and the slot editor.**

```js
function renderSettings() {
  const lang = getLang();
  const langBtn = (code, label) => `<button type="button" data-set-lang="${code}"${lang === code ? ' class="active"' : ""}>${escapeHtml(label)}</button>`;
  // Until the first config fetch lands, slotsConfig is null — show a loading line
  // for the slot editor rather than an empty editable group (which a Save could
  // otherwise push as empty arrays).
  if (!slotsConfig) {
    return `<div class="panel">
      <div class="set-row"><div class="set-label">${escapeHtml(t("settings_language"))}</div><div class="set-langs">${langBtn("en", "English")}${langBtn("ko", "한국어")}</div></div>
      <div class="set-row"><div class="set-label">${escapeHtml(t("settings_time_slots"))}</div><div class="set-status">${escapeHtml(t("loading"))}</div></div>
    </div>`;
  }
  const slots = slotsEdit || { lunch: [], dinner: [] };
  const slotRow = (shift, s, i, n) => `<div class="slot-row" data-shift="${shift}" data-i="${i}">
      <input type="time" class="slot-in" value="${escapeHtml(s.timeIn || "")}" data-shift="${shift}" data-i="${i}" data-field="timeIn">
      <span class="slot-dash">–</span>
      <input type="time" class="slot-out" value="${escapeHtml(s.timeOut || "")}" data-shift="${shift}" data-i="${i}" data-field="timeOut">
      <span class="slot-preview">${escapeHtml(slotLabel(s.timeIn, s.timeOut))}</span>
      <button type="button" class="slot-remove" data-shift="${shift}" data-i="${i}"${n <= 1 ? " disabled" : ""}>×</button>
    </div>`;
  const group = (shift, title) => `<div class="slot-group">
      <div class="slot-group-h">${escapeHtml(title)}</div>
      ${(slots[shift] || []).map((s, i) => slotRow(shift, s, i, (slots[shift] || []).length)).join("")}
      <button type="button" class="slot-add" data-shift="${shift}">${escapeHtml(t("slot_add"))}</button>
    </div>`;
  return `<div class="panel">
    <div class="set-row">
      <div class="set-label">${escapeHtml(t("settings_language"))}</div>
      <div class="set-langs">${langBtn("en", "English")}${langBtn("ko", "한국어")}</div>
    </div>
    <div class="set-row">
      <div class="set-toggle-row">
        <div class="set-label">${escapeHtml(t("settings_show_split"))}</div>
        <label class="set-switch"><input type="checkbox" id="set-show-split"${showSplitConfig ? " checked" : ""}><span class="set-slider"></span></label>
      </div>
      <div class="set-status" id="set-split-status"></div>
    </div>
    <div class="set-row">
      <div class="set-toggle-row">
        <div class="set-label">${escapeHtml(t("settings_kitchen_pct"))}</div>
        <input type="number" id="set-kitchen-pct" min="0" max="50" step="1" value="${escapeHtml(String(kitchenPctConfig))}" style="width:5rem">
      </div>
      <div class="set-status" id="set-kitchen-status"></div>
    </div>
    <div class="set-row">
      <div class="set-label">${escapeHtml(t("settings_time_slots"))}</div>
      ${group("lunch", t("slots_lunch"))}
      ${group("dinner", t("slots_dinner"))}
      <button type="button" id="set-slots-save" class="btn-primary" style="margin-top:.6rem">${escapeHtml(t("slot_save"))}</button>
      <div class="set-status" id="set-slots-status"></div>
    </div>
  </div>`;
}
```

- [ ] **Step 3: Add a working-copy editor model + network savers.**

When the Settings tab renders, seed the editor clone once. Add near the other network functions:

```js
function slotsWorkingCopy() {
  // Deep clone so edits never touch the live config / calc state.
  if (!slotsConfig) return { lunch: [], dinner: [] };
  return JSON.parse(JSON.stringify(slotsConfig));
}
let slotsEdit = null; // populated when the Settings tab is shown

async function saveKitchenPct(val) {
  const status = document.getElementById("set-kitchen-status");
  const n = parseInt(val, 10);
  if (!Number.isInteger(n) || n < 0 || n > 50) { if (status) status.textContent = t("slot_save_fail"); return; }
  if (status) status.textContent = t("slot_saving");
  try {
    const res = await fetch(ENDPOINT_URL, { method: "POST", mode: "cors", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "setKitchenPct", pin: sessionPin, kitchenPct: n }) });
    const data = await res.json();
    if (!data || !data.ok) throw new Error((data && data.error) || "fail");
    if (data.config && typeof data.config.kitchenPct === "number") kitchenPctConfig = data.config.kitchenPct;
    if (status) status.textContent = t("kitchen_pct_saved");
  } catch (e) {
    const inp = document.getElementById("set-kitchen-pct"); if (inp) inp.value = String(kitchenPctConfig);
    if (status) status.textContent = t("slot_save_fail");
  }
}

async function saveSlots() {
  const status = document.getElementById("set-slots-status");
  if (status) status.textContent = t("slot_saving");
  try {
    const res = await fetch(ENDPOINT_URL, { method: "POST", mode: "cors", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "setSlots", pin: sessionPin, slots: slotsEdit }) });
    const data = await res.json();
    if (!data || !data.ok) throw new Error((data && data.error) || "fail");
    if (data.config && data.config.slots) { slotsConfig = data.config.slots; slotsEdit = slotsWorkingCopy(); }
    render();
    const s2 = document.getElementById("set-slots-status"); if (s2) s2.textContent = t("slot_saved");
  } catch (e) {
    if (status) status.textContent = (e && e.message) || t("slot_save_fail");
  }
}
```

In `render()`, where it does `if (activeTab === "settings") { view.innerHTML = renderSettings(); return; }`, seed the editor first:

```js
  if (activeTab === "settings") { if (!slotsEdit) slotsEdit = slotsWorkingCopy(); view.innerHTML = renderSettings(); return; }
```

(`renderSettings` already reads `slotsEdit` per Step 2.) When fresh config arrives in `tryPin`/`refresh`, reset the editor clone **only when the owner isn't mid-edit on the Settings tab**, so a manual Refresh doesn't silently discard unsaved slot edits:

```js
if (data.config && data.config.slots) { slotsConfig = data.config.slots; if (activeTab !== "settings") slotsEdit = null; }
```

(`render()` seeds `slotsEdit` from a fresh clone whenever it is null and the Settings tab opens.)

- [ ] **Step 4: Wire the Settings interactions into the delegated listeners.**

In `wireEvents`, the `#view` `change` delegate already handles `#set-show-split`. Extend it:

```js
  document.getElementById("view").addEventListener("change", (e) => {
    if (e.target && e.target.id === "set-show-split") setConfigShowSplit(e.target.checked);
    if (e.target && e.target.id === "set-kitchen-pct") saveKitchenPct(e.target.value);
    if (e.target && e.target.classList && e.target.classList.contains("slot-in")) updateSlotField(e.target);
    if (e.target && e.target.classList && e.target.classList.contains("slot-out")) updateSlotField(e.target);
  });
```

In the `#view` `click` delegate, add branches (before the closing of the handler):

```js
    if (e.target.closest("#set-slots-save")) { commitSlotInputs(); saveSlots(); return; }
    const addBtn = e.target.closest(".slot-add");
    if (addBtn) { commitSlotInputs(); const sh = addBtn.dataset.shift; slotsEdit[sh] = slotsEdit[sh] || []; if (slotsEdit[sh].length < 8) slotsEdit[sh].push({ timeIn: "", timeOut: "" }); render(); return; }
    const rmBtn = e.target.closest(".slot-remove");
    if (rmBtn) { commitSlotInputs(); const sh = rmBtn.dataset.shift, i = Number(rmBtn.dataset.i); if (slotsEdit[sh] && slotsEdit[sh].length > 1) { slotsEdit[sh].splice(i, 1); render(); } return; }
```

Add the field updater + a commit helper near the savers. `updateSlotField` writes the value and updates only that row's label preview (no full `render()`, so the input keeps focus); `commitSlotInputs` flushes every visible input into `slotsEdit` before a structural change so an unblurred edit isn't lost:

```js
function updateSlotField(input) {
  const sh = input.dataset.shift, i = Number(input.dataset.i), f = input.dataset.field;
  if (!(slotsEdit && slotsEdit[sh] && slotsEdit[sh][i])) return;
  slotsEdit[sh][i][f] = input.value;
  const row = input.closest(".slot-row");
  const prev = row && row.querySelector(".slot-preview");
  if (prev) prev.textContent = slotLabel(slotsEdit[sh][i].timeIn, slotsEdit[sh][i].timeOut);
}
function commitSlotInputs() {
  document.querySelectorAll("#view .slot-row .slot-in, #view .slot-row .slot-out").forEach(updateSlotField);
}
```

- [ ] **Step 5: Add minimal CSS for the slot editor (in `admin.html` `<style>`).**

```css
.slot-group { margin: .4rem 0; }
.slot-group-h { font-weight: 600; font-size: .85rem; margin: .4rem 0 .2rem; }
.slot-row { display: flex; align-items: center; gap: .4rem; margin-bottom: .3rem; }
.slot-row input[type=time] { flex: 0 0 auto; }
.slot-preview { color: #6b7280; font-size: .82rem; flex: 1; }
.slot-remove { border: 0; background: transparent; color: #b00; font-size: 1.1rem; cursor: pointer; }
.slot-remove:disabled { opacity: .35; cursor: default; }
.slot-add { border: 1px dashed #999; background: #fff; padding: .35rem .6rem; border-radius: 6px; cursor: pointer; font-size: .82rem; }
```

- [ ] **Step 6: Verify in a browser.**

Run the admin page (open `admin.html` against the deployed endpoint, or use the project `run` flow), unlock with the PIN, open Settings. Expected: kitchen % field shows the current value and saves on change; lunch/dinner slot rows render with a live label preview; add/remove works (remove disabled at 1); Save slots persists and the preview labels update. Confirm the date-period selector is still hidden on the Settings tab.

- [ ] **Step 7: Commit.**

```bash
git add admin.js admin.html
git commit -m "Add slot + kitchen-% editor to admin Settings; remove dead enumerateDays"
```

---

### Task 11: index.html — config cache, fail-closed split (#6), slot dropdowns from config

**Note on current code (rebased after commit `440133e`):** `index.html` now uses native name `<select>`s with an "Other..." option (`OTHER_NAME`, `rowName`, `nameValueOf`, `setNameField`, `wireNameField`), a shared `postJSON(payload)` helper, and an **offline queue** (`enqueue`/`flushQueue`/`QUEUE_KEY`, fired on `window "online"` and at load). These are orthogonal to slots; the functions this task edits (`populateSlotSelect`, `loadTodayShifts`, `submitShift`, the init sequence `renderShiftToggle(); addPerson();`) are all still present with the same shape. Step 5 handles the offline-queue interaction.

**Files:**
- Modify: `index.html` (config state, cache, `loadTodayShifts`, `populateSlotSelect`, `submitShift`, `flushQueue`)

- [ ] **Step 1: Add a cached, fail-closed config bootstrap.**

Near the top config state (`let showSplit = true;`, currently ~line 229), change the default and add cache constants + a loader:

```js
let showSplit = false; // fail-closed: hidden until config says otherwise
const CONFIG_KEY = "matsuri_config_v1";
const CONFIG_CACHE_VERSION = 1;

function validSlotsShape(s) {
  if (!s || typeof s !== "object") return false;
  var ok = (x) => {
    if (!x || !/^\d{2}:\d{2}$/.test(x.timeIn) || !/^\d{2}:\d{2}$/.test(x.timeOut)) return false;
    var mi = Number(x.timeIn.slice(0,2))*60 + Number(x.timeIn.slice(3));
    var mo = Number(x.timeOut.slice(0,2))*60 + Number(x.timeOut.slice(3));
    return mo > mi; // mirror the server's timeOut-after-timeIn rule so a corrupt cache can't yield NaN previews
  };
  return ["lunch", "dinner"].every(k => Array.isArray(s[k]) && s[k].length >= 1 && s[k].every(ok));
}
function applyConfig(cfg) {
  if (!cfg) return;
  if (typeof cfg.showSplit === "boolean") showSplit = cfg.showSplit;
  if (validSlotsShape(cfg.slots)) configure({ slots: cfg.slots });
  if (typeof cfg.kitchenPct === "number") configure({ kitchenPct: cfg.kitchenPct });
}
function loadCachedConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONFIG_KEY) || "null");
    if (raw && raw.v === CONFIG_CACHE_VERSION && raw.config) applyConfig(raw.config);
  } catch (e) {}
}
function cacheConfig(cfg) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify({ v: CONFIG_CACHE_VERSION, config: cfg })); } catch (e) {}
}
```

Call `loadCachedConfig();` during init **before the first `addPerson()`** (which builds the first slot dropdown from `SHIFT_SLOTS`). In the current bottom-of-file init sequence, place it immediately after `renderShiftToggle();` and before `addPerson();`. If it runs after `addPerson()`, the first dropdown paints from `DEFAULT_SLOTS` and the cache's instant-slots benefit is lost until the network fetch returns.

- [ ] **Step 2: Apply + cache config and rebuild dropdowns on fetch.**

In `loadTodayShifts`, where it currently reads `data.config`, replace that block with:

```js
      if (data.config) {
        applyConfig(data.config);
        cacheConfig(data.config);
        // Rebuild slot dropdowns; keep a selection only if still valid.
        peopleContainer.querySelectorAll(".p-slot").forEach(sel => populateSlotSelect(sel, getSlot(currentShift, sel.value) ? sel.value : ""));
        updatePreview();
      }
```

- [ ] **Step 3: Make the slot dropdown label use `slotLabel`.**

In `populateSlotSelect`, change the option text from `localizeSlotLabel(s.label)` to:

```js
    slots.map(s => `<option value="${s.id}"${s.id === selectedId ? " selected" : ""}>${escapeHtml(slotLabel(s.timeIn, s.timeOut))}</option>`).join("");
```

- [ ] **Step 4: Handle `unknown_slot` on submit.**

In `submitShift`, where it handles a non-ok response, add a branch before the generic error:

```js
  } else if (response.errorCode === "unknown_slot") {
    showBanner("error", escapeHtml(t("slots_changed_refresh")));
    loadTodayShifts(); // refreshes the dropdowns
  } else if (response.retryable) {
```

- [ ] **Step 5: Offline-queue interaction with `unknown_slot` — surface a dropped entry.**

The offline queue resends payloads via `flushQueue`, which keeps an item only when `!data.ok && data.retryable` (the drop is implicit — items are simply not pushed to `remaining`). `unknown_slot` is non-retryable, so a queued entry whose slot was deleted/retimed while offline is dropped on flush — correct terminal behavior (the slot is gone; retrying forever can't fix it). But unlike the interactive `submitShift` path (Step 4), the background flush shows no feedback, so the staff member would lose an offline-captured shift silently. Fix: detect that specific drop and show a banner after the flush. Change the loop body to track it, and surface it after `setQueue`:

```js
  let droppedSlotChange = false;
  for (const p of q) {
    try {
      const data = await postJSON(p);
      if (!data || (!data.ok && data.retryable)) { remaining.push(p); continue; }
      // dropped here on success or permanent error; flag the slot-change case so
      // the staff member knows to re-enter (the others are benign: dedup/already-entered).
      if (data && data.errorCode === "unknown_slot") droppedSlotChange = true;
    } catch (e) {
      remaining.push(p); // still offline
    }
  }
  setQueue(remaining);
  flushing = false;
  if (droppedSlotChange) showBanner("error", escapeHtml(t("offline_slot_dropped")));
  if (remaining.length < q.length) loadTodayShifts(); // a queued shift may now be taken
```

This needs the new i18n key `offline_slot_dropped` (added in Task 9). `showBanner` is already defined in `index.html`.

- [ ] **Step 6: Verify in a browser.**

Open the entry form. Expected: slot dropdown options show derived labels (e.g. `11a–4:30p`); with `showSplit` off in admin, the preview shows the hidden-split text; after the owner changes slots in admin and you reload, the new slots appear. Simulate a stale slot (pick a slot, have admin delete it, submit) → "tap Refresh" banner. Offline (DevTools offline): submit → "saved on this phone"; back online → it flushes.

- [ ] **Step 7: Commit.**

```bash
git add index.html
git commit -m "Entry form: cached fail-closed config, config-driven slot dropdowns, unknown_slot handling"
```

---

### Task 12: today.html — config cache, slot dropdowns, edit-modal retimed hint, unknown_slot

**Files:**
- Modify: `today.html` (config state/cache, `load`, `slotOptions`, edit modal pre-select, send handler)

- [ ] **Step 1: Add the same cached fail-closed config bootstrap.**

Mirror Task 11 Step 1 in `today.html` (change `let showSplit = true;` to `false`; add `CONFIG_KEY`/`CONFIG_CACHE_VERSION`/`validSlotsShape`/`applyConfig`/`loadCachedConfig`/`cacheConfig` — identical code). Call `loadCachedConfig();` before the initial `load();`.

- [ ] **Step 2: Apply + cache config in `load`.**

Where `load` reads `data.config`, replace with:

```js
    if (data.config) { applyConfig(data.config); cacheConfig(data.config); }
```

- [ ] **Step 3: `slotOptions` uses `slotLabel`.**

```js
function slotOptions(shift, selectedId) {
  return `<option value="">${escapeHtml(t("pick_time"))}</option>` + (SHIFT_SLOTS[shift] || []).map(s => `<option value="${s.id}"${s.id === selectedId ? " selected" : ""}>${escapeHtml(slotLabel(s.timeIn, s.timeOut))}</option>`).join("");
}
```

- [ ] **Step 4: Show a hint when a pre-selected server slot is blank due to retiming.**

In the `.req-btn` click handler, after building `servers` and calling `renderEditPeople(...)`, add:

```js
  const anyBlankSlot = servers.some(s => s.name && !s.slot);
  reqErr.textContent = anyBlankSlot ? t("slot_retimed_hint") : "";
```

- [ ] **Step 5: Handle `unknown_slot` in the send handler.**

In the `reqSend` click handler's `catch`/response check, branch on the code. Replace the `if (!data.ok) throw new Error(...)` area with:

```js
    const data = await res.json();
    if (!data.ok) {
      if (data.errorCode === "unknown_slot") { reqErr.textContent = t("slots_changed_refresh"); await loadChefRoster(); load(); return; }
      throw new Error(data.error || "send failed");
    }
```

- [ ] **Step 6: Verify in a browser.**

Open today's view. Expected: edit-modal slot dropdowns show derived labels; editing a shift whose slot the owner retimed shows the "re-pick the time" hint and a blank slot to choose; submitting against a now-deleted slot shows the refresh prompt.

- [ ] **Step 7: Commit.**

```bash
git add today.html
git commit -m "Today view: config-driven slot dropdowns, retimed-slot hint, unknown_slot handling"
```

---

### Task 13: sw.js — bump cache version

**Files:**
- Modify: `sw.js`

- [ ] **Step 1: Ensure the cache name is bumped.**

Read `sw.js` line 1. The working tree already has `matsuri-tips-v34` (bumped by the in-progress logo work), which is a fresh value versus the committed `v29`, so **no change is needed** unless this feature ships in a separate deploy after v34 is committed — in which case bump it once more. Do not blindly set a number; confirm it is greater than the currently deployed value. The service worker already lists `i18n.js`/`calc.js`/`admin.js` in `ASSETS`, so the new code is covered.

- [ ] **Step 2: Commit.**

```bash
git add sw.js
git commit -m "Bump service worker cache version"
```

---

### Stage A verification gate

- [ ] Run `node calc.test.js` — all PASS.
- [ ] Run `node --check apps-script.gs i18n.js admin.js sw.js` — no output.
- [ ] Confirm the verbatim block is identical in `calc.js` and `apps-script.gs` (Task 4 Step 2 command).
- [ ] Deploy the Apps Script (clasp) and run `_smokeTest` and `_smokeTestConfig` from the editor — both log OK.
- [ ] Manual end-to-end: add a slot, enter a shift using it, change kitchen %, enter another shift, edit/remove a slot, confirm earlier shifts are unchanged in the admin dashboard. Corrupt `SLOTS` by hand in Script Properties; confirm the entry form still loads (falls back to defaults). Restore it.
- [ ] Commit any fixes before starting Stage B.

---

## Stage B — ledger integrity

### Task 14: apps-script.gs — fix #3 (lock `handleRequestEdit`)

**Files:**
- Modify: `apps-script.gs` (`handleRequestEdit`)

- [ ] **Step 1: Wrap the ledger lookup + requests-sheet append in the script lock.**

In `handleRequestEdit`, after input validation and the `configure(...)` call (Task 7) and `validateShiftFields`, acquire the lock around the section that resolves the shift in the ledger and appends to the requests sheet:

```js
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonResponse({ ok: false, retryable: true, error: "Busy, try again." });
  try {
    const tz = ss.getSpreadsheetTimeZone();
    // ... existing ledger lookup (find shiftDate/shiftTime/found) ...
    if (!found) return jsonResponse({ ok: false, error: "That shift is no longer in the ledger. Tap Refresh and try again." });
    const sheet = getOrCreateRequestsSheet(ss);
    // ... existing cleanProposed build + appendRow ...
    return jsonResponse({ ok: true, requestId: reqId });
  } catch (err) {
    return jsonResponse({ ok: false, retryable: true, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
```

Move the existing body (ledger resolve, `getOrCreateRequestsSheet`, `cleanProposed`, `appendRow`, success return) inside this `try`. Keep `cleanProposed` exactly as is.

- [ ] **Step 2: Syntax check.**

Run: `node --check apps-script.gs`
Expected: no output.

- [ ] **Step 3: Verify (manual).**

Deploy. Submit an edit request from the today page; confirm it still appears in the admin Requests tab. (The lock is only observable under contention; the functional path must be unchanged.)

- [ ] **Step 4: Commit.**

```bash
git add apps-script.gs
git commit -m "Lock handleRequestEdit around ledger lookup and request append (#3)"
```

---

### Task 15: apps-script.gs — fix #7 (approve: append-then-delete with deterministic rollback)

**Files:**
- Modify: `apps-script.gs` (`handleResolveRequest` approve branch)

- [ ] **Step 1: Replace the entire `if (resolution === "approve") { ... }` body with the contiguous-block append-then-delete version.**

This is a full replacement of the approve branch (no placeholders). The enclosing `try` already declares `ledger`, `sid`, `ledgerWritten`, `ledgerSavedRows`, `approvedRowStart`, `approvedRowCount` and a `tz` above this branch — keep those declarations; this block assigns them.

**BEFORE** (current code — the whole `if (resolution === "approve") { ... }` block; delete all of it, including the old `ledgerSavedRows = targetRowIdxs.map(...)`, the descending `targetRowIdxs.sort((a,b)=>b-a)`, the `for (const r of targetRowIdxs) ledger.deleteRow(r)` loop, and the `try { approvedRowStart = ledger.getLastRow()+1; ... setValues(newRows) } catch (writeErr) { ... }` restore dance):

```js
    if (resolution === "approve") {
      sid = String(row[3] || "");
      // ... parse proposed, validateShiftFields, read ldata, collect targetRowIdxs,
      //     splitShift, same-day guard, build newRows, then:
      ledgerSavedRows = targetRowIdxs.map(function (r) { return ldata[r - 2]; });
      targetRowIdxs.sort(function (a, b) { return b - a; });
      for (const r of targetRowIdxs) ledger.deleteRow(r);
      try {
        approvedRowStart = ledger.getLastRow() + 1;
        approvedRowCount = newRows.length;
        ledger.getRange(approvedRowStart, 1, newRows.length, NUM_COLS).setValues(newRows);
      } catch (writeErr) {
        // ... old delete-then-append restore dance ...
      }
      ledgerWritten = true;
    }
```

**AFTER** (paste this complete block in place of the entire approve branch):

```js
    if (resolution === "approve") {
      sid = String(row[3] || "");
      let proposed;
      try { proposed = JSON.parse(String(row[8] || "")); } catch (e) {
        return jsonResponse({ ok: false, error: "Stored proposal is invalid" });
      }
      const validation = validateShiftFields(proposed);
      if (validation) return jsonResponse({ ok: false, error: "Proposal invalid: " + validation.replace("unknown_slot:", "") });

      ledger = ss.getSheets()[0];
      const lastL = ledger.getLastRow();
      if (lastL < 2) return jsonResponse({ ok: false, error: "Shift not found in ledger" });
      const ldata = ledger.getRange(2, 1, lastL - 1, NUM_COLS).getValues();

      // Locate the old block; it must be a contiguous run of rows.
      const targetRowIdxs = [];
      let preservedDate = "", preservedTime = "";
      for (let i = 0; i < ldata.length; i++) {
        if (ldata[i][COL.SUBMISSION_ID - 1] === sid) {
          targetRowIdxs.push(i + 2);
          if (!preservedDate) {
            const d = ldata[i][COL.DATE - 1], tt = ldata[i][COL.TIME - 1];
            preservedDate = (d instanceof Date) ? Utilities.formatDate(d, tz, "yyyy-MM-dd") : String(d || "");
            preservedTime = (tt instanceof Date) ? Utilities.formatDate(tt, tz, "HH:mm") : String(tt || "");
          }
        }
      }
      if (!targetRowIdxs.length) return jsonResponse({ ok: false, error: "Shift not found in ledger" });
      const oldStart = Math.min.apply(null, targetRowIdxs);
      const oldCount = targetRowIdxs.length;
      if (Math.max.apply(null, targetRowIdxs) - oldStart + 1 !== oldCount) {
        return jsonResponse({ ok: false, retryable: false, error: "Ledger rows for this shift are not contiguous; resolve manually." });
      }

      const splits = splitShift(proposed);
      const shiftLabel = proposed.shiftType === "lunch" ? "Lunch" : "Dinner";
      // Guard: an approved edit must not create a second shift of the same type that day.
      for (let i = 0; i < ldata.length; i++) {
        if (ldata[i][COL.SUBMISSION_ID - 1] === sid) continue;
        const d2 = ldata[i][COL.DATE - 1];
        const ds2 = (d2 instanceof Date) ? Utilities.formatDate(d2, tz, "yyyy-MM-dd") : String(d2 || "");
        if (ds2 === preservedDate && String(ldata[i][COL.SHIFT - 1] || "") === shiftLabel) {
          return jsonResponse({ ok: false, retryable: false, error: "Approving this would create a second " + shiftLabel + " shift for " + preservedDate + "." });
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

      ledgerSavedRows = targetRowIdxs.slice().sort(function (a, b) { return a - b; }).map(function (r) { return ldata[r - 2]; });

      // Append the new rows first (one atomic call).
      const newStart = ledger.getLastRow() + 1;
      try {
        ledger.getRange(newStart, 1, newRows.length, NUM_COLS).setValues(newRows);
      } catch (writeErr) {
        return jsonResponse({ ok: false, retryable: true, error: String(writeErr && writeErr.message || writeErr) });
      }
      // Then delete the old contiguous block (one atomic call; oldStart still valid
      // because appends went to the bottom and didn't shift earlier rows).
      try {
        ledger.deleteRows(oldStart, oldCount);
      } catch (delErr) {
        let rolled = false;
        try { ledger.deleteRows(newStart, newRows.length); rolled = true; } catch (rbErr) {
          return jsonResponse({ ok: false, retryable: false, error: "CRITICAL: ledger has duplicate rows for " + sid + " and rollback failed. Resolve manually." });
        }
        if (rolled) return jsonResponse({ ok: false, retryable: true, error: String(delErr && delErr.message || delErr) });
      }
      // After the delete, the appended block shifted up by oldCount (rows below oldStart move up).
      approvedRowStart = newStart - oldCount;
      approvedRowCount = newRows.length;
      ledgerWritten = true;
    }
```

- [ ] **Step 2: Update the status-write rollback to use `deleteRows` and skip the sweep.**

In the `catch (statusErr)` block that rolls back after a failed status write, replace the per-row delete loop with a single call and re-append at the bottom:

```js
      if (ledgerWritten && approvedRowCount > 0 && ledgerSavedRows) {
        let rollbackOk = false;
        try {
          ledger.deleteRows(approvedRowStart, approvedRowCount);
          const restoreStart = ledger.getLastRow() + 1;
          ledger.getRange(restoreStart, 1, ledgerSavedRows.length, NUM_COLS).setValues(ledgerSavedRows);
          try { recolorShifts(); } catch (e) {} // best-effort; shading only
          rollbackOk = true;
        } catch (rollbackErr) {
          return jsonResponse({ ok: false, retryable: false, error: "CRITICAL: status write and ledger rollback both failed for " + sid + ". Manually mark the request resolved and verify the ledger." });
        }
        if (rollbackOk) throw statusErr; // outer catch -> retryable: true
      }
      throw statusErr;
```

(The auto-supersede sweep stays only on the success path after the status write — it is not added to any rollback path.)

- [ ] **Step 3: Syntax check.**

Run: `node --check apps-script.gs`
Expected: no output.

- [ ] **Step 4: Verify (manual, including the duplicate-window reasoning).**

Deploy. From the today page, submit an edit request; from admin, approve it. Expected: the ledger shows the edited rows (old rows replaced), the request flips to Approved, shading is correct, and any other pending request for the same shift is Superseded. Approve a second independent edit to confirm the path repeats. Manually re-sort the ledger sheet, attempt an approve, and confirm it returns the clear "not contiguous" error rather than corrupting rows; then undo the sort.

- [ ] **Step 5: Commit.**

```bash
git add apps-script.gs
git commit -m "Approve path: append-then-delete with deterministic rollback (#7)"
```

---

### Stage B verification gate

- [ ] Run `node --check apps-script.gs` — no output.
- [ ] Confirm the verbatim block is still identical between `calc.js` and `apps-script.gs`.
- [ ] Deploy; run `_smokeTest` and `_smokeTestConfig` — both OK.
- [ ] Manual: full approve cycle works; contiguity guard fires on a manually-sorted ledger; edit-request still records under the lock.

---

## Final review pass

After both stages, run a fresh review flow (Codex + the review agents) over the actual diff against the spec, then address any findings. Then run `/code-review --fix` (or `/simplify`) per the repo convention before any deploy/commit-to-main is requested.

## Notes for the implementer

- The `calc.js` ↔ `apps-script.gs` verbatim block must stay byte-identical; re-run the identity check after any change to either.
- `safeText` is for text columns only — never wrap Amount, Total tips, Hours, or Trainee %.
- Do not manually sort the ledger sheet; a shift's rows must stay contiguous (the approve path depends on it).
- The clasp deploy procedure and prod deployment id are in the project memory (`reference_clasp-deploy.md`); the remote file is `Code.js` and `setAdminPin` must be preserved.
