// Shared bilingual strings for the entry app and the admin app.
// The chosen language is stored per device (localStorage) and, because both
// apps live on the same origin, one setting covers both. Default is English.
//
// Usage: t("key") or t("key", { name: "Sam" }) for {placeholder} interpolation.
// Tag static HTML with data-i18n="key" (textContent), data-i18n-ph="key"
// (placeholder), or data-i18n-aria="key" (aria-label), then call applyStaticI18n().

var LANG_KEY = "matsuri_lang";

var I18N = {
  en: {
    // shared
    lunch: "Lunch",
    dinner: "Dinner",
    kitchen: "Kitchen",
    trainee: "Trainee",
    total: "Total",
    refresh: "Refresh",
    loading: "Loading...",
    slot_close: "close",
    chef_suffix: "(chef)",
    pick_time: "Pick a time",

    // entry app
    entry_title: "Shift Tip Entry",
    today_link: "Today",
    your_name: "Your name",
    not_me: "Not {name}?",
    shift_label: "Shift",
    total_tips_label: "Total tip amount ($)",
    servers_label: "Servers on shift",
    add_server: "+ Add server",
    chefs_label: "Chefs on shift",
    preview_empty: "Enter tips and times to see the split",
    preview_hint: "Enter tips, servers, and slots to see the split",
    split_hidden_ready: "Entry looks good. Tap Submit to record the shift.",
    submit: "Submit shift",
    submitting: "Submitting...",
    ph_name: "Name",
    remove: "Remove",
    time_slot: "Time slot",
    server_n: "Server {n}",
    server_word: "Server",
    both_entered: "Both shifts have been entered today. Use 'Today' to edit them.",
    one_entered: "{shift} already entered today.",
    trainee_suffix: "({pct}% trainee)",
    prev_recorded: "Previously recorded shift",
    shift_recorded: "Shift recorded",
    record_another: "Record another shift",
    required: "Required",
    err_amount_range: "Enter an amount between $1 and $100,000",
    name_required: "Name required",
    pick_time_slot: "Pick a time slot",
    dup_server: "Duplicate server name",
    err_save_conn: "Could not save. Check your connection and tap Submit again.",
    err_save_retry: "Could not save. Try again in a few seconds.",
    err_entry_prefix: "Something was wrong with your entry: ",
    unknown_error: "Unknown error",

    // today app
    today_title: "Today's shifts",
    entry_back: "Entry",
    request_edit: "Request edit",
    entered_by_prefix: "Entered by ",
    no_shifts_today: "No shifts entered today yet.",
    could_not_load: "Could not load. Check your connection and tap Refresh.",
    note_optional: "Note (optional)",
    note_ph: "Anything the owner should know",
    edit_hint: "Edit any field below, then send. The owner will review and approve.",
    entered_by_label: "Entered by",
    servers_word: "Servers",
    cancel: "Cancel",
    send_request: "Send request",
    sending: "Sending...",
    edit_sub_tpl: "Shift {date} {time} · {amount}. The owner will review.",
    shift_gone: "That shift is no longer on today's list. Tap Refresh to reload.",
    err_who_recorded: "Please enter who recorded the shift.",
    err_total_range2: "Total must be between $1 and $100,000.",
    err_one_server: "At least one server is required.",
    err_server_name_n: "Server {n}: name is required.",
    err_server_slot_n: "Server {n}: pick a time slot.",
    err_two_servers_same: "Two servers have the same name: {name}.",
    err_dup_chef: "Duplicate chef selected: {name}.",
    err_enter_name: "Please enter your name.",
    could_not_send_prefix: "Could not send: ",
    try_again: "try again.",
    edit_sent_toast: "Edit request sent to the owner.",

    // admin
    gate_title: "Matsuri Tips Admin",
    gate_checking: "Checking saved PIN...",
    gate_prompt: "Enter your access PIN.",
    unlock: "Unlock",
    pin_aria: "Access PIN",
    admin_title: "Tips Admin",
    sheet: "Sheet",
    sign_out: "Sign out",
    period_today: "Today",
    period_yesterday: "Yesterday",
    period_week: "This Week",
    period_month: "This Month",
    period_custom: "Custom",
    range_to: "to",
    start_date: "Start date",
    end_date: "End date",
    tab_summary: "Summary",
    tab_calendar: "Calendar",
    tab_shifts: "Shifts",
    tab_people: "People",
    tab_requests: "Requests",
    tab_settings: "Settings",
    could_not_connect: "Could not connect. Check your internet and try again.",
    wrong_pin: "Wrong PIN.",
    checking: "Checking...",
    could_not_load_requests: "Could not load requests.",
    requests_stale: "Could not reach the server. Pending list may be out of date.",
    could_not_add: "Could not add.",
    network_retry: "Network error. Try again.",
    could_not_update: "Could not update.",
    confirm_approve: "Approve and apply changes to the ledger?",
    confirm_deny: "Deny this request?",
    could_not_resolve: "Could not resolve.",
    no_shifts_period: "No shifts in this period.",
    shift_one: "shift",
    shift_many: "shifts",
    range_sep: "to",
    card_total_tips: "Total tips",
    card_chefs: "Chefs",
    card_servers: "Servers",
    card_trainees: "Trainees",
    card_shifts: "Shifts",
    card_distinct_staff: "Distinct staff",
    panel_day_shifts: "Shifts across the day",
    panel_daily_total: "Daily total tips",
    chart_aria: "Daily total tips bar chart",
    no_data: "No data.",
    shift_n: "Shift {n}",
    prev_month: "Previous month",
    next_month: "Next month",
    cal_back: "Calendar",
    no_shifts_day: "No shifts on this day.",
    req_by: "by",
    deny: "Deny",
    approve: "Approve",
    diff_current: "Current",
    diff_proposed: "Proposed",
    orig_not_found: "Original shift not found in the ledger.",
    proposed_invalid: "Proposed data is invalid.",
    no_pending: "No pending edit requests.",
    pending_load_fail: "Pending list could not be loaded.",
    manage_staff: "Manage staff",
    add_staff_ph: "Add staff name",
    role_server: "Server",
    role_chef: "Chef",
    add: "Add",
    no_active_staff: "No active staff yet. Add one above.",
    inactive_count: "Inactive ({n})",
    inactivate: "Inactivate",
    reactivate: "Reactivate",
    earnings_by_person: "Earnings by person",
    no_earnings_active: "No earnings yet for active staff in this period.",
    add_staff_start: "Add staff above to start tracking earnings.",
    trainee_tag: "{pct}% trainee",
    confirm_inactivate: "Inactivate {name}? They will be hidden from the entry form and leaderboard.",

    // settings
    settings_language: "Language",
    settings_show_split: "Show tip split after submission",
    saving: "Saving...",
    saved: "Saved",
    could_not_save_setting: "Could not save setting. Try again.",
  },

  ko: {
    // shared
    lunch: "점심",
    dinner: "저녁",
    kitchen: "주방",
    trainee: "수습",
    total: "합계",
    refresh: "새로고침",
    loading: "불러오는 중...",
    slot_close: "마감",
    chef_suffix: "(셰프)",
    pick_time: "시간 선택",

    // entry app
    entry_title: "팁 입력",
    today_link: "오늘",
    your_name: "이름",
    not_me: "{name} 아니세요?",
    shift_label: "시프트",
    total_tips_label: "총 팁 금액 ($)",
    servers_label: "담당 서버",
    add_server: "+ 서버 추가",
    chefs_label: "시프트 셰프",
    preview_empty: "팁과 시간을 입력하면 분배가 표시됩니다",
    preview_hint: "팁, 서버, 시간대를 입력하면 분배가 표시됩니다",
    split_hidden_ready: "입력이 완료되었습니다. 입력을 눌러 기록하세요.",
    submit: "입력",
    submitting: "입력 중...",
    ph_name: "이름",
    remove: "삭제",
    time_slot: "시간대",
    server_n: "서버 {n}",
    server_word: "서버",
    both_entered: "오늘 점심과 저녁 시프트가 모두 입력되었습니다. '오늘'에서 수정하세요.",
    one_entered: "오늘 {shift} 시프트가 이미 입력되었습니다.",
    trainee_suffix: "({pct}% 수습)",
    prev_recorded: "이전에 기록된 시프트",
    shift_recorded: "시프트가 기록되었습니다",
    record_another: "다른 시프트 입력",
    required: "필수",
    err_amount_range: "$1 ~ $100,000 사이 금액을 입력하세요",
    name_required: "이름을 입력하세요",
    pick_time_slot: "시간대를 선택하세요",
    dup_server: "중복된 서버 이름",
    err_save_conn: "저장하지 못했습니다. 연결을 확인하고 다시 입력하세요.",
    err_save_retry: "저장하지 못했습니다. 잠시 후 다시 시도하세요.",
    err_entry_prefix: "입력에 문제가 있습니다: ",
    unknown_error: "알 수 없는 오류",

    // today app
    today_title: "오늘의 시프트",
    entry_back: "입력",
    request_edit: "수정 요청",
    entered_by_prefix: "입력자: ",
    no_shifts_today: "아직 오늘 입력된 시프트가 없습니다.",
    could_not_load: "불러오지 못했습니다. 연결을 확인하고 새로고침하세요.",
    note_optional: "메모 (선택)",
    note_ph: "사장님께 전달할 내용",
    edit_hint: "아래 항목을 수정한 뒤 보내세요. 사장님이 검토 후 승인합니다.",
    entered_by_label: "입력자",
    servers_word: "서버",
    cancel: "취소",
    send_request: "요청 보내기",
    sending: "보내는 중...",
    edit_sub_tpl: "{date} {time} · {amount} 시프트. 사장님이 검토합니다.",
    shift_gone: "해당 시프트가 더 이상 목록에 없습니다. 새로고침하세요.",
    err_who_recorded: "시프트를 입력한 사람을 적어주세요.",
    err_total_range2: "총액은 $1 ~ $100,000 사이여야 합니다.",
    err_one_server: "서버가 최소 한 명 필요합니다.",
    err_server_name_n: "서버 {n}: 이름이 필요합니다.",
    err_server_slot_n: "서버 {n}: 시간대를 선택하세요.",
    err_two_servers_same: "두 서버의 이름이 같습니다: {name}.",
    err_dup_chef: "중복된 셰프가 선택되었습니다: {name}.",
    err_enter_name: "이름을 입력하세요.",
    could_not_send_prefix: "보내지 못했습니다: ",
    try_again: "다시 시도하세요.",
    edit_sent_toast: "수정 요청을 사장님께 보냈습니다.",

    // admin
    gate_title: "Matsuri 팁 관리자",
    gate_checking: "저장된 PIN 확인 중...",
    gate_prompt: "접속 PIN을 입력하세요.",
    unlock: "잠금 해제",
    pin_aria: "접속 PIN",
    admin_title: "팁 관리자",
    sheet: "시트",
    sign_out: "로그아웃",
    period_today: "오늘",
    period_yesterday: "어제",
    period_week: "이번 주",
    period_month: "이번 달",
    period_custom: "사용자 지정",
    range_to: "~",
    start_date: "시작 날짜",
    end_date: "종료 날짜",
    tab_summary: "요약",
    tab_calendar: "캘린더",
    tab_shifts: "시프트",
    tab_people: "직원",
    tab_requests: "요청",
    tab_settings: "설정",
    could_not_connect: "연결할 수 없습니다. 인터넷을 확인하고 다시 시도하세요.",
    wrong_pin: "잘못된 PIN입니다.",
    checking: "확인 중...",
    could_not_load_requests: "요청을 불러오지 못했습니다.",
    requests_stale: "서버에 연결할 수 없습니다. 대기 목록이 최신이 아닐 수 있습니다.",
    could_not_add: "추가하지 못했습니다.",
    network_retry: "네트워크 오류입니다. 다시 시도하세요.",
    could_not_update: "업데이트하지 못했습니다.",
    confirm_approve: "변경 사항을 승인하고 장부에 적용할까요?",
    confirm_deny: "이 요청을 거부할까요?",
    could_not_resolve: "처리하지 못했습니다.",
    no_shifts_period: "이 기간에 시프트가 없습니다.",
    shift_one: "시프트",
    shift_many: "시프트",
    range_sep: "~",
    card_total_tips: "총 팁",
    card_chefs: "셰프",
    card_servers: "서버",
    card_trainees: "수습",
    card_shifts: "시프트",
    card_distinct_staff: "직원 수",
    panel_day_shifts: "오늘 시프트",
    panel_daily_total: "일별 총 팁",
    chart_aria: "일별 총 팁 막대 그래프",
    no_data: "데이터 없음.",
    shift_n: "시프트 {n}",
    prev_month: "이전 달",
    next_month: "다음 달",
    cal_back: "캘린더",
    no_shifts_day: "이 날에 시프트가 없습니다.",
    req_by: "요청자",
    deny: "거부",
    approve: "승인",
    diff_current: "현재",
    diff_proposed: "제안",
    orig_not_found: "장부에서 원본 시프트를 찾을 수 없습니다.",
    proposed_invalid: "제안된 데이터가 올바르지 않습니다.",
    no_pending: "대기 중인 수정 요청이 없습니다.",
    pending_load_fail: "대기 목록을 불러올 수 없습니다.",
    manage_staff: "직원 관리",
    add_staff_ph: "직원 이름 추가",
    role_server: "서버",
    role_chef: "셰프",
    add: "추가",
    no_active_staff: "활성 직원이 없습니다. 위에서 추가하세요.",
    inactive_count: "비활성 ({n})",
    inactivate: "비활성화",
    reactivate: "재활성화",
    earnings_by_person: "직원별 수입",
    no_earnings_active: "이 기간에 활성 직원의 수입이 없습니다.",
    add_staff_start: "위에서 직원을 추가해 수입을 추적하세요.",
    trainee_tag: "{pct}% 수습",
    confirm_inactivate: "{name}님을 비활성화할까요? 입력 양식과 순위에서 숨겨집니다.",

    // settings
    settings_language: "언어",
    settings_show_split: "입력 후 팁분배 결과 표시",
    saving: "저장 중...",
    saved: "저장됨",
    could_not_save_setting: "설정을 저장하지 못했습니다. 다시 시도하세요.",
  },
};

