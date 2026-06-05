// calc.js — shift definitions, slot lookup, and pure tip-split calculation.
// The block between the VERBATIM MIRROR markers MUST match the mirrored copy in
// apps-script.gs byte-for-byte (DEFAULT_SLOTS / SHIFT_SLOTS / configure /
// resetConfig / getSlot / findSlotByTimes / firstDuplicateName / minutesWorked /
// slotLabel / splitShift). splitShift does NO validation; the caller validates.
// calc.js must stay a classic, non-module, non-IIFE script: top-level `var` is
// intentionally a window global so the entry/today pages can read SHIFT_SLOTS.

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
// Aggregate ledger rows into per-person earnings for the admin leaderboard.
// Only Server/Trainee rows count (chefs and the Kitchen fund are excluded).
// activeKeys is a Set of lowercased active staff names; anyone earning who is
// not in it is partitioned into `former`. Returns active/former arrays (each
// ranked by total desc) and a shared `max` for comparable bar widths.
function aggregatePeople(rows, activeKeys) {
  var agg = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.role !== "Server" && r.role !== "Trainee") continue;
    var name = String(r.recipient || "").trim();
    var key = name.toLowerCase();
    if (!key) continue;
    if (!agg[key]) agg[key] = { key: key, total: 0, hours: 0, shifts: {}, names: {}, traineePct: null, rows: [] };
    var a = agg[key];
    a.total += r.amount || 0;
    a.hours += r.hours || 0;
    if (r.submissionId) a.shifts[r.submissionId] = true;
    a.names[name] = (a.names[name] || 0) + 1;
    if (r.role === "Trainee" && r.traineePct != null) a.traineePct = r.traineePct;
    a.rows.push(r);
  }
  var people = Object.keys(agg).map(function (k) {
    var a = agg[k];
    var display = Object.keys(a.names).sort(function (x, y) { return a.names[y] - a.names[x]; })[0];
    return {
      key: a.key, display: display, total: a.total, hours: a.hours,
      shifts: Object.keys(a.shifts).length, traineePct: a.traineePct,
      rows: a.rows, isFormer: !activeKeys.has(a.key),
    };
  });
  var byTotal = function (x, y) { return y.total - x.total; };
  var active = people.filter(function (p) { return !p.isFormer; }).sort(byTotal);
  var former = people.filter(function (p) { return p.isFormer; }).sort(byTotal);
  var max = people.reduce(function (m, p) { return p.total > m ? p.total : m; }, 1);
  return { active: active, former: former, max: max };
}

// --- END VERBATIM MIRROR ---

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
  window.aggregatePeople = aggregatePeople;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { SHIFT_SLOTS: SHIFT_SLOTS, DEFAULT_SLOTS: DEFAULT_SLOTS, DEFAULT_KITCHEN_PCT: DEFAULT_KITCHEN_PCT, getSlot: getSlot, findSlotByTimes: findSlotByTimes, firstDuplicateName: firstDuplicateName, splitShift: splitShift, minutesWorked: minutesWorked, slotLabel: slotLabel, configure: configure, resetConfig: resetConfig, aggregatePeople: aggregatePeople };
}
