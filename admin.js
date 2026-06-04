// Matsuri Tips Admin dashboard. View-only; reads the tip ledger through the
// same Apps Script endpoint the entry app posts to, gated by a server-checked PIN.

const ENDPOINT_URL = "https://script.google.com/macros/s/AKfycbyvxUBapgpbZpf-ndoexuH2ZjWIwO5bIzH26F-OeWmEcQY4QqbeFXs2lvRTarhlaFtHtQ/exec";
const PIN_KEY = "matsuri_admin_pin";
const TZ = "America/Los_Angeles";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const fmt = (n) => money.format(n || 0);

let sessionPin = "";
let allRows = [];
let staffList = []; // [{ name, active }] from handleFetchData
let pendingRequests = [];
let requestsLoadError = "";
// Single mutex shared by every mutating admin action (resolveRequest,
// addStaff, setStaffActive). Prevents overlapping refresh() calls.
let actionBusy = false;
let period = "today";
let activeTab = "summary";
let showSplitConfig = true; // global config mirrored from the backend (Settings tab)

// Date/number formatting locale follows the chosen UI language.
function locale() { return getLang() === "ko" ? "ko-KR" : "en-US"; }
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
  if (period === "yesterday") { const y = addDays(today, -1); return { start: y, end: y }; }
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
const gateChecking = document.getElementById("gate-checking");
const gateForm = document.getElementById("gate-form");

// While a saved PIN is auto-verifying we show a brief "Checking..." line instead
// of the PIN box, so the user doesn't think the app forgot them and re-enter it.
// init() picks the starting state so neither element flashes on load.
function showChecking() { gateForm.classList.add("hidden"); gateChecking.classList.remove("hidden"); }
function showGateForm() { gateChecking.classList.add("hidden"); gateForm.classList.remove("hidden"); }

function showGateErr(msg) { gateErr.textContent = msg || ""; }
function setGateBusy(b) { pinSubmit.disabled = b; pinSubmit.textContent = b ? t("checking") : t("unlock"); }

async function tryPin(pin, silent) {
  if (!pin) { focusPin(); return; }
  setGateBusy(true);
  showGateErr("");
  let data;
  try {
    data = await fetchData(pin);
  } catch (e) {
    setGateBusy(false);
    showGateForm();
    if (!silent) showGateErr(t("could_not_connect"));
    focusPin();
    return;
  }
  setGateBusy(false);
  if (data && data.ok) {
    sessionPin = pin;
    localStorage.setItem(PIN_KEY, pin);
    allRows = data.rows || []; staffList = data.staff || [];
    if (data.config && typeof data.config.showSplit === "boolean") showSplitConfig = data.config.showSplit;
    gateEl.classList.add("hidden");
    appEl.classList.remove("hidden");
    render();
    loadRequests().then(() => { if (activeTab === "requests") render(); });
  } else {
    localStorage.removeItem(PIN_KEY);
    showGateForm();
    if (!silent) showGateErr((data && data.error) || t("wrong_pin"));
    focusPin();
  }
}

async function loadRequests() {
  try {
    const res = await fetch(ENDPOINT_URL, {
      method: "POST", mode: "cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "listRequests", pin: sessionPin }),
    });
    const data = await res.json();
    if (data && data.ok) {
      pendingRequests = data.requests || [];
      requestsLoadError = "";
    } else {
      requestsLoadError = (data && data.error) || t("could_not_load_requests");
    }
  } catch (e) {
    requestsLoadError = t("requests_stale");
  }
  const b = document.getElementById("req-badge");
  if (b) {
    if (pendingRequests.length) { b.textContent = pendingRequests.length; b.classList.add("show"); }
    else { b.textContent = ""; b.classList.remove("show"); }
  }
}

async function addStaff(name, role) {
  if (actionBusy) return;
  name = (name || "").trim();
  if (!name) return;
  actionBusy = true;
  try {
    const res = await fetch(ENDPOINT_URL, {
      method: "POST", mode: "cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "addStaff", pin: sessionPin, name: name, role: role || "Server" }),
    });
    const data = await res.json();
    if (!data || !data.ok) { window.alert((data && data.error) || t("could_not_add")); return; }
    await refresh();
  } catch (e) {
    window.alert(t("network_retry"));
  } finally { actionBusy = false; }
}

