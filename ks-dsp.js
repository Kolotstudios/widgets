/* Kolot karaoke studio – audio engine (runs in a Web Worker, also loadable in the page).
 * shift(L,R,sr,semi)            key change without tempo change (phase vocoder with phase locking + band-limited resampling)
 * f0(x,sr)                      pitch track every 10 ms (YIN), Hz or 0 for unvoiced
 * tune(x,sr,opts)               pitch correction toward the reference melody (TD-PSOLA)
 * deess / helpers               shared with the blessing recorder
 */
var KSDSP = (function () {
  "use strict";
  /* ---------- FFT (radix-2, in place) ---------- */
  var FT = {};
  function tables(N) {
    if (FT[N]) return FT[N];
    var rev = new Uint32Array(N), bits = Math.round(Math.log2(N)), i;
    for (i = 0; i < N; i++) { var r = 0, v = i; for (var b = 0; b < bits; b++) { r = (r << 1) | (v & 1); v >>= 1; } rev[i] = r; }
    var cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
    for (i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = -Math.sin(2 * Math.PI * i / N); }
    var win = new Float64Array(N); for (i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    return FT[N] = { rev: rev, cos: cos, sin: sin, win: win };
  }
  function fft(re, im, T, inv) {
    var N = re.length, i, j, k, t;
    for (i = 0; i < N; i++) { j = T.rev[i]; if (j > i) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (var size = 2; size <= N; size <<= 1) {
      var half = size >> 1, step = N / size;
      for (i = 0; i < N; i += size) {
        for (j = i, k = 0; j < i + half; j++, k += step) {
          var c = T.cos[k], s = inv ? -T.sin[k] : T.sin[k], l = j + half;
          var tr = re[l] * c - im[l] * s, ti = re[l] * s + im[l] * c;
          re[l] = re[j] - tr; im[l] = im[j] - ti; re[j] += tr; im[j] += ti;
        }
      }
    }
    if (inv) for (i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
  }
  var TWO_PI = 2 * Math.PI;
  function princ(a) { return a - TWO_PI * Math.round(a / TWO_PI); }

  /* ---------- key change ----------
     1) time-stretch by r = 2^(semi/12) with a phase vocoder (fixed analysis hop, identity phase locking),
     2) resample by r back to the original length (windowed sinc, cut-off follows the ratio).
     Two channels go through one complex FFT (L in the real part, R in the imaginary part). */
  function stretch(L, R, r, onp) {
    var N = 2048, Ha = 512, T = tables(N), w = T.win, K = N / 2 + 1, len = L.length;
    var frames = Math.ceil((len + N) / Ha) + 1, outLen = Math.ceil(frames * Ha * r) + 2 * N;
    var oL = new Float32Array(outLen), oR = R ? new Float32Array(outLen) : null, ws = new Float32Array(outLen);
    var re = new Float64Array(N), im = new Float64Array(N);
    var chans = R ? 2 : 1, mag = [new Float64Array(K), new Float64Array(K)], ph = [new Float64Array(K), new Float64Array(K)];
    var prevPh = [new Float64Array(K), new Float64Array(K)], synPh = [new Float64Array(K), new Float64Array(K)];
    var outPh = [new Float64Array(K), new Float64Array(K)], omega = new Float64Array(K), peaks = new Int32Array(K);
    for (var k = 0; k < K; k++) omega[k] = TWO_PI * k * Ha / N;
    var first = true, prevPos = 0;
    for (var m = 0; m < frames; m++) {
      var a0 = m * Ha - N, pos = Math.round(m * Ha * r), Hs = pos - prevPos, i;
      for (i = 0; i < N; i++) { var n = a0 + i, inr = n >= 0 && n < len; re[i] = inr ? L[n] * w[i] : 0; im[i] = inr && R ? R[n] * w[i] : 0; }
      fft(re, im, T, false);
      // split the two real spectra
      for (k = 0; k < K; k++) {
        var nk = (N - k) % N, zr = re[k], zi = im[k], cr = re[nk], ci = -im[nk];
        var xr = (zr + cr) / 2, xi = (zi + ci) / 2;            // X_L
        mag[0][k] = Math.sqrt(xr * xr + xi * xi); ph[0][k] = Math.atan2(xi, xr);
        if (R) { var yr = (zi - ci) / 2, yi = -(zr - cr) / 2; mag[1][k] = Math.sqrt(yr * yr + yi * yi); ph[1][k] = Math.atan2(yi, yr); }
      }
      for (var c = 0; c < chans; c++) {
        var M = mag[c], P = ph[c], pp = prevPh[c], sp = synPh[c], op = outPh[c];
        if (first) { for (k = 0; k < K; k++) { sp[k] = P[k]; op[k] = P[k]; } }
        else {
          // peaks (local maxima over 2 neighbours each side)
          var np = 0;
          for (k = 2; k < K - 2; k++) if (M[k] > M[k - 1] && M[k] >= M[k + 1] && M[k] > M[k - 2] && M[k] >= M[k + 2]) peaks[np++] = k;
          var ratio = Hs / Ha;
          for (var q = 0; q < np; q++) { k = peaks[q]; var dp = princ(P[k] - pp[k] - omega[k]); sp[k] += (omega[k] + dp) * ratio; }
          // every bin follows its nearest peak (identity phase locking); bins with no peak just advance
          if (np) {
            var pi = 0;
            for (k = 0; k < K; k++) {
              while (pi < np - 1 && Math.abs(peaks[pi + 1] - k) <= Math.abs(peaks[pi] - k)) pi++;
              var pk = peaks[pi]; op[k] = sp[pk] + (P[k] - P[pk]);
            }
            for (q = 0; q < np; q++) op[peaks[q]] = sp[peaks[q]];
          } else for (k = 0; k < K; k++) { sp[k] += (omega[k] + princ(P[k] - pp[k] - omega[k])) * ratio; op[k] = sp[k]; }
        }
        for (k = 0; k < K; k++) pp[k] = P[k];
      }
      first = false;
      // rebuild one complex spectrum Y = Y_L + i*Y_R and invert
      for (k = 0; k < K; k++) {
        var lr = mag[0][k] * Math.cos(outPh[0][k]), li = mag[0][k] * Math.sin(outPh[0][k]);
        var rr = R ? mag[1][k] * Math.cos(outPh[1][k]) : 0, ri = R ? mag[1][k] * Math.sin(outPh[1][k]) : 0;
        re[k] = lr - ri; im[k] = li + rr;
        if (k > 0 && k < N / 2) { re[N - k] = lr + ri; im[N - k] = -li + rr; }
      }
      fft(re, im, T, true);
      var o0 = pos;
      for (i = 0; i < N; i++) { var o = o0 + i; oL[o] += re[i] * w[i]; if (R) oR[o] += im[i] * w[i]; ws[o] += w[i] * w[i]; }
      prevPos = pos;
      if (onp && (m & 255) === 0) onp(m / frames);
    }
    // a0 started at -N: output sample N*r... maps to input 0
    var off = Math.round(N * r), sl = Math.ceil(len * r) + 8, sL = new Float32Array(sl), sR = R ? new Float32Array(sl) : null;
    for (var j = 0; j < sl; j++) { var g = ws[off + j]; g = g > 0.1 ? 1 / g : (g > 1e-6 ? 10 : 0); sL[j] = oL[off + j] * g; if (R) sR[j] = oR[off + j] * g; }
    return [sL, sR];
  }
  // read x at positions n*r (band-limited when r>1)
  function resample(x, r, len) {
    var y = new Float32Array(len), HW = 12, fc = Math.min(1, 1 / r), n = x.length;
    var TAB = 512, tab = new Float32Array((2 * HW + 1) * TAB + 1);
    // windowed sinc table over [-HW, HW]
    for (var t = 0; t < tab.length; t++) {
      var u = t / TAB - HW, s = u === 0 ? 1 : Math.sin(Math.PI * u * fc) / (Math.PI * u * fc);
      var win = 0.42 + 0.5 * Math.cos(Math.PI * u / HW) + 0.08 * Math.cos(2 * Math.PI * u / HW);
      tab[t] = s * win * fc;
    }
    for (var i = 0; i < len; i++) {
      var p = i * r, ip = Math.floor(p), fr = p - ip, acc = 0;
      for (var k = -HW + 1; k <= HW; k++) {
        var idx = ip + k; if (idx < 0 || idx >= n) continue;
        var tt = (k - fr + HW) * TAB, ti = tt | 0, tf = tt - ti;
        acc += x[idx] * (tab[ti] + (tab[ti + 1] - tab[ti]) * tf);
      }
      y[i] = acc;
    }
    return y;
  }
  function shift(L, R, sr, semi, onp) {
    if (!semi) return [L, R];
    var r = Math.pow(2, semi / 12), len = L.length;
    var st = stretch(L, R, r, onp && function (p) { onp(p * 0.8); });
    var out = [resample(st[0], r, len), null];
    if (onp) onp(0.9);
    if (R) out[1] = resample(st[1], r, len);
    if (onp) onp(1);
    return out;
  }

  /* ---------- filters ---------- */
  function coef(type, f, Q, gainDb, sr) {
    var A = Math.pow(10, (gainDb || 0) / 40), w0 = 2 * Math.PI * f / sr, cs = Math.cos(w0), sn = Math.sin(w0), al = sn / (2 * Q), b0, b1, b2, a0, a1, a2, sq;
    if (type === "hp") { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else if (type === "lp") { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else if (type === "peak") { b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; }
    else if (type === "hshelf") { sq = 2 * Math.sqrt(A) * al; b0 = A * ((A + 1) + (A - 1) * cs + sq); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - sq); a0 = (A + 1) - (A - 1) * cs + sq; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - sq; }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  function filt(x, c) {
    var y = new Float32Array(x.length), x1 = 0, x2 = 0, y1 = 0, y2 = 0, b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];
    for (var i = 0; i < x.length; i++) { var v = x[i], o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o; }
    return y;
  }
  function filtfilt(x, c) { var y = filt(x, c); y.reverse(); y = filt(y, c); y.reverse(); return y; }
  function highpass(x, f, sr) { return filt(filt(x, coef("hp", f, 0.5412, 0, sr)), coef("hp", f, 1.3066, 0, sr)); }
  function removeDC(x) { var y = new Float32Array(x.length), R = 0.9995, px = 0, py = 0; for (var i = 0; i < x.length; i++) { var v = x[i], o = v - px + R * py; px = v; py = o; y[i] = o; } return y; }
  function follower(x, att, rel, sr) {
    var a = Math.exp(-1 / (sr * att)), r = Math.exp(-1 / (sr * rel)), e = 0, y = new Float32Array(x.length);
    for (var i = 0; i < x.length; i++) { var v = Math.abs(x[i]); e = v > e ? a * e + (1 - a) * v : r * e + (1 - r) * v; y[i] = e; }
    return y;
  }
  // de-esser from the blessing recorder: only the top band is turned down, when it pokes out over the voice
  function deess(x, sr, amount) {
    if (!amount) return x;
    var hi = filtfilt(x, coef("hp", 4800, 0.7071, 0, sr));
    var i, low = filt(filt(x, coef("lp", 3500, 0.7071, 0, sr)), coef("lp", 3500, 0.7071, 0, sr));
    var eH = follower(hi, 0.0005, 0.03, sr), eL = follower(low, 0.0005, 0.03, sr);
    var pk = 0; for (i = 0; i < eL.length; i++) if (eL[i] > pk) pk = eL[i];
    var acc = 0, cnt = 0; for (i = 0; i < eL.length; i += 16) if (eL[i] > pk * 0.15) { acc += eL[i]; cnt++; }
    var ref = cnt ? acc / cnt : pk * 0.5, k = 1.2 - amount * 0.7; // amount 0..1
    var ga = Math.exp(-1 / (sr * 0.0004)), gr = Math.exp(-1 / (sr * 0.03)), g = 1, y = new Float32Array(x.length);
    for (i = 0; i < x.length; i++) {
      var tg = 1, lim = Math.max(k * 0.6 * eL[i], k * 0.4 * ref);
      if (eH[i] > 0.003 && eH[i] > lim) tg = Math.max(0.15, lim / eH[i]);
      g = tg < g ? ga * g + (1 - ga) * tg : gr * g + (1 - gr) * tg;
      y[i] = x[i] - hi[i] * (1 - g);
    }
    return y;
  }

  /* ---------- pitch track (YIN, 10 ms hop) + clean-up ---------- */
  var midi = function (hz) { return 69 + 12 * Math.log2(hz / 440); };
  function f0(x, sr, onp) {
    var D = Math.max(1, Math.round(sr / 12000)), fs = sr / D, i;
    var lp = D > 1 ? filtfilt(filtfilt(x, coef("lp", fs * 0.42, 0.7071, 0, sr)), coef("lp", fs * 0.42, 0.7071, 0, sr)) : x;
    var n = Math.floor(lp.length / D), y = new Float32Array(n); for (i = 0; i < n; i++) y[i] = lp[i * D];
    var hop = fs * 0.01, tmin = Math.floor(fs / 950), tmax = Math.ceil(fs / 65), W = Math.round(fs * 0.025);
    var frames = Math.max(0, Math.floor((n - W - tmax) / hop) + 1), out = new Float32Array(frames), lev = new Float32Array(frames);
    var d = new Float64Array(tmax + 1), cm = new Float64Array(tmax + 1);
    // frames centred on t = f*10ms: the analysis window starts half a window earlier
    var half = Math.round((W + tmax) / 2), st = function (f) { return Math.round(f * hop) - half; };
    var gpk = 0, f;
    for (f = 0; f < frames; f++) { var s0 = st(f), e = 0, c = 0; for (i = 0; i < W; i += 2) { var k = s0 + i; if (k >= 0 && k < n) { e += y[k] * y[k]; c++; } } lev[f] = c ? Math.sqrt(e / c) : 0; if (lev[f] > gpk) gpk = lev[f]; }
    var gate = Math.max(gpk * 0.035, 1e-4);
    for (f = 0; f < frames; f++) {
      if (lev[f] < gate) continue;
      var s = st(f), tau; if (s < 0 || s + W + tmax >= n) continue;
      for (tau = 1; tau <= tmax; tau++) { var acc = 0; for (i = 0; i < W; i++) { var v = y[s + i] - y[s + i + tau]; acc += v * v; } d[tau] = acc; }
      var run = 0; cm[0] = 1;
      for (tau = 1; tau <= tmax; tau++) { run += d[tau]; cm[tau] = run > 0 ? d[tau] * tau / run : 1; }
      var best = -1;
      for (tau = tmin; tau < tmax; tau++) if (cm[tau] < 0.12) { while (tau + 1 < tmax && cm[tau + 1] < cm[tau]) tau++; best = tau; break; }
      if (best < 0) { var mn = 1e9; for (tau = tmin; tau < tmax; tau++) if (cm[tau] < mn) { mn = cm[tau]; best = tau; } if (mn > 0.25) continue; }
      var a = cm[best - 1], b = cm[best], c2 = cm[best + 1], den = a - 2 * b + c2, sh = den ? 0.5 * (a - c2) / den : 0;
      out[f] = fs / (best + Math.max(-1, Math.min(1, sh)));
      if (onp && (f & 1023) === 0) onp(f / frames);
    }
    return { f0: clean(out), hop: 0.01 };
  }
  // median smoothing, octave-jump repair, voiced runs of at least 50 ms
  function clean(F) {
    var n = F.length, m = new Float32Array(n), o = new Float32Array(n), f, j;
    for (f = 0; f < n; f++) m[f] = F[f] ? midi(F[f]) : 0;
    for (f = 0; f < n; f++) {
      if (!m[f]) continue; var win = [];
      for (j = Math.max(0, f - 7); j <= Math.min(n - 1, f + 7); j++) if (m[j]) win.push(m[j]);
      win.sort(function (a, b) { return a - b; }); var med = win[win.length >> 1], v = m[f];
      while (v - med > 9) v -= 12; while (med - v > 9) v += 12; o[f] = v;
    }
    var r = new Float32Array(n);
    for (f = 0; f < n; f++) { if (!o[f]) continue; var w = []; for (j = f - 2; j <= f + 2; j++) if (j >= 0 && j < n && o[j]) w.push(o[j]); w.sort(function (a, b) { return a - b; }); r[f] = w[w.length >> 1]; }
    for (f = 0; f < n;) { if (!r[f]) { f++; continue; } var e = f; while (e < n && r[e]) e++; if (e - f < 5) for (j = f; j < e; j++) r[j] = 0; f = e; }
    var hz = new Float32Array(n); for (f = 0; f < n; f++) hz[f] = r[f] ? 440 * Math.pow(2, (r[f] - 69) / 12) : 0;
    return hz;
  }
  /* ---------- note map (the "MIDI" of a vocal): stable pitch regions ---------- */
  function notes(track, fine) {
    var JUMP = fine ? 0.5 : 0.75, STAY = fine ? 4 : 6, F = track.f0, n = F.length, m = new Float32Array(n), out = [], f, j;
    for (f = 0; f < n; f++) m[f] = F[f] ? midi(F[f]) : 0;
    for (f = 0; f < n;) {
      if (!m[f]) { f++; continue; }
      var e = f; while (e < n && m[e]) e++;
      // split a voiced run where the (smoothed) pitch moves to a new level and stays there for 60 ms
      var start = f, k = f + 1;
      var lvl = function (a, b) { var w = []; for (var q = a; q < b; q++) w.push(m[q]); w.sort(function (x, y) { return x - y; }); return w[w.length >> 1]; };
      while (k < e) {
        var cur = lvl(Math.max(start, k - STAY), k);
        if (Math.abs(m[k] - cur) > JUMP) {
          var stay = true, q; for (q = k; q < Math.min(e, k + STAY); q++) if (Math.abs(m[q] - cur) <= JUMP * 0.8) { stay = false; break; }
          if (stay && k + STAY <= e && k - start >= STAY) { out.push(mk(start, k)); start = k; }
        }
        k++;
      }
      out.push(mk(start, e)); f = e;
    }
    function mk(a, b) { var len = b - a, a2 = a + Math.floor(len * 0.2), b2 = Math.max(a2 + 1, b - Math.floor(len * 0.2)), w = []; for (var q = a2; q < b2; q++) w.push(m[q]); w.sort(function (x, y) { return x - y; }); return { s: a, e: b, m: w[w.length >> 1] }; }
    return out;
  }
  /* ---------- correction plan ----------
     every note the singer sings gets one target: the note the original singer sings at that moment
     (any octave, the song's own tuning), or the nearest note of the song's scale. The whole note moves
     to the target, so vibrato and expression stay; `flat` also straightens the pitch inside the note
     (the "autotune" sound). Returns cents per 10 ms frame, smoothed without delay. */
  function plan(user, ref, opts) {
    var semi = opts.semi || 0, lag = opts.lag || 0, cen = opts.center == null ? 1 : opts.center, flat = opts.flat || 0, ramp = opts.ramp || 0.04;
    var hop = user.hop, n = user.f0.length, rn = notes(ref, true), un = notes(user, true), f, i;
    rn.forEach(function (r) { r.m += semi; r.ts = r.s * ref.hop; r.te = r.e * ref.hop; });
    // the song's tuning offset (A=440 or not) and scale, from the original singer's notes
    var offs = [], pc = new Float64Array(12);
    rn.forEach(function (r) { var d = r.e - r.s; if (d < 8) return; offs.push(r.m - Math.round(r.m)); pc[((Math.round(r.m) % 12) + 12) % 12] += d; });
    offs.sort(function (a, b) { return a - b; }); var tun = offs.length ? offs[offs.length >> 1] : 0;
    var scale = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].sort(function (a, b) { return pc[b] - pc[a]; }).slice(0, 7);
    var snap = function (v) { return Math.round(v - tun) + tun; };
    var want = new Float32Array(n), um = new Float32Array(n), stats = { notes: un.length, matched: 0, moved: 0 };
    for (f = 0; f < n; f++) um[f] = user.f0[f] ? midi(user.f0[f]) : 0;
    var rM = new Float32Array(ref.f0.length); for (f = 0; f < rM.length; f++) rM[f] = ref.f0[f] ? midi(ref.f0[f]) + semi : 0;
    un.forEach(function (u) {
      var us = u.s * hop + lag, ue = u.e * hop + lag, best = null, bs = -1e9;
      for (i = 0; i < rn.length; i++) {
        var r = rn[i]; if (r.te < us - 0.25 || r.ts > ue + 0.25) continue;
        var ov = Math.min(ue, r.te + 0.12) - Math.max(us, r.ts - 0.12); if (ov <= 0) continue;
        var tgt = opts.grid ? snap(r.m) : r.m; tgt += 12 * Math.round((u.m - tgt) / 12); var dist = Math.abs(u.m - tgt);
        var sc = ov / Math.max(0.05, ue - us) - 0.45 * dist; if (dist <= 2 && sc > bs) { bs = sc; best = tgt; }
      }
      // "curve": the original's own pitch at the same moments (median of the differences over the note)
      if (opts.mode !== "notes") {
        // singers are never exactly in time: try offsets of +-150 ms and keep the one where the
        // difference between the two pitch curves is steadiest (the singer follows the same shape)
        var bestScore = 1e9, bestDm = null;
        for (var dl = -15; dl <= 15; dl++) {
          var diffs = [];
          for (f = u.s; f < u.e; f++) {
            if (!um[f]) continue; var rf = Math.round((f * hop + lag) / ref.hop) + dl; if (rf < 0 || rf >= rM.length || !rM[rf]) continue;
            var dd = rM[rf] - um[f]; dd -= 12 * Math.round(dd / 12); diffs.push(dd);
          }
          if (diffs.length < Math.max(3, (u.e - u.s) * 0.6)) continue;
          diffs.sort(function (p, q) { return p - q; }); var md = diffs[diffs.length >> 1], mad = 0;
          for (var q = 0; q < diffs.length; q++) mad += Math.abs(diffs[q] - md); mad /= diffs.length;
          var score = mad + 0.08 * Math.abs(dl) / 15 + 0.05 * Math.abs(md);
          if (score < bestScore) { bestScore = score; bestDm = md; }
        }
        if (bestDm != null && bestScore < 0.6 && Math.abs(bestDm) <= 1.6) best = u.m + bestDm;
      }
      if (best == null) { var bb = 99; for (var o = -2; o <= 2; o++) { var cand = Math.round(u.m - tun) + o, p = ((cand % 12) + 12) % 12; if (scale.indexOf(p) >= 0 && Math.abs(u.m - (cand + tun)) < bb) { bb = Math.abs(u.m - (cand + tun)); best = cand + tun; } } }
      else stats.matched++;
      if (best == null) return;
      var dev = best - u.m; if (Math.abs(dev) > 1.6) return; // far off: another note on purpose
      if (Math.abs(dev) > 0.08) stats.moved++;
      for (f = u.s; f < u.e; f++) { if (!um[f]) continue; want[f] = (dev * cen + (u.m - um[f]) * flat) * 100; }
    });
    // ramps between notes: centred moving average (no timing shift); short notes keep their full correction
    var W = Math.max(0, Math.round(ramp / hop / 2)), y = new Float32Array(n);
    for (f = 0; f < n; f++) { if (!um[f]) continue; var acc = 0, c = 0; for (var j = f - W; j <= f + W; j++) if (j >= 0 && j < n && um[j]) { acc += want[j]; c++; } y[f] = c ? acc / c : 0; }
    stats.tuning = Math.round(tun * 100);
    return { cents: y, stats: stats };
  }
  /* ---------- TD-PSOLA, only where a correction is needed ---------- */
  function psola(x, sr, track, cents) {
    var n = x.length, hop = track.hop, F = track.f0, nf = F.length, out = new Float32Array(x), regions = [], f;
    var at = function (arr, s) { var i = Math.round(s / sr / hop); return i < 0 || i >= nf ? 0 : arr[i]; };
    // regions: frames whose correction is over 1 cent (gaps under 40 ms merged), padded 25 ms
    for (f = 0; f < nf;) { if (Math.abs(cents[f]) <= 1 || !F[f]) { f++; continue; } var e = f; while (e < nf && ((Math.abs(cents[e]) > 1 && F[e]) || (e + 4 < nf && Math.abs(cents[e + 4]) > 1 && F[e + 4]))) e++; regions.push([f, e]); f = e; }
    regions.forEach(function (g) {
      var pad = Math.round(sr * 0.025), a0 = Math.max(0, Math.round(g[0] * hop * sr) - pad), a1 = Math.min(n, Math.round(g[1] * hop * sr) + pad);
      if (a1 - a0 < sr * 0.03) return;
      // the fundamental only, for steady pitch marks
      var fm = []; for (f = g[0]; f < g[1]; f++) if (F[f]) fm.push(F[f]); fm.sort(function (p, q) { return p - q; });
      var f0m = fm[fm.length >> 1] || 150, seg = x.subarray(a0, a1);
      var lp = filtfilt(filtfilt(seg, coef("lp", Math.min(1100, f0m * 1.5), 0.7071, 0, sr)), coef("lp", Math.min(1100, f0m * 1.5), 0.7071, 0, sr));
      var len = a1 - a0, marks = [], per = [], pos = 0, P, i, bv, best;
      var P0 = function (s) { var h = at(F, a0 + s); return Math.round(sr / (h || f0m)); };
      P = P0(0); best = 0; bv = -1e9; for (i = 0; i < Math.min(len, P); i++) if (lp[i] > bv) { bv = lp[i]; best = i; }
      pos = best;
      // marks one period apart, each snapped to the nearby waveform peak; grains use the real spacing
      while (pos < len) {
        P = P0(pos); marks.push(pos); per.push(P);
        var nom = pos + P, r = Math.max(1, Math.round(P * 0.12)); best = nom; bv = -1e9;
        for (i = nom - r; i <= nom + r; i++) if (i >= 0 && i < len && lp[i] > bv) { bv = lp[i]; best = i; }
        pos = Math.max(pos + Math.round(P * 0.6), best);
      }
      for (i = 0; i < marks.length - 1; i++) { var dd = marks[i + 1] - marks[i]; if (dd > per[i] * 0.7 && dd < per[i] * 1.3) per[i] = dd; }
      if (marks.length < 3) return;
      var y = new Float32Array(len), ws = new Float32Array(len), ts = marks[0], mi = 0;
      while (ts < len) {
        while (mi < marks.length - 1 && Math.abs(marks[mi + 1] - ts) <= Math.abs(marks[mi] - ts)) mi++;
        var m = marks[mi], Pa = per[mi], ratio = Math.pow(2, at(cents, a0 + m) / 1200);
        for (i = -Pa; i < Pa; i++) { var src = m + i, dst = ts + i; if (src < 0 || src >= len || dst < 0 || dst >= len) continue; var w = 0.5 + 0.5 * Math.cos(Math.PI * i / Pa); y[dst] += seg[src] * w; ws[dst] += w; }
        ts += Math.max(4, Math.round(Pa / ratio));
      }
      for (i = 0; i < len; i++) y[i] = ws[i] > 0.15 ? y[i] / ws[i] : seg[i];
      // blend in and out over the padding
      for (i = 0; i < len; i++) { var k2 = Math.min(1, i / pad, (len - 1 - i) / pad), c = 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, k2)); out[a0 + i] = seg[i] * (1 - c) + y[i] * c; }
    });
    return out;
  }
  function tune(x, sr, ref, opts, onp) {
    var tr = f0(x, sr, onp && function (p) { onp(p * 0.6); });
    var pl = plan(tr, ref, opts); if (onp) onp(0.7);
    var y = psola(x, sr, tr, pl.cents); if (onp) onp(1);
    return { y: y, stats: pl.stats };
  }
  /* ---------- noise reduction: spectral, decision-directed (keeps the voice natural, no "underwater") ---------- */
  function denoise(x, sr, amount) {
    if (!amount) return x;
    var N = sr > 32000 ? 2048 : 1024, H = N / 4, T = tables(N), w = T.win, K = N / 2 + 1, n = x.length, i, k, f;
    var frames = Math.ceil(n / H) + 3, re = new Float64Array(N), im = new Float64Array(N);
    // noise profile: per-bin average of the quietest 12% of frames
    var en = new Float64Array(frames), specs = [];
    for (f = 0; f < frames; f++) {
      var s0 = f * H - N; for (i = 0; i < N; i++) { var q = s0 + i; re[i] = q >= 0 && q < n ? x[q] * w[i] : 0; im[i] = 0; }
      fft(re, im, T, false); var p = new Float32Array(K), e = 0; for (k = 0; k < K; k++) { p[k] = re[k] * re[k] + im[k] * im[k]; e += p[k]; } specs.push(p); en[f] = e;
    }
    var ord = Array.from(en.keys()).filter(function (f) { return en[f] > 0; }).sort(function (a, b) { return en[a] - en[b]; }), cnt = Math.max(3, Math.floor(ord.length * 0.12));
    var noise = new Float64Array(K); for (i = 0; i < cnt && i < ord.length; i++) for (k = 0; k < K; k++) noise[k] += specs[ord[i]][k] / cnt;
    for (k = 0; k < K; k++) noise[k] = Math.max(noise[k] * 1.4, 1e-12);
    var floor = Math.pow(10, -(6 + amount * 16) / 20), alpha = 0.97, prevG = new Float64Array(K).fill(1), prevPost = new Float64Array(K).fill(1);
    var y = new Float32Array(n + 2 * N), ws = new Float32Array(n + 2 * N), G = new Float64Array(K);
    for (f = 0; f < frames; f++) {
      var s1 = f * H - N; for (i = 0; i < N; i++) { var q2 = s1 + i; re[i] = q2 >= 0 && q2 < n ? x[q2] * w[i] : 0; im[i] = 0; }
      fft(re, im, T, false);
      for (k = 0; k < K; k++) {
        var post = specs[f][k] / noise[k], prio = alpha * prevG[k] * prevG[k] * prevPost[k] + (1 - alpha) * Math.max(post - 1, 0);
        var g = prio / (1 + prio); G[k] = Math.max(floor, g); prevG[k] = g; prevPost[k] = post;
      }
      for (k = 1; k < K - 1; k++) G[k] = Math.max(floor, 0.25 * G[k - 1] + 0.5 * G[k] + 0.25 * G[k + 1]);
      for (k = 0; k < K; k++) { re[k] *= G[k]; im[k] *= G[k]; if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; } }
      fft(re, im, T, true);
      for (i = 0; i < N; i++) { var o = s1 + i + N; if (o < 0 || o >= y.length) continue; y[o] += re[i] * w[i]; ws[o] += w[i] * w[i]; }
    }
    var out = new Float32Array(n); for (i = 0; i < n; i++) { var g2 = ws[i + N]; out[i] = g2 > 1e-3 ? y[i + N] / g2 : 0; }
    return out;
  }
  /* the whole offline voice chain for a take */
  function voice(x, sr, o, onp) {
    var y = highpass(removeDC(x), 75, sr), st = null;
    if (o.nr) y = denoise(y, sr, o.nr); if (onp) onp(0.25);
    if (o.tune && o.ref) { var r = tune(y, sr, o.ref, o.tune, onp && function (p) { onp(0.25 + p * 0.6); }); y = r.y; st = r.stats; }
    if (o.deess) y = deess(y, sr, o.deess); if (onp) onp(1);
    return { y: y, stats: st };
  }
  return { shift: shift, stretch: stretch, resample: resample, f0: f0, notes: notes, plan: plan, psola: psola, tune: tune, denoise: denoise, voice: voice, deess: deess, coef: coef, filt: filt, filtfilt: filtfilt, highpass: highpass, removeDC: removeDC, follower: follower, fft: fft, tables: tables, midi: midi };
})();

