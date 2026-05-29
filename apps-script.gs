// apps-script.gs - Google Apps Script web app for tip-calc (v2, time-based split).
// Deploy as: Web app, Execute as: me, Anyone has access.
// Bound to the Google Sheet whose first sheet is the tip ledger (one row per
// recipient per shift). Header/layout defined in
// docs/superpowers/specs/2026-05-29-time-based-split-design.md.

// Column indices (1-based, A=1)
const COL = {
  DATE: 1, TIME: 2, ENTERED_BY: 3, RECIPIENT: 4, ROLE: 5, TRAINEE_PCT: 6,
  TIME_IN: 7, TIME_OUT: 8, HOURS: 9, AMOUNT: 10, TOTAL_TIPS: 11, SUBMISSION_ID: 12,
};
const NUM_COLS = COL.SUBMISSION_ID;

// MUST match calc.js (minutesWorked / splitShift).
function minutesWorked(timeIn, timeOut) {
  const ip = timeIn.split(":");
  const op = timeOut.split(":");
  return (Number(op[0]) * 60 + Number(op[1])) - (Number(ip[0]) * 60 + Number(ip[1]));
}

function splitShift(input) {
  const T_cents = Math.round(input.totalTips * 100);
  const kitchenCents = Math.round(T_cents * 0.10);
  const poolCents = Math.round(T_cents * 0.45);

  const enriched = input.people.map(function (p) {
    const minutes = minutesWorked(p.timeIn, p.timeOut);
    const rate = p.trainee ? p.pct : 100;
    return { name: p.name, trainee: !!p.trainee, pct: p.trainee ? p.pct : null, minutes: minutes, weight: minutes * rate };
  });
  const totalWeight = enriched.reduce(function (s, p) { return s + p.weight; }, 0);

  let distributed = 0;
  const people = enriched.map(function (p) {
    const cents = totalWeight > 0 ? Math.floor(poolCents * p.weight / totalWeight) : 0;
    distributed += cents;
    return { name: p.name, trainee: p.trainee, pct: p.pct, hours: Math.round(p.minutes / 60 * 100) / 100, amount: cents / 100 };
  });
  const chefsCents = T_cents - kitchenCents - distributed;

  return { kitchen: kitchenCents / 100, chefs: chefsCents / 100, people: people };
}

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
  if (typeof p.submissionId !== "string" || !p.submissionId || p.submissionId.length > 64)
    return "Invalid submissionId";
  if (typeof p.enteredBy !== "string" || !p.enteredBy.trim() || p.enteredBy.length > 60)
    return "Invalid enteredBy";
  if (typeof p.totalTips !== "number" || !isFinite(p.totalTips) || p.totalTips < 1 || p.totalTips > 100000)
    return "totalTips must be between 1 and 100000";
  if (!Array.isArray(p.people) || p.people.length < 1 || p.people.length > 12)
    return "people must have 1-12 entries";
  for (const person of p.people) {
    if (!person || typeof person !== "object") return "Invalid person";
    if (typeof person.name !== "string" || !person.name.trim() || person.name.length > 40)
      return "Invalid person name";
    if (!isValidTime(person.timeIn) || !isValidTime(person.timeOut))
      return "Invalid time (use HH:MM)";
    if (minutesWorked(person.timeIn, person.timeOut) <= 0)
      return "Clock-out must be after clock-in for " + person.name.trim();
    if (person.trainee && person.pct !== 25 && person.pct !== 50 && person.pct !== 75)
      return "Trainee level must be 25, 50, or 75";
  }
  return null;
}

function findRowsBySubmissionId(sheet, submissionId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const data = sheet.getRange(2, 1, lastRow - 1, NUM_COLS).getValues();
  return data.filter(function (row) { return row[COL.SUBMISSION_ID - 1] === submissionId; });
}

function splitsFromRows(rows) {
  const splits = { kitchen: 0, chefs: 0, people: [] };
  for (const row of rows) {
    const role = String(row[COL.ROLE - 1]);
    const amount = Number(row[COL.AMOUNT - 1]) || 0;
    if (role === "Kitchen") splits.kitchen = amount;
    else if (role === "Chefs") splits.chefs = amount;
    else {
      splits.people.push({
        name: String(row[COL.RECIPIENT - 1] || ""),
        trainee: role === "Trainee",
        pct: row[COL.TRAINEE_PCT - 1] === "" ? null : Number(row[COL.TRAINEE_PCT - 1]),
        hours: Number(row[COL.HOURS - 1]) || 0,
        amount: amount,
      });
    }
  }
  return splits;
}

