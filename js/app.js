/* app.js — state and UI wiring.
 *
 * The configuration lives in a full-bleed configurator tile rather than a fixed
 * sidebar, following the product-configurator pattern: a grid of white utility
 * cards on parchment. The frosted sub-nav keeps "Run analysis" and a jump link
 * to the config reachable from anywhere on the page.
 */
(function (root) {
  'use strict';

  var AB = root.AB;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return AB.render.esc(s); };

  var state = {
    data: null,        // { headers, rows }
    kinds: null,
    suggested: null,   // detected config, kept for "Reset to detected"
    fileName: '',
    result: null,
    resultsHtml: ''
  };

  // ── small helpers ─────────────────────────────────────────────────────────
  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 2600);
  }

  function fillSelect(sel, values, selected, allowNone) {
    sel.innerHTML = '';
    if (allowNone) {
      var none = document.createElement('option');
      none.value = '';
      none.textContent = '— none —';
      sel.appendChild(none);
    }
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
    });
    sel.value = selected == null ? '' : selected;
  }

  // Attribute selectors need escaping for column names with odd characters.
  function cssEsc(s) { return String(s).replace(/(["\\])/g, '\\$1'); }

  function clampAlpha(a) {
    if (!isFinite(a) || a <= 0 || a >= 1) return 0.05;
    return a;
  }

  // ── configurator ──────────────────────────────────────────────────────────
  function buildConfigUi(suggested) {
    var headers = state.data.headers;
    var kindOf = {};
    state.kinds.forEach(function (k) { kindOf[k.name] = k.kind; });

    fillSelect($('cfg-unit'), headers, suggested.unitCol, false);
    fillSelect($('cfg-variant'), headers, suggested.variantCol, false);
    fillSelect($('cfg-date'), headers, suggested.dateCol, true);
    refreshControlOptions(suggested.controlName);

    // Segment chips: any column that is not structural.
    var segBox = $('cfg-segments');
    segBox.innerHTML = '';
    headers.forEach(function (h) {
      if (h === suggested.unitCol || h === suggested.variantCol || h === suggested.dateCol) return;
      var checked = suggested.segmentCols.indexOf(h) !== -1;
      var row = document.createElement('label');
      row.className = 'chip';
      row.innerHTML = '<input type="checkbox" value="' + esc(h) + '"' +
        (checked ? ' checked' : '') + '>' +
        '<span class="t-caption chip-name">' + esc(h) + '</span>' +
        '<span class="t-fine chip-kind">' + esc(kindOf[h] || '') + '</span>';
      segBox.appendChild(row);
    });
    if (!segBox.children.length) {
      segBox.innerHTML = '<p class="t-caption muted">No candidate columns.</p>';
    }

    // Metric rows: checkbox + role + aggregation kind.
    var mBox = $('cfg-metrics');
    mBox.innerHTML = '';
    var candidates = headers.filter(function (h) {
      var k = kindOf[h];
      return (k === 'binary' || k === 'numeric') && h !== suggested.unitCol;
    });
    candidates.forEach(function (h) {
      var chosen = suggested.metrics.filter(function (m) { return m.name === h; })[0];
      var kind = kindOf[h] === 'numeric' ? 'continuous' : 'binary';
      var row = document.createElement('div');
      row.className = 'metric-item';
      row.innerHTML =
        '<label class="metric-head">' +
        '<input type="checkbox" data-metric="' + esc(h) + '"' + (chosen ? ' checked' : '') + '>' +
        '<span class="t-caption metric-name">' + esc(h) + '</span></label>' +
        '<div class="metric-selects">' +
        '<select data-role="' + esc(h) + '" aria-label="Role for ' + esc(h) + '">' +
        '<option value="success">success</option>' +
        '<option value="guardrail">guardrail</option></select>' +
        // Labels stay short so they don't clip in the narrow select; the card
        // hint above already spells out binary -> MAX and continuous -> SUM.
        '<select data-kind="' + esc(h) + '" aria-label="Aggregation for ' + esc(h) + '">' +
        '<option value="binary"' + (kind === 'binary' ? ' selected' : '') + '>binary</option>' +
        '<option value="continuous"' + (kind === 'continuous' ? ' selected' : '') +
        '>continuous</option></select>' +
        '</div>';
      mBox.appendChild(row);
    });
    if (!candidates.length) {
      mBox.innerHTML = '<p class="t-caption muted">No numeric or binary columns found.</p>';
    }

    $('cfg-alpha').value = '0.05';
    $('cfg-smalln').value = '100';
    $('cfg-contaminated').checked = false;
    // BH on but reference-only: the adjusted p is visible from the first run
    // without silently changing anyone's verdict.
    $('cfg-correction').value = 'bh';
    $('cfg-correction-verdict').checked = false;

    $('config').hidden = false;
    $('subnav-config').hidden = false;
    $('nav-run').disabled = false;
  }

  // Control options and the expected-split inputs both depend on the variant
  // column, so they rebuild together whenever it changes.
  function refreshControlOptions(preferred) {
    var vCol = $('cfg-variant').value;
    var idx = state.data.headers.indexOf(vCol);
    var values = idx >= 0 ? AB.csv.distinctValues(state.data.rows, idx, 40).sort() : [];

    var pick = preferred && values.indexOf(preferred) !== -1 ? preferred : null;
    if (!pick) {
      for (var i = 0; i < values.length; i++) {
        if (String(values[i]).toLowerCase().indexOf('control') !== -1) { pick = values[i]; break; }
      }
    }
    if (!pick) pick = values[0];
    fillSelect($('cfg-control'), values, pick, false);

    var box = $('cfg-ratio');
    box.innerHTML = '';
    values.forEach(function (v) {
      var row = document.createElement('label');
      row.className = 'ratio-row';
      row.innerHTML = '<span class="t-caption ratio-name">' + esc(v) + '</span>' +
        '<input type="number" data-ratio="' + esc(v) +
        '" value="1" min="0" step="0.1" aria-label="Expected weight for ' + esc(v) + '">';
      box.appendChild(row);
    });
    if (!values.length) {
      box.innerHTML = '<p class="t-caption muted">Pick a variant column first.</p>';
    }
  }

  function readConfig() {
    var metrics = [];
    document.querySelectorAll('#cfg-metrics input[data-metric]').forEach(function (cb) {
      if (!cb.checked) return;
      var name = cb.getAttribute('data-metric');
      metrics.push({
        name: name,
        kind: document.querySelector('[data-kind="' + cssEsc(name) + '"]').value,
        role: document.querySelector('[data-role="' + cssEsc(name) + '"]').value
      });
    });

    var segmentCols = [];
    document.querySelectorAll('#cfg-segments input[type=checkbox]').forEach(function (cb) {
      if (cb.checked) segmentCols.push(cb.value);
    });

    var expectedRatio = {};
    var anyRatio = false;
    document.querySelectorAll('#cfg-ratio input[data-ratio]').forEach(function (inp) {
      var w = parseFloat(inp.value);
      expectedRatio[inp.getAttribute('data-ratio')] = isFinite(w) ? w : 1;
      if (isFinite(w) && w !== 1) anyRatio = true;
    });

    return {
      unitCol: $('cfg-unit').value,
      variantCol: $('cfg-variant').value,
      dateCol: $('cfg-date').value || null,
      controlName: $('cfg-control').value,
      segmentCols: segmentCols,
      metrics: metrics,
      alpha: clampAlpha(parseFloat($('cfg-alpha').value)),
      smallN: Math.max(0, parseInt($('cfg-smalln').value, 10) || 0),
      expectedRatio: anyRatio ? expectedRatio : null,
      includeContaminated: $('cfg-contaminated').checked,
      correction: $('cfg-correction').value,
      correctionForVerdict: $('cfg-correction-verdict').checked
    };
  }

  function noticeTile(title, detail) {
    return AB.render.tile('', 'tile-white', '', '', '',
      '<div class="notice notice-err">' +
      '<p class="t-body-strong">' + title + '</p>' +
      '<p class="t-caption muted" style="margin-top:8px">' + detail + '</p></div>');
  }

  function setSubnavMeta(text) { $('subnav-meta').textContent = text; }

  // ── run ───────────────────────────────────────────────────────────────────
  function run() {
    if (!state.data) { toast('Load a CSV first.'); return; }
    var cfg = readConfig();

    if (!cfg.unitCol || !cfg.variantCol) { toast('Pick a unit and variant column.'); return; }
    if (cfg.unitCol === cfg.variantCol) { toast('Unit and variant must be different columns.'); return; }
    if (!cfg.metrics.length) { toast('Select at least one metric.'); return; }
    if (!cfg.controlName) { toast('Pick a control label.'); return; }

    var body = $('results-body');
    body.innerHTML = AB.render.tile('', 'tile-white', '', '', '',
      '<p class="empty t-body">Computing…</p>');

    // Yield once so the placeholder paints before the synchronous work starts.
    setTimeout(function () {
      var t0 = Date.now();
      try {
        var result = AB.analyze.run(state.data, cfg);

        if (!result.treatments.length) {
          body.innerHTML = noticeTile('No treatment variant found',
            'Only <code>' + esc(cfg.controlName) + '</code> is present in <code>' +
            esc(cfg.variantCol) + '</code>. Check the control label.');
          return;
        }

        state.result = result;
        state.resultsHtml = AB.render.renderAll(result, {
          fileName: state.fileName,
          smallN: cfg.smallN
        });
        body.innerHTML = state.resultsHtml;

        var d = result.diagnostics;
        setSubnavMeta(state.fileName + ' · ' + AB.render.int(d.unitsOut) + ' units');
        toast('Analysed ' + AB.render.int(d.unitsOut) + ' units in ' + (Date.now() - t0) + 'ms');
      } catch (err) {
        body.innerHTML = noticeTile('Analysis failed',
          esc(err && err.message ? err.message : String(err)));
        if (root.console) console.error(err);
      }
    }, 0);
  }

  // ── file loading ──────────────────────────────────────────────────────────
  function loadText(text, name) {
    state.fileName = name || '';
    $('dz-file').textContent = name ? name + ' — parsing…' : '';

    var t0 = Date.now();
    var data;
    try {
      data = AB.csv.parse(text);
    } catch (e) {
      $('dz-file').textContent = 'Could not parse that file.';
      toast('Parse failed.');
      return;
    }

    if (!data.headers.length || !data.rows.length) {
      $('dz-file').textContent = 'That file has no data rows.';
      toast('Empty CSV.');
      return;
    }

    state.data = data;
    state.kinds = AB.csv.detectColumnKinds(data.headers, data.rows);
    state.suggested = AB.csv.suggestConfig(data.headers, data.rows, state.kinds);
    buildConfigUi(state.suggested);

    $('dz-file').textContent = name + ' — ' + AB.render.int(data.rows.length) +
      ' rows, ' + data.headers.length + ' columns (' + (Date.now() - t0) + 'ms)';
    setSubnavMeta(name + ' · ' + AB.render.int(data.rows.length) + ' rows');

    // The detected config is right in the common case, so just run it.
    run();
  }

  function readFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { loadText(String(reader.result), file.name); };
    reader.onerror = function () { toast('Could not read that file.'); };
    reader.readAsText(file);
  }

  // ── chart tooltip ─────────────────────────────────────────────────────────
  var TIP_LABELS = ['', 'lift', 'p', 'N ctrl', 'N trt', 'rate', 'CI'];

  function bindTooltip() {
    var tip = $('chart-tip');

    document.addEventListener('mouseover', function (e) {
      var hit = e.target.closest ? e.target.closest('.chart-hit') : null;
      if (!hit) return;
      var parts = (hit.getAttribute('data-tip') || '').split('|');
      var html = '<b>' + esc(parts[0]) + '</b>';
      for (var i = 1; i < parts.length && i < TIP_LABELS.length; i++) {
        html += '<br>' + TIP_LABELS[i] + ': ' + esc(parts[i]);
      }
      tip.innerHTML = html;
      tip.classList.add('on');
    });

    document.addEventListener('mousemove', function (e) {
      if (!tip.classList.contains('on')) return;
      var pad = 16;
      var w = tip.offsetWidth, h = tip.offsetHeight;
      var x = e.clientX + pad, y = e.clientY + pad;
      if (x + w > root.innerWidth - 8) x = e.clientX - w - pad;
      if (y + h > root.innerHeight - 8) y = e.clientY - h - pad;
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    });

    document.addEventListener('mouseout', function (e) {
      var hit = e.target.closest ? e.target.closest('.chart-hit') : null;
      if (hit) tip.classList.remove('on');
    });
  }

  // ── export actions ────────────────────────────────────────────────────────
  function handleExport(act) {
    if (!state.result) { toast('Run an analysis first.'); return; }
    var X = AB.export;
    var base = 'ab-test-' + X.stamp();

    if (act === 'copy-overall' || act === 'copy-segments') {
      var rows = act === 'copy-overall'
        ? X.flattenOverall(state.result)
        : X.flattenSegments(state.result);
      if (!rows.length) { toast('Nothing to copy — no segment columns selected.'); return; }
      X.copyText(X.toTsv(X.readable(rows), X.READABLE)).then(function () {
        toast(rows.length + ' row(s) copied — paste into Lark or Docs.');
      }, function () {
        toast('Clipboard blocked by the browser. Use Download CSV instead.');
      });
      return;
    }

    if (act === 'download-csv') {
      X.download(base + '.csv', X.toCsv(X.flattenAll(state.result)), 'text/csv');
      toast('CSV downloaded.');
      return;
    }

    if (act === 'download-html') {
      var html = X.buildHtmlReport(state.result, state.resultsHtml, state.fileName);
      X.download(base + '-report.html', html, 'text/html');
      toast('HTML report downloaded.');
    }
  }

  // ── init ──────────────────────────────────────────────────────────────────
  function init() {
    var dz = $('dropzone');
    var input = $('file-input');

    dz.addEventListener('click', function () { input.click(); });
    dz.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    $('nav-open').addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { readFile(input.files[0]); });

    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
    });
    dz.addEventListener('drop', function (e) {
      readFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
    });
    // Stop a stray drop elsewhere from navigating away from the app.
    root.addEventListener('dragover', function (e) { e.preventDefault(); });
    root.addEventListener('drop', function (e) { e.preventDefault(); });

    $('cfg-form').addEventListener('submit', function (e) { e.preventDefault(); run(); });
    $('nav-run').addEventListener('click', run);
    $('cfg-variant').addEventListener('change', function () { refreshControlOptions(null); });

    $('cfg-reset').addEventListener('click', function () {
      if (!state.suggested) return;
      buildConfigUi(state.suggested);
      toast('Config reset to detected values.');
    });

    // Export buttons live inside re-rendered HTML, so delegate.
    $('results-body').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-act]') : null;
      if (btn) handleExport(btn.getAttribute('data-act'));
    });

    bindTooltip();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Exposed for the headless test harness in test/run-tests.js.
  root.AB.app = { loadText: loadText, run: run, state: state };
})(typeof globalThis !== 'undefined' ? globalThis : this);
