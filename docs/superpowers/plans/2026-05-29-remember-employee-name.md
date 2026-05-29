# Remember Employee Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remember the employee's name on their device and auto-fill it everywhere they'd otherwise retype it, with a one-tap way to switch user.

**Architecture:** Store one trimmed name string in `localStorage` under `matsuri_me`. Inline tiny get/set helpers into each employee page (`index.html`, `today.html`) — the same per-device pattern the existing `matsuri_staff` cache uses. Pre-fill on load/open, save on successful submit/send. No server changes, no new files, so the service-worker cache version is untouched.

**Tech Stack:** Vanilla HTML/JS, `localStorage`, Playwright MCP for browser verification.

**Testing note:** There is no DOM unit-test harness in this repo (`test.html` only covers the pure `splitShift` math). Behavior here is verified in a real browser via Playwright MCP: seed `localStorage`, load the page over a local static server, assert input values, exercise the "Not you?" link. The save-on-submit path needs the live Apps Script backend, so it is verified by a final manual check, not Playwright.

---

### Task 1: `index.html` — storage helpers + "Not you?" markup and styles

**Files:**
- Modify: `index.html` (style block ~line 95, markup ~lines 108-113, script staff section ~lines 149-151)

- [ ] **Step 1: Add a quiet link style**

In the `<style>` block, immediately after the `.hidden` rule (`index.html:95`), add:

```css
  .switch-user { display: inline-block; background: none; border: 0; color: #3b82f6; font-size: .82rem; padding: .15rem 0; margin-top: .1rem; cursor: pointer; }
```

- [ ] **Step 2: Add the "Not you?" button to the name field**

Replace the entered-by error line (`index.html:113`):

```html
  <div class="field-error" id="err-entered-by"></div>
```

with:

```html
  <div class="field-error" id="err-entered-by"></div>
  <button type="button" id="switch-user" class="switch-user hidden">Not <span id="me-name"></span>?</button>
```

- [ ] **Step 3: Add the storage key and helpers**

In the script, right after the staff key line `const STAFF_KEY = "matsuri_staff";` (`index.html:150`), add:

```js
const ME_KEY = "matsuri_me";
function getMe() { try { return localStorage.getItem(ME_KEY) || ""; } catch (e) { return ""; } }
function setMe(name) { try { name ? localStorage.setItem(ME_KEY, name) : localStorage.removeItem(ME_KEY); } catch (e) {} }
```

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Add remembered-name storage helpers and switch-user control"
```

---

### Task 2: `index.html` — pre-fill on load and wire the switch-user link

**Files:**
- Modify: `index.html` (init block ~lines 322-327, plus new functions)

- [ ] **Step 1: Add pre-fill and switch-user functions**

Just above the init block (before `totalTipsEl.addEventListener("input", updatePreview);` at `index.html:322`), add:

```js
const switchUserBtn = document.getElementById("switch-user");
const meNameEl = document.getElementById("me-name");

function renderSwitchUser() {
  const me = getMe();
  meNameEl.textContent = me;
  switchUserBtn.classList.toggle("hidden", !me);
}

function applyRememberedName() {
  const me = getMe();
  if (!me) { renderSwitchUser(); return; }
  enteredByEl.value = me;
  const firstName = peopleContainer.querySelector(".person .p-name");
  if (firstName && !firstName.value) firstName.value = me;
  renderSwitchUser();
}

switchUserBtn.addEventListener("click", () => {
  setMe("");
  enteredByEl.value = "";
  const firstName = peopleContainer.querySelector(".person .p-name");
  if (firstName) firstName.value = "";
  renderSwitchUser();
  updatePreview();
  enteredByEl.focus();
});
```

- [ ] **Step 2: Call pre-fill during init**

The init sequence currently reads (`index.html:323-327`):

```js
addPersonBtn.addEventListener("click", addPerson);
attachCombo(enteredByEl);
addPerson();
updatePreview();
loadStaff();
```

Change it to call `applyRememberedName()` after the first person row exists:

```js
addPersonBtn.addEventListener("click", addPerson);
attachCombo(enteredByEl);
addPerson();
applyRememberedName();
updatePreview();
loadStaff();
```

- [ ] **Step 3: Verify pre-fill and switch in a browser**

Start a static server from the repo root and drive it with Playwright MCP:

Run: `python -m http.server 8765` (leave running)

Then in Playwright MCP:
1. `browser_navigate` to `http://localhost:8765/index.html`
2. `browser_evaluate`: `() => { localStorage.setItem('matsuri_me', 'Kenji'); location.reload(); }`
3. `browser_snapshot` and confirm:
   - the "Your name" input value is `Kenji`
   - the first person row's name input value is `Kenji`
   - a "Not Kenji?" button is visible
4. `browser_click` the "Not Kenji?" button
5. `browser_snapshot` and confirm both name fields are empty and the button is gone
6. `browser_evaluate`: `() => localStorage.getItem('matsuri_me')` → expect `null`

