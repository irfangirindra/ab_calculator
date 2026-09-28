#!/usr/bin/env node
/* Headless test suite. Run with:  node test/run-tests.js
 *
 * The modules are plain classic scripts that attach to globalThis.AB, so they
 * load in node with no shim. app.js is excluded because it touches the DOM at
 * load time; export.js loads fine because only its download / clipboard /
 * HTML-report functions need a document, and those are not called here.
 *
 * The golden conversion counts come from the real experiment exports and encode
 * the whole point of this tool: unit-level aggregation counts a unit that
 * converted on ANY date, where the old notebook's row-level dedup kept only the
 * unit's first date.
 */
'use strict';

require('../js/stats.js');
require('../js/csv.js');
require('../js/aggregate.js');
require('../js/analyze.js');
require('../js/render.js');
require('../js/export.js');

var AB = globalThis.AB;
var fs = require('fs');
var path = require('path');

var pass = 0, fail = 0;

function ok(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL  ' + label + (detail ? '  — ' + detail : ''));
}

function eq(label, got, want) {
  ok(label, got === want, 'got ' + got + ', want ' + want);
}

function near(label, got, want, tol) {
  ok(label, Math.abs(got - want) <= (tol || 1e-9) * Math.max(1, Math.abs(want)),
    'got ' + got + ', want ' + want);
}

function section(name) { console.log('\n' + name); }

// ── distributions ───────────────────────────────────────────────────────────
/* Cross-checked against normalization-free numerical integration (so the
 * reference does not depend on our own logGamma). Constants below were
 * produced that way, not recalled. */
section('distributions');
var S = AB.stats;
near('normCdf(1.96)', S.normCdf(1.96), 0.9750021048517795, 1e-12);
near('normSf(10) far tail', S.normSf(10), 7.619853024160525e-24, 1e-7);
near('normPpf(0.975)', S.normPpf(0.975), 1.959963984540054, 1e-9);
near('chi2Sf(3.8414588,1)', S.chi2Sf(3.841458820694124, 1), 0.05, 1e-9);
near('chi2Sf(0.5,3)', S.chi2Sf(0.5, 3), 0.9188914116546933, 1e-10);
near('chi2Sf(12.7,4)', S.chi2Sf(12.7, 4), 0.012838591451519272, 1e-10);
near('tSf2(2,10)', S.tSf2(2, 10), 0.0733880347707397, 1e-10);
near('tSf2(2.5,137.3) non-integer df', S.tSf2(2.5, 137.3), 0.013596539481759557, 1e-10);
near('tPpf(0.975,10)', S.tPpf(0.975, 10), 2.2281388519649385, 1e-8);
// The far chi-square tail must not collapse to 0 — a broken SRM should report
// a real p-value, not "p = 0.0000".
ok('chi2Sf(100,5) keeps tail precision', S.chi2Sf(100, 5) > 0 && S.chi2Sf(100, 5) < 1e-19,
  'got ' + S.chi2Sf(100, 5));

section('two-proportion z-test (notebook parity)');
var z = S.twoProportionZ({ nCtrl: 41295, convCtrl: 6600, nTrt: 41295, convTrt: 6779, alpha: 0.05 });
// Independent recomputation of the notebook's exact formula.
var rc = 6600 / 41295, rt = 6779 / 41295, dd = rt - rc;
var pp = (6600 + 6779) / (41295 * 2);
near('z statistic', z.stat, dd / Math.sqrt(pp * (1 - pp) * (2 / 41295)), 1e-12);
near('relative lift', z.lift, dd / rc, 1e-12);
var sed = Math.sqrt(rc * (1 - rc) / 41295 + rt * (1 - rt) / 41295);
near('CI low (unpooled SE / control rate)', z.ciLo, (dd - S.normPpf(0.975) * sed) / rc, 1e-12);

