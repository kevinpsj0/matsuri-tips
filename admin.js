// Matsuri Tips Admin dashboard. View-only; reads the tip ledger through the
// same Apps Script endpoint the entry app posts to, gated by a server-checked PIN.

const ENDPOINT_URL = "https://script.google.com/macros/s/AKfycbyvxUBapgpbZpf-ndoexuH2ZjWIwO5bIzH26F-OeWmEcQY4QqbeFXs2lvRTarhlaFtHtQ/exec";
const PIN_KEY = "matsuri_admin_pin";
const TZ = "America/Los_Angeles";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const fmt = (n) => money.format(n || 0);

let sessionPin = "";
let allRows = [];
let period = "today";
let activeTab = "summary";
let calMonth = null; // { y, m } 1-based month
let calDay = null;   // ISO date when drilled into a single day, else null

// ---- date helpers (operate on yyyy-mm-dd strings; ISO sorts lexically) ----
function todayISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function isoParts(iso) { const [y, m, d] = iso.split("-").map(Number); return { y, m, d }; }
function toISO(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function isoWeekday(iso) { const { y, m, d } = isoParts(iso); return new Date(y, m - 1, d).getDay(); }
function addDays(iso, n) { const { y, m, d } = isoParts(iso); const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + n); return toISO(dt); }
function lastDayOfMonth(y, m) { return new Date(y, m, 0).getDate(); }
function enumerateDays(start, end) {
  const out = [];
  let cur = start;
  let guard = 0;
  while (cur <= end && guard < 1000) { out.push(cur); cur = addDays(cur, 1); guard++; }
  return out;
}

function currentRange() {
  const today = todayISO();
  if (period === "today") return { start: today, end: today };
  if (period === "week") { const start = addDays(today, -isoWeekday(today)); return { start, end: addDays(start, 6) }; }
  if (period === "month") { const { y, m } = isoParts(today); return { start: `${y}-${String(m).padStart(2, "0")}-01`, end: `${y}-${String(m).padStart(2, "0")}-${String(lastDayOfMonth(y, m)).padStart(2, "0")}` }; }
  // custom
  const s = document.getElementById("custom-start").value;
  const e = document.getElementById("custom-end").value;
  if (!s || !e) return { start: today, end: today };
  return s <= e ? { start: s, end: e } : { start: e, end: s };
}