async function setStaffActive(name, active) {
  if (actionBusy) return;
  actionBusy = true;
  try {
    const res = await fetch(ENDPOINT_URL, {
      method: "POST", mode: "cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "setStaffActive", pin: sessionPin, name: name, active: !!active }),
    });
    const data = await res.json();
    if (!data || !data.ok) { window.alert((data && data.error) || t("could_not_update")); return; }
    await refresh();
  } catch (e) {
    window.alert(t("network_retry"));
  } finally { actionBusy = false; }
}

async function resolveRequest(rid, resolution) {
  if (actionBusy) return; // shared mutex with addStaff / setStaffActive
  const verb = resolution === "approve" ? t("confirm_approve") : t("confirm_deny");
  if (!window.confirm(verb)) return;
  actionBusy = true;
  // Disable any approve/deny buttons for this rid so a second tap can't fire.
  document.querySelectorAll(`[data-resolve][data-rid="${rid}"]`).forEach((b) => { b.disabled = true; });
  let needsRender = false;
  try {
    const res = await fetch(ENDPOINT_URL, {
      method: "POST", mode: "cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "resolveRequest", pin: sessionPin, requestId: rid, resolution: resolution }),
    });
    const data = await res.json();
    if (!data || !data.ok) {
      window.alert((data && data.error) || t("could_not_resolve"));
      needsRender = true; // re-render so the disabled buttons come back
      return;
    }
    // Drop the resolved request locally so a failed loadRequests can't leave
    // it visible and re-clickable.
    pendingRequests = pendingRequests.filter((r) => r.id !== rid);
    await loadRequests();
    if (resolution === "approve") {
      await refresh();
    } else {
      render();
    }
  } catch (e) {
    window.alert(t("network_retry"));
    needsRender = true;
  } finally {
    actionBusy = false;
    if (needsRender) render();
  }
}

function focusPin() { try { pinInput.focus(); } catch (e) {} }

async function refresh() {
  const view = document.getElementById("view");
  view.innerHTML = `<div class="loading">${escapeHtml(t("loading"))}</div>`;
  try {
    const data = await fetchData(sessionPin);
    if (data && data.ok) { allRows = data.rows || []; staffList = data.staff || []; if (data.config && typeof data.config.showSplit === "boolean") showSplitConfig = data.config.showSplit; render(); return; }
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
  // Calendar and Settings manage no date range, so the period selector is hidden.
  const noRange = activeTab === "calendar" || activeTab === "settings";
  document.getElementById("periods").classList.toggle("hidden", noRange);
  document.getElementById("custom-range").classList.toggle("show", !noRange && period === "custom");
  document.getElementById("custom-range").classList.toggle("hidden", noRange);
  document.getElementById("range-label").classList.toggle("hidden", noRange);

  document.querySelectorAll("#periods button").forEach((b) => b.classList.toggle("active", b.dataset.period === period));
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === activeTab));

  const view = document.getElementById("view");
  if (activeTab === "settings") { view.innerHTML = renderSettings(); return; }
  if (activeTab === "calendar") { view.innerHTML = calDay ? renderCalDayDetail(calDay) : renderCalendar(); return; }

  const { start, end } = currentRange();
  document.querySelectorAll("#day-presets .day-preset").forEach((b) => b.classList.toggle("active", start === end && b.dataset.day === start));
  const rows = rowsInRange(start, end);
  const shiftCount = new Set(rows.map((r) => r.submissionId)).size;
  const label = start === end ? start : `${start} ${t("range_sep")} ${end}`;
  document.getElementById("range-label").textContent = `${label} · ${shiftCount} ${shiftWord(shiftCount)}`;

  if (activeTab === "summary") view.innerHTML = renderSummary(rows, start, end);
  else if (activeTab === "shifts") view.innerHTML = renderShifts(rows);
  else if (activeTab === "people") view.innerHTML = renderPeople(rows);
  else if (activeTab === "requests") view.innerHTML = renderRequests();
}