var z0 = S.twoProportionZ({ nCtrl: 500, convCtrl: 0, nTrt: 500, convTrt: 12, alpha: 0.05 });
eq('control rate 0 -> lift undefined', z0.liftDefined, false);
ok('control rate 0 -> NaN lift, not 0', isNaN(z0.lift));
eq('control rate 0 -> direction from rateDiff', z0.sig, 'positive');
var zz = S.twoProportionZ({ nCtrl: 500, convCtrl: 0, nTrt: 500, convTrt: 0, alpha: 0.05 });
eq('both arms 0 -> not_sig', zz.sig, 'not_sig');
ok('p-value never exceeds 1', zz.pVal <= 1, 'got ' + zz.pVal);

section('Welch t-test');
var c = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], t = c.map(function (v) { return v + 2; });
var sum = function (a) { return a.reduce(function (s, v) { return s + v; }, 0); };
var sq = function (a) { return a.reduce(function (s, v) { return s + v * v; }, 0); };
var w = S.welchT({
  nCtrl: 10, sumCtrl: sum(c), sumSqCtrl: sq(c),
  nTrt: 10, sumTrt: sum(t), sumSqTrt: sq(t), alpha: 0.05
});
near('mean control', w.rCtrl, 5.5, 1e-12);
near('mean treatment', w.rTrt, 7.5, 1e-12);
near('equal variances -> df = 18', w.df, 18, 1e-9);
near('t statistic', w.stat, 2 / Math.sqrt(2 * (55 / 6) / 10), 1e-10);

section('SRM');
var even = S.srm({ counts: [{ variant: 'C', n: 41295 }, { variant: 'V', n: 41295 }], alpha: 0.05 });
eq('even split not flagged', even.detected, false);
var uneven = [{ variant: 'C', n: 66000 }, { variant: 'V', n: 16590 }];
eq('80/20 data flagged under even expectation',
  S.srm({ counts: uneven, alpha: 0.05 }).detected, true);
eq('80/20 data not flagged under 80/20 expectation',
  S.srm({ counts: uneven, expectedRatio: { C: 80, V: 20 }, alpha: 0.05 }).detected, false);

// ── multiplicity corrections ────────────────────────────────────────────────
section('multiplicity (adjusted p-values)');
var P4 = [0.01, 0.02, 0.03, 0.045];

// Bonferroni: p * n, capped at 1.
var bonf = S.bonferroniAdjust(P4);
near('bonferroni p*n', bonf[0], 0.04, 1e-12);
near('bonferroni caps at 1', S.bonferroniAdjust([0.4, 0.5, 0.6])[2], 1, 1e-12);

/* BH reference computed by hand from the step-up definition:
 *   raw   p*n/rank            running min from the largest down
 *   .045  .045*4/4 = .045     .045
 *   .03   .03 *4/3 = .04      .04
 *   .02   .02 *4/2 = .04      .04   <- pulled down by the .03 term
 *   .01   .01 *4/1 = .04      .04
 */
var bh = S.bhAdjust(P4);
near('BH largest is p*n/n = p', bh[3], 0.045, 1e-12);
near('BH rank 3', bh[2], 0.04, 1e-12);
near('BH rank 2 takes running min', bh[1], 0.04, 1e-12);
near('BH rank 1 takes running min', bh[0], 0.04, 1e-12);
ok('BH is never stricter than Bonferroni',
  bh.every(function (v, i) { return v <= bonf[i] + 1e-12; }));
ok('BH monotone in p', bh[0] <= bh[1] + 1e-12 && bh[1] <= bh[2] + 1e-12 &&
  bh[2] <= bh[3] + 1e-12);

// Order independence: the same set shuffled must give each member the same value.
var shuffled = [0.03, 0.045, 0.01, 0.02];
var bhS = S.bhAdjust(shuffled);
near('BH order independent (0.01)', bhS[2], bh[0], 1e-12);
near('BH order independent (0.045)', bhS[1], bh[3], 1e-12);

