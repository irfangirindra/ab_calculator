/* analyze.js — turns collapsed unit records into test results.
 *
 * Mirrors the notebook's stats_overall / stats_segments structures, with two
 * differences: multiple segment columns instead of a single SEGMENT_COL, and a
 * per-metric choice of test (z-test for binary, Welch t-test for continuous).
 */
(function (root) {
  'use strict';

  var S = root.AB.stats;

  function isBinary(metric) { return metric.kind === 'binary'; }

  // Accumulate one metric over a set of units, split by variant.
  function accumulate(units, metricName, binary) {
    var out = Object.create(null);
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      var a = out[u.variant];
      if (!a) { a = out[u.variant] = { n: 0, conv: 0, sum: 0, sumSq: 0 }; }
      a.n++;
      var v = u.values[metricName];
      if (binary) {
        if (v > 0) a.conv++;
      } else {
        a.sum += v;
        a.sumSq += v * v;
      }
    }
    return out;
  }

  var EMPTY = { n: 0, conv: 0, sum: 0, sumSq: 0 };

  /* Run the appropriate test for one metric given two accumulators.
   * Both branches return the same field set, so callers never need to know
   * which test ran (except for number formatting). */
  function runTest(metric, ctrlAcc, trtAcc, alpha) {
    var c = ctrlAcc || EMPTY, t = trtAcc || EMPTY;
    if (isBinary(metric)) {
      return S.twoProportionZ({
        nCtrl: c.n, convCtrl: c.conv,
        nTrt: t.n, convTrt: t.conv,
        alpha: alpha
      });
    }
    return S.welchT({
      nCtrl: c.n, sumCtrl: c.sum, sumSqCtrl: c.sumSq,
      nTrt: t.n, sumTrt: t.sum, sumSqTrt: t.sumSq,
      alpha: alpha
    });
  }

  // ── overall ───────────────────────────────────────────────────────────────
  function analyzeOverall(collapsed, config) {
    var alpha = config.alpha;
    var out = Object.create(null);   // out[treatment][metric]
    var accs = Object.create(null);  // cached per metric

    config.metrics.forEach(function (m) {
      accs[m.name] = accumulate(collapsed.units, m.name, isBinary(m));
    });

    config.treatments.forEach(function (trt) {
      out[trt] = Object.create(null);
      config.metrics.forEach(function (m) {
        var a = accs[m.name];
        out[trt][m.name] = runTest(m, a[config.controlName], a[trt], alpha);
      });
    });

    return out;
  }

  // ── per-segment ───────────────────────────────────────────────────────────
  /* out[treatment][segmentColumn][metric] = [row, ...] sorted by treatment N desc.
   * Segments where either arm is empty are dropped — the notebook did the same,
   * since a one-armed comparison produces nothing meaningful. */
  function analyzeSegments(collapsed, config) {
    var alpha = config.alpha;
    var segCols = config.segmentCols || [];
    var out = Object.create(null);
    if (!segCols.length) return out;

    // Bucket units by segment value once per segment column.
    var buckets = Object.create(null);
    segCols.forEach(function (col) {
      var byValue = new Map();
      for (var i = 0; i < collapsed.units.length; i++) {
        var u = collapsed.units[i];
        var v = u.segments[col];
        if (v === undefined || v === null || v === '') continue;  // notebook dropped NaN segments
        var arr = byValue.get(v);
        if (!arr) { arr = []; byValue.set(v, arr); }
        arr.push(u);
      }
      buckets[col] = byValue;
    });

    config.treatments.forEach(function (trt) {
      out[trt] = Object.create(null);
      segCols.forEach(function (col) {
        out[trt][col] = Object.create(null);
        config.metrics.forEach(function (m) {
          var rows = [];
          buckets[col].forEach(function (units, value) {
            var a = accumulate(units, m.name, isBinary(m));
            var c = a[config.controlName], t = a[trt];
            if (!c || !t || !c.n || !t.n) return;
            var r = runTest(m, c, t, alpha);
            r.segment = value;
            rows.push(r);
          });
          rows.sort(function (x, y) { return y.nTrt - x.nTrt; });
          out[trt][col][m.name] = rows;
        });
      });
    });

    return out;
  }

  // ── over time ─────────────────────────────────────────────────────────────
  /* Cumulative results per date. Each point answers "if we had stopped here,
   * what would the readout have been" — which is exactly what makes peeking
   * visible. */
  function analyzeOverTime(data, config, excludedUnits) {
    var cum = root.AB.aggregate.buildCumulativeSeries(data, config, excludedUnits);
    if (!cum) return null;

    var out = Object.create(null);   // out[treatment][metric] = [point, ...]
    config.treatments.forEach(function (trt) {
      out[trt] = Object.create(null);
      config.metrics.forEach(function (m) {
        var ctrlArr = cum.series[m.name][config.controlName] || [];
        var trtArr = cum.series[m.name][trt] || [];
        var points = [];
        for (var i = 0; i < cum.dates.length; i++) {
          var c = ctrlArr[i], t = trtArr[i];
          if (!c || !t || !c.n || !t.n) continue;
          var r = runTest(m, c, t, config.alpha);
          r.date = cum.dates[i];
          points.push(r);
        }
        out[trt][m.name] = points;
      });
    });

    return { dates: cum.dates, results: out };
  }

  // ── SRM ───────────────────────────────────────────────────────────────────
  /* Run at unit level, which is the correct denominator for assignment balance.
   * The notebook ran it on deduplicated rows, so with multi-date data its
   * counts were whatever drop_duplicates happened to keep. */
  function analyzeSrm(collapsed, config) {
    var counts = collapsed.variants.map(function (v) {
      return { variant: v, n: collapsed.variantCounts[v] };
    });
    return S.srm({
      counts: counts,
      expectedRatio: config.expectedRatio || null,
      alpha: 0.05   // SRM is a data-quality gate, not the experiment's alpha
    });
  }

  // ── multiplicity ──────────────────────────────────────────────────────────
  /* Alpha is never divided. It stays exactly what the experiment was designed
   * at, and multiplicity is expressed as an adjusted p-value instead. See the
   * note in stats.js for why that direction is the right one.
   *
   * What gets corrected is decided by metric ROLE, because the two roles want
   * opposite treatment:
   *
   *   success    — several shots at a win, so the family-wise / false-discovery
   *                rate really does inflate. Correct these.
   *   guardrail  — a harm detector. Correcting RAISES its bar, which lowers the
   *                chance of catching a real regression: exactly backwards for
   *                a metric whose entire job is to catch regressions. Never
   *                correct these, and never let one join another family.
   *
   * A metric with no role set is treated as not correctable. That is the safe
   * direction — never silently tighten a threshold on a metric whose job we
   * cannot establish — and the UI always sets a role, so it only affects
   * hand-built configs. */
  function isCorrectable(metric) { return metric.role === 'success'; }

  // Everything gets these fields, so downstream code never has to check whether
  // a correction ran.
  function markUncorrected(rows) {
    rows.forEach(function (r) {
      r.pAdj = r.pVal;
      r.familyN = 1;
      r.corrected = false;
      r.sigAdj = r.sig;
    });
  }

  /* Correct one family in place.
   *
   * A family is a set of tests where a false positive on ANY member would
   * drive the same decision — that shared decision is what makes them one
   * error budget. Splitting a decision across two families, or merging two
   * decisions into one, both misstate the real error rate.
   */
  function correctFamily(rows, method, alpha) {
    if (method === 'none' || rows.length < 2) { markUncorrected(rows); return 1; }

    var pvals = rows.map(function (r) { return r.pVal; });
    var adj = S.adjustPValues(pvals, method);
    var n = S.finiteCount(pvals);

    rows.forEach(function (r, i) {
      r.pAdj = adj[i];
      r.familyN = n;
      r.corrected = n > 1;
      r.sigAdj = S.classify(adj[i], r.absDiff, alpha);
    });
    return n;
  }

  /* The verdict actually shown. `sig` (uncorrected) is always kept alongside,
   * so turning the correction on or off never destroys the raw reading. */
  function verdictOf(r, useAdjusted) {
    return (useAdjusted && r.corrected) ? r.sigAdj : r.sig;
  }

  /* Full run. `config` is the resolved config object from app.js:
   *   { unitCol, variantCol, dateCol, segmentCols[], metrics[{name,kind,role}],
   *     controlName, alpha, expectedRatio, includeContaminated,
   *     correction, correctionForVerdict }
   */
  function run(data, config) {
    var collapsed = root.AB.aggregate.collapseToUnits(data, config);

    var treatments = collapsed.variants.filter(function (v) {
      return v !== config.controlName;
    }).sort();

    var resolved = Object.create(null);
    for (var k in config) resolved[k] = config[k];
    resolved.treatments = treatments;
    resolved.correction = resolved.correction || 'none';
    resolved.correctionForVerdict = !!resolved.correctionForVerdict;

    var overall = analyzeOverall(collapsed, resolved);
    var segments = analyzeSegments(collapsed, resolved);
    var overTime = analyzeOverTime(data, resolved, collapsed.excludedUnits);
    var srm = analyzeSrm(collapsed, resolved);

    var method = resolved.correction;
    var alpha = resolved.alpha;
    var successMetrics = resolved.metrics.filter(isCorrectable);

    /* Overall family spans every treatment x success-metric pair, because any
     * one of them coming back positive is a reason to ship — that is one
     * decision, so it is one error budget. It degrades on its own: a single arm
     * with a single success metric is a family of 1 and nothing is corrected. */
    var overallFamily = [];
    treatments.forEach(function (trt) {
      resolved.metrics.forEach(function (m) {
        var r = overall[trt][m.name];
        if (isCorrectable(m)) overallFamily.push(r);
        else markUncorrected([r]);
      });
    });
    var overallFamilyN = correctFamily(overallFamily, method, alpha);

    /* Segment families are per treatment x segment column x metric: scanning
     * countries for one metric is one exploration, scanning them for a
     * different metric is another. */
    var segmentFamilyN = Object.create(null);
    treatments.forEach(function (trt) {
      segmentFamilyN[trt] = Object.create(null);
      (resolved.segmentCols || []).forEach(function (col) {
        segmentFamilyN[trt][col] = Object.create(null);
        resolved.metrics.forEach(function (m) {
          var rows = (segments[trt] && segments[trt][col] && segments[trt][col][m.name]) || [];
          segmentFamilyN[trt][col][m.name] = isCorrectable(m)
            ? correctFamily(rows, method, alpha)
            : (markUncorrected(rows), 1);
        });
      });
    });

    /* Cumulative points are deliberately left uncorrected. Repeatedly reading
     * the same accumulating experiment is a SEQUENTIAL testing problem, and
     * Bonferroni/BH across dates does not address it — they assume a fixed set
     * of separate hypotheses, not one hypothesis re-read as data arrives.
     * Fixing it properly needs always-valid p-values or alpha spending. */
    if (overTime) {
      treatments.forEach(function (trt) {
        resolved.metrics.forEach(function (m) {
          markUncorrected(overTime.results[trt][m.name] || []);
        });
      });
    }

    return {
      config: resolved,
      collapsed: collapsed,
      diagnostics: collapsed.diagnostics,
      treatments: treatments,
      srm: srm,
      overall: overall,
      segments: segments,
      overTime: overTime,
      correction: {
        method: method,
        forVerdict: resolved.correctionForVerdict,
        overallFamilyN: overallFamilyN,
        successMetricCount: successMetrics.length,
        segmentFamilyN: segmentFamilyN
      }
    };
  }

  root.AB = root.AB || {};
  root.AB.analyze = {
    run: run,
    analyzeOverall: analyzeOverall,
    analyzeSegments: analyzeSegments,
    analyzeOverTime: analyzeOverTime,
    analyzeSrm: analyzeSrm,
    isCorrectable: isCorrectable,
    correctFamily: correctFamily,
    markUncorrected: markUncorrected,
    verdictOf: verdictOf,
    accumulate: accumulate,
    runTest: runTest
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.AB.analyze;
})(typeof globalThis !== 'undefined' ? globalThis : this);
