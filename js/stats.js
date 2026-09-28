/* stats.js — distributions and hypothesis tests, no dependencies.
 *
 * Replaces the scipy.stats calls from the original notebook:
 *   stats.norm.cdf / stats.norm.ppf  -> normCdf / normPpf
 *   stats.chisquare                  -> srm (via chi2Sf)
 *   (new, for continuous metrics)    -> welchT (via tCdf / tPpf)
 */
(function (root) {
  'use strict';

  var SQRT2 = Math.SQRT2;

  /* Chebyshev erfc (Numerical Recipes 3rd ed. §6.2). Chosen over the simpler
   * Abramowitz & Stegun 7.1.26 polynomial because A&S is accurate to ~1.5e-7
   * in ABSOLUTE terms, which floors every p-value below ~1e-7 to exactly zero.
   * This form keeps relative accuracy into the far tail, so a wildly
   * significant metric reports p = 3.1e-42 instead of p = 0.0000. */
  var ERFC_COF = [-1.3026537197817094, 6.4196979235649026e-1,
    1.9476473204185836e-2, -9.561514786808631e-3, -9.46595344482036e-4,
    3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
    -1.624290004647e-6, 1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
    6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10,
    9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13,
    -1.12708e-13, 3.81e-16, 7.106e-15];

  function erfc(x) {
    var z = Math.abs(x);
    var t = 2 / (2 + z);
    var ty = 4 * t - 2;
    var d = 0, dd = 0, tmp;
    for (var j = ERFC_COF.length - 1; j > 0; j--) {
      tmp = d;
      d = ty * d - dd + ERFC_COF[j];
      dd = tmp;
    }
    var ans = t * Math.exp(-z * z + 0.5 * (ERFC_COF[0] + ty * d) - dd);
    return x >= 0 ? ans : 2 - ans;
  }

  function erf(x) { return 1 - erfc(x); }

  function normCdf(z) { return 0.5 * erfc(-z / SQRT2); }

  // Upper tail. Kept separate from 1-normCdf so tail precision survives.
  function normSf(z) { return 0.5 * erfc(z / SQRT2); }

  // Acklam's inverse normal CDF, refined by one Halley step.
  var A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  var B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  var C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  var D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];

  function normPpf(p) {
    if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
    var q, r, x;
    if (p < 0.02425) {
      q = Math.sqrt(-2 * Math.log(p));
      x = (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
        ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
    } else if (p <= 0.97575) {
      q = p - 0.5;
      r = q * q;
      x = (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q /
        (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
    } else {
      q = Math.sqrt(-2 * Math.log(1 - p));
      x = -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
        ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
    }
    // One Halley refinement against normCdf.
    var e = normCdf(x) - p;
    var u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
    return x - u / (1 + x * u / 2);
  }

  // ── gamma / chi-square ────────────────────────────────────────────────────
  var LG_C = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];

  function logGamma(x) {
    var y = x, tmp = x + 5.5, ser = 1.000000000190015;
    tmp -= (x + 0.5) * Math.log(tmp);
    for (var j = 0; j < 6; j++) ser += LG_C[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }

  // Series expansion for P(s, x); converges fast for x < s+1.
  function gammaSeries(s, x) {
    var ap = s, sum = 1 / s, del = sum;
    for (var i = 0; i < 500; i++) {
      ap++;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-x + s * Math.log(x) - logGamma(s));
  }

  // Continued fraction (modified Lentz) for Q(s, x); converges for x >= s+1.
  function gammaCF(s, x) {
    var TINY = 1e-300;
    var b = x + 1 - s, c = 1 / TINY, d = 1 / b, h = d;
    for (var j = 1; j < 500; j++) {
      var an = -j * (j - s);
      b += 2;
      d = an * d + b; if (Math.abs(d) < TINY) d = TINY;
      c = b + an / c; if (Math.abs(c) < TINY) c = TINY;
      d = 1 / d;
      var delta = d * c;
      h *= delta;
      if (Math.abs(delta - 1) < 1e-15) break;
    }
    return Math.exp(-x + s * Math.log(x) - logGamma(s)) * h;
  }

  // Regularized lower incomplete gamma P(s, x).
  function lowerGammaReg(s, x) {
    if (x <= 0) return 0;
    return x < s + 1 ? gammaSeries(s, x) : 1 - gammaCF(s, x);
  }

  /* Regularized upper incomplete gamma Q(s, x).
   * Exposed separately so chi2Sf can return the continued fraction directly.
   * Going through 1 - lowerGammaReg() would round any Q below ~1e-16 to
   * exactly 0 — a badly broken SRM would then report p = 0 instead of, say,
   * p = 4.7e-20. */
  function upperGammaReg(s, x) {
    if (x <= 0) return 1;
    return x < s + 1 ? 1 - gammaSeries(s, x) : gammaCF(s, x);
  }

  // Chi-square survival function (upper tail).
  function chi2Sf(x, df) {
    if (!(x > 0) || !(df > 0)) return 1;
    return upperGammaReg(df / 2, x / 2);
  }

  // ── beta / Student t ──────────────────────────────────────────────────────
  function logBeta(a, b) {
    return logGamma(a) + logGamma(b) - logGamma(a + b);
  }

  function betacf(a, b, x) {
    var TINY = 1e-300;
    var qab = a + b, qap = a + 1, qam = a - 1;
    var c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < TINY) d = TINY;
    d = 1 / d;
    var h = d;
    for (var m = 1; m <= 300; m++) {
      var m2 = 2 * m;
      var aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
      c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
      d = 1 / d;
      h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
      c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
      d = 1 / d;
      var del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-15) break;
    }
    return h;
  }

  /* Regularized incomplete beta I_x(a, b).
   * The front factor exp(-logBeta(a,b) + a*ln x + b*ln(1-x)) is invariant
   * under (a,b,x) -> (b,a,1-x), so the same `front` serves both branches. */
  function incBeta(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var front = Math.exp(-logBeta(a, b) + a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return front * betacf(a, b, x) / a;
    return 1 - front * betacf(b, a, 1 - x) / b;
  }

  function tCdf(t, df) {
    if (!isFinite(t)) return t > 0 ? 1 : 0;
    if (!(df > 0)) return NaN;
    var p = 0.5 * incBeta(df / 2, 0.5, df / (df + t * t));
    return t > 0 ? 1 - p : p;
  }

  // Two-tailed t p-value.
  function tSf2(t, df) {
    if (!isFinite(t)) return 0;
    if (!(df > 0)) return NaN;
    return incBeta(df / 2, 0.5, df / (df + t * t));
  }

  /* Inverse t CDF by bisection. Welch's df is non-integer, which rules out the
   * usual closed-form approximations that assume integer df. 200 iterations on
   * a fixed bracket is cheap and only runs once per test. */
  function tPpf(p, df) {
    if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
    if (df > 1e7) return normPpf(p);
    var lo = -1e3, hi = 1e3;
    for (var i = 0; i < 200; i++) {
      var mid = (lo + hi) / 2;
      if (tCdf(mid, df) < p) lo = mid; else hi = mid;
      if (hi - lo < 1e-12) break;
    }
    return (lo + hi) / 2;
  }

  // ── shared result shape ──────────────────────────────────────────────────
  // Rounding in the tail approximations can nudge a p-value a hair past 1.
  function clamp01(p) {
    if (!isFinite(p)) return NaN;
    return p < 0 ? 0 : (p > 1 ? 1 : p);
  }

  /* Direction comes from the absolute difference, NOT the lift — lift is NaN
   * when the control rate is 0, and would silently swallow the sign. */
  function classify(pVal, rateDiff, alpha) {
    if (isFinite(pVal) && pVal < alpha && rateDiff !== 0) {
      return rateDiff > 0 ? 'positive' : 'negative';
    }
    return 'not_sig';
  }

  /* Two-proportion z-test. Port of _compute_metric_stats() from the notebook:
   * pooled SE for the p-value, unpooled SE for the CI, and the CI expressed as
   * a relative lift by dividing through by the control rate. */
  function twoProportionZ(o) {
    var nCtrl = o.nCtrl, nTrt = o.nTrt;
    var convCtrl = o.convCtrl, convTrt = o.convTrt;
    var alpha = o.alpha;

    var rCtrl = nCtrl ? convCtrl / nCtrl : 0;
    var rTrt = nTrt ? convTrt / nTrt : 0;
    var rateDiff = rTrt - rCtrl;

    // Relative lift is undefined when the control rate is 0 — flag it rather
    // than report 0, matching the notebook.
    var liftDefined = rCtrl > 0;

    var pPool = (nCtrl + nTrt) ? (convCtrl + convTrt) / (nCtrl + nTrt) : 0;
    var denom = (nCtrl && nTrt && pPool > 0 && pPool < 1)
      ? pPool * (1 - pPool) * (1 / nCtrl + 1 / nTrt) : 0;
    var seZ = denom > 0 ? Math.sqrt(denom) : 1e-9;
    var z = rateDiff / seZ;
    var pVal = clamp01(2 * normSf(Math.abs(z)));

    var zCrit = normPpf(1 - alpha / 2);
    var seDelta = (nCtrl && nTrt)
      ? Math.sqrt(rCtrl * (1 - rCtrl) / nCtrl + rTrt * (1 - rTrt) / nTrt) : 0;
    var absCiLo = rateDiff - zCrit * seDelta;
    var absCiHi = rateDiff + zCrit * seDelta;

    return {
      kind: 'binary',
      nCtrl: nCtrl, nTrt: nTrt,
      convCtrl: convCtrl, convTrt: convTrt,
      rCtrl: rCtrl, rTrt: rTrt,
      absDiff: rateDiff,
      absCiLo: absCiLo, absCiHi: absCiHi,
      lift: liftDefined ? rateDiff / rCtrl : NaN,
      liftDefined: liftDefined,
      ciLo: liftDefined ? absCiLo / rCtrl : NaN,
      ciHi: liftDefined ? absCiHi / rCtrl : NaN,
      stat: z, df: Infinity, pVal: pVal,
      sig: classify(pVal, rateDiff, alpha)
    };
  }

  /* Welch's t-test on per-unit values (continuous metrics).
   * Takes sufficient statistics so callers can accumulate incrementally for
   * the over-time series. The relative-lift CI is the absolute CI rescaled by
   * the control mean — the same convention as the binary path, so the two
   * render identically. */
  function welchT(o) {
    var nCtrl = o.nCtrl, nTrt = o.nTrt;
    var sumCtrl = o.sumCtrl, sumTrt = o.sumTrt;
    var sumSqCtrl = o.sumSqCtrl, sumSqTrt = o.sumSqTrt;
    var alpha = o.alpha;

    var mCtrl = nCtrl ? sumCtrl / nCtrl : 0;
    var mTrt = nTrt ? sumTrt / nTrt : 0;
    var diff = mTrt - mCtrl;

    // Unbiased sample variances. Clamped at 0 because the sum-of-squares form
    // can produce a tiny negative value through cancellation.
    var vCtrl = nCtrl > 1 ? Math.max(0, (sumSqCtrl - nCtrl * mCtrl * mCtrl) / (nCtrl - 1)) : 0;
    var vTrt = nTrt > 1 ? Math.max(0, (sumSqTrt - nTrt * mTrt * mTrt) / (nTrt - 1)) : 0;

    var sCtrl = nCtrl ? vCtrl / nCtrl : 0;
    var sTrt = nTrt ? vTrt / nTrt : 0;
    var se = Math.sqrt(sCtrl + sTrt);

    var df, t, pVal;
    if (se > 0) {
      // Welch–Satterthwaite.
      var num = (sCtrl + sTrt) * (sCtrl + sTrt);
      var den = (nCtrl > 1 ? sCtrl * sCtrl / (nCtrl - 1) : 0) +
        (nTrt > 1 ? sTrt * sTrt / (nTrt - 1) : 0);
      df = den > 0 ? num / den : Math.max(1, nCtrl + nTrt - 2);
      t = diff / se;
      pVal = clamp01(tSf2(Math.abs(t), df));
    } else {
      // Zero variance in both arms: no sampling noise to test against.
      df = Math.max(1, nCtrl + nTrt - 2);
      t = diff === 0 ? 0 : (diff > 0 ? Infinity : -Infinity);
      pVal = diff === 0 ? 1 : 0;
    }

    var tCrit = tPpf(1 - alpha / 2, df);
    var liftDefined = mCtrl > 0;
    var absCiLo = diff - tCrit * se;
    var absCiHi = diff + tCrit * se;

    return {
      kind: 'continuous',
      nCtrl: nCtrl, nTrt: nTrt,
      convCtrl: sumCtrl, convTrt: sumTrt,
      rCtrl: mCtrl, rTrt: mTrt,
      absDiff: diff,
      absCiLo: absCiLo, absCiHi: absCiHi,
      lift: liftDefined ? diff / mCtrl : NaN,
      liftDefined: liftDefined,
      ciLo: liftDefined ? absCiLo / mCtrl : NaN,
      ciHi: liftDefined ? absCiHi / mCtrl : NaN,
      stat: t, df: df, pVal: pVal,
      sig: classify(pVal, diff, alpha)
    };
  }

  /* Sample ratio mismatch: chi-square goodness-of-fit.
   * The notebook hardcoded an even split; expectedRatio lets an intentionally
   * uneven design (e.g. 80/20) avoid being flagged as SRM.
   *   counts        [{variant, n}, ...]
   *   expectedRatio {variant: weight} — optional, defaults to even
   */
  function srm(o) {
    var counts = o.counts;
    var alpha = o.alpha == null ? 0.05 : o.alpha;
    var ratio = o.expectedRatio || null;
    var k = counts.length;
    var total = counts.reduce(function (s, c) { return s + c.n; }, 0);

    var weights = counts.map(function (c) {
      var w = ratio && isFinite(ratio[c.variant]) ? Number(ratio[c.variant]) : 1;
      return w > 0 ? w : 0;
    });
    var wSum = weights.reduce(function (s, w) { return s + w; }, 0);
    if (wSum <= 0) { weights = counts.map(function () { return 1; }); wSum = k; }

    var chi2 = 0;
    var rows = counts.map(function (c, i) {
      var exp = total * weights[i] / wSum;
      if (exp > 0) chi2 += (c.n - exp) * (c.n - exp) / exp;
      return {
        variant: c.variant, observed: c.n, expected: exp,
        observedShare: total ? c.n / total : 0,
        expectedShare: weights[i] / wSum
      };
    });

    var df = Math.max(1, k - 1);
    var pVal = chi2Sf(chi2, df);
    return {
      chi2: chi2, df: df, pVal: pVal,
      detected: pVal < alpha, total: total, rows: rows
    };
  }

  // ── multiplicity ──────────────────────────────────────────────────────────
  /* Corrections return ADJUSTED P-VALUES, not an adjusted alpha.
   *
   * Both express the same decision, but adjusting p keeps the threshold on
   * screen at the alpha the experiment was actually designed at, and lets
   * corrections over different families sit side by side without alpha
   * degrading into an unreadable 0.00138. It is also the convention
   * statsmodels and R report in, so a reviewer can check the number.
   *
   * Non-finite p-values (degenerate tests — zero variance in both arms, an
   * empty arm) are held OUT of the family: they carry no evidence, so letting
   * them count toward n would penalise every real test beside them.
   */
  function finiteCount(pvals) {
    var n = 0;
    for (var i = 0; i < pvals.length; i++) if (isFinite(pvals[i])) n++;
    return n;
  }

  // Bonferroni: controls the family-wise error rate. p * n, capped at 1.
  function bonferroniAdjust(pvals) {
    var n = finiteCount(pvals);
    return pvals.map(function (p) {
      return isFinite(p) ? clamp01(p * n) : NaN;
    });
  }

  /* Benjamini–Hochberg: controls the false discovery rate.
   * Step-up from the largest p, carrying a running minimum so the adjusted
   * sequence stays monotone in p — without that, a marginal test could end up
   * with a smaller adjusted p than a more significant one. */
  function bhAdjust(pvals) {
    var out = pvals.map(function () { return NaN; });
    var idx = [];
    for (var i = 0; i < pvals.length; i++) if (isFinite(pvals[i])) idx.push(i);
    var n = idx.length;
    if (!n) return out;

    idx.sort(function (a, b) { return pvals[a] - pvals[b]; });
    var running = 1;
    for (var k = n - 1; k >= 0; k--) {
      running = Math.min(running, pvals[idx[k]] * n / (k + 1));
      out[idx[k]] = clamp01(running);
    }
    return out;
  }

  /* method: 'none' | 'bonferroni' | 'bh'.
   * 'none' passes p through unchanged so callers never branch on the method. */
  function adjustPValues(pvals, method) {
    if (method === 'bonferroni') return bonferroniAdjust(pvals);
    if (method === 'bh') return bhAdjust(pvals);
    return pvals.map(function (p) { return isFinite(p) ? clamp01(p) : NaN; });
  }

  root.AB = root.AB || {};
  root.AB.stats = {
    erf: erf,
    erfc: erfc,
    normCdf: normCdf,
    normSf: normSf,
    normPpf: normPpf,
    logGamma: logGamma,
    lowerGammaReg: lowerGammaReg,
    upperGammaReg: upperGammaReg,
    chi2Sf: chi2Sf,
    logBeta: logBeta,
    incBeta: incBeta,
    tCdf: tCdf,
    tSf2: tSf2,
    tPpf: tPpf,
    classify: classify,
    twoProportionZ: twoProportionZ,
    welchT: welchT,
    srm: srm,
    finiteCount: finiteCount,
    bonferroniAdjust: bonferroniAdjust,
    bhAdjust: bhAdjust,
    adjustPValues: adjustPValues
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.AB.stats;
})(typeof globalThis !== 'undefined' ? globalThis : this);