// Single-member family must not move the p-value at all.
near('bonferroni family of 1 is identity', S.bonferroniAdjust([0.037])[0], 0.037, 1e-12);
near('BH family of 1 is identity', S.bhAdjust([0.037])[0], 0.037, 1e-12);

/* Non-finite p-values are degenerate tests carrying no evidence. They must not
 * count toward n, or they would penalise every real test beside them. */
var withNaN = S.bonferroniAdjust([0.01, NaN, 0.02]);
near('NaN held out of n (n=2, not 3)', withNaN[0], 0.02, 1e-12);
ok('NaN stays NaN', isNaN(withNaN[1]));
ok('all-NaN family survives', S.bhAdjust([NaN, NaN]).every(isNaN));
eq('empty family returns empty', S.adjustPValues([], 'bh').length, 0);
near('method "none" passes p through', S.adjustPValues([0.03], 'none')[0], 0.03, 1e-12);

section('role-aware correction');
var roleData = AB.csv.parse([
  'unit,variant,win_a,win_b,win_c,guard',
  // 300 rows are generated below; header only here.
].join('\n'));
(function () {
  // Treatment beats control on win_a only; guard is deliberately near-neutral.
  var rows = [];
  for (var i = 0; i < 400; i++) {
    var isTrt = i % 2 === 0;
    rows.push([
      'u' + i, isTrt ? 'VAR' : 'CONTROL',
      isTrt ? (i % 4 === 0 ? 1 : 0) : (i % 10 === 0 ? 1 : 0),   // strong effect
      i % 7 === 0 ? 1 : 0,
      i % 11 === 0 ? 1 : 0,
      isTrt ? (i % 6 === 0 ? 1 : 0) : (i % 5 === 0 ? 1 : 0)     // guardrail dip
    ]);
  }
  roleData.rows = rows;
})();

var roleCfg = {
  unitCol: 'unit', variantCol: 'variant', dateCol: null, controlName: 'CONTROL',
  segmentCols: [], alpha: 0.05,
  metrics: [
    { name: 'win_a', kind: 'binary', role: 'success' },
    { name: 'win_b', kind: 'binary', role: 'success' },
    { name: 'win_c', kind: 'binary', role: 'success' },
    { name: 'guard', kind: 'binary', role: 'guardrail' }
  ],
  correction: 'bh', correctionForVerdict: true
};

var rr = AB.analyze.run(roleData, roleCfg);
eq('family spans success metrics only, not guardrails',
  rr.correction.overallFamilyN, 3);
eq('guardrail not corrected', rr.overall.VAR.guard.corrected, false);
eq('guardrail pAdj equals raw p', rr.overall.VAR.guard.pAdj, rr.overall.VAR.guard.pVal);
eq('guardrail verdict unchanged by correction',
  AB.analyze.verdictOf(rr.overall.VAR.guard, true), rr.overall.VAR.guard.sig);
eq('success metric corrected', rr.overall.VAR.win_a.corrected, true);
ok('adjusted p >= raw p for success metric',
  rr.overall.VAR.win_a.pAdj >= rr.overall.VAR.win_a.pVal - 1e-12,
  rr.overall.VAR.win_a.pAdj + ' vs ' + rr.overall.VAR.win_a.pVal);
ok('raw p is preserved alongside the adjusted one',
  isFinite(rr.overall.VAR.win_a.pVal) && rr.overall.VAR.win_a.sig !== undefined);

// Alpha must never be divided, whatever the correction.
eq('alpha untouched by correction', rr.config.alpha, 0.05);

// Two arms x three success metrics = family of 6.
var roleData2 = { headers: roleData.headers, rows: roleData.rows.map(function (r) {
  return r.slice();
}) };
roleData2.rows.forEach(function (r, i) {
  if (r[1] === 'VAR' && i % 4 === 1) r[1] = 'VAR2';
});
var rr2 = AB.analyze.run(roleData2, roleCfg);
eq('family spans arms x success metrics', rr2.correction.overallFamilyN,
  rr2.treatments.length * 3);