function renderSummary(rows, start, end) {
  if (!rows.length) return emptyState(t("no_shifts_period"));
  let total = 0, kitchen = 0, chefs = 0, servers = 0, trainees = 0;
  const staff = new Set();
  const shifts = new Set();
  for (const r of rows) {
    total += r.amount;
    if (r.role === "Kitchen") kitchen += r.amount;
    else if (r.role === "Chef") { chefs += r.amount; staff.add((r.recipient || "").trim().toLowerCase()); }
    else if (r.role === "Trainee") { trainees += r.amount; staff.add((r.recipient || "").trim().toLowerCase()); }
    else { servers += r.amount; staff.add((r.recipient || "").trim().toLowerCase()); }
    if (r.submissionId) shifts.add(r.submissionId);
  }
  const cards = `
    <div class="cards">
      <div class="card hero"><div class="k">${escapeHtml(t("card_total_tips"))}</div><div class="v">${fmt(total)}</div></div>
      <div class="card"><div class="k">${escapeHtml(t("kitchen"))}</div><div class="v">${fmt(kitchen)}</div></div>
      <div class="card"><div class="k">${escapeHtml(t("card_chefs"))}</div><div class="v">${fmt(chefs)}</div></div>
      <div class="card"><div class="k">${escapeHtml(t("card_servers"))}</div><div class="v">${fmt(servers)}</div></div>
      <div class="card"><div class="k">${escapeHtml(t("card_trainees"))}</div><div class="v">${fmt(trainees)}</div></div>
      <div class="card"><div class="k">${escapeHtml(t("card_shifts"))}</div><div class="v">${shifts.size}</div></div>
      <div class="card"><div class="k">${escapeHtml(t("card_distinct_staff"))}</div><div class="v">${staff.size}</div></div>
    </div>`;

  let chart;
  if (start === end) {
    chart = `<div class="panel"><h2>${escapeHtml(t("panel_day_shifts"))}</h2>${dayTimelineHtml(rows)}</div>`;
  } else {
    const days = enumerateDays(start, end);
    const byDay = {};
    for (const r of rows) byDay[r.date] = (byDay[r.date] || 0) + r.amount;
    const series = days.map((d) => ({ label: String(isoParts(d).d), value: byDay[d] || 0 }));
    chart = `<div class="panel"><h2>${escapeHtml(t("panel_daily_total"))}</h2>${buildBarChart(series)}</div>`;
  }
  return cards + chart;
}

// Single-day summary: one combined bar split into a Lunch segment and a Dinner
// segment, each sized by that shift's total tips. Tap a segment for its detail.
function dayTimelineHtml(rows) {
  const byShift = {};
  for (const r of rows) {
    const id = r.submissionId || (r.date + r.time);
    if (!byShift[id]) byShift[id] = { id: id, shift: r.shift || "", totalTips: r.totalTips || 0, time: r.time || "" };
  }
  const rank = (s) => { const v = String(s.shift).toLowerCase(); return v === "lunch" ? 0 : v === "dinner" ? 1 : 2; };
  const shifts = Object.values(byShift).sort((a, b) => rank(a) - rank(b) || (a.time || "").localeCompare(b.time || ""));
  const sum = shifts.reduce((acc, s) => acc + (s.totalTips || 0), 0);
  if (!sum) return `<div class="empty-state">${escapeHtml(t("no_data"))}</div>`;
  const segs = shifts.map((s) => {
    const w = Math.max(s.totalTips / sum * 100, 0);
    const cls = String(s.shift).toLowerCase() === "lunch" ? "day-seg lunch" : "day-seg dinner";
    const label = `${escapeHtml(localizeShiftName(s.shift))} ${fmt(s.totalTips)}`;
    return `<div class="${cls}" data-sid="${escapeHtml(s.id)}" style="width:${w.toFixed(1)}%" title="${label}"><span class="day-seg-lbl">${label}</span></div>`;
  }).join("");
  return `<div class="day-combined">${segs}</div>`;
}

