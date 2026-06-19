/*
 * Salary pay-calculation engine.
 *
 * Pure functions, no DOM access, so the exact same code runs in the browser
 * (attached to window.SalaryCalc) and under Node for the unit tests.
 *
 * DAILY shift rules (percent = multiple of the hourly rate):
 *
 *   MORNING (starts ~06:00 / 07:00) - tiers by HOURS WORKED:
 *       first 9 hours        -> 100%
 *       next 2 hours (9-11)  -> 125%
 *       beyond 11 hours      -> 150%
 *
 *   EVENING (starts ~16:00) - tiers by CLOCK TIME:
 *       from start .. 23:00  -> 125%
 *       23:00 and later      -> 150%   (incl. hours after midnight)
 *
 *   NIGHT (starts ~18:50 / 19:00, runs into the early morning):
 *       every hour           -> 150%   (flat)
 *
 * WEEKLY rule (work week starts Sunday):
 *   FRIDAY is special. Hours worked Sun..Thu accumulate toward 42h.
 *   On Friday: hours that COMPLETE the week up to 42h -> 100% (flat),
 *   the next 2 hours -> 125%, anything beyond -> 150%.
 *   (Sun..Thu keep their own daily shift rules above.)
 *
 * BREAKS (unpaid, removed from the LOWEST-rate tier of the day):
 *   every worked day -> 45 minutes, except FRIDAY -> 15 minutes.
 *
 * PAID VACATION (a day not worked):
 *   pays 8.6 hours x hourly rate x 100%. Does NOT count toward the 42h week.
 */
