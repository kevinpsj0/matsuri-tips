// apps-script.gs - Google Apps Script web app for tip-calc (v2, time-based split).
// Deploy as: Web app, Execute as: me, Anyone has access.
// Bound to the Google Sheet whose first sheet is the tip ledger (one row per
// recipient per shift). Header/layout defined in
// docs/superpowers/specs/2026-05-29-time-based-split-design.md.

// Column indices (1-based, A=1)
// v3 14-column ledger.
const COL = {
  DATE: 1, TIME: 2, SHIFT: 3, ENTERED_BY: 4, RECIPIENT: 5, ROLE: 6, TRAINEE_PCT: 7,
  SLOT: 8, TIME_IN: 9, TIME_OUT: 10, HOURS: 11, AMOUNT: 12, TOTAL_TIPS: 13, SUBMISSION_ID: 14,
};
const NUM_COLS = COL.SUBMISSION_ID;

// Alternating row shades so each shift's block of rows is visually distinct.
// Index 0 (white) and index 1 (light gray) flip from one shift to the next.
const SHIFT_SHADES = ["#ffffff", "#f0f0f0"];

// The block between the VERBATIM MIRROR markers MUST match calc.js byte-for-byte
// (DEFAULT_SLOTS / SHIFT_SLOTS / configure / resetConfig / getSlot /
// findSlotByTimes / firstDuplicateName / minutesWorked / slotLabel / splitShift).
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

function getSlot(shiftType, slotId) {
  var slots = SHIFT_SLOTS[shiftType];
  if (!slots) return null;
  for (var i = 0; i < slots.length; i++) if (slots[i].id === slotId) return slots[i];
  return null;
}

function findSlotByTimes(shiftType, timeIn, timeOut) {
  var slots = SHIFT_SLOTS[shiftType];
  if (!slots) return null;
  for (var i = 0; i < slots.length; i++) {
    if (slots[i].timeIn === timeIn && slots[i].timeOut === timeOut) return slots[i];
  }
  return null;
}

// Returns the first display name that appears more than once (case-insensitive,
// trimmed), or null if all are unique. Empty/whitespace names are ignored.
function firstDuplicateName(names) {
  var seen = {};
  for (var i = 0; i < names.length; i++) {
    var raw = names[i] == null ? "" : String(names[i]).trim();
    if (!raw) continue;
    var k = raw.toLowerCase();
    if (seen[k]) return raw;
    seen[k] = true;
  }
  return null;
}

function minutesWorked(timeIn, timeOut) {
  var ip = timeIn.split(":");
  var op = timeOut.split(":");
  return (Number(op[0]) * 60 + Number(op[1])) - (Number(ip[0]) * 60 + Number(ip[1]));
}

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

function splitShift(input) {
  var T = Math.round(input.totalTips * 100);
  var kitchenCents = Math.round(T * KITCHEN_PCT / 100);
  var pool = T - kitchenCents;

  var servers = input.servers || [];
  var chefs = input.chefs || [];
  var S = servers.length;
  var C = chefs.length;

  var enriched = servers.map(function (p) {
    var slot = getSlot(input.shiftType, p.slot);
    var timeIn = slot ? slot.timeIn : p.timeIn;
    var timeOut = slot ? slot.timeOut : p.timeOut;
    var minutes = minutesWorked(timeIn, timeOut);
    var rate = p.trainee ? p.pct : 100;
    return {
      name: p.name, trainee: !!p.trainee, pct: p.trainee ? p.pct : null,
      slot: slot ? slot.id : p.slot, slotLabel: slot ? slotLabel(slot.timeIn, slot.timeOut) : "",
      timeIn: timeIn, timeOut: timeOut,
      hours: Math.round(minutes / 60 * 100) / 100, weight: minutes * rate,
    };
  });

  var chefPool;
  if (C === 0) chefPool = 0;
  else if (input.shiftType === "lunch") chefPool = Math.round(pool * 0.5);
  else chefPool = Math.round(pool * C / (S + C)); // dinner
  var serverPool = pool - chefPool;

  var chefsOut = [];
  if (C > 0) {
    var base = Math.floor(chefPool / C);
    var chefRemainder = chefPool - base * C;
    for (var ci = 0; ci < C; ci++) {
      chefsOut.push({ name: chefs[ci].name, amount: (base + (ci < chefRemainder ? 1 : 0)) / 100 });
    }
  }

  var totalWeight = enriched.reduce(function (s, p) { return s + p.weight; }, 0);
  var cents = enriched.map(function (p) {
    return totalWeight > 0 ? Math.floor(serverPool * p.weight / totalWeight) : 0;
  });
  var distributed = cents.reduce(function (s, c) { return s + c; }, 0);
  var remainder = serverPool - distributed;
  var order = enriched.map(function (_, i) { return i; }).sort(function (a, b) {
    if (enriched[b].weight !== enriched[a].weight) return enriched[b].weight - enriched[a].weight;
    return a - b;
  });
  for (var r = 0; r < remainder && order.length; r++) cents[order[r % order.length]] += 1;

  var serversOut = enriched.map(function (p, i) {
    return {
      name: p.name, trainee: p.trainee, pct: p.pct,
      slot: p.slot, slotLabel: p.slotLabel, timeIn: p.timeIn, timeOut: p.timeOut,
      hours: p.hours, amount: cents[i] / 100,
    };
  });

  return { shiftType: input.shiftType, kitchen: kitchenCents / 100, servers: serversOut, chefs: chefsOut };
}
// --- END VERBATIM MIRROR ---

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function isValidTime(t) {
  if (typeof t !== "string" || !/^\d{2}:\d{2}$/.test(t)) return false;
  const h = Number(t.slice(0, 2)), m = Number(t.slice(3, 5));
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function validatePayload(p) {
  if (!p || typeof p !== "object") return "Invalid payload";
  if (typeof p.submissionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(p.submissionId)) return "Invalid submissionId";
  return validateShiftFields(p);
}

// Build a client response from a validateShiftFields/validatePayload error. Slot
// rejections are tagged with an "unknown_slot:" prefix so the client can show a
// "tap Refresh" prompt instead of a dead-end error.
function validationResponse(msg) {
  if (typeof msg === "string" && msg.indexOf("unknown_slot:") === 0) {
    return jsonResponse({ ok: false, retryable: false, errorCode: "unknown_slot", error: msg.slice("unknown_slot:".length) });
  }
  return jsonResponse({ ok: false, retryable: false, error: msg });
}

function findRowsBySubmissionId(sheet, submissionId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const data = sheet.getRange(2, 1, lastRow - 1, NUM_COLS).getValues();
  return data.filter(function (row) { return row[COL.SUBMISSION_ID - 1] === submissionId; });
}

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

// Read path for the entry form's name dropdowns. Returns the roster from the
// "Staff" tab (column A, below the header). No PIN: names are not sensitive and
// the public entry form needs them.
// Reads col A (name) and col B (active flag). Empty/missing col B is
// treated as active so existing one-column rows keep working unchanged.
function readStaffRows(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  const seen = {};
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const name = String(values[i][0] || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    const rawB = values[i][1];
    // Empty cell or anything non-FALSE counts as active (backward compat).
    const active = !(rawB === false || String(rawB).toLowerCase() === "false" || String(rawB).toLowerCase() === "inactive");
    const role = String(values[i][2] || "").trim().toLowerCase() === "chef" ? "Chef" : "Server";
    const tp = Number(values[i][3]);
    const traineePct = (tp === 25 || tp === 50 || tp === 75) ? tp : null;
    out.push({ name: name, active: active, role: role, traineePct: traineePct, rowIdx: i + 2 });
  }
  return out;
}

// Ensure the Staff sheet exists and its header row covers Name + Active.
function getOrCreateStaffSheet(ss) {
  let sheet = ss.getSheetByName("Staff");
  if (!sheet) {
    try {
      sheet = ss.insertSheet("Staff", ss.getNumSheets());
      sheet.getRange(1, 1, 1, 4).setValues([["Name", "Active", "Role", "Trainee %"]]).setFontWeight("bold");
      sheet.setFrozenRows(1);
      return sheet;
    } catch (e) {
      sheet = ss.getSheetByName("Staff");
      if (!sheet) throw e;
    }
  }
  // Backfill the Active + Role + Trainee % headers without touching existing names.
  if (String(sheet.getRange(1, 2).getValue() || "") !== "Active") {
    sheet.getRange(1, 2).setValue("Active").setFontWeight("bold");
  }
  if (String(sheet.getRange(1, 3).getValue() || "") !== "Role") {
    sheet.getRange(1, 3).setValue("Role").setFontWeight("bold");
  }
  if (String(sheet.getRange(1, 4).getValue() || "") !== "Trainee %") {
    sheet.getRange(1, 4).setValue("Trainee %").setFontWeight("bold");
  }
  return sheet;
}

// Public read path: only ACTIVE names, used by the entry form name dropdowns.
function handleFetchStaff() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Staff");
  if (!sheet) return jsonResponse({ ok: true, staff: [] });
  const staff = readStaffRows(sheet).filter(function (s) { return s.active; })
    .map(function (s) { return { name: s.name, role: s.role, traineePct: s.traineePct }; });
  return jsonResponse({ ok: true, staff: staff });
}