function openShiftModal(sid) {
  const shiftRows = allRows.filter((r) => (r.submissionId || (r.date + r.time)) === sid);
  if (!shiftRows.length) return;
  document.getElementById("modal-body").innerHTML = shiftCardsHtml(shiftRows);
  document.getElementById("shift-modal").classList.remove("hidden");
}

// Build recipient-shaped rows from a proposed shift (uses splitShift from calc.js).
function synthesizePropRows(req) {
  if (!req || !req.proposed || typeof splitShift !== "function") return [];
  const p = req.proposed;
  let splits;
  try { splits = splitShift(p); } catch (e) { return []; }
  const base = { date: req.shiftDate || "", time: req.shiftTime || "", shift: (p.shiftType === "lunch" ? "Lunch" : "Dinner"), enteredBy: p.enteredBy || "", totalTips: p.totalTips || 0, submissionId: req.submissionId || "" };
  const out = [];
  splits.servers.forEach((sp) => out.push(Object.assign({}, base, {
    recipient: sp.name, role: sp.trainee ? "Trainee" : "Server", traineePct: sp.trainee ? sp.pct : null,
    slot: sp.slotLabel, timeIn: sp.timeIn, timeOut: sp.timeOut, hours: sp.hours, amount: sp.amount,
  })));
  splits.chefs.forEach((c) => out.push(Object.assign({}, base, { recipient: c.name, role: "Chef", traineePct: null, slot: "", timeIn: "", timeOut: "", hours: 0, amount: c.amount })));
  out.push(Object.assign({}, base, { recipient: "Kitchen", role: "Kitchen", traineePct: null, slot: "", timeIn: "", timeOut: "", hours: 0, amount: splits.kitchen }));
  return out;
}

function renderRequests() {
  const errBanner = requestsLoadError
    ? `<div class="req-load-err">${escapeHtml(requestsLoadError)}</div>`
    : "";
  if (!pendingRequests.length) {
    return errBanner + emptyState(requestsLoadError ? t("pending_load_fail") : t("no_pending"));
  }
  return errBanner + pendingRequests.map((req) => {
    const original = allRows.filter((r) => r.submissionId === req.submissionId);
    const proposed = synthesizePropRows(req);
    const noteHtml = req.note ? `<div class="req-note">${escapeHtml(req.note)}</div>` : "";
    return `<div class="req-card">
      <div class="req-head">
        <span class="req-when">${escapeHtml(req.requestedAt || "")} · ${escapeHtml(t("req_by"))} ${escapeHtml(req.requestedBy || "?")}</span>
        <div class="req-actions">
          <button type="button" class="btn-deny" data-resolve="deny" data-rid="${escapeHtml(req.id)}">${escapeHtml(t("deny"))}</button>
          <button type="button" class="btn-approve" data-resolve="approve" data-rid="${escapeHtml(req.id)}">${escapeHtml(t("approve"))}</button>
        </div>
      </div>
      ${noteHtml}
      <div class="req-diff">
        <div class="diff-col">
          <div class="diff-label">${escapeHtml(t("diff_current"))}</div>
          ${original.length ? shiftCardsHtml(original) : `<div class="empty-state">${escapeHtml(t("orig_not_found"))}</div>`}
        </div>
        <div class="diff-col">
          <div class="diff-label">${escapeHtml(t("diff_proposed"))}</div>
          ${proposed.length ? shiftCardsHtml(proposed) : `<div class="empty-state">${escapeHtml(t("proposed_invalid"))}</div>`}
        </div>
      </div>
    </div>`;
  }).join("");
}