// 'none' must leave every verdict exactly as the raw test found it.
var rrNone = AB.analyze.run(roleData,
  Object.assign({}, roleCfg, { correction: 'none', correctionForVerdict: true }));
['win_a', 'win_b', 'win_c', 'guard'].forEach(function (m) {
  eq('correction=none keeps raw verdict for ' + m,
    AB.analyze.verdictOf(rrNone.overall.VAR[m], true), rrNone.overall.VAR[m].sig);
  eq('correction=none marks nothing corrected for ' + m,
    rrNone.overall.VAR[m].corrected, false);
});

// Cumulative points are deliberately left raw — sequential, not multiplicity.
var otCfg = Object.assign({}, roleCfg, { dateCol: null });
ok('over-time absent without a date column', AB.analyze.run(roleData, otCfg).overTime === null);

section('rendered output reflects the correction');
/* Segment column and guardrail note only exist in the rendered markup, so they
 * need a render assertion — the numeric tests above cannot reach them.
 * Segment value is deliberately decoupled from the arm: if it tracked the arm,
 * every segment would hold one arm only and all rows would be dropped. */
var segData = AB.csv.parse('date_key,unit,variant,country,win,win2,guard\n');
(function () {
  var rows = [];
  for (var i = 0; i < 2400; i++) {
    var arm = ['CONTROL', 'VAR'][i % 2];
    var country = ['ID', 'SG', 'MY', 'TH'][Math.floor(i / 2) % 4];
    var day = '2026-06-' + (10 + Math.floor(i / 8) % 5);
    rows.push([day, 'u' + i, arm, country,
      (arm === 'VAR' ? i % 4 === 0 : i % 9 === 0) ? 1 : 0,
      (arm === 'VAR' ? i % 8 === 0 : i % 9 === 0) ? 1 : 0,
      (arm === 'VAR' ? i % 6 === 0 : i % 7 === 0) ? 1 : 0]);
  }
  segData.rows = rows;
})();

// Two success metrics so the overall family is genuinely > 1 — with a single
// arm and a single success metric there is nothing to correct, and the card
// would (correctly) show no adjusted p at all.
var segCfg = {
  unitCol: 'unit', variantCol: 'variant', dateCol: 'date_key', controlName: 'CONTROL',
  segmentCols: ['country'], alpha: 0.05,
  metrics: [
    { name: 'win', kind: 'binary', role: 'success' },
    { name: 'win2', kind: 'binary', role: 'success' },
    { name: 'guard', kind: 'binary', role: 'guardrail' }
  ],
  correction: 'bh', correctionForVerdict: true
};

var segRes = AB.analyze.run(segData, segCfg);
eq('segment rows built for all four countries',
  segRes.segments.VAR.country.win.length, 4);
eq('segment family size is the segment count',
  segRes.correction.segmentFamilyN.VAR.country.win, 4);
eq('overall family is arms x success metrics, guardrail excluded',
  segRes.correction.overallFamilyN, 2);
eq('guardrail segment rows uncorrected',
  segRes.segments.VAR.country.guard.every(function (r) { return !r.corrected; }), true);

var segHtml = AB.render.renderAll(segRes, { fileName: 'seg.csv', smallN: 100 });
eq('one "p adj" column per corrected success table',
  (segHtml.match(/<th class="r">p adj<\/th>/g) || []).length, 2);
ok('guardrail table says it is not corrected', /Guardrail &mdash; <strong>not corrected/
  .test(segHtml));
ok('note states alpha is not divided', /&alpha; stays 0\.05 rather than being divided/
  .test(segHtml));
ok('KPI cards show an adjusted p', /p<sub>adj<\/sub>/.test(segHtml));
ok('over-time panel disclaims the correction',
  /sequential<\/em> testing problem/.test(segHtml));
