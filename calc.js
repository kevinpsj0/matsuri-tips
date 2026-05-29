// calc.js — pure tip-split calculation.
// MUST match the algorithm in apps-script.gs (splitShift / minutesWorked).
// Inputs are validated by the caller. This function does NO validation.

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
    return {
      name: p.name,
      trainee: p.trainee,
      pct: p.pct,
      hours: Math.round(p.minutes / 60 * 100) / 100,
      amount: cents / 100,
    };
  });
  const chefsCents = T_cents - kitchenCents - distributed;

  return { kitchen: kitchenCents / 100, chefs: chefsCents / 100, people: people };
}

if (typeof window !== "undefined") {
  window.splitShift = splitShift;
  window.minutesWorked = minutesWorked;
}