function buildBarChart(series) {
  const W = 600, H = 200, padTop = 14, padBottom = 26, padX = 8;
  const plotH = H - padTop - padBottom;
  const n = series.length;
  if (!n) return `<div class="empty-state">${escapeHtml(t("no_data"))}</div>`;
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
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(t("chart_aria"))}">
    <line x1="${padX}" y1="${baseY}" x2="${W - padX}" y2="${baseY}" stroke="#e4e7ee" />
    ${bars}
  </svg>`;
}

function renderCalendar() {
  const { y, m } = calMonth;
  const monthName = new Date(y, m - 1, 1).toLocaleDateString(locale(), { month: "long", year: "numeric" });
  const byDay = {};
  let maxAmt = 0;
  for (const r of allRows) {
    const p = isoParts(r.date || "");
    if (p.y === y && p.m === m) { byDay[p.d] = (byDay[p.d] || 0) + r.amount; if (byDay[p.d] > maxAmt) maxAmt = byDay[p.d]; }
  }
  const firstDow = new Date(y, m - 1, 1).getDay();
  const days = lastDayOfMonth(y, m);
  const today = todayISO();

  const dowNames = [];
  for (let i = 0; i < 7; i++) dowNames.push(new Date(2024, 0, 7 + i).toLocaleDateString(locale(), { weekday: "short" }));
  const dow = dowNames.map((d) => `<div class="cal-dow">${escapeHtml(d)}</div>`).join("");
  let cells = "";
  for (let i = 0; i < firstDow; i++) cells += `<div class="cal-cell empty"></div>`;
  for (let d = 1; d <= days; d++) {
    const amt = byDay[d] || 0;
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const alpha = maxAmt > 0 && amt > 0 ? (0.18 + 0.62 * (amt / maxAmt)).toFixed(2) : 0;
    const bg = amt > 0 ? `style="background: rgba(158,58,46, ${alpha})"` : "";
    const todayCls = iso === today ? " today" : "";
    const amtTxt = amt > 0 ? `<div class="amt">${amt >= 1000 ? "$" + (amt / 1000).toFixed(1).replace(/\.0$/, "") + "k" : fmt(amt).replace(".00", "")}</div>` : "";
    cells += `<div class="cal-cell${todayCls}" data-day="${iso}"${bg ? " " + bg : ""}><div class="d">${d}</div>${amtTxt}</div>`;
  }
  return `<div class="panel">
    <div class="cal-head">
      <button type="button" id="cal-prev" aria-label="${escapeHtml(t("prev_month"))}">&lsaquo;</button>
      <span class="m">${escapeHtml(monthName)}</span>
      <button type="button" id="cal-next" aria-label="${escapeHtml(t("next_month"))}">&rsaquo;</button>
    </div>
    <div class="cal-grid">${dow}${cells}</div>
  </div>`;
}

function renderCalDayDetail(iso) {
  const { y, m, d } = isoParts(iso);
  const title = new Date(y, m - 1, d).toLocaleDateString(locale(), { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const rows = allRows.filter((r) => r.date === iso);
  const body = rows.length ? shiftCardsHtml(rows) : `<div class="empty-state">${escapeHtml(t("no_shifts_day"))}</div>`;
  return `<div class="cal-head">
      <button type="button" data-cal-back>&lsaquo; ${escapeHtml(t("cal_back"))}</button>
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
    const chefsR = sh.recipients.filter((r) => r.role === "Chef");
    const fixed = sh.recipients.filter((r) => r.role === "Kitchen");
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
      let dur = "";
      if (ci != null && co != null && co > ci) { const m = co - ci; dur = Math.floor(m / 60) + "h" + (m % 60 ? " " + (m % 60) + "m" : ""); }
      const info = escapeHtml(`${p.recipient || "?"} · ${p.timeIn || "?"}–${p.timeOut || "?"}${dur ? " · " + dur : ""}`);
      const track = hasBar
        ? `<div class="tl-track"><div class="${cls}" style="left:${left.toFixed(1)}%;width:${Math.max(width, 2).toFixed(1)}%" title="${info}" data-info="${info}"></div></div>`
        : `<div class="tl-track"></div>`;
      return `<div class="tl-row"><span class="tl-name" title="${escapeHtml(p.recipient || "")}">${escapeHtml(p.recipient || "?")}${pct}</span>${track}<span class="tl-amt">${fmt(p.amount)}</span></div>`;
    }).join("");

    const chefSummary = chefsR.map((c) => `${escapeHtml(c.recipient || t("role_chef"))} ${fmt(c.amount)}`).join("  ·  ");
    const fixedSummary = fixed.map((f) => `${escapeHtml(t("kitchen"))} ${fmt(f.amount)}`).join("  ·  ");
    const shiftTag = sh.recipients[0] && sh.recipients[0].shift ? escapeHtml(localizeShiftName(sh.recipients[0].shift)) + " · " : "";

    return `<div class="shift">
      <div class="top">
        <span class="when">${shiftTag}${escapeHtml(sh.date)} ${escapeHtml(sh.time)}</span>
        <span class="tot">${fmt(sh.totalTips)}</span>
      </div>
      <div class="by">${escapeHtml(t("entered_by_prefix"))}${escapeHtml(sh.enteredBy || "?")}</div>
      ${axisHtml}
      <div class="tl-rows">${rowsHtml}</div>
      ${chefSummary ? `<div class="tl-fixed">${chefSummary}</div>` : ""}
      ${fixedSummary ? `<div class="tl-fixed">${fixedSummary}</div>` : ""}
    </div>`;
  }).join("");
}

