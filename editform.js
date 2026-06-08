// editform.js — shared shift-edit form for today.html (staff request) and
// admin.html (direct admin edit). Classic global script (no module/IIFE), loaded
// AFTER calc.js + i18n.js. Depends on globals: SHIFT_SLOTS, getSlot,
// findSlotByTimes, firstDuplicateName, slotLabel (calc.js); escapeHtml, t (page).
// The submit action (requestEdit vs adminEditShift), name/note fields, and toasts
// stay in each caller. This module only builds, populates, and reads the fields.

// Inner field markup. Carries data-i18n attributes so a runtime language toggle
// re-translates it. Inject once into a container, then run the page's static-i18n
// pass (or rely on t() already having filled the current language).
function editFormFieldsHtml() {
  return `
    <label for="edit-by" data-i18n="entered_by_label">${escapeHtml(t("entered_by_label"))}</label>
    <input type="text" id="edit-by" maxlength="60" autocomplete="off">

    <label for="edit-total" data-i18n="total_tips_label">${escapeHtml(t("total_tips_label"))}</label>
    <input type="number" id="edit-total" inputmode="decimal" step="0.01" min="1" max="100000">

    <label data-i18n="shift_label">${escapeHtml(t("shift_label"))}</label>
    <div class="ep-pct" id="edit-shift">
      <button type="button" data-shift="lunch" data-i18n="lunch">${escapeHtml(t("lunch"))}</button>
      <button type="button" data-shift="dinner" data-i18n="dinner">${escapeHtml(t("dinner"))}</button>
    </div>

    <label data-i18n="servers_word">${escapeHtml(t("servers_word"))}</label>
    <div id="edit-people"></div>
    <button type="button" class="add-btn" id="edit-add" data-i18n="add_server">${escapeHtml(t("add_server"))}</button>

    <div id="edit-chef-section" class="hidden">
      <label data-i18n="chefs_label">${escapeHtml(t("chefs_label"))}</label>
      <div id="edit-chef-list"></div>
    </div>`;
}

// Ledger rows for one shift -> form model. Both pages pass ledger-shaped rows
// (recipient, role, shift, timeIn, timeOut, enteredBy, totalTips).
function shiftRowsToModel(rows) {
  const first = rows[0] || {};
  const shiftType = String(first.shift || "Dinner").toLowerCase() === "lunch" ? "lunch" : "dinner";
  const servers = rows
    .filter((r) => r.role === "Server" || r.role === "Trainee")
    .map((r) => {
      const slot = findSlotByTimes(shiftType, r.timeIn, r.timeOut);
      return { name: r.recipient || "", slot: slot ? slot.id : "" };
    });
  const chefs = rows.filter((r) => r.role === "Chef").map((r) => ({ name: r.recipient || "" }));
  return {
    enteredBy: first.enteredBy || "",
    totalTips: first.totalTips != null ? first.totalTips : "",
    shiftType: shiftType,
    servers: servers.length ? servers : [{ name: "", slot: "" }],
    chefs: chefs,
  };
}

