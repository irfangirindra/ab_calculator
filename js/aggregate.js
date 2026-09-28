/* aggregate.js — collapse date x unit rows down to one row per unit.
 *
 * This is the whole point of the tool. The source notebook did:
 *
 *     df.drop_duplicates(subset=[UNIT_COL, VARIANT_COL])
 *
 * which keeps the FIRST row per unit and silently discards every later date.
 * A unit that did not convert on the 20th but converted on the 21st was
 * therefore counted as not converted. Measured on real data that understated
 * CVR_to_login by 11% (244 vs 271 conversions across 1,320 units).
 *
 * Here, instead:
 *   binary metric     -> MAX across the unit's dates (converted at least once)
 *   continuous metric -> SUM across the unit's dates
 *   segment value     -> taken from the unit's EARLIEST date
 *
 * After collapseToUnits(), one unit == one row, so everything downstream
 * operates at the right granularity without knowing dates exist.
 */
(function (root) {
  'use strict';

  function metricAgg(kind) { return kind === 'binary' ? 'max' : 'sum'; }

  function resolveCols(headers, config) {
    var uIdx = headers.indexOf(config.unitCol);
    var vIdx = headers.indexOf(config.variantCol);
    if (uIdx < 0) throw new Error('Unit column not found: ' + config.unitCol);
    if (vIdx < 0) throw new Error('Variant column not found: ' + config.variantCol);
    return {
      uIdx: uIdx,
      vIdx: vIdx,
      dIdx: config.dateCol ? headers.indexOf(config.dateCol) : -1,
      segCols: (config.segmentCols || []).map(function (name) {
        return { name: name, index: headers.indexOf(name) };
      }).filter(function (s) { return s.index >= 0; }),
      metrics: (config.metrics || []).map(function (m) {
        return {
          name: m.name, index: headers.indexOf(m.name),
          kind: m.kind, agg: metricAgg(m.kind)
        };
      }).filter(function (m) { return m.index >= 0; })
    };
  }

  /* Collapse to unit level.
   *
   * config: { unitCol, variantCol, dateCol, segmentCols[], metrics[{name,kind}],
   *           includeContaminated }
   *
   * Returns { units, variants, variantCounts, diagnostics }.
   *   units — [{ unit, variant, firstDate, lastDate, nDates, segments{}, values{} }]
   */
  function collapseToUnits(data, config) {
    var headers = data.headers, rows = data.rows;
    var toNumber = root.AB.csv.toNumber;   // resolved lazily: csv.js may load after this file
    var cols = resolveCols(headers, config);
    var uIdx = cols.uIdx, vIdx = cols.vIdx, dIdx = cols.dIdx;
    var segCols = cols.segCols, metrics = cols.metrics;

    var map = new Map();
    var nRows = rows.length;

    for (var i = 0; i < nRows; i++) {
      var row = rows[i];
      var unit = row[uIdx];
      var variant = row[vIdx];
      // The date column is optional; without one, every row is one "date".
      var date = dIdx >= 0 ? row[dIdx] : '';

      var rec = map.get(unit);

      if (!rec) {
        rec = {
          unit: unit,
          variant: variant,
          firstDate: date,
          lastDate: date,
          dates: null,        // allocated only once a second distinct date shows up
          nDates: 1,
          contaminated: false,
          segFlags: null,     // allocated only on a segment collision
          segments: {},
          values: {}
        };
        for (var s = 0; s < segCols.length; s++) {
          rec.segments[segCols[s].name] = row[segCols[s].index];
        }
        for (var m = 0; m < metrics.length; m++) {
          rec.values[metrics[m].name] = toNumber(row[metrics[m].index]);
        }
        map.set(unit, rec);
        continue;
      }

      // Distinct-date tracking, so diagnostics can report how many units the
      // granularity change actually affects.
      if (!rec.dates) {
        if (date !== rec.firstDate) rec.dates = new Set([rec.firstDate, date]);
      } else {
        rec.dates.add(date);
      }

      var isEarlier = date < rec.firstDate;
      if (isEarlier) rec.firstDate = date;
      if (date > rec.lastDate) rec.lastDate = date;

      // Variant contamination: the same unit seen under more than one variant.
      if (variant !== rec.variant) {
        rec.contaminated = true;
        // Keep the earliest date's variant, matching the segment rule below.
        if (isEarlier) rec.variant = variant;
      }

      /* Segment value comes from the unit's earliest date. CSV row order is not
       * guaranteed to be date-sorted, so compare dates explicitly instead of
       * relying on first-seen order. */
      for (var s2 = 0; s2 < segCols.length; s2++) {
        var sc = segCols[s2];
        var sv = row[sc.index];
        if (sv !== rec.segments[sc.name]) {
          if (!rec.segFlags) rec.segFlags = {};
          rec.segFlags[sc.name] = true;
          if (isEarlier) rec.segments[sc.name] = sv;
        }
      }

      // The actual fix: accumulate across dates instead of discarding them.
      for (var m2 = 0; m2 < metrics.length; m2++) {
        var mt = metrics[m2];
        var val = toNumber(row[mt.index]);
        if (mt.agg === 'max') {
          if (val > rec.values[mt.name]) rec.values[mt.name] = val;
        } else {
          rec.values[mt.name] += val;
        }
      }
    }

    var units = [];
    var multiDateUnits = 0;
    var contaminatedUnits = 0;
    var collisionsByColumn = Object.create(null);
    var collisionUnits = 0;
    var variantCounts = Object.create(null);
    var excludedUnits = new Set();
    segCols.forEach(function (s) { collisionsByColumn[s.name] = 0; });

    map.forEach(function (rec) {
      if (rec.dates) { rec.nDates = rec.dates.size; rec.dates = null; }

      if (rec.contaminated) {
        contaminatedUnits++;
        // Excluded by default: a unit exposed to both arms biases both of them.
        if (!config.includeContaminated) {
          excludedUnits.add(rec.unit);
          return;
        }
      }

      // Counted over analysed units only, so these totals reconcile with unitsOut.
      if (rec.nDates > 1) multiDateUnits++;
      if (rec.segFlags) {
        collisionUnits++;
        for (var name in rec.segFlags) collisionsByColumn[name]++;
      }
      rec.segFlags = null;

      variantCounts[rec.variant] = (variantCounts[rec.variant] || 0) + 1;
      units.push(rec);
    });

    return {
      units: units,
      variants: Object.keys(variantCounts).sort(),
      variantCounts: variantCounts,
      excludedUnits: excludedUnits,
      diagnostics: {
        rowsIn: nRows,
        unitsSeen: map.size,
        unitsOut: units.length,
        multiDateUnits: multiDateUnits,
        contaminatedUnits: contaminatedUnits,
        contaminatedIncluded: !!config.includeContaminated,
        segmentCollisionUnits: collisionUnits,
        segmentCollisionsByColumn: collisionsByColumn,
        metricAggregation: metrics.map(function (m) {
          return { name: m.name, kind: m.kind, agg: m.agg };
        })
      }
    };
  }

  // Per-variant accumulator for one metric. Binary tracks conversions;
  // continuous tracks sum and sum-of-squares, which is all Welch's t-test needs.
  function newAcc() { return { n: 0, conv: 0, sum: 0, sumSq: 0 }; }

  /* Build cumulative per-date statistics for the over-time chart.
   *
   * Recomputing the full collapse at every cutoff date would be
   * O(dates x rows). Instead this walks the dates in order once, keeping each
   * unit's running metric value, and updates the per-variant accumulators
   * incrementally — O(rows + dates x variants x metrics).
   *
   * `excludedUnits` (from collapseToUnits) is skipped so the cumulative
   * denominators reconcile with the headline numbers — otherwise a contaminated
   * unit excluded from the overall test would still inflate N in the chart.
   *
   * Returns { dates, variants, series } where series[metric][variant] is an
   * array of snapshots aligned index-for-index with `dates`.
   */
  function buildCumulativeSeries(data, config, excludedUnits) {
    var headers = data.headers, rows = data.rows;
    var toNumber = root.AB.csv.toNumber;
    var cols = resolveCols(headers, config);
    var uIdx = cols.uIdx, vIdx = cols.vIdx, dIdx = cols.dIdx;
    var metrics = cols.metrics;

    if (dIdx < 0) return null;        // no date column, nothing to trend
    if (!metrics.length) return null;

    // Group row indices by date, and collect every variant up front so all
    // series arrays stay aligned with `dates` even when a variant's first unit
    // appears late in the experiment.
    var skip = excludedUnits && excludedUnits.size ? excludedUnits : null;
    var byDate = new Map();
    var variantSet = new Set();
    for (var i = 0; i < rows.length; i++) {
      if (skip && skip.has(rows[i][uIdx])) continue;
      var d = rows[i][dIdx];
      var bucket = byDate.get(d);
      if (!bucket) { bucket = []; byDate.set(d, bucket); }
      bucket.push(i);
      variantSet.add(rows[i][vIdx]);
    }
    var dates = Array.from(byDate.keys()).sort();
    var variants = Array.from(variantSet).sort();

    var unitState = new Map();
    var acc = Object.create(null);      // acc[variant][metric]
    var series = Object.create(null);   // series[metric][variant][]
    metrics.forEach(function (m) { series[m.name] = Object.create(null); });
    variants.forEach(function (v) {
      acc[v] = Object.create(null);
      metrics.forEach(function (m) {
        acc[v][m.name] = newAcc();
        series[m.name][v] = [];
      });
    });

    for (var di = 0; di < dates.length; di++) {
      var idxs = byDate.get(dates[di]);

      for (var k = 0; k < idxs.length; k++) {
        var row = rows[idxs[k]];
        var unit = row[uIdx];
        var st = unitState.get(unit);

        if (!st) {
          // First appearance: the unit enters its variant's denominator.
          st = { variant: row[vIdx], values: Object.create(null) };
          unitState.set(unit, st);
          for (var m = 0; m < metrics.length; m++) {
            st.values[metrics[m].name] = 0;
            acc[st.variant][metrics[m].name].n++;
          }
        }
        // Always attribute to the first-seen variant, so a contaminated unit
        // cannot land in two denominators.
        var av = acc[st.variant];

        for (var mi = 0; mi < metrics.length; mi++) {
          var mt = metrics[mi];
          var val = toNumber(row[mt.index]);
          var old = st.values[mt.name];
          var next = mt.agg === 'max' ? (val > old ? val : old) : old + val;
          if (next === old) continue;

          st.values[mt.name] = next;
          var a = av[mt.name];
          if (mt.kind === 'binary') {
            if (old <= 0 && next > 0) a.conv++;   // only a 0 -> 1 flip converts
          } else {
            /* sumSq must be corrected against the OLD value. Adding the
             * squared delta would be wrong: (x+d)^2 != x^2 + d^2. */
            a.sum += next - old;
            a.sumSq += next * next - old * old;
          }
        }
      }

      // Snapshot once the date has been fully applied.
      for (var mi2 = 0; mi2 < metrics.length; mi2++) {
        var name = metrics[mi2].name;
        for (var vi = 0; vi < variants.length; vi++) {
          var a2 = acc[variants[vi]][name];
          series[name][variants[vi]].push({
            date: dates[di],
            n: a2.n, conv: a2.conv, sum: a2.sum, sumSq: a2.sumSq
          });
        }
      }
    }

    return { dates: dates, variants: variants, series: series };
  }

  root.AB = root.AB || {};
  root.AB.aggregate = {
    collapseToUnits: collapseToUnits,
    buildCumulativeSeries: buildCumulativeSeries,
    metricAgg: metricAgg,
    newAcc: newAcc
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.AB.aggregate;
})(typeof globalThis !== 'undefined' ? globalThis : this);
