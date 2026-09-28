/* render.js — builds the results markup.
 *
 * Output is a stack of full-bleed tiles that alternate surface colour:
 *
 *   white      diagnostics + SRM status
 *   dark       overall KPI results          <- the headline moment
 *   parchment  significance over time
 *   white      segment breakdown
 *   parchment  export actions
 *
 * The colour change between tiles is the section divider; there are no borders
 * or shadows between them. Colour classes (.val-pos / .val-neg / .val-neutral)
 * resolve differently inside .tile-dark, so the same renderer works on both
 * light and dark surfaces without branching.
 */
(function (root) {
  'use strict';

  var SIG_CLASS = { positive: 'val-pos', negative: 'val-neg', not_sig: 'val-neutral' };
  var SIG_LABEL = { positive: 'Sig. Positive', negative: 'Sig. Negative', not_sig: 'Not Sig.' };

  // ── formatting ────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function int(n) {
    if (!isFinite(n)) return '—';
    return Math.round(n).toLocaleString('en-US');
  }

  function pct(x, dp) {
    if (!isFinite(x)) return '—';
    return (x * 100).toFixed(dp == null ? 2 : dp) + '%';
  }

  function signedPct(x, dp) {
    if (!isFinite(x)) return '—';
    var s = (x * 100).toFixed(dp == null ? 2 : dp) + '%';
    return x >= 0 ? '+' + s : s;
  }

  // Continuous metrics are means, not rates.
  function num(x) {
    if (!isFinite(x)) return '—';
    var a = Math.abs(x);
    if (a === 0) return '0';
    if (a < 0.001) return x.toExponential(2);
    if (a < 1) return x.toFixed(4);
    if (a < 1000) return x.toFixed(3);
    return x.toLocaleString('en-US', { maximumFractionDigits: 1 });
  }

  // A metric's own scale: rates as %, means as plain numbers.
  function level(r, x) { return r.kind === 'binary' ? pct(x) : num(x); }

  /* p-values: keep 4 decimals in the range people eyeball, switch to
   * scientific notation rather than printing a misleading "0.0000". */
  function pFmt(p) {
    if (!isFinite(p)) return '—';
    if (p === 0) return '<1e-300';
    if (p < 0.0001) return p.toExponential(2);
    return p.toFixed(4);
  }

  function statName(r) { return r.kind === 'binary' ? 'z' : 't'; }

  var METHOD_LABEL = {
    none: 'none', bonferroni: 'Bonferroni', bh: 'Benjamini&ndash;Hochberg (FDR)'
  };
  var METHOD_SHORT = { none: '', bonferroni: 'Bonferroni', bh: 'BH' };

  // Verdict shown = corrected only if a correction ran AND it drives the verdict.
  function verdict(result, r) {
    return root.AB.analyze.verdictOf(r, result.correction.forVerdict);
  }

  /* Trim a user-entered alpha to something readable without printing fake
   * precision (0.0500 -> 0.05). Alpha itself is never divided — multiplicity
   * lands on the p-value instead — so this only ever formats one value. */
  function alphaFmt(a) {
    if (!isFinite(a)) return '—';
    if (a === 0) return '0';
    var s = a.toPrecision(3);
    // Drop trailing zeros left by toPrecision (0.0500 -> 0.05).
    if (s.indexOf('e') === -1 && s.indexOf('.') !== -1) {
      s = s.replace(/0+$/, '').replace(/\.$/, '');
    }
    return s;
  }

  function tag(cls, label) {
    return '<span class="tag ' + cls + '">' + label + '</span>';
  }

  function roleTag(metric) {
    return metric.role === 'success'
      ? tag('tag-success', 'success')
      : tag('tag-guard', 'guardrail');
  }

  function tile(id, surface, eyebrow, heading, sub, body, omitFromExport) {
    return '<section class="tile ' + surface + '"' +
      (id ? ' id="' + id + '"' : '') +
      (omitFromExport ? ' data-export-omit' : '') + '>' +
      '<div class="wrap">' +
      (heading
        ? '<div class="tile-head">' +
          (eyebrow ? '<p class="eyebrow">' + eyebrow + '</p>' : '') +
          '<h2 class="t-display-lg">' + heading + '</h2>' +
          (sub ? '<p class="t-body">' + sub + '</p>' : '') +
          '</div>'
        : '') +
      body +
      '</div></section>';
  }

  // ── SRM status ────────────────────────────────────────────────────────────
  /* Rendered as a quiet row with coloured text, not a filled banner — keeps the
   * no-decorative-chrome rule while still reading as a status. */
  function srmStatus(result) {
    var s = result.srm;
    var split = s.rows.map(function (r) {
      return esc(r.variant) + ' ' + int(r.observed) + ' (' + pct(r.observedShare, 2) + ')';
    }).join(' &nbsp;·&nbsp; ');
    var expected = s.rows.map(function (r) { return pct(r.expectedShare, 2); }).join(' / ');

    var title = s.detected
      ? 'SRM detected — variant assignment is imbalanced'
      : 'No SRM — assignment looks balanced';
    var extra = s.detected
      ? '<br>Investigate before reporting. If the split is uneven by design, set the ' +
        'expected split in the configuration above.'
      : '';

    return '<div class="status ' + (s.detected ? 'status-warn' : 'status-ok') + '">' +
      '<span class="status-icon">' + (s.detected ? '&#9888;&#65039;' : '&#10003;') + '</span>' +
      '<div class="status-body">' +
      '<p class="t-body-strong status-title">' + title + '</p>' +
      '<p class="t-caption status-detail">' + split +
      ' &nbsp;|&nbsp; expected ' + expected +
      ' &nbsp;|&nbsp; <code>&chi;&sup2; = ' + s.chi2.toFixed(2) + ', df = ' + s.df +
      ', p = ' + pFmt(s.pVal) + '</code>' + extra +
      '</p></div></div>';
  }

  // ── diagnostics ───────────────────────────────────────────────────────────
  function renderDiagnostics(result, fileName) {
    var d = result.diagnostics;
    var cfg = result.config;
    var collapsedBy = d.rowsIn - d.unitsSeen;

    var items = [
      { v: int(d.rowsIn), k: 'rows in' },
      { v: int(d.unitsOut), k: 'units analysed' },
      { v: int(collapsedBy), k: 'rows collapsed away' },
      { v: int(d.multiDateUnits), k: 'units on &gt;1 date' }
    ];
    if (d.contaminatedUnits) {
      items.push({ v: int(d.contaminatedUnits), k: 'units in &gt;1 variant' });
    }

    var stats = '<div class="stat-grid">' + items.map(function (i) {
      return '<div><p class="stat-v">' + i.v + '</p>' +
        '<p class="t-caption stat-k">' + i.k + '</p></div>';
    }).join('') + '</div>';

    // Spell out what happened to the granularity — this is the whole reason the
    // tool exists, so it should not be buried.
    var notes = [];
    var agg = d.metricAggregation.map(function (m) {
      return '<code>' + esc(m.name) + '</code> ' + (m.agg === 'max' ? 'MAX' : 'SUM');
    }).join(' · ');

    notes.push('<strong>Aggregated per unit:</strong> ' + agg +
      '. A unit that converted on any date inside the window counts as converted once.');

    if (d.multiDateUnits) {
      notes.push('<strong>' + int(d.multiDateUnits) + '</strong> unit' +
        (d.multiDateUnits === 1 ? '' : 's') + ' appeared on more than one date. ' +
        'Row-level dedup (the old notebook behaviour) would have kept only their first ' +
        'date and undercounted conversions.');
    } else {
      notes.push('No unit appeared on more than one date, so unit-level and row-level ' +
        'aggregation give identical counts here.');
    }

    if (d.segmentCollisionUnits) {
      var per = [];
      for (var col in d.segmentCollisionsByColumn) {
        if (d.segmentCollisionsByColumn[col]) {
          per.push('<code>' + esc(col) + '</code>: ' + int(d.segmentCollisionsByColumn[col]));
        }
      }
      notes.push('<strong>' + int(d.segmentCollisionUnits) + '</strong> unit' +
        (d.segmentCollisionUnits === 1 ? '' : 's') +
        ' had a segment value that changed between dates (' + per.join(', ') +
        '). The value from each unit\'s <strong>earliest date</strong> was used.');
    }

    if (d.contaminatedUnits) {
      notes.push('<strong>' + int(d.contaminatedUnits) + '</strong> unit' +
        (d.contaminatedUnits === 1 ? '' : 's') + ' appeared under more than one variant and ' +
        (d.contaminatedIncluded
          ? 'were <strong>included</strong>, assigned by earliest date.'
          : 'were <strong>excluded</strong> — a unit exposed to both arms biases both. ' +
            'Enable the option in the configuration to include them.'));
    }

    notes.push('Test: binary &rarr; two-proportion z-test, continuous &rarr; Welch t-test. ' +
      '&alpha; = ' + alphaFmt(cfg.alpha) + ' (two-tailed).');

    var corr = result.correction;
    if (corr.method === 'none') {
      notes.push('<strong>Multiple comparisons:</strong> no correction. Every p-value below ' +
        'is raw. With ' + int(corr.successMetricCount) + ' success metric' +
        (corr.successMetricCount === 1 ? '' : 's') + ' &times; ' +
        int(result.treatments.length) + ' treatment arm' +
        (result.treatments.length === 1 ? '' : 's') +
        ', the chance of at least one false positive is above &alpha;.');
    } else {
      notes.push('<strong>Multiple comparisons:</strong> ' + METHOD_LABEL[corr.method] +
        ', reported as an adjusted p-value &mdash; &alpha; stays ' + alphaFmt(cfg.alpha) +
        '. Overall family: ' + int(corr.overallFamilyN) + ' test' +
        (corr.overallFamilyN === 1 ? '' : 's') +
        ' (success metrics &times; treatment arms). Segment tables are corrected within ' +
        'each metric separately. ' +
        (corr.forVerdict
          ? 'The adjusted p-value <strong>drives the verdict</strong>; the raw p is kept ' +
            'in the export.'
          : 'Verdicts still use the raw p-value &mdash; the adjusted column is reference only.'));
      notes.push('<strong>Guardrails are never corrected.</strong> Correcting one raises its ' +
        'bar, which lowers the chance of catching a real regression &mdash; backwards for a ' +
        'metric whose job is to catch harm.');
    }

    var prose = '<div class="prose"><p class="t-caption">' +
      notes.join('</p><p class="t-caption">') + '</p></div>';

    return tile('data', 'tile-white', 'Data',
      'Granularity',
      fileName ? 'Source: <code>' + esc(fileName) + '</code>' : '',
      srmStatus(result) + stats + prose);
  }

  // ── KPI cards, on the dark tile ───────────────────────────────────────────
  function kpiCard(result, metric, r) {
    var alpha = result.config.alpha;
    var v = verdict(result, r);
    var sigCls = SIG_CLASS[v];
    var liftStr, ciStr;

    if (r.liftDefined) {
      liftStr = signedPct(r.lift);
      ciStr = Math.round((1 - alpha) * 100) + '% CI: ' +
        signedPct(r.ciLo) + ' to ' + signedPct(r.ciHi);
    } else {
      // Relative lift is undefined at a zero baseline — say so instead of
      // printing a fake 0%.
      liftStr = r.rTrt > 0 ? 'new' : '&mdash;';
      ciStr = (r.kind === 'binary' ? 'control rate = 0%' : 'control mean = 0') +
        ' (relative lift undefined)';
    }

    var absLine = r.kind === 'binary'
      ? 'abs diff: ' + signedPct(r.absDiff) + 'pt'
      : 'abs diff: ' + (r.absDiff >= 0 ? '+' : '') + num(r.absDiff);

    /* Adjusted p sits on its own line, never replacing the raw one — the point
     * is to show what multiplicity costs, which needs both numbers visible. */
    var adjLine = '';
    if (r.corrected) {
      adjLine = '<div>p<sub>adj</sub> = ' + pFmt(r.pAdj) +
        ' <span class="dim">(' + METHOD_SHORT[result.correction.method] +
        ', family of ' + int(r.familyN) + ')</span></div>';
    } else if (result.correction.method !== 'none' && metric.role !== 'success') {
      adjLine = '<div class="dim">guardrail — not corrected</div>';
    }

    return '<div class="kpi">' +
      '<p class="kpi-label"><span class="t-body kpi-name">' + esc(metric.name) + '</span>' +
      roleTag(metric) + tag('tag-kind', r.kind) + '</p>' +
      '<p class="kpi-value ' + sigCls + '">' + liftStr + '</p>' +
      '<p class="t-body kpi-rate">' + level(r, r.rCtrl) + ' &rarr; ' + level(r, r.rTrt) +
      ' &nbsp;·&nbsp; <span class="kpi-verdict ' + sigCls + '">' + SIG_LABEL[v] +
      '</span></p>' +
      '<div class="t-caption kpi-meta">' +
      '<div>' + ciStr + '</div>' +
      '<div>' + absLine + '</div>' +
      '<div>p = ' + pFmt(r.pVal) + ' &nbsp;|&nbsp; ' + statName(r) + ' = ' +
      (isFinite(r.stat) ? r.stat.toFixed(3) : '—') + '</div>' +
      adjLine +
      '<div class="dim">N ctrl: ' + int(r.nCtrl) + ' &nbsp;|&nbsp; N trt: ' + int(r.nTrt) +
      '</div></div></div>';
  }

  function renderOverall(result) {
    var sections = result.treatments.map(function (trt) {
      var cards = result.config.metrics.map(function (m) {
        return kpiCard(result, m, result.overall[trt][m.name]);
      }).join('');
      return '<div class="kpi-section">' +
        '<p class="trt-label">' + esc(trt) + ' vs ' + esc(result.config.controlName) + '</p>' +
        '<div class="kpi-grid">' + cards + '</div></div>';
    }).join('');

    return tile('overall', 'tile-white', 'Overall', 'Results per unit',
      'Each unit is counted once, regardless of how many dates it appears on.', sections);
  }

  // ── segment tables ────────────────────────────────────────────────────────
  function liftCell(r, v) {
    if (!r.liftDefined) {
      if (r.rTrt === 0) return '<span class="val-neutral">&mdash;</span>';
      return '<span class="' + SIG_CLASS[v] + ' c-strong" ' +
        'title="control baseline = 0, relative lift undefined">new</span>';
    }
    return '<span class="' + SIG_CLASS[v] + ' c-strong">' + signedPct(r.lift) + '</span>';
  }

  function convDiffCell(r) {
    var diff = r.convTrt - r.convCtrl;
    var s = (diff >= 0 ? '+' : '') + (r.kind === 'binary' ? int(diff) : num(diff));
    var cls = diff > 0 ? 'val-pos' : (diff < 0 ? 'val-neg' : 'val-neutral');
    return '<span class="' + cls + ' c-strong">' + s + '</span>';
  }

  function verdictCell(v, isSuccess) {
    if (v === 'negative') {
      return '<span class="pill-verdict verdict-neg">' +
        (isSuccess ? 'sig negative' : 'guardrail breach') + '</span>';
    }
    if (v === 'positive') return '<span class="pill-verdict verdict-pos">sig positive</span>';
    return '<span class="pill-verdict verdict-none">not sig</span>';
  }

  function segmentTable(result, trt, col, metric, smallN) {
    var rows = result.segments[trt][col][metric.name] || [];
    var isSuccess = metric.role === 'success';
    var corr = result.correction;
    // Only carry the extra column when it would hold something.
    var showAdj = corr.method !== 'none' && isSuccess && rows.length > 1;
    var convLabel = metric.kind === 'binary' ? 'Conv &Delta;' : 'Total &Delta;';
    var rateLabel = metric.kind === 'binary' ? 'CVR (ctrl &rarr; trt)' : 'Mean (ctrl &rarr; trt)';

    var caption = '<p class="t-body-strong tbl-caption">' + esc(metric.name) +
      roleTag(metric) +
      '<span class="tbl-scope t-caption">' + esc(trt) + ' vs ' +
      esc(result.config.controlName) + ' &middot; by ' + esc(col) + '</span></p>';

    if (!rows.length) {
      return '<div class="tbl-block">' + caption +
        '<p class="t-caption tbl-note">No segment has units in both arms.</p></div>';
    }

    var body = rows.map(function (r) {
      var v = verdict(result, r);
      return '<tr' + (r.nTrt < smallN ? ' class="low"' : '') + '>' +
        '<td class="c-seg">' + esc(r.segment) + '</td>' +
        '<td class="r c-num">' + int(r.nCtrl) + '</td>' +
        '<td class="r c-num">' + int(r.nTrt) + '</td>' +
        '<td class="r">' + liftCell(r, v) + '</td>' +
        '<td class="r c-pair">' + level(r, r.rCtrl) + ' &rarr; ' + level(r, r.rTrt) + '</td>' +
        '<td class="r">' + convDiffCell(r) + '</td>' +
        '<td class="r c-num">' + pFmt(r.pVal) + '</td>' +
        (showAdj ? '<td class="r c-num">' + pFmt(r.pAdj) + '</td>' : '') +
        '<td>' + verdictCell(v, isSuccess) + '</td>' +
        '</tr>';
    }).join('');

    var note;
    if (!isSuccess) {
      note = 'Guardrail &mdash; <strong>not corrected</strong> for multiple comparisons at ' +
        'any setting. Raising a guardrail\'s bar lowers the chance of catching a real ' +
        'regression. Verdict uses &alpha; = ' + alphaFmt(result.config.alpha) + '.';
    } else if (showAdj) {
      note = '<code>p adj</code> is ' + METHOD_LABEL[corr.method] + '-adjusted across the ' +
        rows.length + ' segments in this table; &alpha; stays ' +
        alphaFmt(result.config.alpha) + ' rather than being divided. ' +
        (corr.forVerdict
          ? 'It <strong>drives the verdict</strong> column.'
          : 'Reference only &mdash; the verdict column uses the raw p.') +
        ' A segment breakdown is exploratory: treat anything here as a hypothesis to test ' +
        'in its own experiment, not a result.';
    } else {
      note = 'No correction applied' +
        (rows.length > 1 ? ' (set a method in the configuration).' : ' &mdash; single segment.') +
        ' Segment breakdowns are exploratory.';
    }
    note += ' Segments with fewer than ' + int(smallN) + ' treatment units are dimmed: ' +
      '"not sig" there reflects insufficient power, not absence of effect.';

    return '<div class="tbl-block">' + caption +
      '<div class="tbl-scroll"><table class="tbl"><thead><tr>' +
      '<th>' + esc(col) + '</th>' +
      '<th class="r">Ctrl N</th>' +
      '<th class="r">Trt N</th>' +
      '<th class="r">Lift</th>' +
      '<th class="r">' + rateLabel + '</th>' +
      '<th class="r">' + convLabel + '</th>' +
      '<th class="r">p</th>' +
      (showAdj ? '<th class="r">p adj</th>' : '') +
      '<th>Verdict</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="t-caption tbl-note">' + note + '</p></div>';
  }

  function renderSegments(result, smallN) {
    var cols = result.config.segmentCols || [];
    if (!cols.length) return '';
    var blocks = '';
    result.treatments.forEach(function (trt) {
      cols.forEach(function (col) {
        result.config.metrics.forEach(function (m) {
          blocks += segmentTable(result, trt, col, m, smallN);
        });
      });
    });
    return tile('segments', 'tile-white', 'Breakdown', 'Per segment',
      'Segment value is taken from each unit\'s earliest date.', blocks);
  }

  // ── over-time charts ──────────────────────────────────────────────────────
  var CH = { w: 900, hLift: 190, hP: 84, gap: 34, padL: 56, padR: 16, padT: 14, padB: 22 };

  function niceTicks(lo, hi, count) {
    if (!(hi > lo)) hi = lo + 1;
    var raw = (hi - lo) / Math.max(1, count);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    var ticks = [];
    for (var t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) {
      ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
    }
    return ticks;
  }

  /* Two stacked panels sharing one x axis: cumulative lift with its CI band on
   * top, cumulative p-value beneath with the alpha threshold marked. */
  function chart(result, trt, metric) {
    var points = (result.overTime.results[trt][metric.name] || [])
      .filter(function (p) { return isFinite(p.lift); });

    var head = '<p class="t-body-strong chart-title">' + esc(metric.name) +
      roleTag(metric) + '</p>';

    if (points.length < 2) {
      return '<div class="chart-block">' + head +
        '<p class="t-caption chart-sub">Not enough dated points to plot' +
        (points.length ? '' : ' (relative lift undefined — control baseline is 0)') +
        '.</p></div>';
    }

    var alpha = result.config.alpha;
    var n = points.length;
    var innerW = CH.w - CH.padL - CH.padR;
    var yLiftBot = CH.padT + CH.hLift;
    var yPTop = yLiftBot + CH.gap;
    var yPBot = yPTop + CH.hP;
    var totalH = yPBot + CH.padB;

    // Lift scale spans the CI band and always includes zero, so the sign reads
    // at a glance.
    var lo = 0, hi = 0;
    points.forEach(function (p) {
      var a = isFinite(p.ciLo) ? p.ciLo : p.lift;
      var b = isFinite(p.ciHi) ? p.ciHi : p.lift;
      lo = Math.min(lo, a, p.lift); hi = Math.max(hi, b, p.lift);
    });
    var padY = (hi - lo) * 0.08 || 0.01;
    lo -= padY; hi += padY;

    var x = function (i) { return CH.padL + (n === 1 ? innerW / 2 : innerW * i / (n - 1)); };
    var yL = function (v) { return yLiftBot - (v - lo) / (hi - lo) * CH.hLift; };

    /* p-value on a log scale; linear would flatten everything interesting.
     * p = 1 sits at the TOP and small p descends toward the floor, so a line
     * dropping below the alpha rule reads as "became significant".
     *
     * The floor adapts to the data — a fixed 1e-6 wastes most of the panel when
     * p never gets below 0.01 — but is always at least a decade under alpha so
     * the threshold rule stays on-panel with room to cross it. */
    var pMin = points.reduce(function (m, p) {
      return isFinite(p.pVal) && p.pVal > 0 ? Math.min(m, p.pVal) : m;
    }, 1);
    var P_FLOOR = Math.max(1e-12, Math.min(
      Math.pow(10, Math.floor(Math.log10(Math.max(pMin, 1e-12)))),
      alpha / 10
    ));
    var logFloor = Math.log10(P_FLOOR);
    var yP = function (p) {
      var c = Math.max(P_FLOOR, Math.min(1, p));
      var t = Math.log10(c) / logFloor;   // 0 at p=1, 1 at the floor
      return yPTop + t * CH.hP;
    };
    var floorLabel = P_FLOOR >= 0.001
      ? String(P_FLOOR)
      : '1e' + Math.round(logFloor);

    var last = points[n - 1];
    var pos = last.lift >= 0;
    var svg = '';

    niceTicks(lo, hi, 4).forEach(function (t) {
      if (t < lo || t > hi) return;
      var yy = yL(t);
      svg += '<line class="' + (t === 0 ? 'chart-zero-line' : 'chart-grid-line') +
        '" x1="' + CH.padL + '" y1="' + yy.toFixed(1) + '" x2="' + (CH.w - CH.padR) +
        '" y2="' + yy.toFixed(1) + '"/>' +
        '<text class="chart-axis-text" x="' + (CH.padL - 8) + '" y="' + (yy + 3).toFixed(1) +
        '" text-anchor="end">' + signedPct(t, 0) + '</text>';
    });

    // CI band: upper edge forward, lower edge back, closed.
    var band = '';
    points.forEach(function (p, i) {
      var v = isFinite(p.ciHi) ? p.ciHi : p.lift;
      band += (i ? ' L' : 'M') + x(i).toFixed(1) + ' ' + yL(v).toFixed(1);
    });
    for (var i2 = n - 1; i2 >= 0; i2--) {
      var v2 = isFinite(points[i2].ciLo) ? points[i2].ciLo : points[i2].lift;
      band += ' L' + x(i2).toFixed(1) + ' ' + yL(v2).toFixed(1);
    }
    svg += '<path class="' + (pos ? 'chart-band' : 'chart-band-neg') + '" d="' + band + ' Z"/>';

    var lineD = '';
    points.forEach(function (p, i) {
      lineD += (i ? ' L' : 'M') + x(i).toFixed(1) + ' ' + yL(p.lift).toFixed(1);
    });
    svg += '<path class="' + (pos ? 'chart-line' : 'chart-line-neg') + '" d="' + lineD + '"/>';

    // p-value panel.
    var yAlpha = yP(alpha);
    svg += '<line class="chart-grid-line" x1="' + CH.padL + '" y1="' + yPTop +
      '" x2="' + (CH.w - CH.padR) + '" y2="' + yPTop + '"/>' +
      '<line class="chart-alpha-line" x1="' + CH.padL + '" y1="' + yAlpha.toFixed(1) +
      '" x2="' + (CH.w - CH.padR) + '" y2="' + yAlpha.toFixed(1) + '"/>' +
      '<text class="chart-axis-text" x="' + (CH.padL - 8) + '" y="' + (yAlpha + 3).toFixed(1) +
      '" text-anchor="end">&alpha;=' + alphaFmt(alpha) + '</text>' +
      '<text class="chart-axis-text" x="' + (CH.padL - 8) + '" y="' + (yPTop + 4) +
      '" text-anchor="end">p=1</text>' +
      '<text class="chart-axis-text" x="' + (CH.padL - 8) + '" y="' + (yPBot + 3) +
      '" text-anchor="end">&le;' + floorLabel + '</text>';

    var pD = '';
    points.forEach(function (p, i) {
      pD += (i ? ' L' : 'M') + x(i).toFixed(1) + ' ' + yP(p.pVal).toFixed(1);
    });
    svg += '<path class="chart-line-p" d="' + pD + '"/>';

    // x labels: first, last, and a few between without crowding.
    var everyX = Math.max(1, Math.ceil(n / 7));
    points.forEach(function (p, i) {
      if (i !== 0 && i !== n - 1 && i % everyX !== 0) return;
      var anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
      svg += '<text class="chart-axis-text" x="' + x(i).toFixed(1) + '" y="' + (yPBot + 16) +
        '" text-anchor="' + anchor + '">' + esc(String(p.date).slice(5)) + '</text>';
    });

    svg += '<circle class="chart-dot ' + (pos ? 'chart-dot-pos' : 'chart-dot-neg') +
      '" cx="' + x(n - 1).toFixed(1) + '" cy="' + yL(last.lift).toFixed(1) + '" r="4"/>';

    // Invisible hover columns. The tooltip payload rides on data-tip so app.js
    // renders it without re-deriving anything.
    var colW = innerW / Math.max(1, n - 1);
    points.forEach(function (p, i) {
      var tip = p.date + '|' + signedPct(p.lift) + '|' + pFmt(p.pVal) + '|' +
        int(p.nCtrl) + '|' + int(p.nTrt) + '|' +
        level(p, p.rCtrl) + ' → ' + level(p, p.rTrt) + '|' +
        (isFinite(p.ciLo) ? signedPct(p.ciLo) + ' to ' + signedPct(p.ciHi) : 'n/a');
      svg += '<rect class="chart-hit" data-tip="' + esc(tip) +
        '" x="' + (x(i) - colW / 2).toFixed(1) + '" y="' + CH.padT +
        '" width="' + colW.toFixed(1) + '" height="' + (yPBot - CH.padT).toFixed(1) + '"/>';
    });

    return '<div class="chart-block">' + head +
      '<p class="t-caption chart-sub">Cumulative readout after each date &mdash; ' +
      'what the result would have been had you stopped there.</p>' +
      '<svg class="chart-svg" viewBox="0 0 ' + CH.w + ' ' + totalH +
      '" preserveAspectRatio="xMidYMid meet" role="img" ' +
      'aria-label="Cumulative lift and p-value for ' + esc(metric.name) + '">' + svg + '</svg>' +
      '<div class="chart-legend t-fine">' +
      '<span><i class="swatch ' + (pos ? 'swatch-pos' : 'swatch-neg') +
      '"></i>cumulative lift + CI</span>' +
      '<span><i class="swatch swatch-p"></i>p-value (log scale)</span>' +
      '<span><i class="swatch swatch-alpha"></i>&alpha; threshold</span>' +
      '</div></div>';
  }

  function renderOverTime(result) {
    if (!result.overTime || result.overTime.dates.length < 2) return '';
    var blocks = '';
    result.treatments.forEach(function (trt) {
      blocks += '<p class="trt-label">' + esc(trt) + ' vs ' +
        esc(result.config.controlName) + '</p>';
      result.config.metrics.forEach(function (m) { blocks += chart(result, trt, m); });
    });
    blocks += '<p class="t-caption tbl-note">Each point re-runs the test on all units ' +
      'accumulated up to that date. A p-value that crosses &alpha; and comes back is the ' +
      'classic peeking trap — judge the experiment at its planned end date, not at its ' +
      'best-looking day.</p>' +
      '<p class="t-caption tbl-note">These p-values are <strong>raw</strong>, and the ' +
      'multiple-comparison setting does not apply here. Re-reading one accumulating ' +
      'experiment is a <em>sequential</em> testing problem, not a multiplicity one — ' +
      'Bonferroni and BH both assume a fixed set of separate hypotheses, so neither fixes ' +
      'peeking. Doing it properly needs always-valid p-values or an alpha-spending ' +
      'function. Read this panel as a diagnostic, not as a decision rule.</p>';

    return tile('overtime', 'tile-white', 'Trend', 'Significance over time', '', blocks);
  }

  // ── export actions ────────────────────────────────────────────────────────
  /* data-export-omit marks this tile for removal from the saved HTML report —
   * the buttons would be dead there. */
  function renderToolbar() {
    var body = '<div class="btn-row">' +
      '<button type="button" class="btn-pearl" data-act="copy-overall">Copy overall (TSV)</button>' +
      '<button type="button" class="btn-pearl" data-act="copy-segments">Copy segments (TSV)</button>' +
      '<button type="button" class="btn-pearl" data-act="download-csv">Download CSV</button>' +
      '<button type="button" class="btn-pearl" data-act="download-html">Download HTML report</button>' +
      '</div>' +
      '<p class="t-caption tbl-note">TSV pastes straight into Lark Sheets / Docs as a table. ' +
      'Exports contain experiment figures — treat them as internal.</p>';

    return tile('export', 'tile-parchment', 'Export', 'Take it with you', '', body, true);
  }

  function renderAll(result, opts) {
    opts = opts || {};
    return renderDiagnostics(result, opts.fileName) +
      renderOverall(result) +
      renderOverTime(result) +
      renderSegments(result, opts.smallN == null ? 100 : opts.smallN) +
      renderToolbar();
  }

  root.AB = root.AB || {};
  root.AB.render = {
    renderAll: renderAll,
    renderDiagnostics: renderDiagnostics,
    renderOverall: renderOverall,
    renderSegments: renderSegments,
    renderOverTime: renderOverTime,
    srmStatus: srmStatus,
    tile: tile,
    esc: esc,
    int: int,
    pct: pct,
    signedPct: signedPct,
    num: num,
    level: level,
    pFmt: pFmt
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.AB.render;
})(typeof globalThis !== 'undefined' ? globalThis : this);
