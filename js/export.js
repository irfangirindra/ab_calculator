/* export.js — flatten results for the clipboard, a CSV file, or a standalone
 * HTML report.
 *
 * Everything produced here contains experiment figures, so it is internal
 * material by default. Nothing leaves the browser: downloads use blob URLs and
 * the clipboard write is local.
 */
(function (root) {
  'use strict';

  var COLUMNS = [
    'treatment', 'control', 'scope', 'segment_column', 'segment',
    'metric', 'role', 'metric_kind',
    'n_control', 'n_treatment',
    'converted_control', 'converted_treatment',
    'rate_control', 'rate_treatment',
    'abs_diff', 'rel_lift', 'ci_low', 'ci_high',
    'statistic', 'stat_name', 'df',
    // Raw p and adjusted p both ship, always. Alpha is a single constant now —
    // multiplicity lands on p_adjusted, so alpha never varies row to row.
    'p_value', 'p_adjusted', 'correction', 'family_n', 'alpha',
    // significance = raw, significance_adjusted = corrected, verdict = the one
    // the tool actually displayed under the current setting.
    'significance', 'significance_adjusted', 'verdict'
  ];

  function metricByName(config, name) {
    for (var i = 0; i < config.metrics.length; i++) {
      if (config.metrics[i].name === name) return config.metrics[i];
    }
    return { name: name, role: '', kind: '' };
  }

  // Raw numbers, not display strings — these rows land in a spreadsheet.
  function flattenRow(result, trt, scope, segCol, r, metric, alpha) {
    return {
      treatment: trt,
      control: result.config.controlName,
      scope: scope,
      segment_column: segCol || '',
      segment: r.segment == null ? '' : r.segment,
      metric: metric.name,
      role: metric.role || '',
      metric_kind: r.kind,
      n_control: r.nCtrl,
      n_treatment: r.nTrt,
      converted_control: r.convCtrl,
      converted_treatment: r.convTrt,
      rate_control: r.rCtrl,
      rate_treatment: r.rTrt,
      abs_diff: r.absDiff,
      rel_lift: r.liftDefined ? r.lift : '',
      ci_low: r.liftDefined ? r.ciLo : '',
      ci_high: r.liftDefined ? r.ciHi : '',
      statistic: isFinite(r.stat) ? r.stat : '',
      stat_name: r.kind === 'binary' ? 'z' : 't',
      df: isFinite(r.df) ? r.df : '',
      p_value: r.pVal,
      p_adjusted: r.corrected && isFinite(r.pAdj) ? r.pAdj : '',
      correction: r.corrected ? result.correction.method : 'none',
      family_n: r.corrected ? r.familyN : '',
      alpha: alpha,
      significance: r.sig,
      significance_adjusted: r.corrected ? r.sigAdj : '',
      verdict: root.AB.analyze.verdictOf(r, result.correction.forVerdict)
    };
  }

  function flattenOverall(result) {
    var alpha = result.config.alpha;
    var rows = [];
    result.treatments.forEach(function (trt) {
      result.config.metrics.forEach(function (m) {
        rows.push(flattenRow(result, trt, 'overall', '',
          result.overall[trt][m.name], m, alpha));
      });
    });
    return rows;
  }

  function flattenSegments(result) {
    var alpha = result.config.alpha;
    var rows = [];
    (result.config.segmentCols || []).forEach(function (col) {
      result.treatments.forEach(function (trt) {
        result.config.metrics.forEach(function (m) {
          (result.segments[trt][col][m.name] || []).forEach(function (r) {
            rows.push(flattenRow(result, trt, 'segment', col, r, m, alpha));
          });
        });
      });
    });
    return rows;
  }

  function flattenOverTime(result) {
    var alpha = result.config.alpha;
    var rows = [];
    if (!result.overTime) return rows;
    result.treatments.forEach(function (trt) {
      result.config.metrics.forEach(function (m) {
        (result.overTime.results[trt][m.name] || []).forEach(function (p) {
          var row = flattenRow(result, trt, 'cumulative', '', p, m, alpha);
          row.segment = p.date;          // reuse the segment slot for the cutoff date
          row.segment_column = 'date';
          rows.push(row);
        });
      });
    });
    return rows;
  }

  function flattenAll(result) {
    return flattenOverall(result).concat(flattenSegments(result), flattenOverTime(result));
  }

  // ── serialisation ─────────────────────────────────────────────────────────
  function csvCell(v) {
    var s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(rows, columns) {
    columns = columns || COLUMNS;
    var out = [columns.join(',')];
    rows.forEach(function (r) {
      out.push(columns.map(function (c) { return csvCell(r[c]); }).join(','));
    });
    return out.join('\r\n');
  }

  // TSV for clipboard: Lark Sheets and Docs both split tab-separated text into
  // real table cells, so tabs beat commas here. Strip tabs/newlines from values.
  function tsvCell(v) {
    var s = v == null ? '' : String(v);
    return s.replace(/[\t\r\n]+/g, ' ');
  }

  function toTsv(rows, columns) {
    columns = columns || COLUMNS;
    var out = [columns.join('\t')];
    rows.forEach(function (r) {
      out.push(columns.map(function (c) { return tsvCell(r[c]); }).join('\t'));
    });
    return out.join('\n');
  }

  /* Rounded, human-readable variant for pasting into a writeup. Percentages
   * come out as percentages so nobody has to reformat a column of 0.1251. */
  var READABLE = ['treatment', 'segment_column', 'segment', 'metric', 'role',
    'n_control', 'n_treatment', 'rate_control', 'rate_treatment',
    'rel_lift', 'ci_low', 'ci_high', 'p_value', 'p_adjusted', 'verdict'];

  function readable(rows) {
    var R = root.AB.render;
    return rows.map(function (r) {
      var isRate = r.metric_kind === 'binary';
      var fmtLevel = function (v) { return v === '' ? '' : (isRate ? R.pct(v) : R.num(v)); };
      return {
        treatment: r.treatment + ' vs ' + r.control,
        segment_column: r.segment_column,
        segment: r.segment,
        metric: r.metric,
        role: r.role,
        n_control: r.n_control,
        n_treatment: r.n_treatment,
        rate_control: fmtLevel(r.rate_control),
        rate_treatment: fmtLevel(r.rate_treatment),
        rel_lift: r.rel_lift === '' ? 'n/a' : R.signedPct(r.rel_lift),
        ci_low: r.ci_low === '' ? '' : R.signedPct(r.ci_low),
        ci_high: r.ci_high === '' ? '' : R.signedPct(r.ci_high),
        p_value: R.pFmt(r.p_value),
        // Blank rather than "—" so an uncorrected row reads as "not applicable"
        // instead of "we tried and got nothing".
        p_adjusted: r.p_adjusted === '' ? '' : R.pFmt(r.p_adjusted),
        verdict: r.verdict
      };
    });
  }

  // ── browser actions ───────────────────────────────────────────────────────
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke on the next tick; revoking synchronously can cancel the download.
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // file:// without a secure context has no async clipboard — fall back.
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('Clipboard unavailable'));
    });
  }

  function stamp() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes());
  }

  /* Self-contained HTML report: the rendered results plus the stylesheet
   * inlined, so a single file can be shared without the rest of the app. */
  function buildHtmlReport(result, resultsHtml, fileName) {
    var css = '';
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      try {
        var rules = sheets[i].cssRules;
        for (var j = 0; j < rules.length; j++) css += rules[j].cssText + '\n';
      } catch (e) {
        // Cross-origin stylesheet — cannot read rules. Not expected locally.
      }
    }

    var cfg = result.config;
    var corr = result.correction;
    var METHOD = { none: 'none', bonferroni: 'Bonferroni', bh: 'Benjamini-Hochberg (FDR)' };
    var meta = [
      'Source: ' + (fileName || 'CSV'),
      'Generated: ' + new Date().toLocaleString(),
      'Granularity: per unit (binary = MAX across dates, continuous = SUM)',
      'Control: ' + cfg.controlName,
      'Treatments: ' + result.treatments.join(', '),
      'Alpha: ' + cfg.alpha + ' (two-tailed, not divided)',
      'Multiple comparisons: ' + METHOD[corr.method] +
        (corr.method === 'none' ? '' :
          ' — overall family of ' + corr.overallFamilyN +
          ' (success metrics x arms); ' +
          (corr.forVerdict ? 'drives the verdict' : 'reference only') +
          '; guardrails never corrected'),
      'Units analysed: ' + result.diagnostics.unitsOut +
        ' (from ' + result.diagnostics.rowsIn + ' rows)'
    ];

    /* Drop interactive-only chrome from the static report. Sections are marked
     * with data-export-omit rather than matched on their markup, so restyling a
     * tile cannot silently break this. Parsed via a detached DOM instead of a
     * regex — nested tags make regex stripping unreliable. */
    var holder = document.createElement('div');
    holder.innerHTML = resultsHtml;
    holder.querySelectorAll('[data-export-omit]').forEach(function (el) { el.remove(); });
    holder.querySelectorAll('.chart-hit').forEach(function (el) { el.remove(); });
    var body = holder.innerHTML;

    var esc = root.AB.render.esc;

    return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>AB Test Report — ' + esc(fileName || 'results') + '</title>' +
      '<style>\n' + css + '\n</style></head><body>' +
      '<section class="tile tile-parchment">' +
      '<div class="wrap">' +
      '<p class="eyebrow">Report</p>' +
      '<h1 class="t-display-lg">AB Test Post-Analysis &mdash; per unit</h1>' +
      '<div class="prose" style="margin-top:24px">' +
      meta.map(function (m) { return '<p class="t-caption">' + esc(m) + '</p>'; }).join('') +
      '</div></div></section>' +
      '<main>' + body + '</main></body></html>';
  }

  root.AB = root.AB || {};
  root.AB.export = {
    COLUMNS: COLUMNS,
    READABLE: READABLE,
    flattenOverall: flattenOverall,
    flattenSegments: flattenSegments,
    flattenOverTime: flattenOverTime,
    flattenAll: flattenAll,
    readable: readable,
    toCsv: toCsv,
    toTsv: toTsv,
    download: download,
    copyText: copyText,
    stamp: stamp,
    buildHtmlReport: buildHtmlReport
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.AB.export;
})(typeof globalThis !== 'undefined' ? globalThis : this);
