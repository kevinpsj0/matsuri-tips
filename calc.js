// calc.js — shift definitions, slot lookup, and pure tip-split calculation.
// MUST match the mirrored copy in apps-script.gs (SHIFT_SLOTS / minutesWorked / splitShift).
// splitShift does NO validation; the caller validates.

var SHIFT_SLOTS = {
  lunch: [
    { id: "L1100", label: "11 – 4:30", timeIn: "11:00", timeOut: "16:30" },
    { id: "L1200", label: "12 – 4:30", timeIn: "12:00", timeOut: "16:30" },
  ],
  dinner: [
    { id: "D1530", label: "3:30 – close", timeIn: "15:30", timeOut: "21:30" },
    { id: "D1630", label: "4:30 – close", timeIn: "16:30", timeOut: "21:30" },
    { id: "D1730", label: "5:30 – close", timeIn: "17:30", timeOut: "21:30" },
    { id: "D1800", label: "6 – close",    timeIn: "18:00", timeOut: "21:30" },
  ],
};

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

function getSlotByLabel(shiftType, label) {
  var slots = SHIFT_SLOTS[shiftType];
  if (!slots) return null;
  for (var i = 0; i < slots.length; i++) if (slots[i].label === label) return slots[i];
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

function splitShift(input) {
  var T = Math.round(input.totalTips * 100);
  var kitchenCents = Math.round(T * 0.15);
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
      slot: slot ? slot.id : p.slot, slotLabel: slot ? slot.label : "",
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

if (typeof window !== "undefined") {
  window.SHIFT_SLOTS = SHIFT_SLOTS;
  window.getSlot = getSlot;
  window.findSlotByTimes = findSlotByTimes;
  window.getSlotByLabel = getSlotByLabel;
  window.firstDuplicateName = firstDuplicateName;
  window.splitShift = splitShift;
  window.minutesWorked = minutesWorked;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { SHIFT_SLOTS: SHIFT_SLOTS, getSlot: getSlot, findSlotByTimes: findSlotByTimes, getSlotByLabel: getSlotByLabel, firstDuplicateName: firstDuplicateName, splitShift: splitShift, minutesWorked: minutesWorked };
}
