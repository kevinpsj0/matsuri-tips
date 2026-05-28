// apps-script.gs - Google Apps Script web app for tip-calc.
// Deploy as: Web app, Execute as: me, Anyone has access.
// Bound to the Google Sheet whose first sheet is the tip ledger with the
// header row defined in docs/superpowers/specs/2026-05-27-tip-calc-design.md.

// Column indices (1-based, A=1)
const COL = {
  DATE: 1, TIME: 2, ENTERED_BY: 3, TOTAL_TIPS: 4, NUM_SERVERS: 5,
  SERVER_NAMES: 6, TRAINEE_NAME: 7, TRAINEE_PCT: 8,
  KITCHEN: 9, CHEFS: 10, PER_SERVER: 11, TRAINEE_AMT: 12,
  SUBMISSION_ID: 13,
};

// MUST match calc.js (splitShift).
function splitShift(input) {
  const T_cents = Math.round(input.totalTips * 100);
  const numServers = input.serverNames.length;
  const trainee = input.trainee;
  const traineeFrac = trainee ? trainee.pct / 100 : 0;
  const totalShares = numServers + traineeFrac;

  const kitchenCents = Math.round(T_cents * 0.10);
  const poolCents = Math.round(T_cents * 0.45);
  const perServerCents = Math.floor(poolCents / totalShares);
  const traineeCents = trainee ? Math.floor(poolCents * traineeFrac / totalShares) : 0;
  const chefsCents = T_cents - kitchenCents - (numServers * perServerCents) - traineeCents;

  const out = {
    kitchen: kitchenCents / 100,
    chefs: chefsCents / 100,
    perServer: perServerCents / 100,
  };
  if (trainee) out.trainee = traineeCents / 100;
  return out;
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function validatePayload(p) {
  if (!p || typeof p !== "object") return "Invalid payload";
  if (typeof p.submissionId !== "string" || !p.submissionId || p.submissionId.length > 64)
    return "Invalid submissionId";
  if (typeof p.enteredBy !== "string" || !p.enteredBy.trim() || p.enteredBy.length > 60)
    return "Invalid enteredBy";
  if (typeof p.totalTips !== "number" || !isFinite(p.totalTips) || p.totalTips < 1 || p.totalTips > 100000)
    return "totalTips must be between 1 and 100000";
  if (!Array.isArray(p.serverNames) || p.serverNames.length < 1 || p.serverNames.length > 6)
    return "serverNames must have 1-6 entries";
  for (const n of p.serverNames) {
    if (typeof n !== "string" || !n.trim() || n.length > 40) return "Invalid server name";
  }
  if (p.trainee !== null && p.trainee !== undefined) {
    if (typeof p.trainee !== "object") return "Invalid trainee";
    if (typeof p.trainee.name !== "string" || !p.trainee.name.trim() || p.trainee.name.length > 40)
      return "Invalid trainee name";
    if (p.trainee.pct !== 25 && p.trainee.pct !== 50 && p.trainee.pct !== 75)
      return "trainee.pct must be 25, 50, or 75";
  }
  return null;
}

function findRowBySubmissionId(sheet, submissionId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2, COL.SUBMISSION_ID, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === submissionId) return i + 2;
  }
  return -1;
}

function dedupResponseFromRow(sheet, rowIndex) {
  const row = sheet.getRange(rowIndex, 1, 1, COL.SUBMISSION_ID).getValues()[0];
  const splits = {
    kitchen: Number(row[COL.KITCHEN - 1]),
    chefs: Number(row[COL.CHEFS - 1]),
    perServer: Number(row[COL.PER_SERVER - 1]),
  };
  const traineeAmt = row[COL.TRAINEE_AMT - 1];
  if (traineeAmt !== "" && traineeAmt !== null && traineeAmt !== undefined) {
    splits.trainee = Number(traineeAmt);
  }
  return { ok: true, dedup: true, splits: splits };
}

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (parseErr) {
    return jsonResponse({ ok: false, retryable: false, error: "Invalid JSON" });
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
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

    const existingRow = findRowBySubmissionId(sheet, payload.submissionId);
    if (existingRow > 0) {
      return jsonResponse(dedupResponseFromRow(sheet, existingRow));
    }

    const splits = splitShift(payload);

    const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    const now = new Date();
    const dateStr = Utilities.formatDate(now, tz, "yyyy-MM-dd");
    const timeStr = Utilities.formatDate(now, tz, "HH:mm");

    const row = new Array(COL.SUBMISSION_ID).fill("");
    row[COL.DATE - 1] = dateStr;
    row[COL.TIME - 1] = timeStr;
    row[COL.ENTERED_BY - 1] = payload.enteredBy.trim();
    row[COL.TOTAL_TIPS - 1] = payload.totalTips;
    row[COL.NUM_SERVERS - 1] = payload.serverNames.length;
    row[COL.SERVER_NAMES - 1] = payload.serverNames.map(n => n.trim()).join(", ");
    row[COL.TRAINEE_NAME - 1] = payload.trainee ? payload.trainee.name.trim() : "";
    row[COL.TRAINEE_PCT - 1] = payload.trainee ? payload.trainee.pct : "";
    row[COL.KITCHEN - 1] = splits.kitchen;
    row[COL.CHEFS - 1] = splits.chefs;
    row[COL.PER_SERVER - 1] = splits.perServer;
    row[COL.TRAINEE_AMT - 1] = (splits.trainee != null) ? splits.trainee : "";
    row[COL.SUBMISSION_ID - 1] = payload.submissionId;

    sheet.appendRow(row);

    return jsonResponse({ ok: true, dedup: false, splits: splits });
  } catch (err) {
    return jsonResponse({ ok: false, retryable: true, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// One-time initializer. Run this once from the Apps Script editor: it sets the
// spreadsheet timezone, writes the header row, freezes it, and formats the
// currency columns. Running it also triggers the OAuth consent the web app needs.
function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone("America/Los_Angeles");
  const sheet = ss.getSheets()[0];
  const header = [
    "Date", "Time", "Entered by", "Total tips", "# of full servers",
    "Server names", "Trainee name", "Trainee %", "Kitchen $", "Chefs $",
    "Per-server $", "Trainee $", "Submission ID",
  ];
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold");
  sheet.setFrozenRows(1);
  sheet.getRange("D:D").setNumberFormat("$#,##0.00");
  sheet.getRange("I:L").setNumberFormat("$#,##0.00");
}

// Manual smoke test runnable inside the Apps Script editor.
// Pass an explicit submissionId string to exercise the dedup path:
//   _smokeTest()              -> fresh ID, writes a row
//   _smokeTest("dedup-test")  -> fixed ID; running twice exercises dedup
function _smokeTest(idOverride) {
  const payload = {
    submissionId: idOverride || ("test-" + Date.now()),
    enteredBy: "TEST",
    totalTips: 1000,
    serverNames: ["Alice", "Bob"],
    trainee: { name: "Charlie", pct: 50 },
  };
  const fakeEvent = { postData: { contents: JSON.stringify(payload) } };
  const resp = doPost(fakeEvent);
  Logger.log(resp.getContent());
}