function rowsInRange(start, end) {
  return allRows.filter((r) => r.date && r.date >= start && r.date <= end);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- network ----
async function fetchData(pin) {
  const res = await fetch(ENDPOINT_URL, {
    method: "POST",
    mode: "cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: "fetchData", pin }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

// ---- gate ----
const gateEl = document.getElementById("gate");
const appEl = document.getElementById("app");
const pinInput = document.getElementById("pin-input");
const pinSubmit = document.getElementById("pin-submit");
const gateErr = document.getElementById("gate-err");

function showGateErr(msg) { gateErr.textContent = msg || ""; }
function setGateBusy(b) { pinSubmit.disabled = b; pinSubmit.textContent = b ? "Checking..." : "Unlock"; }

async function tryPin(pin, silent) {
  if (!pin) { focusPin(); return; }
  setGateBusy(true);
  showGateErr("");
  let data;
  try {
    data = await fetchData(pin);
  } catch (e) {
    setGateBusy(false);
    if (!silent) showGateErr("Could not connect. Check your internet and try again.");
    return;
  }
  setGateBusy(false);
  if (data && data.ok) {
    sessionPin = pin;
    localStorage.setItem(PIN_KEY, pin);
    allRows = data.rows || [];
    gateEl.classList.add("hidden");
    appEl.classList.remove("hidden");
    render();
  } else {
    localStorage.removeItem(PIN_KEY);
    if (!silent) showGateErr((data && data.error) || "Wrong PIN.");
    focusPin();
  }
}

function focusPin() { try { pinInput.focus(); } catch (e) {} }

async function refresh() {
  const view = document.getElementById("view");
  view.innerHTML = `<div class="loading">Loading...</div>`;
  try {
    const data = await fetchData(sessionPin);
    if (data && data.ok) { allRows = data.rows || []; render(); return; }
    if (data && data.error) { signOut(); return; }
  } catch (e) { /* keep existing data */ }
  render();
}

function signOut() {
  localStorage.removeItem(PIN_KEY);
  location.reload();
}

// ---- rendering ----
function render() {
  // period UI is irrelevant on the calendar tab
  const onCal = activeTab === "calendar";
  document.getElementById("periods").classList.toggle("hidden", onCal);
  document.getElementById("custom-range").classList.toggle("show", !onCal && period === "custom");
  document.getElementById("custom-range").classList.toggle("hidden", onCal);
  document.getElementById("range-label").classList.toggle("hidden", onCal);

  document.querySelectorAll("#periods button").forEach((b) => b.classList.toggle("active", b.dataset.period === period));
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === activeTab));

  const view = document.getElementById("view");
  if (onCal) { view.innerHTML = calDay ? renderCalDayDetail(calDay) : renderCalendar(); return; }

  const { start, end } = currentRange();
  const rows = rowsInRange(start, end);
  const shiftCount = new Set(rows.map((r) => r.submissionId)).size;
  const label = start === end ? start : `${start} to ${end}`;
  document.getElementById("range-label").textContent = `${label} · ${shiftCount} shift${shiftCount === 1 ? "" : "s"}`;

  if (activeTab === "summary") view.innerHTML = renderSummary(rows, start, end);
  else if (activeTab === "shifts") view.innerHTML = renderShifts(rows);
  else if (activeTab === "people") view.innerHTML = renderPeople(rows);
}

function renderSummary(rows, start, end) {
  if (!rows.length) return emptyState("No shifts in this period.");
  let total = 0, kitchen = 0, chefs = 0, servers = 0, trainees = 0;
  const staff = new Set();
  const shifts = new Set();
  for (const r of rows) {
    total += r.amount;
    if (r.role === "Kitchen") kitchen += r.amount;
    else if (r.role === "Chefs") chefs += r.amount;
    else if (r.role === "Trainee") { trainees += r.amount; staff.add((r.recipient || "").trim().toLowerCase()); }
    else { servers += r.amount; staff.add((r.recipient || "").trim().toLowerCase()); }
    if (r.submissionId) shifts.add(r.submissionId);
  }
  const cards = `
    <div class="cards">
      <div class="card hero"><div class="k">Total tips</div><div class="v">${fmt(total)}</div></div>
      <div class="card"><div class="k">Kitchen</div><div class="v">${fmt(kitchen)}</div></div>
      <div class="card"><div class="k">Chefs</div><div class="v">${fmt(chefs)}</div></div>
      <div class="card"><div class="k">Servers</div><div class="v">${fmt(servers)}</div></div>
      <div class="card"><div class="k">Trainees</div><div class="v">${fmt(trainees)}</div></div>
      <div class="card"><div class="k">Shifts</div><div class="v">${shifts.size}</div></div>
      <div class="card"><div class="k">Distinct staff</div><div class="v">${staff.size}</div></div>
    </div>`;

  const days = enumerateDays(start, end);
  const byDay = {};
  for (const r of rows) byDay[r.date] = (byDay[r.date] || 0) + r.amount;
  const series = days.map((d) => ({ label: String(isoParts(d).d), value: byDay[d] || 0 }));
  const chart = `<div class="panel"><h2>Daily total tips</h2>${buildBarChart(series)}</div>`;
  return cards + chart;
}

function buildBarChart(series) {
  const W = 600, H = 200, padTop = 14, padBottom = 26, padX = 8;
  const plotH = H - padTop - padBottom;
  const n = series.length;
  if (!n) return `<div class="empty-state">No data.</div>`;
  const max = Math.max(1, ...series.map((s) => s.value));
  const slot = (W - 2 * padX) / n;
  const baseY = padTop + plotH;
  const showLabels = n <= 16;
  let bars = "";
  series.forEach((s, i) => {
    const bw = slot * 0.66;
    const bx = padX + i * slot + (slot - bw) / 2;
    const bh = s.value > 0 ? Math.max(1, (s.value / max) * plotH) : 0;
    const by = baseY - bh;
    bars += `<rect class="bar" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2"><title>${escapeHtml(s.label)}: ${fmt(s.value)}</title></rect>`;
    if (showLabels) bars += `<text x="${(bx + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${escapeHtml(s.label)}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily total tips bar chart">
    <line x1="${padX}" y1="${baseY}" x2="${W - padX}" y2="${baseY}" stroke="#e4e7ee" />
    ${bars}
  </svg>`;
}

function renderCalendar() {
  const { y, m } = calMonth;
  const monthName = new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const byDay = {};
  let maxAmt = 0;
  for (const r of allRows) {
    const p = isoParts(r.date || "");
    if (p.y === y && p.m === m) { byDay[p.d] = (byDay[p.d] || 0) + r.amount; if (byDay[p.d] > maxAmt) maxAmt = byDay[p.d]; }
  }
  const firstDow = new Date(y, m - 1, 1).getDay();
  const days = lastDayOfMonth(y, m);
  const today = todayISO();

  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<div class="cal-dow">${d}</div>`).join("");
  let cells = "";
  for (let i = 0; i < firstDow; i++) cells += `<div class="cal-cell empty"></div>`;
  for (let d = 1; d <= days; d++) {
    const amt = byDay[d] || 0;
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const alpha = maxAmt > 0 && amt > 0 ? (0.18 + 0.62 * (amt / maxAmt)).toFixed(2) : 0;
    const bg = amt > 0 ? `style="background: rgba(214,160,76, ${alpha})"` : "";
    const todayCls = iso === today ? " today" : "";
    const amtTxt = amt > 0 ? `<div class="amt">${amt >= 1000 ? "$" + (amt / 1000).toFixed(1).replace(/\.0$/, "") + "k" : fmt(amt).replace(".00", "")}</div>` : "";
    cells += `<div class="cal-cell${todayCls}" data-day="${iso}"${bg ? " " + bg : ""}><div class="d">${d}</div>${amtTxt}</div>`;
  }
  return `<div class="panel">
    <div class="cal-head">
      <button type="button" id="cal-prev" aria-label="Previous month">&lsaquo;</button>
      <span class="m">${monthName}</span>
      <button type="button" id="cal-next" aria-label="Next month">&rsaquo;</button>
    </div>
    <div class="cal-grid">${dow}${cells}</div>
  </div>`;
}

function renderCalDayDetail(iso) {
  const { y, m, d } = isoParts(iso);
  const title = new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const rows = allRows.filter((r) => r.date === iso);
  const body = rows.length ? shiftCardsHtml(rows) : `<div class="empty-state">No shifts on this day.</div>`;
  return `<div class="cal-head">
      <button type="button" data-cal-back>&lsaquo; Calendar</button>
      <span class="m">${escapeHtml(title)}</span>
      <span class="cal-spacer"></span>
    </div>${body}`;
}

function clockMins(t) {
  if (!t) return null;
  const p = String(t).split(":");
  const h = Number(p[0]), m = Number(p[1]);
  if (!isFinite(h) || !isFinite(m)) return null;
  return h * 60 + m;
}

function fmtClock(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  const ap = h < 12 ? "a" : "p";
  let hh = h % 12; if (hh === 0) hh = 12;
  return hh + (m ? ":" + String(m).padStart(2, "0") : "") + ap;
}

function shiftCardsHtml(rows) {
  const shifts = {};
  for (const r of rows) {
    const id = r.submissionId || (r.date + r.time);
    if (!shifts[id]) shifts[id] = { date: r.date, time: r.time, enteredBy: r.enteredBy, totalTips: r.totalTips, recipients: [] };
    shifts[id].recipients.push(r);
  }
  const list = Object.values(shifts).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  return list.map((sh) => {
    const people = sh.recipients.filter((r) => r.role === "Server" || r.role === "Trainee");
    const fixed = sh.recipients.filter((r) => r.role === "Kitchen" || r.role === "Chefs");
    const timed = people.filter((p) => clockMins(p.timeIn) != null && clockMins(p.timeOut) != null && clockMins(p.timeOut) > clockMins(p.timeIn));

    let axisHtml = "";
    let span = 0, axisMin = 0;
    if (timed.length) {
      axisMin = Math.min.apply(null, timed.map((p) => clockMins(p.timeIn)));
      const axisMax = Math.max.apply(null, timed.map((p) => clockMins(p.timeOut)));
      span = axisMax - axisMin;
      const ticks = [0, 1, 2, 3].map((i) => `<span>${fmtClock(Math.round(axisMin + span * i / 3))}</span>`).join("");
      axisHtml = `<div class="tl-axis"><span class="tl-name"></span><div class="tl-ticks">${ticks}</div><span class="tl-amt"></span></div>`;
    }

    const ordered = people.slice().sort((a, b) => (clockMins(a.timeIn) || 0) - (clockMins(b.timeIn) || 0));
    const rowsHtml = ordered.map((p) => {
      const ci = clockMins(p.timeIn), co = clockMins(p.timeOut);
      const hasBar = ci != null && co != null && co > ci && span > 0;
      const left = hasBar ? ((ci - axisMin) / span * 100) : 0;
      const width = hasBar ? ((co - ci) / span * 100) : 0;
      const cls = p.role === "Trainee" ? "tl-bar trainee" : "tl-bar";
      const pct = (p.role === "Trainee" && p.traineePct != null) ? `<span class="tl-tr">${escapeHtml(String(p.traineePct))}%</span>` : "";
      const title = (p.timeIn && p.timeOut) ? `${escapeHtml(p.timeIn)}–${escapeHtml(p.timeOut)}` : "";
      const track = hasBar
        ? `<div class="tl-track"><div class="${cls}" style="left:${left.toFixed(1)}%;width:${Math.max(width, 2).toFixed(1)}%" title="${title}"></div></div>`
        : `<div class="tl-track"></div>`;
      return `<div class="tl-row"><span class="tl-name" title="${escapeHtml(p.recipient || "")}">${escapeHtml(p.recipient || "?")}${pct}</span>${track}<span class="tl-amt">${fmt(p.amount)}</span></div>`;
    }).join("");

    const fixedSummary = fixed
      .sort((a, b) => (a.role === "Kitchen" ? -1 : 1))
      .map((f) => `${f.role} ${fmt(f.amount)}`).join("  ·  ");

    return `<div class="shift">
      <div class="top">
        <span class="when">${escapeHtml(sh.date)} ${escapeHtml(sh.time)}</span>
        <span class="tot">${fmt(sh.totalTips)}</span>
      </div>
      <div class="by">Entered by ${escapeHtml(sh.enteredBy || "?")}</div>
      ${axisHtml}
      <div class="tl-rows">${rowsHtml}</div>
      ${fixedSummary ? `<div class="tl-fixed">${escapeHtml(fixedSummary)}</div>` : ""}
    </div>`;
  }).join("");
}

function renderShifts(rows) {
  if (!rows.length) return emptyState("No shifts in this period.");
  return `<div>${shiftCardsHtml(rows)}</div>`;
}

function renderPeople(rows) {
  const people = rows.filter((r) => r.role === "Server" || r.role === "Trainee");
  if (!people.length) return emptyState("No staff in this period.");
  const agg = {}; // key -> { total, hours, shifts:Set, names: {display: count} }
  for (const r of people) {
    const name = (r.recipient || "").trim();
    const key = name.toLowerCase();
    if (!key) continue;
    if (!agg[key]) agg[key] = { total: 0, hours: 0, shifts: new Set(), names: {} };
    agg[key].total += r.amount;
    agg[key].hours += r.hours || 0;
    if (r.submissionId) agg[key].shifts.add(r.submissionId);
    agg[key].names[name] = (agg[key].names[name] || 0) + 1;
  }
  const list = Object.values(agg).map((a) => {
    const display = Object.keys(a.names).sort((x, y) => a.names[y] - a.names[x])[0];
    return { display, total: a.total, hours: a.hours, shifts: a.shifts.size };
  }).sort((a, b) => b.total - a.total);

  const body = list.map((p) => `<tr>
      <td>${escapeHtml(p.display)}</td>
      <td class="num">${p.shifts}</td>
      <td class="num">${p.hours.toFixed(1)}</td>
      <td class="num">${fmt(p.total)}</td>
    </tr>`).join("");
  return `<div class="panel"><h2>Earnings by person</h2>
    <table class="people">
      <thead><tr><th>Name</th><th class="num">Shifts</th><th class="num">Hours</th><th class="num">Earned</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function emptyState(msg) { return `<div class="empty-state">${escapeHtml(msg)}</div>`; }

// ---- wiring ----
function wireEvents() {
  pinSubmit.addEventListener("click", () => tryPin(pinInput.value.trim(), false));
  pinInput.addEventListener("keydown", (e) => { if (e.key === "Enter") tryPin(pinInput.value.trim(), false); });

  document.getElementById("refresh-btn").addEventListener("click", refresh);
  document.getElementById("signout-btn").addEventListener("click", signOut);

  document.getElementById("periods").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-period]");
    if (!btn) return;
    period = btn.dataset.period;
    render();
  });
  document.getElementById("custom-start").addEventListener("change", () => { if (period === "custom") render(); });
  document.getElementById("custom-end").addEventListener("change", () => { if (period === "custom") render(); });

  document.getElementById("tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (!btn) return;
    activeTab = btn.dataset.tab;
    calDay = null;
    render();
  });

  // Calendar interactions are delegated on the (persistent) #view container.
  document.getElementById("view").addEventListener("click", (e) => {
    if (e.target.closest("#cal-prev")) { calMonth.m--; if (calMonth.m < 1) { calMonth.m = 12; calMonth.y--; } render(); return; }
    if (e.target.closest("#cal-next")) { calMonth.m++; if (calMonth.m > 12) { calMonth.m = 1; calMonth.y++; } render(); return; }
    if (e.target.closest("[data-cal-back]")) { calDay = null; render(); return; }
    const cell = e.target.closest(".cal-cell[data-day]");
    if (cell) { calDay = cell.getAttribute("data-day"); render(); return; }
  });
}

function init() {
  const t = isoParts(todayISO());
  calMonth = { y: t.y, m: t.m };
  wireEvents();
  const stored = localStorage.getItem(PIN_KEY);
  if (stored) tryPin(stored, true); else focusPin();
}

document.addEventListener("DOMContentLoaded", init);