function renderShifts(rows) {
  if (!rows.length) return emptyState(t("no_shifts_period"));
  return `<div>${shiftCardsHtml(rows)}</div>`;
}

function renderStaffManager() {
  const sorted = staffList.slice().sort((a, b) => a.name.localeCompare(b.name));
  const active = sorted.filter((s) => s.active);
  const inactive = sorted.filter((s) => !s.active);
  const row = (s, label, action) => `<div class="staff-row${s.active ? "" : " inactive"}">
    <span class="staff-name">${escapeHtml(s.name)}${s.role === "Chef" ? " " + escapeHtml(t("chef_suffix")) : ""}</span>
    <button type="button" class="staff-btn" data-staff-action="${action}" data-staff-name="${escapeHtml(s.name)}">${escapeHtml(label)}</button>
  </div>`;
  const activeHtml = active.length
    ? active.map((s) => row(s, t("inactivate"), "inactivate")).join("")
    : `<div class="staff-empty">${escapeHtml(t("no_active_staff"))}</div>`;
  const inactiveHtml = inactive.length
    ? `<details class="staff-inactive"><summary>${escapeHtml(t("inactive_count", { n: inactive.length }))}</summary>${inactive.map((s) => row(s, t("reactivate"), "activate")).join("")}</details>`
    : "";
  return `<div class="panel staff-panel">
    <h2>${escapeHtml(t("manage_staff"))}</h2>
    <div class="staff-add">
      <input type="text" id="staff-add-input" placeholder="${escapeHtml(t("add_staff_ph"))}" maxlength="40" autocomplete="off" />
      <select id="staff-add-role"><option value="Server">${escapeHtml(t("role_server"))}</option><option value="Chef">${escapeHtml(t("role_chef"))}</option></select>
      <button type="button" id="staff-add-btn">${escapeHtml(t("add"))}</button>
    </div>
    <div class="staff-list">${activeHtml}</div>
    ${inactiveHtml}
  </div>`;
}

function renderPeople(rows) {
  const manager = renderStaffManager();
  const activeSet = new Set(staffList.filter((s) => s.active).map((s) => s.name.toLowerCase()));
  const people = rows.filter((r) =>
    (r.role === "Server" || r.role === "Trainee" || r.role === "Chef") &&
    activeSet.has((r.recipient || "").trim().toLowerCase())
  );
  if (!people.length) {
    return manager + emptyState(activeSet.size ? t("no_earnings_active") : t("add_staff_start"));
  }
  const agg = {}; // key -> { total, hours, shifts:Set, names: {display: count}, traineePct }
  for (const r of people) {
    const name = (r.recipient || "").trim();
    const key = name.toLowerCase();
    if (!key) continue;
    if (!agg[key]) agg[key] = { total: 0, hours: 0, shifts: new Set(), names: {}, traineePct: null };
    agg[key].total += r.amount;
    agg[key].hours += r.hours || 0;
    if (r.submissionId) agg[key].shifts.add(r.submissionId);
    agg[key].names[name] = (agg[key].names[name] || 0) + 1;
    if (r.role === "Trainee" && r.traineePct != null) agg[key].traineePct = r.traineePct;
  }
  const list = Object.values(agg).map((a) => {
    const display = Object.keys(a.names).sort((x, y) => a.names[y] - a.names[x])[0];
    return { display, total: a.total, hours: a.hours, shifts: a.shifts.size, traineePct: a.traineePct };
  }).sort((a, b) => b.total - a.total);

  const max = Math.max(1, ...list.map((p) => p.total));
  const body = list.map((p) => {
    const w = p.total > 0 ? Math.max(2, p.total / max * 100) : 0;
    const tag = p.traineePct != null ? `<span class="lb-tag"> · ${escapeHtml(t("trainee_tag", { pct: p.traineePct }))}</span>` : "";
    const rate = p.hours > 0 ? fmt(p.total / p.hours) + "/h" : "—";
    return `<div class="lb-row">
      <div class="lb-head"><span class="lb-name">${escapeHtml(p.display)}${tag}</span><span class="lb-earned">${fmt(p.total)}</span></div>
      <div class="lb-track">${w ? `<div class="lb-bar" style="width:${w.toFixed(1)}%"></div>` : ""}</div>
      <div class="lb-meta">${p.shifts} ${escapeHtml(shiftWord(p.shifts))} · ${p.hours.toFixed(1)}h · ${rate}</div>
    </div>`;
  }).join("");
  return manager + `<div class="panel"><h2>${escapeHtml(t("earnings_by_person"))}</h2>${body}</div>`;
}