ok('rendered output free of undefined/NaN', !/undefined|>NaN<|NaN%/.test(segHtml));

// With the correction off, neither the column nor the adjusted line appears.
var offHtml = AB.render.renderAll(
  AB.analyze.run(segData, Object.assign({}, segCfg, { correction: 'none' })),
  { fileName: 'seg.csv', smallN: 100 });
eq('no "p adj" column when correction is off',
  (offHtml.match(/<th class="r">p adj<\/th>/g) || []).length, 0);
ok('no adjusted p line when correction is off', !/p<sub>adj<\/sub>/.test(offHtml));
ok('correction=none is stated explicitly', /no correction\. Every p-value below/.test(offHtml));

// ── CSV parsing ─────────────────────────────────────────────────────────────
section('CSV parsing');
var p = AB.csv.parse('a,b,c\r\n1,"he said ""hi"", ok",2\r\n3,plain,4\n');
eq('quoted field with escaped quotes', p.rows[0][1], 'he said "hi", ok');
eq('CRLF handled', p.rows.length, 2);
eq('BOM stripped', AB.csv.parse('﻿x,y\n1,2').headers[0], 'x');
eq('blank trailing line dropped', AB.csv.parse('x,y\n1,2\n\n').rows.length, 1);
eq('ragged row padded', AB.csv.parse('x,y,z\n1,2\n').rows[0].length, 3);
eq('boolean true -> 1', AB.csv.toNumber('true'), 1);
eq('boolean false -> 0', AB.csv.toNumber('false'), 0);
eq('blank -> 0', AB.csv.toNumber(''), 0);

// ── unit-level aggregation edge cases ───────────────────────────────────────
section('unit-level aggregation');
var edge = AB.csv.parse([
  'date_key,unit,variant,seg,bin,cont',
  // The case this tool exists for: no conversion on the 20th, conversion on the 21st.
  '2026-06-20,u1,CONTROL,B2C,0,5',
  '2026-06-21,u1,CONTROL,B2C,1,7',
  // Segment collision with the LATER date listed first — earliest must still win.
  '2026-06-21,u2,CONTROL,Metasearch,0,1',
  '2026-06-20,u2,CONTROL,B2C,0,2',
  '2026-06-20,u3,VAR,B2C,1,3',
  // Contaminated: same unit under two variants.
  '2026-06-20,x1,CONTROL,B2C,1,4',
  '2026-06-21,x1,VAR,B2C,1,4'
].join('\n'));

var cfgEdge = {
  unitCol: 'unit', variantCol: 'variant', dateCol: 'date_key',
  segmentCols: ['seg'],
  metrics: [{ name: 'bin', kind: 'binary' }, { name: 'cont', kind: 'continuous' }]
};
var col = AB.aggregate.collapseToUnits(edge, cfgEdge);
var byUnit = {};
col.units.forEach(function (u) { byUnit[u.unit] = u; });

eq('binary metric takes MAX across dates', byUnit.u1.values.bin, 1);
eq('continuous metric takes SUM across dates', byUnit.u1.values.cont, 12);
eq('multi-date unit counted', byUnit.u1.nDates, 2);
eq('segment from earliest date, not file order', byUnit.u2.segments.seg, 'B2C');
eq('contaminated unit excluded by default', byUnit.x1, undefined);
eq('excludedUnits populated', col.excludedUnits.has('x1'), true);
eq('unitsOut counts analysed units only', col.diagnostics.unitsOut, 3);
eq('contaminated counted in diagnostics', col.diagnostics.contaminatedUnits, 1);
eq('segment collision counted per unit', col.diagnostics.segmentCollisionUnits, 1);

var cfgInc = Object.assign({}, cfgEdge, { includeContaminated: true });
var colInc = AB.aggregate.collapseToUnits(edge, cfgInc);
eq('contaminated unit included when opted in', colInc.diagnostics.unitsOut, 4);
eq('included contaminated assigned earliest-date variant',
  colInc.units.filter(function (u) { return u.unit === 'x1'; })[0].variant, 'CONTROL');