/* ---------- worker protocol: {id, op, ...} -> {id, ok, ...} ---------- */
if (typeof window === "undefined" && typeof self !== "undefined" && typeof self.postMessage === "function") {
  self.onmessage = function (e) {
    var m = e.data, prog = function (p) { self.postMessage({ id: m.id, progress: p }); };
    try {
      if (m.op === "shift") {
        var o = KSDSP.shift(m.L, m.R, m.sr, m.semi, prog), tr = [o[0].buffer]; if (o[1]) tr.push(o[1].buffer);
        self.postMessage({ id: m.id, ok: true, L: o[0], R: o[1] }, tr);
      } else if (m.op === "f0") {
        var t = KSDSP.f0(m.x, m.sr, prog); self.postMessage({ id: m.id, ok: true, f0: t.f0, hop: t.hop });
      } else if (m.op === "tune") {
        var r = KSDSP.tune(m.x, m.sr, { f0: m.ref, hop: m.refHop }, m.opts, prog);
        self.postMessage({ id: m.id, ok: true, y: r.y, stats: r.stats }, [r.y.buffer]);
      } else if (m.op === "voice") {
        var v = KSDSP.voice(m.x, m.sr, { nr: m.nr, deess: m.deess, tune: m.tune, ref: m.ref ? { f0: m.ref, hop: m.refHop } : null }, prog);
        self.postMessage({ id: m.id, ok: true, y: v.y, stats: v.stats }, [v.y.buffer]);
      } else if (m.op === "deess") {
        var d = KSDSP.deess(m.x, m.sr, m.amount); self.postMessage({ id: m.id, ok: true, y: d }, [d.buffer]);
      } else self.postMessage({ id: m.id, ok: false, error: "unknown op" });
    } catch (err) { self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) }); }
  };
}
