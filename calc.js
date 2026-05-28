// calc.js — pure tip-split calculation.
// MUST match the algorithm in apps-script.gs (splitShift function).
// Inputs are validated by the caller. This function does NO validation.

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

if (typeof window !== "undefined") window.splitShift = splitShift;