function emptyState(msg) { return `<div class="empty-state">${escapeHtml(msg)}</div>`; }

function renderSettings() {
  const lang = getLang();
  const langBtn = (code, label) => `<button type="button" data-set-lang="${code}"${lang === code ? ' class="active"' : ""}>${escapeHtml(label)}</button>`;
  return `<div class="panel">
    <div class="set-row">
      <div class="set-label">${escapeHtml(t("settings_language"))}</div>
      <div class="set-langs">${langBtn("en", "English")}${langBtn("ko", "한국어")}</div>
    </div>
    <div class="set-row">
      <div class="set-toggle-row">
        <div class="set-label">${escapeHtml(t("settings_show_split"))}</div>
        <label class="set-switch"><input type="checkbox" id="set-show-split"${showSplitConfig ? " checked" : ""}><span class="set-slider"></span></label>
      </div>
      <div class="set-status" id="set-split-status"></div>
    </div>
  </div>`;
}

// Language is a device-local preference; re-translate the chrome and re-render
// the active view so dynamic content picks up the new language immediately.
function applyAdminLang() {
  applyStaticI18n();
  buildDayPresets();
  render();
}

// Show-split is a global setting persisted on the backend (PIN protected).
async function setConfigShowSplit(val) {
  const status = document.getElementById("set-split-status");
  if (status) status.textContent = t("saving");
  try {
    const res = await fetch(ENDPOINT_URL, {
      method: "POST", mode: "cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "setConfig", pin: sessionPin, showSplit: !!val }),
    });
    const data = await res.json();
    if (!data || !data.ok) throw new Error((data && data.error) || "fail");
    showSplitConfig = (data.config && typeof data.config.showSplit === "boolean") ? data.config.showSplit : !!val;
    if (status) status.textContent = t("saved");
  } catch (e) {
    const cb = document.getElementById("set-show-split");
    if (cb) cb.checked = showSplitConfig; // revert to the last known-good value
    if (status) status.textContent = t("could_not_save_setting");
  }
}

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
  document.getElementById("day-presets").addEventListener("click", (e) => {
    const btn = e.target.closest(".day-preset");
    if (!btn) return;
    const d = btn.getAttribute("data-day");
    document.getElementById("custom-start").value = d;
    document.getElementById("custom-end").value = d;
    period = "custom";
    render();
  });

  document.getElementById("tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (!btn) return;
    activeTab = btn.dataset.tab;
    calDay = null;
    render();
  });

  // Calendar interactions are delegated on the (persistent) #view container.
  document.getElementById("view").addEventListener("click", (e) => {
    const langBtn = e.target.closest("[data-set-lang]");
    if (langBtn) { setLang(langBtn.dataset.setLang); applyAdminLang(); return; }
    if (e.target.closest("#cal-prev")) { calMonth.m--; if (calMonth.m < 1) { calMonth.m = 12; calMonth.y--; } render(); return; }
    if (e.target.closest("#cal-next")) { calMonth.m++; if (calMonth.m > 12) { calMonth.m = 1; calMonth.y++; } render(); return; }
    if (e.target.closest("[data-cal-back]")) { calDay = null; render(); return; }
    const cell = e.target.closest(".cal-cell[data-day]");
    if (cell) { calDay = cell.getAttribute("data-day"); render(); return; }
    const dlbar = e.target.closest("[data-sid]");
    if (dlbar && dlbar.dataset.sid) { openShiftModal(dlbar.dataset.sid); return; }
    const resolveBtn = e.target.closest("[data-resolve]");
    if (resolveBtn && resolveBtn.dataset.rid) { resolveRequest(resolveBtn.dataset.rid, resolveBtn.dataset.resolve); return; }
    if (e.target.closest("#staff-add-btn")) {
      const input = document.getElementById("staff-add-input");
      const roleSel = document.getElementById("staff-add-role");
      const name = input ? input.value.trim() : "";
      if (name) addStaff(name, roleSel ? roleSel.value : "Server");
      return;
    }
    const staffBtn = e.target.closest("[data-staff-action]");
    if (staffBtn && staffBtn.dataset.staffName) {
      const action = staffBtn.dataset.staffAction;
      const name = staffBtn.dataset.staffName;
      if (action === "inactivate" && !window.confirm(t("confirm_inactivate", { name: name }))) return;
      setStaffActive(name, action === "activate");
      return;
    }
  });
  // Submit add-staff on Enter in the input.
  document.getElementById("view").addEventListener("keydown", (e) => {
    if (e.target && e.target.id === "staff-add-input" && e.key === "Enter") {
      const roleSel = document.getElementById("staff-add-role");
      const name = e.target.value.trim();
      if (name) addStaff(name, roleSel ? roleSel.value : "Server");
    }
  });

  // Settings: the show-split toggle is a checkbox change, not a click.
  document.getElementById("view").addEventListener("change", (e) => {
    if (e.target && e.target.id === "set-show-split") setConfigShowSplit(e.target.checked);
  });

  const modal = document.getElementById("shift-modal");
  modal.addEventListener("click", (e) => {
    if (e.target === modal || e.target.closest("#modal-close")) modal.classList.add("hidden");
  });

  // Tap a timeline bar to show its name, clock-in/out, and duration as a popup.
  const pop = document.getElementById("tip-pop");
  document.addEventListener("click", (e) => {
    const bar = e.target.closest(".tl-bar");
    if (bar && bar.dataset.info) {
      pop.textContent = bar.dataset.info;
      pop.classList.remove("hidden");
      const popW = pop.offsetWidth, popH = pop.offsetHeight;
      const r = bar.getBoundingClientRect();
      let left = r.left + r.width / 2 - popW / 2;
      left = Math.max(6, Math.min(left, window.innerWidth - popW - 6));
      let top = r.top - popH - 8;
      if (top < 6) top = r.bottom + 8;
      pop.style.left = left + "px";
      pop.style.top = top + "px";
    } else {
      pop.classList.add("hidden");
    }
  });
  window.addEventListener("scroll", () => pop.classList.add("hidden"), true);
}

function buildDayPresets() {
  const today = todayISO();
  let html = "";
  for (let back = 2; back <= 6; back++) {
    const d = addDays(today, -back);
    const p = isoParts(d);
    const wd = new Date(p.y, p.m - 1, p.d).toLocaleDateString(locale(), { weekday: "short" });
    html += `<button type="button" class="preset day-preset" data-day="${d}">${escapeHtml(wd)}</button>`;
  }
  document.getElementById("day-presets").innerHTML = html;
}

function init() {
  applyStaticI18n();
  const today = isoParts(todayISO());
  calMonth = { y: today.y, m: today.m };
  wireEvents();
  buildDayPresets();
  const stored = localStorage.getItem(PIN_KEY);
  if (stored) { showChecking(); tryPin(stored, true); } else { showGateForm(); focusPin(); }
}

document.addEventListener("DOMContentLoaded", init);