// Admin-only: add a new staff member (active by default). Rejects duplicates.
function handleAddStaff(payload) {
  const storedPin = PropertiesService.getScriptProperties().getProperty("ADMIN_PIN");
  if (!storedPin) return jsonResponse({ ok: false, error: "Admin access is not configured yet." });
  if (typeof payload.pin !== "string" || payload.pin !== storedPin) {
    Utilities.sleep(1000);
    return jsonResponse({ ok: false, error: "Wrong PIN." });
  }
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!name) return jsonResponse({ ok: false, error: "Name is required" });
  if (name.length > 40) return jsonResponse({ ok: false, error: "Name is too long (40 chars max)" });
  const role = (typeof payload.role === "string" && payload.role.toLowerCase() === "chef") ? "Chef" : "Server";

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return jsonResponse({ ok: false, retryable: true, error: "Busy, try again." });
  try {
    const sheet = getOrCreateStaffSheet(ss);
    const existing = readStaffRows(sheet);
    const key = name.toLowerCase();
    for (const s of existing) {
      if (s.name.toLowerCase() === key) {
        if (s.active) return jsonResponse({ ok: false, error: name + " is already on the roster." });
        // Re-activate instead of inserting a duplicate row.
        sheet.getRange(s.rowIdx, 2).setValue(true);
        sheet.getRange(s.rowIdx, 3).setValue(role);
        return jsonResponse({ ok: true, reactivated: true });
      }
    }
    sheet.appendRow([safeText(name), true, role, ""]);
    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, retryable: true, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// Admin-only: toggle a staff member active/inactive.
function handleSetStaffActive(payload) {
  const storedPin = PropertiesService.getScriptProperties().getProperty("ADMIN_PIN");
  if (!storedPin) return jsonResponse({ ok: false, error: "Admin access is not configured yet." });
  if (typeof payload.pin !== "string" || payload.pin !== storedPin) {
    Utilities.sleep(1000);
    return jsonResponse({ ok: false, error: "Wrong PIN." });
  }
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!name) return jsonResponse({ ok: false, error: "Name is required" });
  const active = !!payload.active;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return jsonResponse({ ok: false, retryable: true, error: "Busy, try again." });
  try {
    const sheet = getOrCreateStaffSheet(ss);
    const rows = readStaffRows(sheet);
    const key = name.toLowerCase();
    for (const s of rows) {
      if (s.name.toLowerCase() === key) {
        sheet.getRange(s.rowIdx, 2).setValue(active);
        return jsonResponse({ ok: true });
      }
    }
    return jsonResponse({ ok: false, error: name + " is not on the roster." });
  } catch (err) {
    return jsonResponse({ ok: false, retryable: true, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// Admin-only: set (or clear) a staff member's trainee level. traineePct is
// null/empty to clear, or 25/50/75. Stored in the Staff "Trainee %" column.
function handleSetStaffTrainee(payload) {
  const storedPin = PropertiesService.getScriptProperties().getProperty("ADMIN_PIN");
  if (!storedPin) return jsonResponse({ ok: false, error: "Admin access is not configured yet." });
  if (typeof payload.pin !== "string" || payload.pin !== storedPin) {
    Utilities.sleep(1000);
    return jsonResponse({ ok: false, error: "Wrong PIN." });
  }
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!name) return jsonResponse({ ok: false, error: "Name is required" });
  let cell = "";
  if (payload.traineePct !== null && payload.traineePct !== undefined && payload.traineePct !== "" && payload.traineePct !== false) {
    const pct = Number(payload.traineePct);
    if (pct !== 25 && pct !== 50 && pct !== 75) return jsonResponse({ ok: false, error: "Trainee level must be 25, 50, or 75" });
    cell = pct;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return jsonResponse({ ok: false, retryable: true, error: "Busy, try again." });
  try {
    const sheet = getOrCreateStaffSheet(ss);
    const rows = readStaffRows(sheet);
    const key = name.toLowerCase();
    for (const s of rows) {
      if (s.name.toLowerCase() === key) {
        sheet.getRange(s.rowIdx, 4).setValue(cell);
        return jsonResponse({ ok: true });
      }
    }
    return jsonResponse({ ok: false, error: name + " is not on the roster." });
  } catch (err) {
    return jsonResponse({ ok: false, retryable: true, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// The Staff roster is the source of truth for trainee status. Overwrite each
// submitted server's trainee/pct from the roster so a stale phone (or an
// off-roster "Other" name) can't set the wrong level.
function applyRosterTrainees(servers) {
  if (!Array.isArray(servers) || !servers.length) return;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Staff");
  const map = {};
  if (sheet) readStaffRows(sheet).forEach(function (s) { if (s.traineePct) map[s.name.toLowerCase()] = s.traineePct; });
  servers.forEach(function (sv) {
    const pct = map[String(sv && sv.name || "").trim().toLowerCase()];
    if (pct === 25 || pct === 50 || pct === 75) { sv.trainee = true; sv.pct = pct; }
    else { sv.trainee = false; sv.pct = null; }
  });
}

// Read path for the admin dashboard. PIN is checked against the ADMIN_PIN
// Script Property (Project Settings -> Script Properties), never stored in code.
function handleFetchData(payload) {
  const storedPin = PropertiesService.getScriptProperties().getProperty("ADMIN_PIN");
  if (!storedPin) {
    return jsonResponse({ ok: false, error: "Admin access is not configured yet." });
  }
  if (typeof payload.pin !== "string" || payload.pin !== storedPin) {
    Utilities.sleep(1000); // slow down brute-force guessing
    return jsonResponse({ ok: false, error: "Wrong PIN." });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheets()[0];
  const lastRow = sheet.getLastRow();
  const staffSheet = ss.getSheetByName("Staff");
  const staff = staffSheet ? readStaffRows(staffSheet).map(function (s) { return { name: s.name, active: s.active, role: s.role, traineePct: s.traineePct }; }) : [];
  if (lastRow < 2) return jsonResponse({ ok: true, rows: [], staff: staff, config: configObject() });

  const tz = ss.getSpreadsheetTimeZone();
  const asDateStr = (v) => (v instanceof Date) ? Utilities.formatDate(v, tz, "yyyy-MM-dd") : String(v || "");
  const asTimeStr = (v) => (v instanceof Date) ? Utilities.formatDate(v, tz, "HH:mm") : String(v || "");
  const numOrNull = (v) => (v === "" || v === null || v === undefined) ? null : Number(v);

  const values = sheet.getRange(2, 1, lastRow - 1, NUM_COLS).getValues();
  const rows = values.map((r) => ({
    date: asDateStr(r[COL.DATE - 1]),
    time: asTimeStr(r[COL.TIME - 1]),
    shift: String(r[COL.SHIFT - 1] || ""),
    enteredBy: String(r[COL.ENTERED_BY - 1] || ""),
    recipient: String(r[COL.RECIPIENT - 1] || ""),
    role: String(r[COL.ROLE - 1] || ""),
    traineePct: numOrNull(r[COL.TRAINEE_PCT - 1]),
    slot: String(r[COL.SLOT - 1] || ""),
    timeIn: asTimeStr(r[COL.TIME_IN - 1]),
    timeOut: asTimeStr(r[COL.TIME_OUT - 1]),
    hours: Number(r[COL.HOURS - 1]) || 0,
    amount: Number(r[COL.AMOUNT - 1]) || 0,
    totalTips: Number(r[COL.TOTAL_TIPS - 1]) || 0,
    submissionId: String(r[COL.SUBMISSION_ID - 1] || ""),
  }));
  return jsonResponse({ ok: true, rows: rows, staff: staff, config: configObject() });
}

// Read path for the staff verification page (today.html). Returns just
// today's rows, no PIN. Same trust model as the entry form: anyone with
// the URL can read today's shifts.
function handleFetchToday() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheets()[0];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonResponse({ ok: true, rows: [], config: configObject() });

  const tz = ss.getSpreadsheetTimeZone();
  const today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  const asDateStr = (v) => (v instanceof Date) ? Utilities.formatDate(v, tz, "yyyy-MM-dd") : String(v || "");
  const asTimeStr = (v) => (v instanceof Date) ? Utilities.formatDate(v, tz, "HH:mm") : String(v || "");
  const numOrNull = (v) => (v === "" || v === null || v === undefined) ? null : Number(v);

  const values = sheet.getRange(2, 1, lastRow - 1, NUM_COLS).getValues();
  const rows = [];
  for (const r of values) {
    const date = asDateStr(r[COL.DATE - 1]);
    if (date !== today) continue;
    rows.push({
      date: date,
      time: asTimeStr(r[COL.TIME - 1]),
      shift: String(r[COL.SHIFT - 1] || ""),
      enteredBy: String(r[COL.ENTERED_BY - 1] || ""),
      recipient: String(r[COL.RECIPIENT - 1] || ""),
      role: String(r[COL.ROLE - 1] || ""),
      traineePct: numOrNull(r[COL.TRAINEE_PCT - 1]),
      slot: String(r[COL.SLOT - 1] || ""),
      timeIn: asTimeStr(r[COL.TIME_IN - 1]),
      timeOut: asTimeStr(r[COL.TIME_OUT - 1]),
      hours: Number(r[COL.HOURS - 1]) || 0,
      amount: Number(r[COL.AMOUNT - 1]) || 0,
      totalTips: Number(r[COL.TOTAL_TIPS - 1]) || 0,
      submissionId: String(r[COL.SUBMISSION_ID - 1] || ""),
    });
  }
  return jsonResponse({ ok: true, rows: rows, config: configObject() });
}

// Validates the shift body (everything except submissionId). Shared by the
// entry write path and the edit-request flow.
function validateShiftFields(p) {
  if (!p || typeof p !== "object") return "Invalid shift";
  if (p.shiftType !== "lunch" && p.shiftType !== "dinner") return "Invalid shift type";
  if (typeof p.enteredBy !== "string" || !p.enteredBy.trim() || p.enteredBy.length > 60) return "Invalid enteredBy";
  if (typeof p.totalTips !== "number" || !isFinite(p.totalTips) || p.totalTips < 1 || p.totalTips > 100000)
    return "totalTips must be between 1 and 100000";
  if (!Array.isArray(p.servers) || p.servers.length < 1 || p.servers.length > 12) return "servers must have 1-12 entries";
  for (const s of p.servers) {
    if (!s || typeof s !== "object") return "Invalid server";
    if (typeof s.name !== "string" || !s.name.trim() || s.name.length > 40) return "Invalid server name";
    if (!getSlot(p.shiftType, s.slot)) return "unknown_slot:Invalid time slot for " + (s.name || "server");
    // Trainee is roster-enforced via applyRosterTrainees before this runs on the
    // write paths, so trainee/pct here are already authoritative; this just guards.
    if (s.trainee && s.pct !== 25 && s.pct !== 50 && s.pct !== 75) return "Trainee level must be 25, 50, or 75";
  }
  const dupServer = firstDuplicateName(p.servers.map(function (s) { return s.name; }));
  if (dupServer) return "Two servers have the same name: " + dupServer + ". Please use different names.";
  if (!Array.isArray(p.chefs) || p.chefs.length > 6) return "chefs must have 0-6 entries";
  for (const c of p.chefs) {
    if (!c || typeof c !== "object") return "Invalid chef";
    if (typeof c.name !== "string" || !c.name.trim() || c.name.length > 40) return "Invalid chef name";
  }
  const dupChef = firstDuplicateName(p.chefs.map(function (c) { return c.name; }));
  if (dupChef) return "Duplicate chef: " + dupChef;
  return null;
}

const EDIT_REQ_HEADER = [
  "Request ID", "Requested at", "Requested by", "Shift submission ID",
  "Shift date", "Shift time", "Status", "Note", "Proposed (JSON)",
  "Resolved at", "Resolved by",
];

// Defuse Sheets formula injection: prefix with a single quote so the cell
// renders as plain text instead of being evaluated as a formula.
function safeText(s) {
  const str = String(s == null ? "" : s);
  // Quote if the first non-whitespace char is a formula trigger, or it starts
  // with a control char. Text columns only — never wrap numeric columns.
  return (/^[\s]*[=+\-@]/.test(str) || /^[\t\r\n]/.test(str)) ? "'" + str : str;
}

function getOrCreateRequestsSheet(ss) {
  let sheet = ss.getSheetByName("Edit requests");
  if (!sheet) {
    // insertSheet throws if a tab with that name already exists, which can
    // happen if two staff submit the very first edit request at the same time.
    // Catch and re-fetch instead of bubbling the exception.
    try {
      sheet = ss.insertSheet("Edit requests", ss.getNumSheets()); // append; keep ledger at index 0
      sheet.getRange(1, 1, 1, EDIT_REQ_HEADER.length).setValues([EDIT_REQ_HEADER]).setFontWeight("bold");
      sheet.setFrozenRows(1);
      return sheet;
    } catch (e) {
      sheet = ss.getSheetByName("Edit requests");
      if (!sheet) throw e;
    }
  }
  const a1 = String(sheet.getRange(1, 1).getValue() || "");
  if (a1 === EDIT_REQ_HEADER[0]) return sheet;
  // Only auto-initialize when the sheet is truly empty (no header, no rows).
  // If A1 differs but the sheet has data, surface an error rather than wiping
  // pending requests — manual migration is safer than silent data loss.
  if (a1 === "" && sheet.getLastRow() <= 1) {
    sheet.getRange(1, 1, 1, EDIT_REQ_HEADER.length).setValues([EDIT_REQ_HEADER]).setFontWeight("bold");
    sheet.setFrozenRows(1);
    return sheet;
  }
  throw new Error('"Edit requests" tab header is not "Request ID". Migrate manually before submitting new requests.');
}

// Write path for the staff verification page: logs a request-to-edit (with the
// proposed full shift payload + optional note) to the "Edit requests" tab.
function handleRequestEdit(payload) {
  if (!payload || typeof payload !== "object") return jsonResponse({ ok: false, error: "Invalid request" });
  const sid = typeof payload.submissionId === "string" ? payload.submissionId.trim() : "";
  const by = typeof payload.requestedBy === "string" ? payload.requestedBy.trim() : "";
  const note = typeof payload.note === "string" ? payload.note.trim() : "";
  if (!sid || sid.length > 64) return jsonResponse({ ok: false, error: "Invalid submissionId" });
  if (!by || by.length > 60) return jsonResponse({ ok: false, error: "Please enter your name" });
  if (note.length > 500) return jsonResponse({ ok: false, error: "Note is too long (500 chars max)" });

  // Load the active slot table before validation (validateShiftFields -> getSlot).
  configure({ slots: getSlots(), kitchenPct: getKitchenPct() });
  const validation = validateShiftFields(payload.proposed);
  if (validation) return validationResponse(validation);

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Hold the script lock around the ledger lookup AND the requests-sheet append
  // so a concurrent approve can't delete the shift between the two steps.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonResponse({ ok: false, retryable: true, error: "Busy, try again." });
  try {
    // Resolve the shift in the ledger BEFORE touching the requests sheet. If the
    // submissionId isn't there (e.g. the shift was deleted), reject the request
    // up-front instead of writing a phantom row that approval will always fail.
    const tz = ss.getSpreadsheetTimeZone();
    let shiftDate = "", shiftTime = "", found = false;
    const ledger = ss.getSheets()[0];
    const lastRow = ledger.getLastRow();
    if (lastRow >= 2) {
      const vals = ledger.getRange(2, 1, lastRow - 1, NUM_COLS).getValues();
      for (const r of vals) {
        if (r[COL.SUBMISSION_ID - 1] === sid) {
          const d = r[COL.DATE - 1], t = r[COL.TIME - 1];
          shiftDate = (d instanceof Date) ? Utilities.formatDate(d, tz, "yyyy-MM-dd") : String(d || "");
          shiftTime = (t instanceof Date) ? Utilities.formatDate(t, tz, "HH:mm") : String(t || "");
          found = true;
          break;
        }
      }
    }
    if (!found) return jsonResponse({ ok: false, error: "That shift is no longer in the ledger. Tap Refresh and try again." });

    const sheet = getOrCreateRequestsSheet(ss);
    // Re-build proposed from only the validated fields so an oversized or
    // adversarial payload can't bloat the JSON cell or smuggle extra keys.
    const cleanProposed = {
      shiftType: payload.proposed.shiftType,
      enteredBy: String(payload.proposed.enteredBy).trim(),
      totalTips: Number(payload.proposed.totalTips),
      servers: payload.proposed.servers.map(function (s) {
        const trainee = !!s.trainee;
        return { name: String(s.name).trim(), slot: String(s.slot), trainee: trainee, pct: trainee ? Number(s.pct) : null };
      }),
      chefs: payload.proposed.chefs.map(function (c) { return { name: String(c.name).trim() }; }),
    };
    const reqId = "er-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const now = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm");
    sheet.appendRow([reqId, now, safeText(by), safeText(sid), shiftDate, shiftTime, "Pending", safeText(note), JSON.stringify(cleanProposed), "", ""]);
    return jsonResponse({ ok: true, requestId: reqId });
  } catch (err) {
    return jsonResponse({ ok: false, retryable: true, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// Admin read path: returns pending edit requests for the dashboard.
function handleListRequests(payload) {
  const storedPin = PropertiesService.getScriptProperties().getProperty("ADMIN_PIN");
  if (!storedPin) return jsonResponse({ ok: false, error: "Admin access is not configured yet." });
  if (typeof payload.pin !== "string" || payload.pin !== storedPin) {
    Utilities.sleep(1000);
    return jsonResponse({ ok: false, error: "Wrong PIN." });
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Edit requests");
  if (!sheet) return jsonResponse({ ok: true, requests: [] });
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonResponse({ ok: true, requests: [] });

  const tz = ss.getSpreadsheetTimeZone();
  const asDateStr = (v) => (v instanceof Date) ? Utilities.formatDate(v, tz, "yyyy-MM-dd") : String(v || "");
  const asTimeStr = (v) => (v instanceof Date) ? Utilities.formatDate(v, tz, "HH:mm") : String(v || "");
  const asStampStr = (v) => (v instanceof Date) ? Utilities.formatDate(v, tz, "yyyy-MM-dd HH:mm") : String(v || "");

  const data = sheet.getRange(2, 1, lastRow - 1, EDIT_REQ_HEADER.length).getValues();
  const requests = [];
  for (const r of data) {
    const status = String(r[6] || "");
    if (status !== "Pending") continue;
    let proposed = null;
    try { proposed = JSON.parse(String(r[8] || "{}")); } catch (e) {}
    requests.push({
      id: String(r[0] || ""),
      requestedAt: asStampStr(r[1]),
      requestedBy: String(r[2] || ""),
      submissionId: String(r[3] || ""),
      shiftDate: asDateStr(r[4]),
      shiftTime: asTimeStr(r[5]),
      status: status,
      note: String(r[7] || ""),
      proposed: proposed,
    });
  }
  return jsonResponse({ ok: true, requests: requests });
}

// Admin write path: approve (apply the proposed shift to the ledger) or deny.
function handleResolveRequest(payload) {
  const storedPin = PropertiesService.getScriptProperties().getProperty("ADMIN_PIN");
  if (!storedPin) return jsonResponse({ ok: false, error: "Admin access is not configured yet." });
  if (typeof payload.pin !== "string" || payload.pin !== storedPin) {
    Utilities.sleep(1000);
    return jsonResponse({ ok: false, error: "Wrong PIN." });
  }
  const reqId = typeof payload.requestId === "string" ? payload.requestId.trim() : "";
  const resolution = payload.resolution;
  if (!reqId || reqId.length > 64) return jsonResponse({ ok: false, error: "Invalid requestId" });
  if (resolution !== "approve" && resolution !== "deny") return jsonResponse({ ok: false, error: "Invalid resolution" });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const reqSheet = ss.getSheetByName("Edit requests");
  if (!reqSheet) return jsonResponse({ ok: false, error: "No requests" });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonResponse({ ok: false, retryable: true, error: "Busy, try again." });
  try {
    const lastRow = reqSheet.getLastRow();
    if (lastRow < 2) return jsonResponse({ ok: false, error: "Request not found" });
    const data = reqSheet.getRange(2, 1, lastRow - 1, EDIT_REQ_HEADER.length).getValues();
    let rowIdx = -1;
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][0]) === reqId) { rowIdx = i + 2; break; }
    }
    if (rowIdx === -1) return jsonResponse({ ok: false, error: "Request not found" });
    const row = data[rowIdx - 2];
    if (String(row[6] || "") !== "Pending") return jsonResponse({ ok: false, error: "Request already resolved" });

    const tz = ss.getSpreadsheetTimeZone();
    // Rollback bookkeeping for the approve path; consulted in the status-write
    // catch below so we can put the ledger back if marking the request fails.
    let ledger = null, sid = "";
    let ledgerWritten = false, ledgerSavedRows = null;
    let approvedRowStart = -1, approvedRowCount = 0;
    if (resolution === "approve") {
      sid = String(row[3] || "");
      let proposed;
      try { proposed = JSON.parse(String(row[8] || "")); } catch (e) {
        return jsonResponse({ ok: false, error: "Stored proposal is invalid" });
      }
      configure({ slots: getSlots(), kitchenPct: getKitchenPct() });
      if (proposed && typeof proposed === "object") applyRosterTrainees(proposed.servers);
      const validation = validateShiftFields(proposed);
      if (validation) return jsonResponse({ ok: false, error: "Proposal invalid: " + validation.replace("unknown_slot:", "") });

      ledger = ss.getSheets()[0];
      const lastL = ledger.getLastRow();
      if (lastL < 2) return jsonResponse({ ok: false, error: "Shift not found in ledger" });
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
      if (!targetRowIdxs.length) return jsonResponse({ ok: false, error: "Shift not found in ledger" });
      const oldStart = Math.min.apply(null, targetRowIdxs);
      const oldCount = targetRowIdxs.length;
      if (Math.max.apply(null, targetRowIdxs) - oldStart + 1 !== oldCount) {
        return jsonResponse({ ok: false, retryable: false, error: "Ledger rows for this shift are not contiguous; resolve manually." });
      }

      const splits = splitShift(proposed);
      const shiftLabel = proposed.shiftType === "lunch" ? "Lunch" : "Dinner";
      // Guard: an approved edit must not create a second shift of the same type
      // on the same day (e.g. editing a lunch into a dinner that already exists).
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

      // Save the originals (ascending) so we can restore the ledger on rollback.
      ledgerSavedRows = targetRowIdxs.slice().sort(function (a, b) { return a - b; }).map(function (r) { return ldata[r - 2]; });

      // Append the new rows first (one atomic call). A hard kill here leaves
      // recoverable duplicate rows rather than a silently lost shift.
      const newStart = ledger.getLastRow() + 1;
      try {
        ledger.getRange(newStart, 1, newRows.length, NUM_COLS).setValues(newRows);
      } catch (writeErr) {
        return jsonResponse({ ok: false, retryable: true, error: String(writeErr && writeErr.message || writeErr) });
      }
      // Then delete the old contiguous block (one atomic call; oldStart still
      // valid because appends went to the bottom and didn't shift earlier rows).
      try {
        ledger.deleteRows(oldStart, oldCount);
      } catch (delErr) {
        let rolled = false;
        try { ledger.deleteRows(newStart, newRows.length); rolled = true; } catch (rbErr) {
          return jsonResponse({ ok: false, retryable: false, error: "CRITICAL: ledger has duplicate rows for " + sid + " and rollback failed. Resolve manually." });
        }
        if (rolled) return jsonResponse({ ok: false, retryable: true, error: String(delErr && delErr.message || delErr) });
      }
      // After the delete, the appended block shifted up by oldCount.
      approvedRowStart = newStart - oldCount;
      approvedRowCount = newRows.length;
      ledgerWritten = true;
    }

    // Mark the request resolved BEFORE the cosmetic recolor step so a recolor
    // failure can't leave the ledger updated but the request stuck "Pending".
    // Write Status / Resolved at / Resolved by in a single setValues call so
    // a partial write can't leave Status="Approved" without a resolver. We
    // read cols 8-9 (Note, Proposed JSON) and pass them through so they're
    // preserved untouched.
    const nowStr = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm");
    try {
      const keep = reqSheet.getRange(rowIdx, 8, 1, 2).getValues()[0];
      reqSheet.getRange(rowIdx, 7, 1, 5).setValues([[
        resolution === "approve" ? "Approved" : "Denied",
        keep[0], keep[1], nowStr, "admin",
      ]]);
    } catch (statusErr) {
      // Ledger has already been updated but the request is still "Pending".
      // If we leave it, an admin retry would re-apply the same changes (or
      // a Deny could mark Denied while the ledger holds the approved data).
      // Attempt to roll the ledger back so the request can be safely retried.
      if (ledgerWritten && approvedRowCount > 0 && ledgerSavedRows) {
        // Use a flag so the rethrow that signals "retryable" can't be re-caught
        // by this same catch block, which would mask it as non-retryable.
        let rollbackOk = false;
        try {
          ledger.deleteRows(approvedRowStart, approvedRowCount);
          const restoreStart = ledger.getLastRow() + 1;
          ledger.getRange(restoreStart, 1, ledgerSavedRows.length, NUM_COLS).setValues(ledgerSavedRows);
          try { recolorShifts(); } catch (e) {} // best-effort; shading only, restored rows sit at the bottom
          rollbackOk = true;
        } catch (rollbackErr) {
          return jsonResponse({
            ok: false,
            retryable: false,
            error: "CRITICAL: status write and ledger rollback both failed for " + sid + ". Manually mark the request resolved and verify the ledger.",
          });
        }
        if (rollbackOk) throw statusErr; // outer catch -> retryable: true
      }
      throw statusErr;
    }
    if (resolution === "approve") {
      // Auto-supersede any OTHER pending requests for the same shift so a
      // stale proposal from before this approval can't silently overwrite
      // the ledger changes we just applied. handleRequestEdit doesn't hold
      // the script lock, so rows may have been appended during this lock
      // window — re-read fresh instead of trusting the start-of-function
      // snapshot. Best-effort: per-row writes are isolated so a single
      // failure can't undo the primary approval.
      const freshLast = reqSheet.getLastRow();
      const sweepData = (freshLast >= 2)
        ? reqSheet.getRange(2, 1, freshLast - 1, EDIT_REQ_HEADER.length).getValues()
        : [];
      for (let i = 0; i < sweepData.length; i++) {
        if (i + 2 === rowIdx) continue;
        const r = sweepData[i];
        if (String(r[6] || "") !== "Pending") continue;
        if (String(r[3] || "") !== sid) continue;
        const otherRow = i + 2;
        try {
          const keepO = reqSheet.getRange(otherRow, 8, 1, 2).getValues()[0];
          reqSheet.getRange(otherRow, 7, 1, 5).setValues([[
            "Superseded", keepO[0], keepO[1], nowStr, "admin (auto)",
          ]]);
        } catch (e) { /* best effort */ }
      }
      try { recolorShifts(); } catch (e) { /* shading is cosmetic; don't fail the approval */ }
    }
    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, retryable: true, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// True if the ledger already has a row for this calendar date (restaurant tz)
// and shift label ("Lunch"/"Dinner"). Date cells may be strings or Date values.
function shiftExistsForDay(sheet, dateStr, shiftLabel, tz) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const vals = sheet.getRange(2, 1, lastRow - 1, NUM_COLS).getValues();
  for (const r of vals) {
    const d = r[COL.DATE - 1];
    const ds = (d instanceof Date) ? Utilities.formatDate(d, tz, "yyyy-MM-dd") : String(d || "");
    if (ds === dateStr && String(r[COL.SHIFT - 1] || "") === shiftLabel) return true;
  }
  return false;
}

// ---- global config ----
// SHOW_SPLIT controls whether the entry app reveals the per-person tip split to
// servers. Stored in Script Properties; defaults to on when unset.
function getShowSplit() {
  const v = PropertiesService.getScriptProperties().getProperty("SHOW_SPLIT");
  return (v === null || v === undefined || v === "") ? true : (v === "1");
}

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
  // Normalize: return only {id,timeIn,timeOut}, dropping any extra keys.
  function norm(arr) { return arr.map(function (s) { return { id: String(s.id), timeIn: String(s.timeIn), timeOut: String(s.timeOut) }; }); }
  return { lunch: norm(parsed.lunch), dinner: norm(parsed.dinner) };
}

function getKitchenPct() {
  var raw = PropertiesService.getScriptProperties().getProperty("KITCHEN_PCT");
  if (raw == null || String(raw).trim() === "") return 15;
  var n = Number(raw);
  return (Number.isInteger(n) && n >= 0 && n <= 50) ? n : 15;
}

function configObject() {
  return { showSplit: getShowSplit(), kitchenPct: getKitchenPct(), slots: getSlots() };
}

// Admin write path: persist a global setting. PIN protected, like the other
// admin actions.
function handleSetConfig(payload) {
  const storedPin = PropertiesService.getScriptProperties().getProperty("ADMIN_PIN");
  if (!storedPin) return jsonResponse({ ok: false, error: "Admin access is not configured yet." });
  if (typeof payload.pin !== "string" || payload.pin !== storedPin) {
    Utilities.sleep(1000);
    return jsonResponse({ ok: false, error: "Wrong PIN." });
  }
  if (typeof payload.showSplit !== "boolean") return jsonResponse({ ok: false, error: "Invalid config" });
  PropertiesService.getScriptProperties().setProperty("SHOW_SPLIT", payload.showSplit ? "1" : "0");
  return jsonResponse({ ok: true, config: configObject() });
}

// Admin write path: set the kitchen cut %. PIN protected.
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

// Admin write path: replace the whole slot config. PIN protected. Reconstructs
// from validated fields only (drops extra keys) and assigns globally-unique ids.
function handleSetSlots(payload) {
  const storedPin = PropertiesService.getScriptProperties().getProperty("ADMIN_PIN");
  if (!storedPin) return jsonResponse({ ok: false, error: "Admin access is not configured yet." });
  if (typeof payload.pin !== "string" || payload.pin !== storedPin) {
    Utilities.sleep(1000);
    return jsonResponse({ ok: false, error: "Wrong PIN." });
  }
  const err = validateSlots(payload.slots);
  if (err) return jsonResponse({ ok: false, error: err });

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

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (parseErr) {
    return jsonResponse({ ok: false, retryable: false, error: "Invalid JSON" });
  }

  if (payload && payload.action === "fetchData") {
    return handleFetchData(payload);
  }
  if (payload && payload.action === "setConfig") {
    return handleSetConfig(payload);
  }
  if (payload && payload.action === "fetchStaff") {
    return handleFetchStaff();
  }
  if (payload && payload.action === "fetchToday") {
    return handleFetchToday();
  }
  if (payload && payload.action === "requestEdit") {
    return handleRequestEdit(payload);
  }
  if (payload && payload.action === "listRequests") {
    return handleListRequests(payload);
  }
  if (payload && payload.action === "resolveRequest") {
    return handleResolveRequest(payload);
  }
  if (payload && payload.action === "addStaff") {
    return handleAddStaff(payload);
  }
  if (payload && payload.action === "setStaffActive") {
    return handleSetStaffActive(payload);
  }
  if (payload && payload.action === "setStaffTrainee") {
    return handleSetStaffTrainee(payload);
  }
  if (payload && payload.action === "setSlots") {
    return handleSetSlots(payload);
  }
  if (payload && payload.action === "setKitchenPct") {
    return handleSetKitchenPct(payload);
  }

  // Direct shift-write path. Load the active slot table + kitchen % before
  // validation (getSlot) and the split.
  configure({ slots: getSlots(), kitchenPct: getKitchenPct() });
  if (payload && typeof payload === "object") applyRosterTrainees(payload.servers);

  const validationError = validatePayload(payload);
  if (validationError) {
    return validationResponse(validationError);
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return jsonResponse({ ok: false, retryable: true, error: "Sheet busy, please try again." });
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheets()[0];
    const tz = ss.getSpreadsheetTimeZone();

    const existing = findRowsBySubmissionId(sheet, payload.submissionId);
    if (existing.length) {
      return jsonResponse({ ok: true, dedup: true, splits: splitsFromRows(existing, tz), showSplit: getShowSplit() });
    }

    const splits = splitShift(payload);

    const now = new Date();
    const dateStr = Utilities.formatDate(now, tz, "yyyy-MM-dd");
    const timeStr = Utilities.formatDate(now, tz, "HH:mm");
    const shiftLabel = payload.shiftType === "lunch" ? "Lunch" : "Dinner";
    // One Lunch + one Dinner per day. Runs inside the script lock, so two
    // simultaneous submissions of the same shift can't both get through.
    if (shiftExistsForDay(sheet, dateStr, shiftLabel, tz)) {
      return jsonResponse({ ok: false, retryable: false, error: "Today's " + payload.shiftType + " shift was already entered. Open 'View today's shifts' to edit it." });
    }
    const enteredBy = safeText(payload.enteredBy.trim());

    function baseRow() {
      const row = new Array(NUM_COLS).fill("");
      row[COL.DATE - 1] = dateStr;
      row[COL.TIME - 1] = timeStr;
      row[COL.SHIFT - 1] = shiftLabel;
      row[COL.ENTERED_BY - 1] = enteredBy;
      row[COL.TOTAL_TIPS - 1] = payload.totalTips;
      row[COL.SUBMISSION_ID - 1] = safeText(payload.submissionId);
      return row;
    }

    const rowsToWrite = [];
    for (const sp of splits.servers) {
      const row = baseRow();
      row[COL.RECIPIENT - 1] = safeText(sp.name.trim());
      row[COL.ROLE - 1] = sp.trainee ? "Trainee" : "Server";
      row[COL.TRAINEE_PCT - 1] = sp.trainee ? sp.pct : "";
      row[COL.SLOT - 1] = safeText(sp.slotLabel);
      row[COL.TIME_IN - 1] = sp.timeIn;
      row[COL.TIME_OUT - 1] = sp.timeOut;
      row[COL.HOURS - 1] = sp.hours;
      row[COL.AMOUNT - 1] = sp.amount;
      rowsToWrite.push(row);
    }
    for (const cf of splits.chefs) {
      const row = baseRow();
      row[COL.RECIPIENT - 1] = safeText(cf.name.trim());
      row[COL.ROLE - 1] = "Chef";
      row[COL.AMOUNT - 1] = cf.amount;
      rowsToWrite.push(row);
    }
    const kitchenRow = baseRow();
    kitchenRow[COL.RECIPIENT - 1] = "Kitchen";
    kitchenRow[COL.ROLE - 1] = "Kitchen";
    kitchenRow[COL.AMOUNT - 1] = splits.kitchen;
    rowsToWrite.push(kitchenRow);

    const startRow = sheet.getLastRow() + 1;
    const range = sheet.getRange(startRow, 1, rowsToWrite.length, NUM_COLS);
    range.setValues(rowsToWrite);

    // Shade this shift the opposite of the shift above it, so blocks alternate.
    const prevShade = startRow > 2 ? sheet.getRange(startRow - 1, 1).getBackground() : "";
    const newShade = prevShade.toLowerCase() === SHIFT_SHADES[1] ? SHIFT_SHADES[0] : SHIFT_SHADES[1];
    range.setBackground(newShade);

    return jsonResponse({ ok: true, dedup: false, splits: splits, showSplit: getShowSplit() });
  } catch (err) {
    return jsonResponse({ ok: false, retryable: true, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// One-time initializer. Run this once from the Apps Script editor. It sets the
// timezone, CLEARS the ledger (start fresh), writes the v2 header, freezes it,
// and formats the currency columns. Running it also triggers the OAuth consent
// the web app needs.
function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone("America/Los_Angeles");
  const sheet = ss.getSheets()[0];
  sheet.clear();
  const header = [
    "Date", "Time", "Shift", "Entered by", "Recipient", "Role", "Trainee %",
    "Slot", "Time in", "Time out", "Hours", "Amount $", "Total tips", "Submission ID",
  ];
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold");
  sheet.setFrozenRows(1);
  sheet.getRange("L:L").setNumberFormat("$#,##0.00"); // Amount $
  sheet.getRange("M:M").setNumberFormat("$#,##0.00"); // Total tips
  // Fresh start also clears stale (old-shape) pending edit requests.
  const req = ss.getSheetByName("Edit requests");
  if (req) req.clear();
}

// One-time helper: recolors every existing shift in the ledger so the blocks
// alternate white / light gray (grouped by Submission ID). Run once from the
// Apps Script editor; new shifts entered after this are shaded automatically.
function recolorShifts() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheets()[0];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const numRows = lastRow - 1;
  const ids = sheet.getRange(2, COL.SUBMISSION_ID, numRows, 1).getValues();
  const backgrounds = [];
  let prevId = null;
  let shadeIndex = 1; // first shift flips this to 0 (white)
  for (let i = 0; i < numRows; i++) {
    const id = String(ids[i][0] || "");
    if (id !== prevId) { shadeIndex = (shadeIndex + 1) % 2; prevId = id; }
    backgrounds.push(new Array(NUM_COLS).fill(SHIFT_SHADES[shadeIndex]));
  }
  sheet.getRange(2, 1, numRows, NUM_COLS).setBackgrounds(backgrounds);
}

// One-time helper: creates the "Staff" tab that feeds the entry form's name
// dropdowns. Run once, then type each staff member's name down column A.
function setupStaffSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Staff");
  if (!sheet) sheet = ss.insertSheet("Staff", ss.getNumSheets()); // append; keep ledger at index 0
  sheet.getRange(1, 1, 1, 3).setValues([["Name", "Active", "Role"]]).setFontWeight("bold");
  sheet.setFrozenRows(1);
}

// Admin PIN setup: the dashboard reads ADMIN_PIN from Script Properties.
// Set it once via Apps Script editor -> Project Settings -> Script Properties
// (add key ADMIN_PIN). The deployed copy also carries a one-off setAdminPin()
// helper with the value baked in; that helper is intentionally kept out of
// version control so the PIN never lands in this public repo.

// Manual smoke test runnable inside the Apps Script editor.
function _smokeTest(idOverride) {
  resetConfig(); // assertions below assume default slots + 15% kitchen
  const payload = {
    submissionId: idOverride || ("test-" + Date.now()),
    enteredBy: "TEST", shiftType: "dinner", totalTips: 300,
    servers: [
      { name: "Eve", slot: "D1630", trainee: false, pct: null },
      { name: "Fay", slot: "D1800", trainee: false, pct: null },
    ],
    chefs: [{ name: "Cho" }],
  };
  const out = splitShift(payload);
  if (out.kitchen !== 45 || out.chefs[0].amount !== 85 || out.servers[0].amount !== 100 || out.servers[1].amount !== 70) {
    throw new Error("splitShift mirror drift: " + JSON.stringify(out));
  }
  const fakeEvent = { postData: { contents: JSON.stringify(payload) } };
  Logger.log(doPost(fakeEvent).getContent());
}

// Manual: run from the Apps Script editor; reads the Logger output. Restores config at the end.
function _smokeTestConfig() {
  const props = PropertiesService.getScriptProperties();
  const savedSlots = props.getProperty("SLOTS");
  const savedPct = props.getProperty("KITCHEN_PCT");
  try {
    props.deleteProperty("SLOTS"); props.deleteProperty("KITCHEN_PCT");
    if (getKitchenPct() !== 15) throw new Error("default pct should be 15");
    if (getSlots().lunch.length !== 2) throw new Error("default slots fallback failed");
    props.setProperty("SLOTS", "{not json"); // unparseable
    if (getSlots().lunch.length !== 2) throw new Error("unparseable SLOTS should fall back to defaults");
    props.setProperty("SLOTS", JSON.stringify({ lunch: [{ id: "a", timeIn: "11:00", timeOut: "10:00" }], dinner: [{ id: "b", timeIn: "18:00", timeOut: "21:30" }] })); // end<start
    if (getSlots().lunch[0].id !== "L1100") throw new Error("invalid (end<start) SLOTS should fall back to defaults");
    props.setProperty("SLOTS", JSON.stringify({ lunch: [{ timeIn: "11:00", timeOut: "16:30" }], dinner: [{ id: "b", timeIn: "18:00", timeOut: "21:30" }] })); // missing id
    if (getSlots().lunch[0].id !== "L1100") throw new Error("missing-id SLOTS should fall back to defaults");
    if (validateSlots({ lunch: [{ timeIn: "11:00", timeOut: "11:10" }], dinner: [{ timeIn: "18:00", timeOut: "21:30" }] }) === null) throw new Error("sub-30-min slot should be rejected");
    if (validateKitchenPct(15) !== null) throw new Error("15 should be valid");
    if (validateKitchenPct(51) === null) throw new Error("51 should be rejected");
    if (validateSlots({ lunch: [{ timeIn: "11:00", timeOut: "16:30" }], dinner: [{ timeIn: "18:00", timeOut: "21:30" }] }) !== null) throw new Error("valid slots rejected");
    Logger.log("smoke config: OK");
  } finally {
    if (savedSlots == null) props.deleteProperty("SLOTS"); else props.setProperty("SLOTS", savedSlots);
    if (savedPct == null) props.deleteProperty("KITCHEN_PCT"); else props.setProperty("KITCHEN_PCT", savedPct);
    resetConfig();
  }
}
