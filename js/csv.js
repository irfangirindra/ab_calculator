/* csv.js — CSV parsing and column-type detection.
 *
 * Rows are kept as arrays of strings (not objects). At ~80k rows x 7 columns
 * an object per row costs far more memory and allocation time than an array,
 * and every consumer here works by column index anyway.
 */
(function (root) {
  'use strict';

  /* Parse CSV text. Handles quoted fields, "" escapes inside quotes, CRLF and
   * LF line endings, a leading BOM, and a trailing newline. */
  function parse(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    var rows = [];
    var field = '';
    var row = [];
    var inQuotes = false;
    var i = 0;
    var n = text.length;

    while (i < n) {
      var ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }

      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ',') { row.push(field); field = ''; i++; continue; }
      if (ch === '\r') {
        // Consume CRLF as a single terminator.
        row.push(field); field = '';
        rows.push(row); row = [];
        i += (text[i + 1] === '\n') ? 2 : 1;
        continue;
      }
      if (ch === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
        i++;
        continue;
      }
      field += ch; i++;
    }
    // Flush the last field/row unless the file ended on a clean newline.
    if (field !== '' || row.length) { row.push(field); rows.push(row); }

    if (!rows.length) return { headers: [], rows: [] };

    var headers = rows[0].map(function (h) { return String(h).trim(); });
    var body = rows.slice(1).filter(function (r) {
      // Drop blank lines, which otherwise show up as a single empty field.
      return !(r.length === 1 && r[0] === '');
    });

    // Normalise ragged rows so every consumer can index safely.
    for (var k = 0; k < body.length; k++) {
      var r = body[k];
      if (r.length < headers.length) {
        while (r.length < headers.length) r.push('');
      } else if (r.length > headers.length) {
        r.length = headers.length;
      }
    }

    return { headers: headers, rows: body };
  }

  // ── value coercion ────────────────────────────────────────────────────────
  var TRUE_SET = { '1': 1, 'true': 1, 'TRUE': 1, 'True': 1, 't': 1, 'yes': 1, 'Y': 1, 'y': 1 };
  var FALSE_SET = { '0': 1, 'false': 1, 'FALSE': 1, 'False': 1, 'f': 1, 'no': 1, 'N': 1, 'n': 1 };
  var NULL_SET = { '': 1, 'null': 1, 'NULL': 1, 'None': 1, 'nan': 1, 'NaN': 1, 'NA': 1, 'na': 1 };

  function isBlank(v) { return NULL_SET[v] === 1; }

  /* Coerce a cell to a number for metric arithmetic.
   * Booleans map to 1/0 — the source data has `is_save_passenger` as literal
   * true/false, and treating that as non-numeric would silently drop it. */
  function toNumber(v) {
    if (isBlank(v)) return 0;
    if (TRUE_SET[v] === 1) return 1;
    if (FALSE_SET[v] === 1) return 0;
    var x = Number(v);
    return isFinite(x) ? x : 0;
  }

  var DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;

  /* Classify every column. Samples up to `sampleSize` rows evenly across the
   * file rather than just the head, so a column that only turns non-binary
   * late in the file is still caught.
   *
   *   binary      — all non-blank values in {0,1,true,false}
   *   numeric     — all non-blank values finite, with at least one outside {0,1}
   *   date        — YYYY-MM-DD (optionally with a time part)
   *   categorical — everything else
   */
  function detectColumnKinds(headers, rows, sampleSize) {
    sampleSize = sampleSize || 20000;
    var nRows = rows.length;
    var step = nRows > sampleSize ? Math.ceil(nRows / sampleSize) : 1;

    return headers.map(function (name, c) {
      var allBinary = true, allNumeric = true, allDate = true;
      var sawNonBinaryNumber = false, sawValue = false;
      var uniq = new Set();
      var uniqCapped = false;

      for (var i = 0; i < nRows; i += step) {
        var v = rows[i][c];
        if (isBlank(v)) continue;
        sawValue = true;

        if (uniq.size < 200) uniq.add(v); else uniqCapped = true;

        var isBin = TRUE_SET[v] === 1 || FALSE_SET[v] === 1;
        if (!isBin) allBinary = false;

        if (allNumeric) {
          var x = Number(v);
          if (!isFinite(x) || v === '') allNumeric = false;
          else if (x !== 0 && x !== 1) sawNonBinaryNumber = true;
        }
        if (allDate && !DATE_RE.test(v)) allDate = false;
        if (!allBinary && !allNumeric && !allDate) break;
      }

      var kind;
      if (!sawValue) kind = 'empty';
      else if (allDate) kind = 'date';
      else if (allBinary) kind = 'binary';
      else if (allNumeric && sawNonBinaryNumber) kind = 'numeric';
      else if (allNumeric) kind = 'binary';
      else kind = 'categorical';

      return {
        name: name,
        index: c,
        kind: kind,
        uniqueApprox: uniq.size,
        uniqueCapped: uniqCapped
      };
    });
  }

  // Exact distinct count for one column — used for the unit/variant heuristics.
  function distinctCount(rows, colIndex, cap) {
    var seen = new Set();
    for (var i = 0; i < rows.length; i++) {
      seen.add(rows[i][colIndex]);
      if (cap && seen.size > cap) return cap + 1;
    }
    return seen.size;
  }

  function distinctValues(rows, colIndex, cap) {
    var seen = new Set();
    for (var i = 0; i < rows.length; i++) {
      seen.add(rows[i][colIndex]);
      if (cap && seen.size > cap) break;
    }
    return Array.from(seen);
  }

  var UNIT_HINTS = ['unit', 'user_id', 'userid', 'cookie_id', 'cookieid', 'visitor_id',
    'device_id', 'user', 'unit_id', 'id'];
  var VARIANT_HINTS = ['variant', 'variant_name', 'group', 'bucket', 'treatment',
    'experiment_group', 'arm', 'variation'];

  function nameScore(name, hints) {
    var lower = String(name).toLowerCase();
    for (var i = 0; i < hints.length; i++) {
      if (lower === hints[i]) return 100 - i;
      if (lower.indexOf(hints[i]) !== -1) return 50 - i;
    }
    return 0;
  }

  /* Best-effort initial config. Every field stays editable in the UI — this
   * only saves the user from filling in the obvious cases by hand. */
  function suggestConfig(headers, rows, kinds) {
    var used = {};

    // unit: strongest name match, else the highest-cardinality column.
    var unitCol = null, unitBest = -1;
    kinds.forEach(function (k) {
      var score = nameScore(k.name, UNIT_HINTS) * 1000;
      if (score === 0) {
        // Fall back to cardinality; a unit id is near-unique per row.
        score = k.uniqueCapped ? 500 : k.uniqueApprox;
      }
      if (k.kind === 'date') score = -1;
      if (score > unitBest) { unitBest = score; unitCol = k.name; }
    });
    if (unitCol) used[unitCol] = 1;

    // variant: name match, else a low-cardinality categorical column.
    var variantCol = null, variantBest = -1;
    kinds.forEach(function (k) {
      if (used[k.name]) return;
      var score = nameScore(k.name, VARIANT_HINTS) * 1000;
      if (score === 0) {
        if (k.kind !== 'categorical') return;
        var d = distinctCount(rows, k.index, 12);
        if (d < 2 || d > 8) return;
        score = 100 - d;
      }
      if (score > variantBest) { variantBest = score; variantCol = k.name; }
    });
    if (variantCol) used[variantCol] = 1;

    // date: first date-kind column.
    var dateCol = null;
    kinds.forEach(function (k) {
      if (!dateCol && !used[k.name] && k.kind === 'date') dateCol = k.name;
    });
    if (dateCol) used[dateCol] = 1;

    // segments: remaining categorical columns with a usable number of levels.
    var segmentCols = [];
    kinds.forEach(function (k) {
      if (used[k.name] || k.kind !== 'categorical') return;
      var d = distinctCount(rows, k.index, 51);
      if (d >= 2 && d <= 50) { segmentCols.push(k.name); used[k.name] = 1; }
    });

    // metrics: every remaining binary/numeric column.
    var metrics = [];
    kinds.forEach(function (k) {
      if (used[k.name]) return;
      if (k.kind === 'binary' || k.kind === 'numeric') {
        metrics.push({ name: k.name, kind: k.kind, role: 'success' });
      }
    });

    // Control label: prefer an obvious name among the variant values.
    var controlName = null;
    if (variantCol) {
      var vIdx = headers.indexOf(variantCol);
      var vals = distinctValues(rows, vIdx, 20);
      for (var i = 0; i < vals.length; i++) {
        var lv = String(vals[i]).toLowerCase();
        if (lv === 'control' || lv === 'ctrl' || lv === 'base' || lv === 'baseline' ||
          lv.indexOf('control') !== -1) { controlName = vals[i]; break; }
      }
      if (!controlName && vals.length) controlName = vals.slice().sort()[0];
    }

    return {
      unitCol: unitCol,
      variantCol: variantCol,
      dateCol: dateCol,
      segmentCols: segmentCols,
      controlName: controlName,
      metrics: metrics
    };
  }

  root.AB = root.AB || {};
  root.AB.csv = {
    parse: parse,
    toNumber: toNumber,
    isBlank: isBlank,
    detectColumnKinds: detectColumnKinds,
    distinctCount: distinctCount,
    distinctValues: distinctValues,
    suggestConfig: suggestConfig
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.AB.csv;
})(typeof globalThis !== 'undefined' ? globalThis : this);