// Read path for the entry form's name dropdowns. Returns the roster from the
// "Staff" tab (column A, below the header). No PIN: names are not sensitive and
// the public entry form needs them.
function handleFetchStaff() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Staff");
  if (!sheet) return jsonResponse({ ok: true, staff: [] });
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonResponse({ ok: true, staff: [] });

  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const seen = {};
  const staff = [];
  for (const row of values) {
    const name = String(row[0] || "").trim();
    const key = name.toLowerCase();
    if (name && !seen[key]) { seen[key] = true; staff.push(name); }
  }
  return jsonResponse({ ok: true, staff: staff });
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
  if (lastRow < 2) return jsonResponse({ ok: true, rows: [] });

  const tz = ss.getSpreadsheetTimeZone();
  const asDateStr = (v) => (v instanceof Date) ? Utilities.formatDate(v, tz, "yyyy-MM-dd") : String(v || "");
  const asTimeStr = (v) => (v instanceof Date) ? Utilities.formatDate(v, tz, "HH:mm") : String(v || "");
  const numOrNull = (v) => (v === "" || v === null || v === undefined) ? null : Number(v);

  const values = sheet.getRange(2, 1, lastRow - 1, NUM_COLS).getValues();
  const rows = values.map((r) => ({
    date: asDateStr(r[COL.DATE - 1]),
    time: asTimeStr(r[COL.TIME - 1]),
    enteredBy: String(r[COL.ENTERED_BY - 1] || ""),
    recipient: String(r[COL.RECIPIENT - 1] || ""),
    role: String(r[COL.ROLE - 1] || ""),
    traineePct: numOrNull(r[COL.TRAINEE_PCT - 1]),
    timeIn: asTimeStr(r[COL.TIME_IN - 1]),
    timeOut: asTimeStr(r[COL.TIME_OUT - 1]),
    hours: Number(r[COL.HOURS - 1]) || 0,
    amount: Number(r[COL.AMOUNT - 1]) || 0,
    totalTips: Number(r[COL.TOTAL_TIPS - 1]) || 0,
    submissionId: String(r[COL.SUBMISSION_ID - 1] || ""),
  }));
  return jsonResponse({ ok: true, rows: rows });
}

// Read path for the staff verification page (today.html). Returns just
// today's rows, no PIN. Same trust model as the entry form: anyone with
// the URL can read today's shifts.
function handleFetchToday() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheets()[0];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonResponse({ ok: true, rows: [] });

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
      enteredBy: String(r[COL.ENTERED_BY - 1] || ""),
      recipient: String(r[COL.RECIPIENT - 1] || ""),
      role: String(r[COL.ROLE - 1] || ""),
      traineePct: numOrNull(r[COL.TRAINEE_PCT - 1]),
      timeIn: asTimeStr(r[COL.TIME_IN - 1]),
      timeOut: asTimeStr(r[COL.TIME_OUT - 1]),
      hours: Number(r[COL.HOURS - 1]) || 0,
      amount: Number(r[COL.AMOUNT - 1]) || 0,
      totalTips: Number(r[COL.TOTAL_TIPS - 1]) || 0,
      submissionId: String(r[COL.SUBMISSION_ID - 1] || ""),
    });
  }
  return jsonResponse({ ok: true, rows: rows });
}

