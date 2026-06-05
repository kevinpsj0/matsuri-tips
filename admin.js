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
let kitchenPctConfig = 15;   // global config mirrored from the backend (Settings tab)
let slotsConfig = null;      // {lunch,dinner} from the backend; null until first fetch
let slotsEdit = null;        // deep-clone working copy the Settings slot editor mutates
// locale() (Intl locale for the chosen language) is shared from i18n.js.
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

function currentRange() {
  const today = todayISO();
  if (period === "today") return { start: today, end: today };
  if (period === "yesterday") { const y = addDays(today, -1); return { start: y, end: y }; }
  if (period === "last3") {
    // The 3 most recent days the restaurant actually had shifts (skips closed days).
    const days = Array.from(new Set(allRows.map((r) => r.date).filter((d) => d && d <= today))).sort();
    if (!days.length) return { start: today, end: today };
    const last3 = days.slice(-3);
    return { start: last3[0], end: last3[last3.length - 1] };
  }
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
    mirrorConfig(data.config);
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

async function setStaffTrainee(name, traineePct) {
  if (actionBusy) return;
  actionBusy = true;
  try {
    const res = await fetch(ENDPOINT_URL, {
      method: "POST", mode: "cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "setStaffTrainee", pin: sessionPin, name: name, traineePct: (traineePct == null ? null : Number(traineePct)) }),
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
    if (data && data.ok) { allRows = data.rows || []; staffList = data.staff || []; mirrorConfig(data.config); render(); return; }
    if (data && data.error) { signOut(); return; }
  } catch (e) { /* keep existing data */ }
  render();
}

// Mirror the backend config into local state. Resets the slot editor clone only
// when the owner isn't mid-edit on the Settings tab, so a refresh won't discard
// unsaved slot edits.
function mirrorConfig(cfg) {
  if (!cfg) return;
  if (typeof cfg.showSplit === "boolean") showSplitConfig = cfg.showSplit;
  if (typeof cfg.kitchenPct === "number") kitchenPctConfig = cfg.kitchenPct;
  if (cfg.slots) { slotsConfig = cfg.slots; if (activeTab !== "settings") slotsEdit = null; }
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
  document.getElementById("settings-btn").classList.toggle("active", activeTab === "settings"); // Settings lives in the header gear, not the tabs

  const view = document.getElementById("view");
  if (activeTab === "settings") { if (!slotsEdit) slotsEdit = slotsWorkingCopy(); view.innerHTML = renderSettings(); return; }
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
    chart = `<div class="panel"><h2>${escapeHtml(t("panel_daily_total"))}</h2>${multiDayBarsHtml(rows)}</div>`;
  }
  return cards + chart;
}

// Multi-day summary: one horizontal bar per day (busiest day = full width),
// each split into Lunch/Dinner segments, matching the single-day view.
function multiDayBarsHtml(rows) {
  const shiftTotals = {};
  for (const r of rows) {
    const id = r.submissionId || (r.date + r.time);
    if (!shiftTotals[id]) shiftTotals[id] = { id: id, date: r.date, shift: String(r.shift || "").toLowerCase(), totalTips: r.totalTips || 0 };
  }
  const byDay = {};
  for (const s of Object.values(shiftTotals)) {
    if (!byDay[s.date]) byDay[s.date] = { date: s.date, total: 0, lunch: null, dinner: null };
    byDay[s.date].total += s.totalTips;
    if (s.shift === "lunch") byDay[s.date].lunch = { amt: s.totalTips, id: s.id };
    else if (s.shift === "dinner") byDay[s.date].dinner = { amt: s.totalTips, id: s.id };
  }
  const list = Object.values(byDay).filter((d) => d.total > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (!list.length) return `<div class="empty-state">${escapeHtml(t("no_data"))}</div>`;
  const max = Math.max(1, ...list.map((d) => d.total));
  const seg = (part, cls) => {
    if (!part || part.amt <= 0) return "";
    const w = part.amt / max * 100;
    return `<div class="day-seg ${cls}" data-sid="${escapeHtml(part.id)}" style="width:${w.toFixed(1)}%" title="${fmt(part.amt)}"></div>`;
  };
  const rowsHtml = list.map((d) => {
    const p = isoParts(d.date);
    const label = new Date(p.y, p.m - 1, p.d).toLocaleDateString(locale(), { month: "numeric", day: "numeric" });
    return `<div class="mday"><span class="mday-label">${escapeHtml(label)}</span><div class="mday-track">${seg(d.lunch, "lunch")}${seg(d.dinner, "dinner")}</div><span class="mday-amt">${fmt(d.total)}</span></div>`;
  }).join("");
  return `<div class="mday-list">${rowsHtml}</div>`;
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
  // Reflect roster-managed trainee levels in the preview (backend applies the
  // same on approve, so the proposal stored without trainee still shows right).
  const tmap = {};
  staffList.forEach((s) => { if (s.traineePct) tmap[s.name.toLowerCase()] = s.traineePct; });
  (p.servers || []).forEach((sv) => {
    const tp = tmap[String(sv.name || "").trim().toLowerCase()];
    if (tp === 25 || tp === 50 || tp === 75) { sv.trainee = true; sv.pct = tp; }
    else { sv.trainee = false; sv.pct = null; }
  });
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
  const isChef = (s) => s.role === "Chef";
  // showRole tags chefs with a suffix; only needed where roles are mixed (the
  // inactive list). Active staff are split into labeled Servers/Chefs groups.
  const row = (s, label, action, showRole) => `<div class="staff-row${s.active ? "" : " inactive"}">
    <span class="staff-name">${escapeHtml(s.name)}${showRole && isChef(s) ? " " + escapeHtml(t("chef_suffix")) : ""}</span>
    <button type="button" class="staff-btn" data-staff-action="${action}" data-staff-name="${escapeHtml(s.name)}">${escapeHtml(label)}</button>
  </div>`;
  // Active servers also get a Trainee toggle; when on, a 25/50/75 selector.
  const pctBtn = (s, v) => `<button type="button" class="trainee-pct${s.traineePct === v ? " selected" : ""}" data-trainee-pct="${v}" data-staff-name="${escapeHtml(s.name)}">${v}%</button>`;
  const serverRow = (s) => {
    const isTrainee = s.traineePct === 25 || s.traineePct === 50 || s.traineePct === 75;
    return `<div class="staff-row staff-server">
      <div class="staff-server-top">
        <span class="staff-name">${escapeHtml(s.name)}</span>
        <button type="button" class="staff-btn" data-staff-action="inactivate" data-staff-name="${escapeHtml(s.name)}">${escapeHtml(t("inactivate"))}</button>
      </div>
      <div class="staff-trainee">
        <label class="set-switch sm"><input type="checkbox" class="staff-trainee-cb" data-staff-name="${escapeHtml(s.name)}"${isTrainee ? " checked" : ""}><span class="set-slider"></span></label>
        <span class="staff-trainee-lbl">${escapeHtml(t("trainee"))}</span>
        <div class="trainee-pcts${isTrainee ? "" : " hidden"}">${pctBtn(s, 25)}${pctBtn(s, 50)}${pctBtn(s, 75)}</div>
      </div>
    </div>`;
  };
  const group = (members, title, renderFn) => members.length
    ? `<div class="staff-group"><div class="staff-group-h">${escapeHtml(title)}</div>${members.map(renderFn).join("")}</div>`
    : "";
  const activeHtml = active.length
    ? group(active.filter((s) => !isChef(s)), t("card_servers"), serverRow) + group(active.filter(isChef), t("card_chefs"), (s) => row(s, t("inactivate"), "inactivate", false))
    : `<div class="staff-empty">${escapeHtml(t("no_active_staff"))}</div>`;
  const inactiveHtml = inactive.length
    ? `<details class="staff-inactive"><summary>${escapeHtml(t("inactive_count", { n: inactive.length }))}</summary>${inactive.map((s) => row(s, t("reactivate"), "activate", true)).join("")}</details>`
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
    (r.role === "Server" || r.role === "Trainee") && // servers only; chefs excluded
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
  const head = `<div class="set-row">
      <div class="set-label">${escapeHtml(t("settings_language"))}</div>
      <div class="set-langs">${langBtn("en", "English")}${langBtn("ko", "한국어")}</div>
    </div>
    <div class="set-row">
      <div class="set-toggle-row">
        <div class="set-label">${escapeHtml(t("settings_show_split"))}</div>
        <label class="set-switch"><input type="checkbox" id="set-show-split"${showSplitConfig ? " checked" : ""}><span class="set-slider"></span></label>
      </div>
      <div class="set-status" id="set-split-status"></div>
    </div>`;
  // Until the first config fetch lands, slotsConfig is null — show a loading line
  // for the kitchen %/slot editor rather than empty editable fields a Save could push.
  if (!slotsConfig) {
    return `<div class="panel">${head}
      <div class="set-row"><div class="set-label">${escapeHtml(t("settings_time_slots"))}</div><div class="set-status">${escapeHtml(t("loading"))}</div></div>
    </div>`;
  }
  const slots = slotsEdit || { lunch: [], dinner: [] };
  const slotRow = (shift, s, i, n) => `<div class="slot-row" data-shift="${shift}" data-i="${i}">
      <input type="time" class="slot-in" value="${escapeHtml(s.timeIn || "")}" data-shift="${shift}" data-i="${i}" data-field="timeIn">
      <span class="slot-dash">–</span>
      <input type="time" class="slot-out" value="${escapeHtml(s.timeOut || "")}" data-shift="${shift}" data-i="${i}" data-field="timeOut">
      <span class="slot-preview">${escapeHtml(slotLabel(s.timeIn, s.timeOut))}</span>
      <button type="button" class="slot-remove" data-shift="${shift}" data-i="${i}"${n <= 1 ? " disabled" : ""}>×</button>
    </div>`;
  const group = (shift, title) => `<div class="slot-group">
      <div class="slot-group-h">${escapeHtml(title)}</div>
      ${(slots[shift] || []).map((s, i) => slotRow(shift, s, i, (slots[shift] || []).length)).join("")}
      <button type="button" class="slot-add" data-shift="${shift}">${escapeHtml(t("slot_add"))}</button>
    </div>`;
  return `<div class="panel">${head}
    <div class="set-row">
      <div class="set-toggle-row">
        <div class="set-label">${escapeHtml(t("settings_kitchen_pct"))}</div>
        <input type="number" id="set-kitchen-pct" min="0" max="50" step="1" value="${escapeHtml(String(kitchenPctConfig))}" style="width:5rem">
      </div>
      <div class="set-status" id="set-kitchen-status"></div>
    </div>
    <div class="set-row">
      <div class="set-label">${escapeHtml(t("settings_time_slots"))}</div>
      ${group("lunch", t("lunch"))}
      ${group("dinner", t("dinner"))}
      <button type="button" id="set-slots-save" class="btn-primary" style="margin-top:.6rem">${escapeHtml(t("slot_save"))}</button>
      <div class="set-status" id="set-slots-status"></div>
    </div>
  </div>`;
}

function slotsWorkingCopy() {
  if (!slotsConfig) return { lunch: [], dinner: [] };
  return JSON.parse(JSON.stringify(slotsConfig)); // deep clone; editor never touches live config
}
function updateSlotField(input) {
  const sh = input.dataset.shift, i = Number(input.dataset.i), f = input.dataset.field;
  if (!(slotsEdit && slotsEdit[sh] && slotsEdit[sh][i])) return;
  slotsEdit[sh][i][f] = input.value;
  const rowEl = input.closest(".slot-row");
  const prev = rowEl && rowEl.querySelector(".slot-preview");
  if (prev) prev.textContent = slotLabel(slotsEdit[sh][i].timeIn, slotsEdit[sh][i].timeOut);
}
function commitSlotInputs() {
  document.querySelectorAll("#view .slot-row .slot-in, #view .slot-row .slot-out").forEach(updateSlotField);
}

async function saveKitchenPct(val) {
  const status = document.getElementById("set-kitchen-status");
  const n = parseInt(val, 10);
  if (!Number.isInteger(n) || n < 0 || n > 50) { if (status) status.textContent = t("slot_save_fail"); return; }
  if (status) status.textContent = t("saving");
  try {
    const res = await fetch(ENDPOINT_URL, { method: "POST", mode: "cors", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "setKitchenPct", pin: sessionPin, kitchenPct: n }) });
    const data = await res.json();
    if (!data || !data.ok) throw new Error((data && data.error) || "fail");
    if (data.config && typeof data.config.kitchenPct === "number") kitchenPctConfig = data.config.kitchenPct;
    if (status) status.textContent = t("saved");
  } catch (e) {
    const inp = document.getElementById("set-kitchen-pct"); if (inp) inp.value = String(kitchenPctConfig);
    if (status) status.textContent = t("slot_save_fail");
  }
}

async function saveSlots() {
  commitSlotInputs();
  const status = document.getElementById("set-slots-status");
  if (status) status.textContent = t("saving");
  try {
    const res = await fetch(ENDPOINT_URL, { method: "POST", mode: "cors", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "setSlots", pin: sessionPin, slots: slotsEdit }) });
    const data = await res.json();
    if (!data || !data.ok) throw new Error((data && data.error) || "fail");
    if (data.config && data.config.slots) { slotsConfig = data.config.slots; slotsEdit = slotsWorkingCopy(); }
    render();
    const s2 = document.getElementById("set-slots-status"); if (s2) s2.textContent = t("saved");
  } catch (e) {
    if (status) status.textContent = (e && e.message) || t("slot_save_fail");
  }
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
  document.getElementById("settings-btn").addEventListener("click", () => { activeTab = "settings"; calDay = null; render(); });

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
    const tpBtn = e.target.closest("[data-trainee-pct]");
    if (tpBtn && tpBtn.dataset.staffName) {
      setStaffTrainee(tpBtn.dataset.staffName, Number(tpBtn.dataset.traineePct));
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
    // Settings: slot editor (commit visible inputs before any structural re-render).
    if (e.target.closest("#set-slots-save")) { saveSlots(); return; }
    const addBtn = e.target.closest(".slot-add");
    if (addBtn) { commitSlotInputs(); const sh = addBtn.dataset.shift; slotsEdit[sh] = slotsEdit[sh] || []; if (slotsEdit[sh].length < 8) slotsEdit[sh].push({ timeIn: "", timeOut: "" }); render(); return; }
    const rmBtn = e.target.closest(".slot-remove");
    if (rmBtn) { commitSlotInputs(); const sh = rmBtn.dataset.shift, i = Number(rmBtn.dataset.i); if (slotsEdit[sh] && slotsEdit[sh].length > 1) { slotsEdit[sh].splice(i, 1); render(); } return; }
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
    if (e.target && e.target.id === "set-kitchen-pct") saveKitchenPct(e.target.value);
    if (e.target && (e.target.classList.contains("slot-in") || e.target.classList.contains("slot-out"))) updateSlotField(e.target);
    if (e.target && e.target.classList.contains("staff-trainee-cb")) setStaffTrainee(e.target.dataset.staffName, e.target.checked ? 50 : null);
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
