# AB Test Calculator (web, unit-level)

Post-analysis calculator for A/B experiments. Input is a CSV of `date × unit`, but it's
**computed per unit**: a unit that converts at least once during the experiment window is
counted as converted.

Open `index.html` — double-clicking from Finder is enough, no server needed, nothing to
install. All parsing and calculation runs in the browser; **no data is sent anywhere**.

---

## Aggregation rules

| Thing | Rule |
|---|---|
| **Binary** metric (0/1, true/false) | **MAX** across dates — convert once = converted |
| **Continuous** metric (GMV, revenue, count) | **SUM** across dates |
| **Segment** value | taken from that unit's **earliest date** |
| **Date** column | collapsed, not analyzed per-date (used for the over-time chart) |
| Unit appearing in **>1 variant** | **excluded** (contaminates both arms at once); a checkbox lets you include them |

Row order in the CSV doesn't need to be date-sorted — dates are compared explicitly.

## Statistical tests

| Metric type | Test | Detail |
|---|---|---|
| binary | two-proportion z-test | pooled SE for the p-value, unpooled SE for the CI, CI expressed as relative lift — same as the notebook |
| continuous | Welch t-test | mean per unit, Welch–Satterthwaite df, CI from the t-distribution |
| SRM | chi-square goodness-of-fit | expected split is editable, so an 80/20 design isn't wrongly flagged |

If the control rate is 0, relative lift is **undefined** — shown as `new` (if the treatment
converts) or `—`, not `0%`. Significance direction is always taken from the absolute
difference, not from the lift.

---

## Multiple comparisons

**Alpha is static.** Whatever you set it to is what every test uses, and it is never divided
by the number of variants, metrics, or segments. Multiplicity is expressed as an **adjusted
p-value** instead.

That direction matters. An adjusted alpha means the threshold on screen changes based on how
many columns happened to be in the export — two people analysing the same experiment get
different verdicts, and `0.05 / 3 = 0.01666…` is unreadable. An adjusted p keeps one
threshold on screen, composes across families without degrading, and matches what statsmodels
and R report, so a reviewer can check the number.

| Method | Controls | Use for |
|---|---|---|
| **Benjamini–Hochberg** (default) | false discovery rate | scanning — segment breakdowns, several success metrics |
| **Bonferroni** | family-wise error rate | when a single false positive is genuinely costly |
| **none** | — | pre-registered single primary metric |

### What counts as one family

A family is a set of tests where a false positive on **any** member would drive the same
decision — that shared decision is what makes them one error budget.

| Scope | Family | Why |
|---|---|---|
| Overall | every treatment arm × success metric | any one coming back positive is a reason to ship, so it's one decision |
| Segments | the segment values within one treatment × segment column × metric | scanning countries for one metric is one exploration; a different metric is another |
| Over time | **never corrected** | see below |

The overall family degrades on its own: one arm with one success metric is a family of 1 and
nothing is adjusted.

### Guardrails are never corrected

Correcting a guardrail **raises** its bar, which lowers the chance of catching a real
regression — exactly backwards for a metric whose whole job is to catch harm. Guardrails are
held out of every family and never join one. The `success` / `guardrail` role in the metric
config is what drives this, so set it deliberately.

### The over-time panel is deliberately left raw

Re-reading one accumulating experiment is a **sequential** testing problem, not a
multiplicity one. Bonferroni and BH both assume a fixed set of separate hypotheses, so
neither fixes peeking — applying them across dates would look like a correction while
addressing nothing. Doing it properly needs always-valid p-values or an alpha-spending
function. Until then that panel is a diagnostic, not a decision rule.

> Not implemented: **Dunnett's test**, which is the correct many-to-one comparison for
> several arms against a shared control and is less conservative than Bonferroni because it
> accounts for the correlation the shared control induces. The arm axis currently goes
> through the generic correction instead.

By default the adjusted p is **shown but does not drive the verdict** — there's a checkbox
for that. The raw p-value is always kept alongside it, on screen and in every export.

---

## CSV format

A unit column and a variant column are required. Everything else is optional.

```csv
date_key,unit,variant,traffic_type,CVR_to_login,CVR_to_issued,is_save_passenger
2026-06-08,1788724903287983389,CONTROL,Metasearch,0,0,true
2026-06-20,1855388215585814142,VAR_ENABLE,Metasearch,1,0,false
```

Columns are auto-detected (unit, variant, date, segment candidates, metric candidates) and
all of it can be overridden in the sidebar. Boolean `true`/`false` is treated as binary.

---

## Output

1. **SRM banner** — χ², p, observed vs expected split
2. **Data & granularity panel** — rows in → units analysed, how many multi-date units,
   how many segment collisions, how many contaminated units. This panel is what makes the
   effect of the granularity change explicit.
3. **KPI cards** per treatment × metric — lift, CI, raw p, adjusted p, N
4. **Significance over time** — cumulative lift with CI and p-value per date. Each point
   answers "if we stopped here, what would the result be". Useful for seeing the peeking
   problem. Raw p-values only — see Multiple comparisons above.
5. **Segment breakdown** — one table per treatment × metric × segment column, with a `p adj`
   column on corrected tables

### Export

- **Copy overall / segments (TSV)** — paste directly as a table into Lark Sheets / Docs
- **Download CSV** — all results (overall + segment + cumulative) as a flat table, raw numbers
- **Download HTML report** — one self-contained file to share

The CSV carries three separate verdict columns, so nothing is ambiguous downstream:
`significance` (raw), `significance_adjusted` (corrected, blank when uncorrected), and
`verdict` (the one the tool actually displayed under your settings). Alongside them,
`p_value`, `p_adjusted`, `correction`, and `family_n`.

> All exports contain experiment numbers. Treat them as **internal / confidential**.

---

## Test

```bash
node test/run-tests.js
```

230 assertions: statistical distributions (cross-checked against numerical integration, not
memorized constants), z-test formula parity against the notebook, unit-level aggregation
edge cases, multiplicity corrections (BH against its hand-computed step-up definition, order
independence, NaN held out of the family), role-aware correction (guardrails stay
untouched), rendered-markup assertions for the adjusted-p column, and golden numbers from
three real experiment exports — each rendered under all three correction settings and checked
for the invariant that **correcting can only ever remove significance, never create it**.

The golden-number tests automatically **skip** if the CSV files aren't present at
`platform-analytics/sandbox_user/muhammad.girindra/ab_test_calculator/` — everything else
still runs. No data files are copied into this repo.

---

## Structure

| File | Contents |
|---|---|
| `js/stats.js` | erfc, normal, chi-square, Student t, z-test, Welch t-test, SRM, Bonferroni / BH p-adjustment — zero dependency |
| `js/csv.js` | CSV parser (quoted fields, CRLF, BOM) + column type detection |
| `js/aggregate.js` | collapses `date × unit` → unit, plus an incremental cumulative accumulator |
| `js/analyze.js` | orchestration: overall, per-segment, over-time, SRM, correction families |
| `js/render.js` | result tiles, KPI cards, segment tables, SVG chart (hand-rolled, no library) |
| `js/export.js` | CSV / TSV / HTML report |
| `js/app.js` | state + UI wiring |

Everything uses classic `<script>` tags under the `window.AB` namespace, **not** ES
modules — modules are blocked by CORS on `file://`, so the app wouldn't run if the file is
just double-clicked. If you add a new JS file, follow the same pattern and register it in
`index.html` in dependency order.