// Controller over the injected fields. Wires its own add/remove/shift-toggle
// handlers once. Call render() to populate, read() to validate + package.
function createEditForm() {
  let shiftType = "dinner";
  let chefRoster = []; // [{name}]
  const peopleEl = document.getElementById("edit-people");

  function slotOptions(shift, selectedId) {
    return `<option value="">${escapeHtml(t("pick_time"))}</option>` +
      (SHIFT_SLOTS[shift] || []).map((s) =>
        `<option value="${escapeHtml(s.id)}"${s.id === selectedId ? " selected" : ""}>${escapeHtml(slotLabel(s.timeIn, s.timeOut))}</option>`
      ).join("");
  }

  function personRowHtml(p) {
    return `<div class="edit-person">
      <div class="ep-row">
        <input type="text" class="ep-name" maxlength="40" placeholder="${escapeHtml(t("ph_name"))}" value="${escapeHtml(p.name || "")}">
        <button type="button" class="ep-remove" aria-label="${escapeHtml(t("remove"))}">&times;</button>
      </div>
      <div class="ep-row"><select class="ep-slot">${slotOptions(shiftType, p.slot || "")}</select></div>
    </div>`;
  }

  function renderPeople(people) {
    peopleEl.innerHTML = people.map(personRowHtml).join("");
  }

  function renderChefs(checkedNames) {
    const sec = document.getElementById("edit-chef-section");
    const list = document.getElementById("edit-chef-list");
    const checked = checkedNames || [];
    // Union the roster with chefs already on the shift so a slow/failed roster
    // load can't silently drop existing chefs (redistributing their money).
    const names = [], seen = {};
    chefRoster.map((c) => c.name).concat(checked).forEach((n) => {
      const k = String(n).toLowerCase();
      if (k && !seen[k]) { seen[k] = true; names.push(n); }
    });
    if (!names.length) { sec.classList.add("hidden"); list.innerHTML = ""; return; }
    sec.classList.remove("hidden");
    const set = new Set(checked.map((n) => n.toLowerCase()));
    list.innerHTML = names.map((n) =>
      `<label class="chef-check"><input type="checkbox" class="edit-chef-cb" value="${escapeHtml(n)}"${set.has(n.toLowerCase()) ? " checked" : ""}> ${escapeHtml(n)}</label>`
    ).join("");
  }

  function renderShiftToggle() {
    document.querySelectorAll("#edit-shift button").forEach((b) => b.classList.toggle("selected", b.dataset.shift === shiftType));
  }

  function readServers() {
    return Array.from(peopleEl.querySelectorAll(".edit-person")).map((row) => ({
      name: row.querySelector(".ep-name").value.trim(),
      slot: row.querySelector(".ep-slot").value,
      trainee: false, // roster-managed; backend reapplies on save
      pct: null,
    }));
  }

  function readChefs() {
    return Array.from(document.querySelectorAll(".edit-chef-cb")).filter((cb) => cb.checked).map((cb) => ({ name: cb.value }));
  }

  // Handlers (wired once at construction).
  peopleEl.addEventListener("click", (e) => {
    const remove = e.target.closest(".ep-remove");
    if (!remove) return;
    if (peopleEl.querySelectorAll(".edit-person").length <= 1) return; // keep at least one
    remove.closest(".edit-person").remove();
  });
  document.getElementById("edit-add").addEventListener("click", () => {
    if (peopleEl.querySelectorAll(".edit-person").length >= 12) return;
    peopleEl.insertAdjacentHTML("beforeend", personRowHtml({ name: "", slot: "" }));
  });
  document.getElementById("edit-shift").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-shift]");
    if (!b) return;
    shiftType = b.dataset.shift;
    renderShiftToggle();
    peopleEl.querySelectorAll(".ep-slot").forEach((sel) => {
      sel.innerHTML = slotOptions(shiftType, getSlot(shiftType, sel.value) ? sel.value : "");
    });
  });

  function render(model, roster) {
    chefRoster = roster || [];
    shiftType = model.shiftType === "lunch" ? "lunch" : "dinner";
    document.getElementById("edit-by").value = model.enteredBy || "";
    document.getElementById("edit-total").value = (model.totalTips != null && model.totalTips !== "") ? model.totalTips : "";
    renderShiftToggle();
    const servers = (model.servers && model.servers.length) ? model.servers : [{ name: "", slot: "" }];
    renderPeople(servers);
    renderChefs((model.chefs || []).map((c) => c.name || c));
    // Hint when a recorded slot no longer matches a current slot (owner retimed it).
    return servers.some((s) => s.name && !s.slot);
  }

  function read() {
    const enteredBy = document.getElementById("edit-by").value.trim();
    const totalTips = parseFloat(document.getElementById("edit-total").value);
    const servers = readServers();
    const chefs = readChefs();
    if (!enteredBy) return { error: t("err_who_recorded") };
    if (!isFinite(totalTips) || totalTips < 1 || totalTips > 100000) return { error: t("err_total_range2") };
    if (!servers.length) return { error: t("err_one_server") };
    for (let i = 0; i < servers.length; i++) {
      if (!servers[i].name) return { error: t("err_server_name_n", { n: i + 1 }) };
      if (!getSlot(shiftType, servers[i].slot)) return { error: t("err_server_slot_n", { n: i + 1 }) };
    }
    const dupServer = firstDuplicateName(servers.map((s) => s.name));
    if (dupServer) return { error: t("err_two_servers_same", { name: dupServer }) };
    const dupChef = firstDuplicateName(chefs.map((c) => c.name));
    if (dupChef) return { error: t("err_dup_chef", { name: dupChef }) };
    return { proposed: { shiftType: shiftType, enteredBy: enteredBy, totalTips: totalTips, servers: servers, chefs: chefs } };
  }

  return { render: render, read: read };
}