// ── golden numbers from the real experiment exports ─────────────────────────
var DATA_DIR = '/Users/muhammad.girindra/platform-analytics/sandbox_user/' +
  'muhammad.girindra/ab_test_calculator';

var GOLDEN = [
  {
    file: 'bquxjob_645d9f61_19f68b2652a.csv',
    units: 1320, multiDate: 205,
    // Old notebook row-dedup values in comments — the gap is the bug being fixed.
    conv: {
      CVR_to_login: 271,          // notebook: 244  (+11.1%)
      CVR_to_issued: 306,         // notebook: 284
      CVR_to_submitBooking: 355,  // notebook: 327
      CVR_to_paymentPage: 467,    // notebook: 430
      is_save_passenger: 457      // boolean true/false parsing
    }
  },
  {
    // Negative control: no unit spans dates, so unit-level == row-level here.
    file: 'bquxjob_219aff57_19f68cbc522.csv',
    units: 82590, multiDate: 0,
    conv: { CVR_to_login: 13379, CVR_to_submitBooking: 30270, CVR_to_paymentPage: 33056 }
  },
  {
    file: 'bquxjob_15fc6201_19f68cd85a2.csv',
    units: 82590, multiDate: 88, segCollisions: 135,
    conv: { CVR_to_login: 13379, CVR_to_submitBooking: 30270, CVR_to_paymentPage: 33056 }
  }
];

section('golden numbers (real experiment exports)');
var ranGolden = 0;

