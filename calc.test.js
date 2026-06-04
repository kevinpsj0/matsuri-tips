// calc.test.js — run with: node calc.test.js
// Tests the pure core in calc.js (Node export). Browser mirror lives in test.html.
const assert = require("assert");
const { splitShift, minutesWorked, getSlot, findSlotByTimes, SHIFT_SLOTS } = require("./calc.js");

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
