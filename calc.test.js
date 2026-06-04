// calc.test.js — run with: node calc.test.js
// Tests the pure core in calc.js (Node export). Browser mirror lives in test.html.
const assert = require("assert");
const { splitShift, minutesWorked, getSlot, findSlotByTimes, SHIFT_SLOTS, firstDuplicateName } = require("./calc.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "\n      " + e.message); }
}
function sum(out) {
  return out.kitchen
    + out.chefs.reduce((s, c) => s + c.amount, 0)
    + out.servers.reduce((s, p) => s + p.amount, 0);
}
const srv = (name, slot, opts = {}) => ({ name, slot, trainee: !!opts.trainee, pct: opts.trainee ? opts.pct : null });

test("lunch worked example: $400, 2 servers (L1100 5.5h, L1200 4.5h), 2 chefs", () => {
  const out = splitShift({
    shiftType: "lunch", totalTips: 400,
    servers: [srv("Alice", "L1100"), srv("Bob", "L1200")],
    chefs: [{ name: "Cho" }, { name: "Dan" }],
  });
  assert.strictEqual(out.kitchen, 60);
  assert.deepStrictEqual(out.chefs, [{ name: "Cho", amount: 85 }, { name: "Dan", amount: 85 }]);
  assert.strictEqual(out.servers[0].amount, 93.5);
  assert.strictEqual(out.servers[1].amount, 76.5);
  assert.strictEqual(out.servers[0].hours, 5.5);
  assert.strictEqual(out.servers[1].hours, 4.5);
  assert.strictEqual(Math.round(sum(out) * 100), 40000);
});

test("dinner worked example: $300, 2 servers (D1630 5h, D1800 3.5h), 1 chef", () => {
  const out = splitShift({
    shiftType: "dinner", totalTips: 300,
    servers: [srv("Eve", "D1630"), srv("Fay", "D1800")],
    chefs: [{ name: "Cho" }],
  });
  assert.strictEqual(out.kitchen, 45);
  assert.deepStrictEqual(out.chefs, [{ name: "Cho", amount: 85 }]);
  assert.strictEqual(out.servers[0].amount, 100);
  assert.strictEqual(out.servers[1].amount, 70);
  assert.strictEqual(Math.round(sum(out) * 100), 30000);
});

test("no chefs: servers take all 85% (lunch)", () => {
  const out = splitShift({ shiftType: "lunch", totalTips: 200, servers: [srv("A", "L1100"), srv("B", "L1100")], chefs: [] });
  assert.deepStrictEqual(out.chefs, []);
  assert.strictEqual(out.kitchen, 30);                 // round(20000*.15)=3000
  assert.strictEqual(out.servers[0].amount + out.servers[1].amount, 170); // pool 17000
  assert.strictEqual(Math.round(sum(out) * 100), 20000);
});

test("no chefs: servers take all 85% (dinner)", () => {
  const out = splitShift({ shiftType: "dinner", totalTips: 200, servers: [srv("A", "D1630")], chefs: [] });
  assert.deepStrictEqual(out.chefs, []);
  assert.strictEqual(out.servers[0].amount, 170);
  assert.strictEqual(Math.round(sum(out) * 100), 20000);
});

test("single server, no chefs", () => {
  const out = splitShift({ shiftType: "dinner", totalTips: 100, servers: [srv("Solo", "D1800")], chefs: [] });
  assert.strictEqual(out.kitchen, 15);
  assert.strictEqual(out.servers[0].amount, 85);
  assert.strictEqual(Math.round(sum(out) * 100), 10000);
});

test("trainee weighted down inside server pool, still a full dinner head", () => {
  // dinner, 2 servers (1 trainee@50) + 1 chef. Heads: chef 1/3, servers 2/3.
  const out = splitShift({
    shiftType: "dinner", totalTips: 300,
    servers: [srv("Full", "D1630"), srv("Trn", "D1630", { trainee: true, pct: 50 })],
    chefs: [{ name: "Cho" }],
  });
  // pool 25500; chefPool round(25500*1/3)=8500; serverPool 17000.
  // weights: 300*100=30000, 300*50=15000; total 45000.
  // floor(17000*30000/45000)=11333, floor(17000*15000/45000)=5666; rem 1 -> to higher weight (Full).
  assert.strictEqual(out.chefs[0].amount, 85);
  assert.strictEqual(out.servers[0].amount, 113.34);
  assert.strictEqual(out.servers[1].amount, 56.66);
  assert.strictEqual(Math.round(sum(out) * 100), 30000);
});

test("equal chef split with odd cents: 3 chefs", () => {
  // lunch $100.07, 1 server + 3 chefs. T=10007, kitchen=round(1501.05)=1501, pool=8506.
  // lunch chefPool=round(4253)=4253; serverPool=4253. chefs base=floor(4253/3)=1417, rem 2 -> 1418,1418,1417.
  const out = splitShift({ shiftType: "lunch", totalTips: 100.07, servers: [srv("A", "L1100")], chefs: [{ name: "C1" }, { name: "C2" }, { name: "C3" }] });
  assert.strictEqual(out.kitchen, 15.01);
  assert.deepStrictEqual(out.chefs.map(c => c.amount), [14.18, 14.18, 14.17]);
  assert.strictEqual(out.servers[0].amount, 42.53);
  assert.strictEqual(Math.round(sum(out) * 100), 10007);
});

test("sum invariant across totals/mixes", () => {
  const cases = [
    { shiftType: "lunch", totalTips: 1, servers: [srv("A", "L1100")], chefs: [] },
    { shiftType: "dinner", totalTips: 7.77, servers: [srv("A", "D1530"), srv("B", "D1800")], chefs: [{ name: "C" }] },
    { shiftType: "lunch", totalTips: 12345.67, servers: [srv("A", "L1100"), srv("B", "L1200")], chefs: [{ name: "C" }, { name: "D" }, { name: "E" }] },
    { shiftType: "dinner", totalTips: 333.33, servers: [srv("A", "D1630"), srv("T", "D1730", { trainee: true, pct: 25 })], chefs: [{ name: "C" }] },
  ];
  for (const c of cases) assert.strictEqual(Math.round(sum(splitShift(c)) * 100), Math.round(c.totalTips * 100), `total $${c.totalTips}`);
});

test("slot helpers: getSlot + findSlotByTimes round-trip", () => {
  assert.strictEqual(getSlot("lunch", "L1100").timeOut, "16:30");
  assert.strictEqual(getSlot("dinner", "NOPE"), null);
  assert.strictEqual(findSlotByTimes("dinner", "16:30", "21:30").id, "D1630");
  assert.strictEqual(findSlotByTimes("lunch", "00:00", "01:00"), null);
});

test("firstDuplicateName: all unique -> null", () => {
  assert.strictEqual(firstDuplicateName(["Eve", "Fay", "Cho"]), null);
});

test("firstDuplicateName: case-insensitive dup returns the display name", () => {
  assert.strictEqual(firstDuplicateName(["Eve", "eve"]), "eve");
});

test("firstDuplicateName: trims whitespace before comparing", () => {
  assert.strictEqual(firstDuplicateName([" Eve ", "eve"]), "eve");
});

test("firstDuplicateName: ignores empty/whitespace-only names", () => {
  assert.strictEqual(firstDuplicateName(["", "  ", "Eve"]), null);
});

test("firstDuplicateName: returns the first repeated name when several repeat", () => {
  assert.strictEqual(firstDuplicateName(["A", "B", "A", "B"]), "A");
});

test("firstDuplicateName: empty list -> null", () => {
  assert.strictEqual(firstDuplicateName([]), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