GOLDEN.forEach(function (g) {
  var full = path.join(DATA_DIR, g.file);
  if (!fs.existsSync(full)) {
    console.log('  SKIP  ' + g.file + ' (not present)');
    return;
  }
  ranGolden++;
  var data = AB.csv.parse(fs.readFileSync(full, 'utf8'));
  var kinds = AB.csv.detectColumnKinds(data.headers, data.rows);
  var cfg = AB.csv.suggestConfig(data.headers, data.rows, kinds);
  cfg.segmentCols = data.headers.indexOf('traffic_type') >= 0 ? ['traffic_type'] : [];
  cfg.alpha = 0.05;

  var res = AB.aggregate.collapseToUnits(data, cfg);
  eq(g.file + ' unitsOut', res.diagnostics.unitsOut, g.units);
  eq(g.file + ' multiDateUnits', res.diagnostics.multiDateUnits, g.multiDate);
  if (g.segCollisions !== undefined) {
    eq(g.file + ' segmentCollisionUnits', res.diagnostics.segmentCollisionUnits, g.segCollisions);
  }
  Object.keys(g.conv).forEach(function (m) {
    var n = 0;
    for (var i = 0; i < res.units.length; i++) if (res.units[i].values[m] > 0) n++;
    eq(g.file + ' conv ' + m, n, g.conv[m]);
  });

  // Cumulative series must converge to exactly the same totals as the one-shot
  // collapse — this is what catches incremental-accumulator drift.
  var cum = AB.aggregate.buildCumulativeSeries(data, cfg, res.excludedUnits);
  cfg.metrics.forEach(function (m) {
    cum.variants.forEach(function (v) {
      var arr = cum.series[m.name][v];
      var last = arr[arr.length - 1];
      var n = 0, conv = 0;
      res.units.forEach(function (u) {
        if (u.variant !== v) return;
        n++;
        if (u.values[m.name] > 0) conv++;
      });
      eq(g.file + ' cumulative n ' + m.name + '/' + v, last.n, n);
      eq(g.file + ' cumulative conv ' + m.name + '/' + v, last.conv, conv);
      eq(g.file + ' series aligned to dates ' + m.name + '/' + v, arr.length, cum.dates.length);
      for (var i = 1; i < arr.length; i++) {
        if (arr[i].n < arr[i - 1].n || arr[i].conv < arr[i - 1].conv) {
          ok(g.file + ' cumulative monotonic ' + m.name + '/' + v, false, 'drop at index ' + i);
          return;
        }
      }
    });
  });

  // Full pipeline should render without throwing.
  var result = AB.analyze.run(data, cfg);
  var html = AB.render.renderAll(result, { fileName: g.file, smallN: 100 });
  ok(g.file + ' renders non-trivial HTML', html.length > 3000, html.length + ' chars');
  ok(g.file + ' no literal undefined/NaN in output',
    !/>undefined<|>NaN<|NaN%/.test(html));

  /* Render again with a correction live and driving verdicts. This is the path
   * that adds a table column and a card line, so it has its own chances to emit
   * undefined — the uncorrected render above would not catch that. */
  ['bonferroni', 'bh'].forEach(function (method) {
    var cfgC = Object.assign({}, cfg, {
      correction: method, correctionForVerdict: true
    });
    var resC = AB.analyze.run(data, cfgC);
    var htmlC = AB.render.renderAll(resC, { fileName: g.file, smallN: 100 });
    ok(g.file + ' renders with ' + method, htmlC.length > 3000, htmlC.length + ' chars');
    ok(g.file + ' no undefined/NaN with ' + method,
      !/>undefined<|>NaN<|NaN%|undefined</.test(htmlC));
    eq(g.file + ' alpha not divided under ' + method, resC.config.alpha, 0.05);

    // Correcting can only ever remove significance, never create it.
    var gained = [];
    resC.treatments.forEach(function (trt) {
      cfg.metrics.forEach(function (m) {
        var raw = result.overall[trt][m.name], adj = resC.overall[trt][m.name];
        if (raw.sig === 'not_sig' && AB.analyze.verdictOf(adj, true) !== 'not_sig') {
          gained.push(trt + '/' + m.name);
        }
      });
    });
    eq(g.file + ' ' + method + ' never creates significance', gained.length, 0);

    // Every exported row must carry both p-values and a resolved verdict.
    var rows = AB.export.flattenAll(resC);
    ok(g.file + ' export rows present under ' + method, rows.length > 0);
    ok(g.file + ' every export row has a verdict under ' + method,
      rows.every(function (r) { return r.verdict === 'positive' ||
        r.verdict === 'negative' || r.verdict === 'not_sig'; }));
    ok(g.file + ' corrected rows carry family_n under ' + method,
      rows.every(function (r) {
        return r.correction === 'none' || (r.family_n > 1 && r.p_adjusted !== '');
      }));
  });
});

if (!ranGolden) {
  console.log('  note: no golden files found — statistical and edge-case tests still ran.');
}

// ── continuous metric consistency ───────────────────────────────────────────
section('continuous metric sumSq consistency');
var contCfg = {
  unitCol: 'unit', variantCol: 'variant', dateCol: 'date_key', segmentCols: [],
  metrics: [{ name: 'cont', kind: 'continuous' }]
};
var cc = AB.aggregate.collapseToUnits(edge, contCfg);
var cumc = AB.aggregate.buildCumulativeSeries(edge, contCfg, cc.excludedUnits);
cumc.variants.forEach(function (v) {
  var arr = cumc.series.cont[v], last = arr[arr.length - 1];
  var n = 0, s = 0, ss = 0;
  cc.units.forEach(function (u) {
    if (u.variant !== v) return;
    n++; s += u.values.cont; ss += u.values.cont * u.values.cont;
  });
  eq('cumulative n ' + v, last.n, n);
  near('cumulative sum ' + v, last.sum, s, 1e-12);
  near('cumulative sumSq ' + v, last.sumSq, ss, 1e-12);
});

// ── report ──────────────────────────────────────────────────────────────────
console.log('\n' + (fail === 0
  ? 'ALL PASS — ' + pass + ' assertions'
  : fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