// Write path for the staff verification page: logs a request-to-edit to the
// "Edit requests" tab (created on demand) so the owner can review and fix.
function handleRequestEdit(payload) {
  if (!payload || typeof payload !== "object") return jsonResponse({ ok: false, error: "Invalid request" });
  const sid = typeof payload.submissionId === "string" ? payload.submissionId.trim() : "";
  const by = typeof payload.requestedBy === "string" ? payload.requestedBy.trim() : "";
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  if (!sid || sid.length > 64) return jsonResponse({ ok: false, error: "Invalid submissionId" });
  if (!by || by.length > 60) return jsonResponse({ ok: false, error: "Please enter your name" });
  if (!reason || reason.length > 500) return jsonResponse({ ok: false, error: "Please describe the issue (up to 500 chars)" });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Edit requests");
  if (!sheet) {
    sheet = ss.insertSheet("Edit requests", ss.getNumSheets()); // append; keep ledger at index 0
    sheet.getRange(1, 1, 1, 6).setValues([["Requested at", "Requested by", "Shift submission ID", "Shift date", "Shift time", "Reason"]]).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }

  const tz = ss.getSpreadsheetTimeZone();
  let shiftDate = "", shiftTime = "";
  const ledger = ss.getSheets()[0];
  const lastRow = ledger.getLastRow();
  if (lastRow >= 2) {
    const vals = ledger.getRange(2, 1, lastRow - 1, NUM_COLS).getValues();
    for (const r of vals) {
      if (r[COL.SUBMISSION_ID - 1] === sid) {
        const d = r[COL.DATE - 1], t = r[COL.TIME - 1];
        shiftDate = (d instanceof Date) ? Utilities.formatDate(d, tz, "yyyy-MM-dd") : String(d || "");
        shiftTime = (t instanceof Date) ? Utilities.formatDate(t, tz, "HH:mm") : String(t || "");
        break;
      }
    }
  }
  const now = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm");
  sheet.appendRow([now, by, sid, shiftDate, shiftTime, reason]);
  return jsonResponse({ ok: true });
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
  if (payload && payload.action === "fetchStaff") {
    return handleFetchStaff();
  }
  if (payload && payload.action === "fetchToday") {
    return handleFetchToday();
  }
  if (payload && payload.action === "requestEdit") {
    return handleRequestEdit(payload);
  }

  const validationError = validatePayload(payload);
  if (validationError) {
    return jsonResponse({ ok: false, retryable: false, error: validationError });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return jsonResponse({ ok: false, retryable: true, error: "Sheet busy, please try again." });
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheets()[0];

    const existing = findRowsBySubmissionId(sheet, payload.submissionId);
    if (existing.length) {
      return jsonResponse({ ok: true, dedup: true, splits: splitsFromRows(existing) });
    }

    const splits = splitShift(payload);

    const tz = ss.getSpreadsheetTimeZone();
    const now = new Date();
    const dateStr = Utilities.formatDate(now, tz, "yyyy-MM-dd");
    const timeStr = Utilities.formatDate(now, tz, "HH:mm");
    const enteredBy = payload.enteredBy.trim();

    const rowsToWrite = [];

    function baseRow() {
      const row = new Array(NUM_COLS).fill("");
      row[COL.DATE - 1] = dateStr;
      row[COL.TIME - 1] = timeStr;
      row[COL.ENTERED_BY - 1] = enteredBy;
      row[COL.TOTAL_TIPS - 1] = payload.totalTips;
      row[COL.SUBMISSION_ID - 1] = payload.submissionId;
      return row;
    }

    for (let i = 0; i < splits.people.length; i++) {
      const sp = splits.people[i];
      const pp = payload.people[i];
      const row = baseRow();
      row[COL.RECIPIENT - 1] = pp.name.trim();
      row[COL.ROLE - 1] = sp.trainee ? "Trainee" : "Server";
      row[COL.TRAINEE_PCT - 1] = sp.trainee ? sp.pct : "";
      row[COL.TIME_IN - 1] = pp.timeIn;
      row[COL.TIME_OUT - 1] = pp.timeOut;
      row[COL.HOURS - 1] = sp.hours;
      row[COL.AMOUNT - 1] = sp.amount;
      rowsToWrite.push(row);
    }

    const kitchenRow = baseRow();
    kitchenRow[COL.RECIPIENT - 1] = "Kitchen";
    kitchenRow[COL.ROLE - 1] = "Kitchen";
    kitchenRow[COL.AMOUNT - 1] = splits.kitchen;
    rowsToWrite.push(kitchenRow);

    const chefsRow = baseRow();
    chefsRow[COL.RECIPIENT - 1] = "Chefs";
    chefsRow[COL.ROLE - 1] = "Chefs";
    chefsRow[COL.AMOUNT - 1] = splits.chefs;
    rowsToWrite.push(chefsRow);

    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rowsToWrite.length, NUM_COLS).setValues(rowsToWrite);

    return jsonResponse({ ok: true, dedup: false, splits: splits });
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
    "Date", "Time", "Entered by", "Recipient", "Role", "Trainee %",
    "Time in", "Time out", "Hours", "Amount $", "Total tips", "Submission ID",
  ];
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold");
  sheet.setFrozenRows(1);
  sheet.getRange("J:J").setNumberFormat("$#,##0.00"); // Amount $
  sheet.getRange("K:K").setNumberFormat("$#,##0.00"); // Total tips
}

// One-time helper: creates the "Staff" tab that feeds the entry form's name
// dropdowns. Run once, then type each staff member's name down column A.
function setupStaffSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Staff");
  if (!sheet) sheet = ss.insertSheet("Staff", ss.getNumSheets()); // append; keep ledger at index 0
  sheet.getRange(1, 1).setValue("Staff name").setFontWeight("bold");
  sheet.setFrozenRows(1);
}

// Admin PIN setup: the dashboard reads ADMIN_PIN from Script Properties.
// Set it once via Apps Script editor -> Project Settings -> Script Properties
// (add key ADMIN_PIN). The deployed copy also carries a one-off setAdminPin()
// helper with the value baked in; that helper is intentionally kept out of
// version control so the PIN never lands in this public repo.

// Manual smoke test runnable inside the Apps Script editor.
function _smokeTest(idOverride) {
  const payload = {
    submissionId: idOverride || ("test-" + Date.now()),
    enteredBy: "TEST",
    totalTips: 400,
    people: [
      { name: "Alice", timeIn: "10:00", timeOut: "16:00", trainee: false },
      { name: "Bob", timeIn: "13:00", timeOut: "16:00", trainee: false },
      { name: "Charlie", timeIn: "12:00", timeOut: "16:00", trainee: true, pct: 50 },
    ],
  };
  const fakeEvent = { postData: { contents: JSON.stringify(payload) } };
  Logger.log(doPost(fakeEvent).getContent());
}
