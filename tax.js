/*
 * Israeli payroll deductions engine — income tax, National Insurance (Bituach
 * Leumi), health tax and mandatory pension, on a MONTHLY basis (Israeli
 * payroll withholding is a monthly period, not per-shift, so this module
 * only ever operates on a month's total gross pay, never a single shift).
 *
 * Pure functions, no DOM access — same file runs in the browser
 * (window.TaxCalc) and under Node for the unit tests.
 *
 * Figures below are the official rates effective January 2026. They change
 * every January — see TAX_META.year / TAX_META.sources for what to re-check.
 *
 * ---------------------------------------------------------------------------
 * INCOME TAX (מס הכנסה) — progressive monthly brackets, then a flat shekel
 * credit per "credit point" (נקודת זיכוי) is subtracted from the tax itself
 * (not from the income). Standard credit points: 2.25 for everyone, +0.5 for
 * women (2.75 total) — before any extra points (children, new immigrant,
 * single parent, etc.), which this app does not attempt to model.
 *
 * Separately, residents of a scheduled development-town/periphery settlement get a
 * discount (§11 of the Income Tax Ordinance) — 7–25% depending on the settlement —
 * computed as that % of GROSS INCOME itself (up to a fixed annual ceiling, 268,560
 * NIS/yr for 2024–2027), subtracted directly from the tax bill. It is NOT a percentage
 * of the computed tax. Which settlements qualify for which rate isn't something this
 * app looks up; the user enters the rate directly, same as with credit points.
 *
 * NOTE: the top statutory bracket (income above ~60,130/month, ~721,560/yr)
 * is also subject to "mas yasaf" (מס יסף, +3% surtax) on ANNUAL income above
 * a much higher yearly threshold. That surtax is reconciled annually via tax
 * return, not withheld monthly through the standard payroll tables, and is
 * intentionally NOT modeled here — it essentially never applies to hourly
 * shift wages anyway.
 *
 * ---------------------------------------------------------------------------
 * NATIONAL INSURANCE (ביטוח לאומי) + HEALTH TAX (ביטוח בריאות) — employee
 * share only. Two-tier: a reduced rate up to 60% of the national average
 * wage, a higher rate above it and up to the insurable-income ceiling.
 * Income above the ceiling pays no further NI/health at all.
 *
 * The reduced-rate "allowance" (the first NI_THRESHOLD of pay) is granted
 * ONCE per person, at whichever employer is their PRIMARY one:
 *   - Primary / only job: gets the full reduced-rate allowance on its own pay.
 *   - Secondary job, no "Bituach Leumi coordination" (תיאום דמי ביטוח):
 *       100% of that job's pay is charged at the FULL rate — by law the
 *       reduced rate is assumed fully used up at the primary job.
 *   - Secondary job WITH coordination: Bituach Leumi splits the allowance —
 *       the secondary job gets what the primary job didn't use, i.e.
 *       max(0, NI_THRESHOLD - primaryJobGross), at the reduced rate.
 *
 * ---------------------------------------------------------------------------
 * INCOME TAX ON A SECOND JOB (עבודה נוספת):
 *   - No "tax coordination" (תיאום מס): the law requires the SECOND employer
 *     to withhold at the flat top marginal rate (47%) on 100% of that job's
 *     pay, with NO credit points — regardless of how little it pays.
 *   - With tax coordination: the Tax Authority effectively taxes the two
 *     incomes as one stacked total (so credit points are granted once, and
 *     the second job is taxed at its true marginal rate rather than a flat
 *     47%). Modeled here as: tax(primary + secondary) - tax(primary alone).
 *
 * A "primary job" (מעסיק עיקרי) here always means the higher-paying /
 * declared-primary job for the purposes of the above rules; the tax
 * coordination and NI coordination toggles only change anything when the
 * job tracked in THIS app is the SECONDARY one. When the app-tracked job is
 * itself the primary job, it is withheld exactly as a single/standalone job
 * would be — the primary employer's own withholding doesn't change just
 * because a second job exists (that burden falls on the second employer).
 *
 * ---------------------------------------------------------------------------
 * PENSION (פנסיה חובה) — mandatory since 2017: 18.5% of pay in total, split
 * 6% employee / 12.5% employer (6.5% severance + 6% compensation). Only the
 * employee's 6% (default, editable) is a deduction from THIS payslip. The
 * statutory minimum contribution wage is capped at the national average
 * wage (min(gross, AVERAGE_WAGE)) — some pension schemes contribute on the
 * full salary instead, so treat amounts above the cap as an estimate.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var TAX_META = {
    year: 2026,
    effectiveFrom: '2026-01-01',
    sources: [
      'gov.il income-tax monthly deductions booklet (Jan 2026)',
      'btl.gov.il — National Insurance & health tax rates for employees',
      'btl.gov.il — Bituach Leumi coordination (תיאום דמי ביטוח)'
    ]
  };

  /* ---- income tax: monthly brackets (NIS), cumulative "up to" ---- */
  var INCOME_TAX_BRACKETS = [
    { upTo: 7010,     rate: 0.10 },
    { upTo: 10060,    rate: 0.14 },
    { upTo: 19000,    rate: 0.20 },
    { upTo: 25100,    rate: 0.31 },
    { upTo: 46690,    rate: 0.35 },
    { upTo: Infinity, rate: 0.47 }
  ];

  var CREDIT_POINT_MONTHLY = 242;   // NIS per נקודת זיכוי, per month
  var CREDIT_POINT_YEARLY = 2904;
  var CREDIT_POINTS_STANDARD = 2.25;        // every resident
  var CREDIT_POINTS_STANDARD_WOMAN = 2.75;  // +0.5 for women

  // Development-town / periphery residence discount (הנחת יישוב מוטב, Income Tax
  // Ordinance §11): a PERCENTAGE off the income tax itself (not off taxable income),
  // for residents of a scheduled settlement (Negev/Galilee development towns, border
  // communities, Eilat, etc.). The rate (commonly 7/10/12/14/16/18/20/25%) is set per
  // settlement by the Tax Authority's published list and isn't something this app can
  // look up — the user enters the rate directly, same as with credit points. Requires
  // 12 months' residence to qualify. Applies only up to an annual income ceiling, fixed
  // at 268,560 NIS/year for tax years 2024–2027 (not a 2026-specific figure).
  var PERIPHERY_CEILING_ANNUAL = 268560;
  var PERIPHERY_CEILING_MONTHLY = PERIPHERY_CEILING_ANNUAL / 12; // 22,380

  /* ---- National Insurance + health tax (employee share) ---- */
  var AVERAGE_WAGE = 13769;           // שכר ממוצע במשק, 2026
  var NI_THRESHOLD = 7703;            // 60% of AVERAGE_WAGE — reduced-rate ceiling
  var NI_CEILING = 51910;             // תקרת הכנסה חייבת בדמי ביטוח (5x avg wage)
  var NI_EMPLOYEE_REDUCED = 0.0104;
  var NI_EMPLOYEE_FULL = 0.07;
  var HEALTH_EMPLOYEE_REDUCED = 0.0323;
  var HEALTH_EMPLOYEE_FULL = 0.0517;

  var SECOND_JOB_FLAT_TAX_RATE = 0.47; // uncoordinated 2nd job: flat top rate, no credits

  /* ---- pension ---- */
  var PENSION_DEFAULT_RATE_PCT = 6;   // employee share, % of pay
  var PENSION_WAGE_CAP = AVERAGE_WAGE;

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }
  function num(n) {
    var v = Number(n);
    return isFinite(v) && v > 0 ? v : 0;
  }

  /** Gross monthly income tax (before credit points), by the 2026 brackets. */
  function grossIncomeTax(monthlyIncome) {
    var income = num(monthlyIncome);
    var tax = 0, lower = 0;
    for (var i = 0; i < INCOME_TAX_BRACKETS.length; i++) {
      var b = INCOME_TAX_BRACKETS[i];
      if (income > lower) tax += (Math.min(income, b.upTo) - lower) * b.rate;
      lower = b.upTo;
      if (income <= b.upTo) break;
    }
    return tax;
  }

  /**
   * Income tax after subtracting credit-point value and, if given, the periphery/
   * development-town discount. That discount is a % of GROSS INCOME itself (up to
   * PERIPHERY_CEILING_MONTHLY) subtracted directly from the tax bill — NOT a
   * percentage of the computed tax. E.g. 12% discount on 14,492 gross knocks
   * 1,739 straight off the tax, regardless of what the bracket tax came to.
   * Never negative.
   */
  function incomeTaxAfterCredits(monthlyIncome, creditPoints, peripheryDiscountPct) {
    var credit = Math.max(0, Number(creditPoints) || 0) * CREDIT_POINT_MONTHLY;
    var pct = Math.max(0, Number(peripheryDiscountPct) || 0);
    var periphery = pct > 0 ? (pct / 100) * Math.min(num(monthlyIncome), PERIPHERY_CEILING_MONTHLY) : 0;
    return Math.max(0, grossIncomeTax(monthlyIncome) - credit - periphery);
  }

  /**
   * Employee National Insurance + health tax for one job's gross pay.
   * @param reducedAllowance  how much of THIS job's pay may use the reduced
   *   rate (0..NI_THRESHOLD): NI_THRESHOLD for a primary/standalone job,
   *   0 for an uncoordinated secondary job, or the leftover allowance
   *   max(0, NI_THRESHOLD - primaryJobGross) for a coordinated secondary job.
   */
  function niAndHealth(gross, reducedAllowance) {
    var g = num(gross);
    var allowance = Math.max(0, Math.min(NI_THRESHOLD, Number(reducedAllowance) || 0));
    var insurable = Math.min(g, NI_CEILING); // nothing due above the ceiling
    var reducedPortion = Math.min(insurable, allowance);
    var fullPortion = insurable - reducedPortion;
    return {
      ni: reducedPortion * NI_EMPLOYEE_REDUCED + fullPortion * NI_EMPLOYEE_FULL,
      health: reducedPortion * HEALTH_EMPLOYEE_REDUCED + fullPortion * HEALTH_EMPLOYEE_FULL,
      insurable: insurable,
      reducedPortion: reducedPortion,
      fullPortion: fullPortion
    };
  }

  /** Employee pension deduction: rate% of pay, capped at AVERAGE_WAGE (statutory minimum base). */
  function pensionEmployee(gross, ratePct) {
    var base = Math.min(num(gross), PENSION_WAGE_CAP);
    var rate = Math.max(0, Number(ratePct)) / 100;
    return base * (isFinite(rate) ? rate : 0);
  }

  /**
   * Full monthly deduction breakdown for the job tracked in this app.
   * @param o.grossPay        this job's gross pay for the month
   * @param o.creditPoints    נקודות זיכוי (default 2.25 if omitted)
   * @param o.peripheryDiscountPct  הנחת יישוב מוטב/פיתוח, % off tax (default 0)
   * @param o.hasSecondJob    the person has another job besides this one
   * @param o.isPrimaryJob    only read when hasSecondJob: true if the job
   *                          tracked in THIS app is the primary employer
   * @param o.primaryJobGross only read when hasSecondJob && !isPrimaryJob:
   *                          gross monthly pay at the (other) primary employer
   * @param o.taxCoordination   יש תיאום מס  (only matters when secondary)
   * @param o.niCoordination    יש תיאום דמי ביטוח לאומי (only matters when secondary)
   * @param o.pensionEnabled  default true
   * @param o.pensionRatePct  default PENSION_DEFAULT_RATE_PCT (6)
   */
  function computeMonthlyDeductions(o) {
    o = o || {};
    var gross = num(o.grossPay);
    var creditPoints = Number(o.creditPoints);
    if (!(creditPoints >= 0)) creditPoints = CREDIT_POINTS_STANDARD;
    var peripheryPct = Math.max(0, Number(o.peripheryDiscountPct) || 0);

    var secondary = !!o.hasSecondJob && !o.isPrimaryJob;
    var primaryGross = num(o.primaryJobGross);

    var incomeTax, taxMethod, niRes;

    if (!secondary) {
      incomeTax = incomeTaxAfterCredits(gross, creditPoints, peripheryPct);
      taxMethod = 'standard';
      niRes = niAndHealth(gross, NI_THRESHOLD);
    } else if (o.taxCoordination) {
      var totalTax = incomeTaxAfterCredits(primaryGross + gross, creditPoints, peripheryPct);
      var primaryTax = incomeTaxAfterCredits(primaryGross, creditPoints, peripheryPct);
      incomeTax = Math.max(0, totalTax - primaryTax);
      taxMethod = 'coordinated';
    } else {
      incomeTax = gross * SECOND_JOB_FLAT_TAX_RATE;
      taxMethod = 'flat47';
    }

    if (secondary) {
      var allowance = o.niCoordination ? Math.max(0, NI_THRESHOLD - primaryGross) : 0;
      niRes = niAndHealth(gross, allowance);
    }

    var pensionEnabled = o.pensionEnabled !== false;
    var pensionRatePct = o.pensionRatePct != null ? o.pensionRatePct : PENSION_DEFAULT_RATE_PCT;
    var pension = pensionEnabled ? pensionEmployee(gross, pensionRatePct) : 0;

    var totalDeductions = incomeTax + niRes.ni + niRes.health + pension;

    return {
      grossPay: round2(gross),
      incomeTax: round2(incomeTax),
      taxMethod: taxMethod,       // 'standard' | 'coordinated' | 'flat47'
      ni: round2(niRes.ni),
      health: round2(niRes.health),
      pension: round2(pension),
      totalDeductions: round2(totalDeductions),
      netPay: round2(gross - totalDeductions)
    };
  }

  var api = {
    TAX_META: TAX_META,
    INCOME_TAX_BRACKETS: INCOME_TAX_BRACKETS,
    CREDIT_POINT_MONTHLY: CREDIT_POINT_MONTHLY,
    CREDIT_POINT_YEARLY: CREDIT_POINT_YEARLY,
    CREDIT_POINTS_STANDARD: CREDIT_POINTS_STANDARD,
    CREDIT_POINTS_STANDARD_WOMAN: CREDIT_POINTS_STANDARD_WOMAN,
    PERIPHERY_CEILING_ANNUAL: PERIPHERY_CEILING_ANNUAL,
    PERIPHERY_CEILING_MONTHLY: PERIPHERY_CEILING_MONTHLY,
    AVERAGE_WAGE: AVERAGE_WAGE,
    NI_THRESHOLD: NI_THRESHOLD,
    NI_CEILING: NI_CEILING,
    NI_EMPLOYEE_REDUCED: NI_EMPLOYEE_REDUCED,
    NI_EMPLOYEE_FULL: NI_EMPLOYEE_FULL,
    HEALTH_EMPLOYEE_REDUCED: HEALTH_EMPLOYEE_REDUCED,
    HEALTH_EMPLOYEE_FULL: HEALTH_EMPLOYEE_FULL,
    SECOND_JOB_FLAT_TAX_RATE: SECOND_JOB_FLAT_TAX_RATE,
    PENSION_DEFAULT_RATE_PCT: PENSION_DEFAULT_RATE_PCT,
    PENSION_WAGE_CAP: PENSION_WAGE_CAP,
    round2: round2,
    grossIncomeTax: grossIncomeTax,
    incomeTaxAfterCredits: incomeTaxAfterCredits,
    niAndHealth: niAndHealth,
    pensionEmployee: pensionEmployee,
    computeMonthlyDeductions: computeMonthlyDeductions
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.TaxCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