function getLang() {
  try { return localStorage.getItem(LANG_KEY) === "ko" ? "ko" : "en"; } catch (e) { return "en"; }
}
function setLang(lang) {
  try { localStorage.setItem(LANG_KEY, lang === "ko" ? "ko" : "en"); } catch (e) {}
}

function t(key, vars) {
  var lang = getLang();
  var table = I18N[lang] || I18N.en;
  var s = (table[key] != null) ? table[key] : (I18N.en[key] != null ? I18N.en[key] : key);
  if (vars) {
    for (var k in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, k)) s = s.split("{" + k + "}").join(String(vars[k]));
    }
  }
  return s;
}

// Slot labels (from calc.js) are time ranges like "3:30 - close"; localize the
// one word in them without touching the numeric times.
function localizeSlotLabel(label) {
  return String(label).replace("close", t("slot_close"));
}

// English pluralizes "shift/shifts"; Korean has one form.
function shiftWord(n) { return n === 1 ? t("shift_one") : t("shift_many"); }

// The ledger stores the shift type as "Lunch"/"Dinner"; show it in the UI language.
function localizeShiftName(name) {
  var s = String(name || "").toLowerCase();
  if (s === "lunch") return t("lunch");
  if (s === "dinner") return t("dinner");
  return String(name || "");
}

function applyStaticI18n(root) {
  var r = root || document;
  var nodes = r.querySelectorAll("[data-i18n]");
  for (var i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute("data-i18n"));
  var phs = r.querySelectorAll("[data-i18n-ph]");
  for (var j = 0; j < phs.length; j++) phs[j].setAttribute("placeholder", t(phs[j].getAttribute("data-i18n-ph")));
  var arias = r.querySelectorAll("[data-i18n-aria]");
  for (var a = 0; a < arias.length; a++) arias[a].setAttribute("aria-label", t(arias[a].getAttribute("data-i18n-aria")));
  try { document.documentElement.setAttribute("lang", getLang()); } catch (e) {}
}
