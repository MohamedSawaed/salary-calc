/* ============================================================
   ShiftPay — app logic
   Vanilla JS. State persisted to localStorage. Uses SalaryCalc.
   ============================================================ */
(function () {
  'use strict';

  var STORAGE_KEY = 'shiftpay.v1';
  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- state ---------------- */
  var state = {
    profile: { name: '', rate: 0, currency: '₪' },
    prefs: { theme: 'system', lang: null, view: 'list' }, // lang null -> show language picker first; view: 'list' | 'calendar'
    shifts: {} // 'yyyy-mm-dd' -> { start, end, type, note }
  };

  /* ---------------- i18n ---------------- */
  function t(key, vars) { return I18N.t(state.prefs.lang || 'en', key, vars); }

  var view = { y: 0, m: 0 };          // currently displayed month
  var editKey = null;                 // date being edited in the sheet
  var editType = 'morning';           // selected shift type in the sheet (concrete; no 'auto')
  var editMode = 'work';              // 'work' | 'vacation'
  var editRate = 0;                   // wage applied to the day being edited
  var deferredInstall = null;         // PWA install prompt

  /* ---------------- persistence ---------------- */
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (data.profile) state.profile = Object.assign(state.profile, data.profile);
        if (data.prefs) state.prefs = Object.assign(state.prefs, data.prefs);
        if (data.shifts) state.shifts = data.shifts;
      }
    } catch (e) { /* corrupt storage -> start fresh */ }
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  // Older shifts had no rate of their own. Freeze them at the current wage once,
  // so a later wage change won't retroactively rewrite past months.
  function migrate() {
    var changed = false;
    Object.keys(state.shifts).forEach(function (k) {
      var s = state.shifts[k];
      if (s && s.rate == null) { s.rate = state.profile.rate; changed = true; }
    });
    if (changed) save();
  }

  /* ---------------- date helpers ---------------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function keyOf(y, m, d) { return y + '-' + pad(m + 1) + '-' + pad(d); }
  function todayKey() { var t = new Date(); return keyOf(t.getFullYear(), t.getMonth(), t.getDate()); }
  function parseKey(k) { var p = k.split('-'); return { y: +p[0], m: +p[1] - 1, d: +p[2] }; }

  var WEEKDAYS_EN = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  function localeCode() { return state.prefs.lang || 'en'; } // BCP-47 short codes work for Intl
  function localeMonthYear(y, m) {
    try { return new Intl.DateTimeFormat(localeCode(), { month: 'long', year: 'numeric' }).format(new Date(y, m, 1)); }
    catch (e) { return new Date(y, m, 1).toDateString(); }
  }
  function localeWeekdayShort(dow) { // 2023-01-01 is a Sunday
    try { return new Intl.DateTimeFormat(localeCode(), { weekday: 'short' }).format(new Date(2023, 0, 1 + dow)); }
    catch (e) { return WEEKDAYS_EN[dow]; }
  }
  function prettyDate(k) {
    var p = parseKey(k);
    try { return new Intl.DateTimeFormat(localeCode(), { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(p.y, p.m, p.d)); }
    catch (e) { return k; }
  }

  /* ---------------- money / hours ---------------- */
  function fmtMoney(n, compact) {
    var cur = state.profile.currency || '';
    if (compact) return cur + Math.round(n).toLocaleString('en-US');
    return cur + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtHours(h) {
    var uh = t('u_h'), um = t('u_m');
    if (h === 0) return '0' + uh;
    var whole = Math.floor(h);
    var mins = Math.round((h - whole) * 60);
    if (mins === 0) return whole + uh;
    if (whole === 0) return mins + um;
    return whole + uh + ' ' + mins + um;
  }

  /* ---------------- theme ---------------- */
  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function applyTheme() {
    var pref = state.prefs.theme;
    var dark = pref === 'dark' || (pref === 'system' && mql && mql.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#4f46e5' : '#6366f1');
  }
  if (mql && mql.addEventListener) mql.addEventListener('change', function () { if (state.prefs.theme === 'system') applyTheme(); });

  /* ---------------- toast ---------------- */
  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg; el.hidden = false;
    requestAnimationFrame(function () { el.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.hidden = true; }, 220);
    }, 1900);
  }

  /* ---------------- apply language ---------------- */
  function langMeta(code) {
    var m = null;
    I18N.LANGS.forEach(function (L) { if (L.code === code) m = L; });
    return m;
  }
  function applyLang() {
    var lang = state.prefs.lang || 'en';
    var meta = langMeta(lang);
    var dir = meta ? meta.dir : 'ltr';
    var html = document.documentElement;
    html.setAttribute('lang', lang);
    html.setAttribute('dir', dir);
    document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    renderLangPickers();
    if (!$('app').hidden) { updateGreeting(); renderWeekdays(); renderView(); }
  }

  function updateGreeting() {
    $('greet-hi').textContent = t('greet', { name: state.profile.name || '' });
  }

  function buildLangButtons(container, onPick) {
    if (!container) return;
    container.innerHTML = '';
    I18N.LANGS.forEach(function (L) {
      var b = document.createElement('button');
      b.className = 'lang-btn' + (state.prefs.lang === L.code ? ' active' : '');
      b.setAttribute('data-lang', L.code);
      b.setAttribute('aria-pressed', state.prefs.lang === L.code ? 'true' : 'false');
      b.innerHTML = '<span class="lang-flag">' + L.flag + '</span><span class="lang-name">' + L.native + '</span>';
      b.addEventListener('click', function () { onPick(L.code); });
      container.appendChild(b);
    });
  }
  function renderLangPickers() {
    buildLangButtons($('lang-grid'), pickLangFirstRun);
    buildLangButtons($('lang-seg'), pickLangSettings);
  }
  function pickLangFirstRun(code) {
    state.prefs.lang = code; save(); applyLang();
    $('lang-screen').hidden = true;
    if (state.profile.name && state.profile.rate) showApp(); else showOnboarding();
  }
  function pickLangSettings(code) {
    state.prefs.lang = code; save(); applyLang();
  }
  function showLangScreen() {
    $('onboarding').hidden = true; $('app').hidden = true;
    $('lang-screen').hidden = false;
    renderLangPickers();
  }

  /* ---------------- screen routing ---------------- */
  function showApp() {
    $('lang-screen').hidden = true;
    $('onboarding').hidden = true;
    $('app').hidden = false;
    updateGreeting();
    var now = new Date();
    view.y = now.getFullYear(); view.m = now.getMonth();
    renderWeekdays();
    renderView();
  }
  function showOnboarding() {
    $('lang-screen').hidden = true;
    $('app').hidden = true;
    $('onboarding').hidden = false;
  }

  /* ---------------- calendar ---------------- */
  function renderWeekdays() {
    var wd = $('weekdays');
    wd.innerHTML = '';
    for (var i = 0; i < 7; i++) {
      var s = document.createElement('span');
      s.textContent = localeWeekdayShort(i);
      wd.appendChild(s);
    }
  }

  function isFridayKey(key) {
    var p = parseKey(key);
    return new Date(p.y, p.m, p.d).getDay() === 5;
  }

  /** Paid minutes worked Sun..Thu of the week that ends on this Friday key. */
  function prevWeekPaidMin(key) {
    var p = parseKey(key);
    var sum = 0;
    for (var off = 5; off >= 1; off--) {       // Friday-5=Sunday .. Friday-1=Thursday
      var dd = new Date(p.y, p.m, p.d - off);   // Date rolls over month/year boundaries
      var s = state.shifts[keyOf(dd.getFullYear(), dd.getMonth(), dd.getDate())];
      if (s && s.type !== 'vacation') {
        sum += SalaryCalc.paidMinutesForWorkedDay(s.start, s.end, s.type, SalaryCalc.BREAK_MIN);
      }
    }
    return sum;
  }

  /** The wage a shift is paid at: its own saved rate, else the current profile rate. */
  function rateOf(shift) {
    return (shift && shift.rate != null) ? shift.rate : state.profile.rate;
  }

  /** Week-aware pay for one day. `override` supplies unsaved editor inputs. */
  function dayResult(key, override) {
    var shift = override !== undefined ? override : state.shifts[key];
    if (!shift) return null;
    var rate = rateOf(shift);
    if (shift.type === 'vacation') return SalaryCalc.vacationResult(rate);
    var fri = isFridayKey(key);
    return SalaryCalc.computeDayPay({
      shift: shift, isFriday: fri, rate: rate,
      prevPaidMin: fri ? prevWeekPaidMin(key) : 0
    });
  }

  function renderCalendar() {
    $('month-label').textContent = localeMonthYear(view.y, view.m);

    var cal = $('calendar');
    cal.innerHTML = '';

    var firstDow = new Date(view.y, view.m, 1).getDay();
    var daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
    var tKey = todayKey();

    // leading blanks
    for (var b = 0; b < firstDow; b++) {
      var blank = document.createElement('div');
      blank.className = 'day empty';
      cal.appendChild(blank);
    }

    var monthPay = 0, monthHours = 0, monthShifts = 0;

    for (var d = 1; d <= daysInMonth; d++) {
      var k = keyOf(view.y, view.m, d);
      var cell = document.createElement('button');
      cell.className = 'day';
      cell.setAttribute('data-key', k);

      var num = document.createElement('span');
      num.className = 'day-num';
      num.textContent = d;
      cell.appendChild(num);

      if (k === tKey) cell.classList.add('today');

      var shift = state.shifts[k];
      if (shift) {
        var res = dayResult(k);
        var meta = SalaryCalc.SHIFT_META[res.type] || SalaryCalc.SHIFT_META.morning;

        cell.classList.add('has-shift');
        cell.style.borderColor = 'color-mix(in srgb, ' + meta.accent + ' 55%, transparent)';

        var tag = document.createElement('span');
        tag.className = 'type-tag';
        tag.style.background = meta.accent;
        cell.appendChild(tag);

        var bar = document.createElement('div');
        bar.className = 'day-bar';
        bar.style.background = meta.accent;
        cell.appendChild(bar);

        var pay = document.createElement('span');
        pay.className = 'day-pay';
        pay.textContent = fmtMoney(res.pay, true);
        cell.appendChild(pay);

        monthPay += res.pay;
        monthHours += res.totalHours;
        monthShifts++;
      }

      cell.addEventListener('click', function () { openSheet(this.getAttribute('data-key')); });
      cal.appendChild(cell);
    }

    // summary
    $('month-total').textContent = fmtMoney(monthPay);
    $('month-hours').textContent = fmtHours(monthHours).replace(' ', '');
    $('month-shifts').textContent = monthShifts;
    $('empty-hint').hidden = monthShifts !== 0;
  }

  /* ---------------- list / table view (timesheet style) ---------------- */
  function renderTable() {
    var tbl = $('month-table');
    tbl.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'mt-row mt-head';
    head.innerHTML =
      '<span class="mt-date">' + t('col_date') + '</span>' +
      '<span class="mt-cell">' + t('col_in') + '</span>' +
      '<span class="mt-cell">' + t('col_out') + '</span>' +
      '<span class="mt-pay">' + t('col_pay') + '</span>';
    tbl.appendChild(head);

    var daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
    var tKey = todayKey();
    var monthPay = 0, monthHours = 0, monthShifts = 0;

    for (var d = 1; d <= daysInMonth; d++) {
      var k = keyOf(view.y, view.m, d);
      var dow = new Date(view.y, view.m, d).getDay();
      var row = document.createElement('button');
      row.className = 'mt-row';
      row.setAttribute('data-key', k);
      if (k === tKey) row.classList.add('mt-today');
      if (dow === 5) row.classList.add('mt-fri');
      if (dow === 6) row.classList.add('mt-sat');

      var shift = state.shifts[k];
      var inHtml = '<span class="muted">—</span>';
      var outHtml = '<span class="muted">—</span>';
      var payHtml = '<span class="muted">—</span>';
      if (shift) {
        var res = dayResult(k);
        var meta = SalaryCalc.SHIFT_META[res.type] || SalaryCalc.SHIFT_META.morning;
        if (shift.type === 'vacation') {
          inHtml = '<i class="t-pill vac">' + meta.emoji + '</i>';
        } else {
          inHtml = '<i class="t-pill in">' + shift.start + '</i>';
          outHtml = '<i class="t-pill out">' + shift.end + '</i>';
        }
        payHtml = '<b class="pay-num">' + fmtMoney(res.pay, true) + '</b>';
        monthPay += res.pay; monthHours += res.totalHours; monthShifts++;
      }
      row.innerHTML =
        '<span class="mt-date"><b>' + d + '</b><small>' + localeWeekdayShort(dow) + '</small></span>' +
        '<span class="mt-cell">' + inHtml + '</span>' +
        '<span class="mt-cell">' + outHtml + '</span>' +
        '<span class="mt-pay">' + payHtml + '</span>';
      row.addEventListener('click', function () { openSheet(this.getAttribute('data-key')); });
      tbl.appendChild(row);
    }

    var tot = document.createElement('div');
    tot.className = 'mt-row mt-total';
    tot.innerHTML =
      '<span class="mt-date">' + t('tbl_total') + '</span>' +
      '<span class="mt-cell"></span><span class="mt-cell"></span>' +
      '<span class="mt-pay"><b>' + fmtMoney(monthPay) + '</b></span>';
    tbl.appendChild(tot);

    $('month-total').textContent = fmtMoney(monthPay);
    $('month-hours').textContent = fmtHours(monthHours).replace(' ', '');
    $('month-shifts').textContent = monthShifts;
    $('empty-hint').hidden = true;
  }

  // dispatcher: render whichever view is selected, keep the toggle in sync
  function renderView() {
    $('month-label').textContent = localeMonthYear(view.y, view.m);
    var list = state.prefs.view === 'list';
    if ($('calendar-view')) $('calendar-view').hidden = list;
    if ($('table-view')) $('table-view').hidden = !list;
    document.querySelectorAll('#view-seg .seg-btn').forEach(function (b) {
      var on = b.getAttribute('data-view') === (list ? 'list' : 'calendar');
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (list) renderTable(); else renderCalendar();
  }

  /* ---------------- shift editor sheet ---------------- */
  function setTypeSeg(type, skip) {
    editType = type;
    document.querySelectorAll('#type-seg .seg-btn').forEach(function (b) {
      var on = b.getAttribute('data-type') === type;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (!skip) renderPreview();
  }

  function setMode(mode, skip) {
    editMode = mode;
    document.querySelectorAll('#mode-seg .seg-btn').forEach(function (b) {
      var on = b.getAttribute('data-mode') === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var vac = mode === 'vacation';
    $('work-fields').hidden = vac;
    $('vacation-note').hidden = !vac;
    if (!skip) renderPreview();
  }

  // Friday is paid by the weekly 42h rule, so the shift-type picker is irrelevant.
  function applyFridayUi(key) {
    var fri = isFridayKey(key) && editMode === 'work';
    $('friday-note').hidden = !fri;
    var seg = $('type-seg');
    seg.classList.toggle('seg-disabled', fri);
    seg.querySelectorAll('.seg-btn').forEach(function (b) { b.disabled = fri; });
  }

  function openSheet(key) {
    if (!state.profile.rate) { toast(t('t_need_wage')); openSettings(); return; }
    editKey = key;
    var existing = state.shifts[key];
    // Editing an existing day keeps its saved wage; a new day uses the current wage.
    editRate = (existing && existing.rate != null) ? existing.rate : state.profile.rate;
    $('sheet-date').textContent = prettyDate(key);

    var isVac = !!(existing && existing.type === 'vacation');
    setMode(isVac ? 'vacation' : 'work', true);

    if (existing && !isVac) {
      $('in-start').value = existing.start;
      $('in-end').value = existing.end;
      var et = existing.type;
      if (!et || et === 'auto') et = SalaryCalc.detectShiftType(existing.start); // legacy 'auto' -> concrete
      setTypeSeg(et, true);
    } else {
      $('in-start').value = '07:00';
      $('in-end').value = isFridayKey(key) ? '13:00' : '16:00';
      setTypeSeg(SalaryCalc.detectShiftType('07:00'), true); // sensible default, user can change
    }
    $('in-note').value = existing ? (existing.note || '') : '';
    $('btn-delete').hidden = !existing;
    $('btn-save').textContent = existing ? t('btn_update') : t('btn_save');

    applyFridayUi(key);
    renderPreview();
    openSheetEl('sheet', 'sheet-backdrop');
  }

  function currentInputs() {
    return { start: $('in-start').value || '00:00', end: $('in-end').value || '00:00' };
  }

  function isValidDuration(inp) {
    if (editMode === 'vacation') return true;
    return inp.start !== inp.end; // equal -> ambiguous (0 or 24h); ask user to fix
  }

  // A muted "<rate>/h" note, flagged when the day keeps a wage different from the current one.
  function rateNoteHtml() {
    var usesOld = editRate !== state.profile.rate;
    var label = usesOld ? t('rate_locked', { rate: fmtMoney(editRate) + '/' + t('u_h') })
                        : t('rate_at', { rate: fmtMoney(editRate) + '/' + t('u_h') });
    return '<div class="prev-row is-context' + (usesOld ? ' is-oldrate' : '') + '">' +
      '<span class="pr-label">' + label + '</span></div>';
  }

  function renderPreview() {
    var saveBtn = $('btn-save');
    var rate = editRate || 0;
    var bars = $('prev-bars');
    var rows = $('prev-rows');

    // ----- vacation -----
    if (editMode === 'vacation') {
      var vr = SalaryCalc.vacationResult(rate);
      $('prev-type').textContent = t('prev_vac');
      $('prev-pay').textContent = fmtMoney(vr.pay);
      bars.innerHTML = '<i class="seg-100" style="width:100%"></i>';
      rows.innerHTML =
        '<div class="prev-vac"><span class="vac-emoji">🏖️</span>' +
        '<span class="vac-line">' + t('vac_line', { h: SalaryCalc.VACATION_HOURS, rate: fmtMoney(rate) }) +
        '</span></div>' + rateNoteHtml();
      saveBtn.disabled = false; saveBtn.style.opacity = '1';
      return;
    }

    // ----- worked shift -----
    var inp = currentInputs();
    var sm = SalaryCalc.parseTimeToMinutes(inp.start);
    var em = SalaryCalc.parseTimeToMinutes(inp.end);
    $('crosses-midnight').hidden = !(em <= sm && inp.start !== inp.end);

    if (!isValidDuration(inp)) {
      $('prev-type').textContent = '—';
      $('prev-pay').textContent = fmtMoney(0);
      bars.innerHTML = '';
      rows.innerHTML = '<div class="prev-empty">' + t('prev_set') + '</div>';
      saveBtn.disabled = true; saveBtn.style.opacity = '.5';
      return;
    }
    saveBtn.disabled = false; saveBtn.style.opacity = '1';

    var fri = isFridayKey(editKey);
    var res = dayResult(editKey, { start: inp.start, end: inp.end, type: editType, rate: editRate });
    var meta = SalaryCalc.SHIFT_META[res.type] || SalaryCalc.SHIFT_META.morning;

    var typeTxt = meta.emoji + ' ' + t('leg_' + res.type);
    if (fri) typeTxt += t('sfx_weekly');
    $('prev-type').textContent = typeTxt;
    $('prev-pay').textContent = fmtMoney(res.pay);

    // stacked bar (paid hours)
    var total = res.totalHours || 1;
    bars.innerHTML = '';
    [['100', 'seg-100'], ['125', 'seg-125'], ['150', 'seg-150']].forEach(function (s) {
      var h = res.hours[s[0]];
      if (h <= 0) return;
      var i = document.createElement('i');
      i.className = s[1];
      i.style.width = (h / total * 100) + '%';
      bars.appendChild(i);
    });

    rows.innerHTML = '';

    // Friday context row
    if (fri) {
      rows.appendChild(rowEl('is-context',
        '', t('r_week'), res.weeklyBeforeHours + ' ' + t('u_h') + ' / 42 ' + t('u_h'), ''));
    }

    // tier rows
    var defs = [
      { key: '100', mult: 1.0, color: '#38bdf8', label: fri ? t('r_100f') : t('r_100') },
      { key: '125', mult: 1.25, color: '#f59e0b', label: t('r_125') },
      { key: '150', mult: 1.5, color: '#ef4444', label: t('r_150') }
    ];
    defs.forEach(function (def) {
      var h = res.hours[def.key];
      if (h <= 0) return;
      rows.appendChild(rowEl('',
        '<span class="swatch" style="background:' + def.color + '"></span>',
        def.label, fmtHours(h), fmtMoney(rate * def.mult * h)));
    });

    // unpaid break row
    var breakMin = Math.round((res.grossHours - res.paidHours) * 60);
    if (breakMin > 0) {
      rows.appendChild(rowEl('is-break',
        '<span class="swatch" style="background:var(--text-faint)"></span>',
        t('r_break'), '− ' + breakMin + t('u_m'), fmtMoney(0)));
    }

    // total row
    var totalRow = rowEl('',
      '<span style="font-weight:700;color:var(--text)">' + t('r_total') + '</span>',
      '', fmtHours(res.totalHours),
      '<b style="color:var(--money)">' + fmtMoney(res.pay) + '</b>');
    totalRow.style.borderTop = '1px solid var(--border)';
    totalRow.style.paddingTop = '8px';
    rows.appendChild(totalRow);

    rows.insertAdjacentHTML('beforeend', rateNoteHtml());
  }

  // helper to build a preview row
  function rowEl(cls, swatchHtml, label, hoursTxt, moneyHtml) {
    var row = document.createElement('div');
    row.className = 'prev-row' + (cls ? ' ' + cls : '');
    row.innerHTML =
      (swatchHtml || '') +
      '<span class="pr-label">' + label + '</span>' +
      '<span class="pr-hours">' + hoursTxt + '</span>' +
      '<span class="pr-money">' + (moneyHtml || '') + '</span>';
    return row;
  }

  function saveShift() {
    if (!state.profile.rate) { toast(t('t_need_wage2')); return; }
    if (editMode === 'vacation') {
      state.shifts[editKey] = { type: 'vacation', note: $('in-note').value.trim(), rate: editRate };
    } else {
      var inp = currentInputs();
      if (!isValidDuration(inp)) { toast(t('t_same')); return; }
      state.shifts[editKey] = {
        start: inp.start, end: inp.end, type: editType, note: $('in-note').value.trim(), rate: editRate
      };
    }
    save();
    renderView();
    closeSheetEl('sheet', 'sheet-backdrop');
    toast(t('t_saved', { x: fmtMoney(dayResult(editKey).pay) }));
  }

  function deleteShift() {
    if (editKey && state.shifts[editKey]) {
      delete state.shifts[editKey];
      save();
      renderView();
    }
    closeSheetEl('sheet', 'sheet-backdrop');
    toast(t('t_removed'));
  }

  /* ---------------- generic sheet open/close ---------------- */
  function openSheetEl(sheetId, backdropId) {
    var bd = $(backdropId), sh = $(sheetId);
    bd.hidden = false; sh.hidden = false;
    requestAnimationFrame(function () { bd.classList.add('show'); sh.classList.add('show'); });
  }
  function closeSheetEl(sheetId, backdropId) {
    var bd = $(backdropId), sh = $(sheetId);
    bd.classList.remove('show'); sh.classList.remove('show');
    setTimeout(function () { bd.hidden = true; sh.hidden = true; }, 320);
  }

  /* ---------------- settings ---------------- */
  function openSettings() {
    $('set-name').value = state.profile.name;
    $('set-rate').value = state.profile.rate || '';
    $('set-currency').value = state.profile.currency;
    document.querySelectorAll('#theme-seg .seg-btn').forEach(function (b) {
      var on = b.getAttribute('data-theme') === state.prefs.theme;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    openSheetEl('settings', 'set-backdrop');
  }
  function saveSettings() {
    var name = $('set-name').value.trim();
    var rate = parseFloat($('set-rate').value);
    var cur = $('set-currency').value.trim() || '₪';
    if (!name) { toast(t('t_name')); return; }
    if (!(rate >= 0) || isNaN(rate)) { toast(t('t_wage')); return; }
    state.profile.name = name;
    state.profile.rate = rate;
    state.profile.currency = cur;
    save();
    updateGreeting();
    renderView();
    closeSheetEl('settings', 'set-backdrop');
    toast(t('t_settings'));
  }

  /* ---------------- export ---------------- */
  // Native app (Capacitor): write the file with Filesystem, then open the share sheet
  // so it can be saved to Files/Drive/email. Browser/PWA: fall back to a blob download.
  function saveFile(content, filename, mime) {
    var cap = window.Capacitor;
    if (cap && cap.isNativePlatform && cap.isNativePlatform() && typeof cap.nativePromise === 'function') {
      // Call the native Filesystem/Share plugins straight through the bridge — the
      // injected Capacitor global has nativePromise() but not registerPlugin().
      cap.nativePromise('Filesystem', 'writeFile',
        { path: filename, data: content, directory: 'CACHE', encoding: 'utf8' })
        .then(function (res) {
          toast(t('t_exported'));
          var uri = (res && (res.uri || res.path)) || filename;
          cap.nativePromise('Share', 'share',
            { title: filename, text: filename, url: uri, dialogTitle: filename })
            .catch(function () {}); // sharing cancelled / unavailable is not a failure
        })
        .catch(function () { toast(t('t_exportfail')); });
      return;
    }
    // web / PWA: prefer the Web Share API with a file (works in an iOS Safari home-screen
    // app and Android Chrome), else fall back to a blob download (desktop browsers).
    try {
      var file = null;
      try { file = new File([content], filename, { type: mime }); } catch (e) {}
      if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: filename })
          .then(function () { toast(t('t_exported')); })
          .catch(function () {}); // user dismissed the share sheet
        return;
      }
      var blob = new Blob([content], { type: mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast(t('t_exported'));
    } catch (e) { toast(t('t_exportfail')); }
  }

  function exportData() {
    saveFile(JSON.stringify(state, null, 2), 'shiftpay-data.json', 'application/json');
  }

  // Detailed month export: one row per day (hours per tier, break, pay) + totals + % shares.
  function exportMonthCSV() {
    var rows = [];
    var tot = { gross: 0, brk: 0, paid: 0, h100: 0, h125: 0, h150: 0, pay: 0 };
    var daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
    for (var d = 1; d <= daysInMonth; d++) {
      var k = keyOf(view.y, view.m, d);
      var s = state.shifts[k];
      if (!s) continue;
      var res = dayResult(k);
      var wd = localeWeekdayShort(new Date(view.y, view.m, d).getDay());
      var typeName = t('leg_' + res.type);
      var brk = Math.round((res.grossHours - res.paidHours) * 60);
      var isVac = s.type === 'vacation';
      rows.push([k, wd, typeName, isVac ? '' : (s.start || ''), isVac ? '' : (s.end || ''),
        res.grossHours, brk, res.paidHours, res.hours['100'], res.hours['125'], res.hours['150'], res.pay]);
      tot.gross += res.grossHours; tot.brk += brk; tot.paid += res.paidHours;
      tot.h100 += res.hours['100']; tot.h125 += res.hours['125']; tot.h150 += res.hours['150']; tot.pay += res.pay;
    }
    if (!rows.length) { toast(t('t_nodata')); return; }

    var r2 = SalaryCalc.round2;
    function esc(v) { v = String(v); return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    function pct(a, b) { return r2(a / (b || 1) * 100) + '%'; }

    var headers = ['csv_date','csv_weekday','csv_type','csv_start','csv_end','csv_gross','csv_break',
      'csv_paid','csv_100','csv_125','csv_150','csv_pay'].map(function (kk) { return t(kk); });

    var lines = [t('csv_month') + ': ' + localeMonthYear(view.y, view.m)];
    lines.push(headers.map(esc).join(','));
    rows.forEach(function (r) {
      lines.push(r.map(function (c, i) { return esc(i >= 5 ? r2(c) : c); }).join(','));
    });
    lines.push([t('csv_total'), '', '', '', '', r2(tot.gross), Math.round(tot.brk), r2(tot.paid),
      r2(tot.h100), r2(tot.h125), r2(tot.h150), r2(tot.pay)].map(esc).join(','));
    lines.push([t('csv_share'), '', '', '', '', '', '', '100%',
      pct(tot.h100, tot.paid), pct(tot.h125, tot.paid), pct(tot.h150, tot.paid), ''].map(esc).join(','));

    var csv = '﻿' + lines.join('\r\n'); // UTF-8 BOM so Excel reads Hebrew/Arabic/Cyrillic
    saveFile(csv, 'shiftpay-' + view.y + '-' + pad(view.m + 1) + '.csv', 'text/csv;charset=utf-8');
  }

  function clearData() {
    if (!confirm(t('confirm_erase'))) return;
    state.shifts = {};
    state.profile = { name: '', rate: 0, currency: '₪' };
    save();
    closeSheetEl('settings', 'set-backdrop');
    showOnboarding();
  }

  /* ---------------- onboarding ---------------- */
  function submitOnboarding(e) {
    e.preventDefault();
    var name = $('onb-name').value.trim();
    var rate = parseFloat($('onb-rate').value);
    var cur = $('onb-currency').value.trim() || '₪';
    if (!name) { toast(t('t_name')); return; }
    if (!(rate >= 0) || isNaN(rate)) { toast(t('t_wage')); return; }
    state.profile = { name: name, rate: rate, currency: cur };
    save();
    showApp();
  }

  /* ---------------- wiring ---------------- */
  function bind() {
    $('onb-form').addEventListener('submit', submitOnboarding);

    $('prev-month').addEventListener('click', function () {
      view.m--; if (view.m < 0) { view.m = 11; view.y--; } renderView();
    });
    $('next-month').addEventListener('click', function () {
      view.m++; if (view.m > 11) { view.m = 0; view.y++; } renderView();
    });
    $('month-label').addEventListener('click', function () {
      var now = new Date(); view.y = now.getFullYear(); view.m = now.getMonth(); renderView();
    });

    $('fab-today').addEventListener('click', function () {
      var now = new Date(); view.y = now.getFullYear(); view.m = now.getMonth();
      renderView(); openSheet(todayKey());
    });

    document.querySelectorAll('#view-seg .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.prefs.view = b.getAttribute('data-view'); save(); renderView();
      });
    });

    // sheet
    $('sheet-close').addEventListener('click', function () { closeSheetEl('sheet', 'sheet-backdrop'); });
    $('sheet-backdrop').addEventListener('click', function () { closeSheetEl('sheet', 'sheet-backdrop'); });
    $('in-start').addEventListener('input', renderPreview);
    $('in-end').addEventListener('input', renderPreview);
    $('btn-save').addEventListener('click', saveShift);
    $('btn-delete').addEventListener('click', deleteShift);
    document.querySelectorAll('#type-seg .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () { setTypeSeg(b.getAttribute('data-type')); });
    });
    document.querySelectorAll('#mode-seg .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); applyFridayUi(editKey); });
    });

    // settings
    $('btn-settings').addEventListener('click', openSettings);
    $('set-close').addEventListener('click', function () { closeSheetEl('settings', 'set-backdrop'); });
    $('set-backdrop').addEventListener('click', function () { closeSheetEl('settings', 'set-backdrop'); });
    $('set-save').addEventListener('click', saveSettings);
    $('btn-export-csv').addEventListener('click', exportMonthCSV);
    $('btn-export').addEventListener('click', exportData);
    $('btn-clear').addEventListener('click', clearData);
    document.querySelectorAll('#theme-seg .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.prefs.theme = b.getAttribute('data-theme');
        document.querySelectorAll('#theme-seg .seg-btn').forEach(function (x) {
          x.classList.remove('active'); x.setAttribute('aria-pressed', 'false');
        });
        b.classList.add('active'); b.setAttribute('aria-pressed', 'true');
        save(); applyTheme();
      });
    });

    // PWA install
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault(); deferredInstall = e; addInstallButton();
    });
  }

  function addInstallButton() {
    if ($('btn-install')) return;
    var zone = document.querySelector('.danger-zone');
    if (!zone) return;
    var btn = document.createElement('button');
    btn.id = 'btn-install'; btn.className = 'btn-ghost';
    btn.textContent = t('install');
    btn.addEventListener('click', function () {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      deferredInstall.userChoice.finally(function () { deferredInstall = null; btn.remove(); });
    });
    zone.insertBefore(btn, zone.firstChild);
  }

  /* ---------------- boot ---------------- */
  function init() {
    load();
    migrate();
    applyTheme();
    applyLang();
    bind();
    if (!state.prefs.lang) showLangScreen();
    else if (state.profile.name && state.profile.rate) showApp();
    else showOnboarding();

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('service-worker.js').catch(function () {});
      });
    }
  }

  init();
})();