(function (global) {
  'use strict';

  var SHIFT_TYPES = ['morning', 'evening', 'night'];

  var SHIFT_META = {
    morning:  { label: 'Morning',  emoji: '☀️', accent: '#f59e0b' },
    evening:  { label: 'Evening',  emoji: '🌆', accent: '#6366f1' },
    night:    { label: 'Night',    emoji: '🌙', accent: '#8b5cf6' },
    friday:   { label: 'Friday',   emoji: '🕯️', accent: '#0ea5e9' },
    vacation: { label: 'Vacation', emoji: '🏖️', accent: '#10b981' }
  };

  var MINUTES_PER_DAY = 24 * 60;
  var WEEKLY_THRESHOLD_MIN = 42 * 60; // 42h
  var VACATION_HOURS = 8.6;
  var BREAK_MIN = 45;
  var FRIDAY_BREAK_MIN = 15;
  var FRIDAY_OT_125_MIN = 2 * 60; // first 2 overtime hours at 125%

  /** "HH:MM" -> minutes since midnight. */
  function parseTimeToMinutes(t) {
    var parts = String(t).split(':');
    var h = parseInt(parts[0], 10) || 0;
    var m = parseInt(parts[1], 10) || 0;
    return h * 60 + m;
  }

  /**
   * Guess the shift type from the start time. The user can always override.
   *   05:00-15:59 -> morning   (catches 06:00, 07:00, plus midday/day shifts -> tiered)
   *   16:00-18:44 -> evening   (catches 16:00)
   *   18:45-04:59 -> night     (catches 18:50, 19:00, and after-midnight starts)
   */
  function detectShiftType(startStr) {
    var m = parseTimeToMinutes(startStr);
    if (m >= 5 * 60 && m < 16 * 60) return 'morning';
    if (m >= 16 * 60 && m < 18 * 60 + 45) return 'evening';
    return 'night';
  }

  /**
   * Resolve start/end into absolute minutes. If the end time is the same as or
   * earlier than the start, the shift is assumed to cross midnight (+1 day).
   */
  function shiftBounds(startStr, endStr) {
    var startMin = parseTimeToMinutes(startStr);
    var endMin = parseTimeToMinutes(endStr);
    if (endMin <= startMin) endMin += MINUTES_PER_DAY;
    return { startMin: startMin, endMin: endMin, durationMin: endMin - startMin };
  }

  var EVENING_REGULAR_UNTIL_MIN = 15 * 60 + 30; // 15:30 — before this, evening hours are 100%
  var EVENING_OT_UNTIL_MIN = 23 * 60;           // 23:00 — 125% up to here, 150% after

  /**
   * The pay multiplier (as a percent) for a single worked minute.
   * @param absMin            absolute minute of this slot (startMin + i, not wrapped)
   * @param eveningSplitAbs   absolute minute of the evening 125%->150% boundary (23:00)
   * @param eveningCutoffAbs  absolute minute of the evening 100%->125% boundary (15:30)
   */
  function percentForMinute(type, elapsedMin, clockMin, absMin, eveningSplitAbs, eveningCutoffAbs) {
    if (type === 'night') return 150;

    if (type === 'morning') {
      var eh = elapsedMin / 60;
      if (eh < 9) return 100;   // first 9 hours
      if (eh < 11) return 125;  // next 2 hours
      return 150;               // beyond 11 hours
    }

    // evening - early hours (before 15:30) are 100%, then 125% until 23:00, then 150%.
    if (absMin < eveningCutoffAbs) return 100;
    if (absMin < eveningSplitAbs) return 125;
    return 150;
  }

  /** Absolute minute of the first 23:00 at or after the shift start. */
  function eveningSplitFor(startMin) {
    var k = EVENING_OT_UNTIL_MIN;
    return startMin <= k ? k : k + MINUTES_PER_DAY;
  }
  /** Absolute minute where evening 100% ends (15:30). If the shift starts at/after
      15:30 there is no 100% portion, so the cutoff is the start itself. */
  function eveningCutoffFor(startMin) {
    return startMin < EVENING_REGULAR_UNTIL_MIN ? EVENING_REGULAR_UNTIL_MIN : startMin;
  }

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function emptyMins() { return { 100: 0, 125: 0, 150: 0 }; }

  /**
   * Tier a worked shift's clock minutes into percentage buckets using the
   * DAILY shift-type rules. Returns { type, mins, durationMin, startMin }.
   * No break and no weekly rule applied here.
   */
  function tierShift(startStr, endStr, typeOpt) {
    var type = (typeOpt && typeOpt !== 'auto') ? typeOpt : detectShiftType(startStr);
    var bounds = shiftBounds(startStr, endStr);
    var eveningSplit = eveningSplitFor(bounds.startMin);
    var eveningCutoff = eveningCutoffFor(bounds.startMin);
    var mins = emptyMins();
    for (var i = 0; i < bounds.durationMin; i++) {
      var absMin = bounds.startMin + i;
      var clock = absMin % MINUTES_PER_DAY;
      var p = percentForMinute(type, i, clock, absMin, eveningSplit, eveningCutoff);
      mins[p] += 1;
    }
    return { type: type, mins: mins, durationMin: bounds.durationMin, startMin: bounds.startMin };
  }

  /**
   * Tier a Friday's clock minutes using the WEEKLY 42h-completion rule.
   * @param durationMin  Friday worked minutes (clock)
   * @param prevPaidMin  paid minutes already worked Sun..Thu this week
   */
  function tierFriday(durationMin, prevPaidMin) {
    var allowance = Math.max(0, WEEKLY_THRESHOLD_MIN - (prevPaidMin || 0));
    var base = Math.min(durationMin, allowance);          // 100% completion hours
    var after = durationMin - base;
    var ot125 = Math.min(after, FRIDAY_OT_125_MIN);        // first 2 OT hours
    var ot150 = after - ot125;                             // beyond
    return { 100: base, 125: ot125, 150: ot150 };
  }

  /**
   * Remove `breakMin` unpaid minutes from the LOWEST-rate non-empty tier first,
   * spilling upward (100 -> 125 -> 150) if a tier runs out. Mutates and returns mins.
   */
  function applyBreak(mins, breakMin) {
    var order = [100, 125, 150];
    var rem = breakMin;
    for (var i = 0; i < order.length && rem > 0; i++) {
      var k = order[i];
      var take = Math.min(mins[k], rem);
      mins[k] -= take;
      rem -= take;
    }
    return mins;
  }

  /** Build a result object from minute buckets. */
  function buildResult(mins, rate, type, grossMin) {
    var r = Number(rate) || 0;
    var h100 = mins[100] / 60, h125 = mins[125] / 60, h150 = mins[150] / 60;
    var paidMin = mins[100] + mins[125] + mins[150];
    var pay = r * (h100 * 1.0 + h125 * 1.25 + h150 * 1.5);
    var basePay = r * (paidMin / 60);
    return {
      type: type,
      kind: 'work',
      grossHours: round2(grossMin / 60),
      paidHours: round2(paidMin / 60),
      totalHours: round2(paidMin / 60),
      paidMinutes: paidMin,
      hours: { '100': round2(h100), '125': round2(h125), '150': round2(h150) },
      pay: round2(pay),
      basePay: round2(basePay),
      extraPay: round2(pay - basePay)
    };
  }

  /* ---------------- public compute functions ---------------- */

  /**
   * Raw single shift, NO break, NO weekly rule. (Kept for the daily-tier tests
   * and as a building block.)
   */
  function computeShift(opts) {
    var t = tierShift(opts.start, opts.end, opts.type);
    return buildResult(t.mins, opts.rate, t.type, t.durationMin);
  }

  /** A normal worked day (Sun..Thu / Sat): daily tiers + break removed from lowest tier. */
  function computeWorkedDay(start, end, type, rate, breakMin) {
    var t = tierShift(start, end, type);
    applyBreak(t.mins, breakMin == null ? BREAK_MIN : breakMin);
    return buildResult(t.mins, rate, t.type, t.durationMin);
  }

  /** Friday: weekly 42h completion tiers + (15min) break removed from lowest tier. */
  function computeFriday(start, end, rate, prevPaidMin, breakMin) {
    var bounds = shiftBounds(start, end);
    var mins = tierFriday(bounds.durationMin, prevPaidMin || 0);
    applyBreak(mins, breakMin == null ? FRIDAY_BREAK_MIN : breakMin);
    var res = buildResult(mins, rate, 'friday', bounds.durationMin);
    res.prevPaidMin = prevPaidMin || 0;
    res.weeklyBeforeHours = round2((prevPaidMin || 0) / 60);
    return res;
  }

  /** Paid minutes a worked day contributes toward the weekly 42h (after break). */
  function paidMinutesForWorkedDay(start, end, type, breakMin) {
    var t = tierShift(start, end, type);
    applyBreak(t.mins, breakMin == null ? BREAK_MIN : breakMin);
    return t.mins[100] + t.mins[125] + t.mins[150];
  }

  /** Paid vacation day: 8.6h x rate x 100%. */
  function vacationResult(rate) {
    var r = Number(rate) || 0;
    return {
      type: 'vacation',
      kind: 'vacation',
      grossHours: VACATION_HOURS,
      paidHours: VACATION_HOURS,
      totalHours: VACATION_HOURS,
      paidMinutes: Math.round(VACATION_HOURS * 60),
      hours: { '100': VACATION_HOURS, '125': 0, '150': 0 },
      pay: round2(r * VACATION_HOURS),
      basePay: round2(r * VACATION_HOURS),
      extraPay: 0
    };
  }

  /**
   * Compute one day's pay given its week context.
   * @param o.shift        { start, end, type } or { type:'vacation' }
   * @param o.isFriday     boolean
   * @param o.rate         hourly rate
   * @param o.prevPaidMin  paid minutes Sun..Thu (only used for Friday)
   */
  function computeDayPay(o) {
    if (!o.shift) return null;
    if (o.shift.type === 'vacation') return vacationResult(o.rate);
    if (o.isFriday) return computeFriday(o.shift.start, o.shift.end, o.rate, o.prevPaidMin || 0);
    return computeWorkedDay(o.shift.start, o.shift.end, o.shift.type, o.rate, BREAK_MIN);
  }

  var api = {
    SHIFT_TYPES: SHIFT_TYPES,
    SHIFT_META: SHIFT_META,
    WEEKLY_THRESHOLD_MIN: WEEKLY_THRESHOLD_MIN,
    VACATION_HOURS: VACATION_HOURS,
    BREAK_MIN: BREAK_MIN,
    FRIDAY_BREAK_MIN: FRIDAY_BREAK_MIN,
    parseTimeToMinutes: parseTimeToMinutes,
    detectShiftType: detectShiftType,
    shiftBounds: shiftBounds,
    eveningSplitFor: eveningSplitFor,
    eveningCutoffFor: eveningCutoffFor,
    percentForMinute: percentForMinute,
    tierShift: tierShift,
    tierFriday: tierFriday,
    applyBreak: applyBreak,
    round2: round2,
    computeShift: computeShift,
    computeWorkedDay: computeWorkedDay,
    computeFriday: computeFriday,
    paidMinutesForWorkedDay: paidMinutesForWorkedDay,
    vacationResult: vacationResult,
    computeDayPay: computeDayPay
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.SalaryCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