Expected: all assertions hold.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Pre-fill remembered name on entry form and first person row"
```

---

### Task 3: `index.html` — save on submit and keep name on reset

**Files:**
- Modify: `index.html` (`submitShift` ~line 427, `resetForm` ~lines 453-464)

- [ ] **Step 1: Save the name on a successful submission**

In `submitShift`, the success branch currently reads (`index.html:427-428`):

```js
  if (response.ok) {
    renderConfirmation(response);
```

Change it to save the trimmed name first:

```js
  if (response.ok) {
    setMe(enteredByEl.value.trim());
    renderConfirmation(response);
```

- [ ] **Step 2: Keep the remembered name when the form resets**

`resetForm` currently reads (`index.html:453-464`):

```js
function resetForm() {
  hideBanner();
  form.classList.remove("hidden");
  enteredByEl.value = "";
  totalTipsEl.value = "";
  peopleContainer.innerHTML = "";
  addPerson();
  clearAllErrors();
  submissionId = newSubmissionId();
  updatePreview();
  enteredByEl.focus();
}
```

Replace it with a version that restores the remembered name, pre-fills the first row, refreshes the switch-user link, and focuses the amount field when the name is already known:

```js
function resetForm() {
  hideBanner();
  form.classList.remove("hidden");
  enteredByEl.value = "";
  totalTipsEl.value = "";
  peopleContainer.innerHTML = "";
  addPerson();
  applyRememberedName();
  clearAllErrors();
  submissionId = newSubmissionId();
  updatePreview();
  if (getMe()) totalTipsEl.focus(); else enteredByEl.focus();
}
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Persist name on submit and keep it filled after reset"
```

---

### Task 4: `today.html` — remember name in the edit-request popup

**Files:**
- Modify: `today.html` (helpers ~line 129, open handler ~line 278, send handler ~line 329)

- [ ] **Step 1: Add the storage helpers**

After the `fmt` helper (`today.html:129`), add:

```js
const ME_KEY = "matsuri_me";
function getMe() { try { return localStorage.getItem(ME_KEY) || ""; } catch (e) { return ""; } }
function setMe(name) { try { name ? localStorage.setItem(ME_KEY, name) : localStorage.removeItem(ME_KEY); } catch (e) {} }
```

- [ ] **Step 2: Pre-fill "Your name" when the popup opens**

In the `content` click handler that opens the modal, the line `reqName.value = "";` (`today.html:278`) becomes:

```js
  reqName.value = getMe();
```

Leave `editBy.value = sh.enteredBy || "";` (`today.html:280`) unchanged — that field is the shift's original recorder, not the current user.

- [ ] **Step 3: Save the name after a successful send**

In the `reqSend` click handler, the success block currently reads (`today.html:329-330`):

```js
    modal.classList.add("hidden");
    showToast("Edit request sent to the owner.");
```

Change it to remember the name:

```js
    setMe(name);
    modal.classList.add("hidden");
    showToast("Edit request sent to the owner.");
```

(`name` is already the trimmed value from `reqName.value.trim()` at the top of the handler.)

- [ ] **Step 4: Verify pre-fill in a browser**

With the static server from Task 2 still running, in Playwright MCP:
1. `browser_navigate` to `http://localhost:8765/today.html`
2. `browser_evaluate`: `() => localStorage.setItem('matsuri_me', 'Kenji')`
3. The page needs a shift to open the modal, and loading shifts requires the live backend. If no shift card renders, skip the click and instead confirm the wiring by `browser_evaluate`: `() => { document.getElementById('req-name').value = getMe(); return document.getElementById('req-name').value; }` → expect `Kenji`.
4. If a shift card is present: `browser_click` its "Request edit" button, then `browser_snapshot` and confirm the "Your name" field shows `Kenji` while "Entered by" shows the original recorder.

Expected: "Your name" pre-fills with `Kenji`; "Entered by" is unaffected.

- [ ] **Step 5: Commit**

```bash
git add today.html
git commit -m "Pre-fill and persist remembered name in the edit-request popup"
```

---

### Task 5: End-to-end manual check against the live form

**Files:** none (verification only)

- [ ] **Step 1: Confirm save-on-submit on the real form**

The save-on-submit path posts to the live Apps Script endpoint, so verify it manually:
1. Open the deployed entry page (or local page pointed at the real endpoint) in a fresh browser profile.
2. Confirm no name is pre-filled and no "Not you?" link shows.
3. Enter a name, tips, and a person; submit successfully.
4. Tap "Record another shift" → confirm the name is still filled and a "Not [name]?" link shows.
5. Reload the page → confirm the name pre-fills on both "Your name" and the first person row.
6. Open `today.html`, open a shift's "Request edit" → confirm "Your name" pre-fills, "Entered by" shows the original recorder.

Expected: name persists across submit, reset, reload, and into the edit popup; "Entered by" never gets overwritten by the remembered name.

- [ ] **Step 2: Run the existing calc tests to confirm nothing regressed**

These changes don't touch `calc.js`, but confirm the suite still loads clean:

Run: open `http://localhost:8765/test.html`
Expected: summary shows `7 passed, 0 failed`.
