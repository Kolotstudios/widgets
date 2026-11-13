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
    var half = Math.round(W / 2), st = function (f) { return Math.round(f * hop) - half; };
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
  /* ---------- key map over time: playback harmony + the original singer's melody, changes must hold ~8 s ---------- */
  var KMAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], KMIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function zs(a) { var m = 0, v = 0, i; for (i = 0; i < a.length; i++) m += a[i]; m /= a.length; for (i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m); v = Math.sqrt(v / a.length) || 1; return a.map(function (x) { return (x - m) / v; }); }
  var KP = (function () { var o = [], r, i, a; for (r = 0; r < 24; r++) { a = []; for (i = 0; i < 12; i++) a.push((r < 12 ? KMAJ : KMIN)[((i - r % 12) + 12) % 12]); o.push(zs(a)); } return o; })();
  function keymap(ref, inst, sr) {
    var secs = Math.ceil(Math.max(ref.f0.length * ref.hop, inst ? inst.length / sr : 0)), ic = [], mc = [], s, i, k;
    for (s = 0; s < secs; s++) { ic.push(new Float64Array(12)); mc.push(new Float64Array(12)); }
    if (inst) {
      var D = Math.max(1, Math.round(sr / 11025)), fs = sr / D, lp = filtfilt(inst, coef("lp", fs * 0.42, 0.7071, 0, sr)), n = Math.floor(lp.length / D), y = new Float32Array(n);
      for (i = 0; i < n; i++) y[i] = lp[i * D];
      var N = 4096, T = tables(N), re = new Float64Array(N), im = new Float64Array(N), pcOf = new Int8Array(N / 2).fill(-1), hop = Math.round(fs * 0.25);
      for (k = 1; k < N / 2; k++) { var hz = k * fs / N; if (hz >= 55 && hz <= 1760) pcOf[k] = ((Math.round(12 * Math.log2(hz / 440)) + 9) % 12 + 12) % 12; }
      for (var st = 0; st + N <= n; st += hop) {
        for (i = 0; i < N; i++) { re[i] = y[st + i] * T.win[i]; im[i] = 0; } fft(re, im, T, false);
        var c = new Float64Array(12), tot = 0; for (k = 1; k < N / 2; k++) if (pcOf[k] >= 0) { var m = Math.sqrt(re[k] * re[k] + im[k] * im[k]); c[pcOf[k]] += m; tot += m; }
        if (tot > 0) { var sec = Math.min(secs - 1, Math.floor((st + N / 2) / fs)); for (i = 0; i < 12; i++) ic[sec][i] += c[i] / tot; }
      }
    }
    for (i = 0; i < ref.f0.length; i++) if (ref.f0[i]) { var pc = ((Math.round(midi(ref.f0[i])) % 12) + 12) % 12, sc2 = Math.min(secs - 1, Math.floor(i * ref.hop)); mc[sc2][pc] += 1; }
    // scores per second over a +-5 s window, melody weighted 1.5x
    var sc = []; for (s = 0; s < secs; s++) {
      var a = new Float64Array(12), b = new Float64Array(12), ta = 0, tb = 0;
      for (var q = Math.max(0, s - 5); q <= Math.min(secs - 1, s + 5); q++) for (i = 0; i < 12; i++) { a[i] += ic[q][i]; b[i] += mc[q][i]; }
      for (i = 0; i < 12; i++) { ta += a[i]; tb += b[i]; }
      var v = []; for (i = 0; i < 12; i++) v.push((ta ? a[i] / ta : 0) + 1.5 * (tb ? b[i] / tb : 0)); var z = zs(v), row = new Float64Array(24);
      for (k = 0; k < 24; k++) { var d2 = 0; for (i = 0; i < 12; i++) d2 += KP[k][i] * z[i]; row[k] = d2 / 12; } sc.push(row);
    }
    // Viterbi: staying is free, changing costs as much as ~8 s of a clearly better fit
    var P = 1.2, Dp = new Float64Array(24), Bk = [], kk;
    for (k = 0; k < 24; k++) Dp[k] = sc[0] ? sc[0][k] : 0;
    for (s = 1; s < secs; s++) { var mx = -1e9, am = 0; for (k = 0; k < 24; k++) if (Dp[k] > mx) { mx = Dp[k]; am = k; } var nd = new Float64Array(24), bk = new Int8Array(24);
      for (k = 0; k < 24; k++) { if (Dp[k] >= mx - P) { nd[k] = Dp[k] + sc[s][k]; bk[k] = k; } else { nd[k] = mx - P + sc[s][k]; bk[k] = am; } } Dp = nd; Bk.push(bk); }
    var out = new Int8Array(secs), best = 0, bv = -1e9; for (k = 0; k < 24; k++) if (Dp[k] > bv) { bv = Dp[k]; best = k; }
    out[secs - 1] = best; for (s = secs - 1; s > 0; s--) out[s - 1] = Bk[s - 1][out[s]];
    return { hop: 1, k: out };
  }
  // the notes of key k (0-11 major, 12-23 minor; minor also allows the raised 7th)
  function keyScale(k, semi) { var r = ((k % 12) + (semi || 0)) % 12; r = (r + 12) % 12; var iv = k < 12 ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10, 11]; return iv.map(function (x) { return (r + x) % 12; }); }
  /* ---------- correction plan ----------
     every note the singer sings gets one target: the note the original singer sings at that moment
     (any octave, the song's own tuning), or the nearest note of the song's scale. The whole note moves
     to the target, so vibrato and expression stay; `flat` also straightens the pitch inside the note
     (the "autotune" sound). Returns cents per 10 ms frame, smoothed without delay. */
  function plan(user, ref, opts) {
    var semi = opts.semi || 0, lag = opts.lag || 0, cen = opts.center == null ? 1 : opts.center, speed = opts.speed || 0.18;
    var hop = user.hop, n = user.f0.length, rn = notes(ref, true), un = notes(user, true), f, i, j;
    rn.forEach(function (r) { r.m += semi; r.ts = r.s * ref.hop; r.te = r.e * ref.hop; });
    // the song's tuning offset (A=440 or not) and scale, from the original singer's notes
    var offs = [], pc = new Float64Array(12);
    rn.forEach(function (r) { var d = r.e - r.s; if (d < 8) return; offs.push(r.m - Math.round(r.m)); pc[((Math.round(r.m) % 12) + 12) % 12] += d; });
    offs.sort(function (a, b) { return a - b; }); var tun = offs.length ? offs[offs.length >> 1] : 0;
    var scale = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].sort(function (a, b) { return pc[b] - pc[a]; }).slice(0, 7);
    var snap = function (v) { return Math.round(v - tun) + tun; };
    var km = opts.keys, scaleAt = function (t) { if (!km || !km.k || !km.k.length) return scale; var i = Math.max(0, Math.min(km.k.length - 1, Math.floor(t / (km.hop || 1)))); return keyScale(km.k[i], semi); };
    var um = new Float32Array(n), err = new Float32Array(n), has = new Uint8Array(n), tid = new Int32Array(n).fill(-1), uix = 0, stats = { notes: un.length, matched: 0, moved: 0 };
    for (f = 0; f < n; f++) um[f] = user.f0[f] ? midi(user.f0[f]) : 0;
    var rM = new Float32Array(ref.f0.length); for (f = 0; f < rM.length; f++) rM[f] = ref.f0[f] ? midi(ref.f0[f]) + semi : 0;
    var noteAt = new Int32Array(ref.f0.length).fill(-1); rn.forEach(function (r, ix) { for (var q = r.s; q < r.e; q++) noteAt[q] = ix; });
    un.forEach(function (u) {
      // 1. line this sung note up with the original in time: offsets of +-150 ms, keep the one where the
      //    difference between the two pitch curves is steadiest (the singer follows the same shape)
      var bestScore = 1e9, bestDm = null, bestDl = 0, best = null;
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
        if (score < bestScore) { bestScore = score; bestDm = md; bestDl = dl; }
      }
      if (bestDm != null && bestScore < 0.6 && Math.abs(bestDm) <= 1.6) { best = u.m + bestDm; if (opts.grid) best = snap(best); stats.matched++; }
      else { // the original gives no clear note here: the nearest note of the key at this point of the song
        bestDl = 0; var lsc = scaleAt((u.s + u.e) / 2 * hop + lag), bb = 99;
        for (var o = -2; o <= 2; o++) { var cand = Math.round(u.m - tun) + o, p = ((cand % 12) + 12) % 12; if (lsc.indexOf(p) >= 0 && Math.abs(u.m - (cand + tun)) < bb) { bb = Math.abs(u.m - (cand + tun)); best = cand + tun; } }
      }
      // 2. the target at every moment: the original singer's note at that (aligned) moment - like Auto-Tune fed with target notes
      var mv = 0, cnt = 0;
      for (f = u.s; f < u.e; f++) {
        if (!um[f]) continue;
        var rf2 = Math.round((f * hop + lag) / ref.hop) + bestDl, tg = null, bd = 9, id = -1;
        for (j = rf2 - 4; j <= rf2 + 4; j++) {
          var ni = j >= 0 && j < noteAt.length ? noteAt[j] : -1; if (ni < 0) continue;
          var c = opts.grid ? snap(rn[ni].m) : rn[ni].m; c += 12 * Math.round((um[f] - c) / 12);
          var d = Math.abs(c - um[f]) + 0.1 * Math.abs(j - rf2); if (d < bd) { bd = d; tg = c; id = ni; }
        }
        if (tg == null || Math.abs(tg - um[f]) > 1.3) { tg = best; id = 1e6 + uix; }
        if (tg == null || Math.abs(tg - um[f]) > 1.6) continue; // far off: sung on purpose, leave it
        err[f] = tg - um[f]; has[f] = 1; tid[f] = id; mv += Math.abs(err[f]); cnt++;
      }
      if (cnt && mv / cnt > 0.08) stats.moved++; uix++;
    });
    // 3. retune speed: the correction is the error smoothed over `speed` seconds (no delay). Slow = the note is carried to
    //    its place with vibrato and slides intact; fast = the pitch is held on the note. Spikes at note changes are removed first.
    //    Each target note is smoothed on its own (a short note is not diluted by its neighbours - Auto-Tune's "humanize" idea:
    //    short notes snap, long notes breathe), and the steps between notes are then rounded over 50 ms.
    var raw = new Float32Array(n), W = Math.max(1, Math.round(speed / hop / 2)), md5 = new Float32Array(n), win = [];
    for (f = 0; f < n; f++) { if (!has[f]) continue; win.length = 0; for (j = f - 3; j <= f + 3; j++) if (j >= 0 && j < n && has[j] && tid[j] === tid[f]) win.push(err[j]); win.sort(function (p, q) { return p - q; }); md5[f] = win[win.length >> 1]; }
    for (f = 0; f < n; f++) {
      if (!has[f]) continue; var acc = 0, ws = 0;
      for (j = f - W; j <= f + W; j++) { if (j < 0 || j >= n || !has[j] || tid[j] !== tid[f]) continue; var wg = 0.5 + 0.5 * Math.cos(Math.PI * (j - f) / (W + 1)); ws += wg; acc += md5[j] * wg; }
      raw[f] = ws ? acc / ws : 0;
    }
    var y = new Float32Array(n), E = Math.max(1, Math.round((opts.edge || 0.05) / hop / 2));
    for (f = 0; f < n; f++) {
      if (!um[f]) continue; var a2 = 0, w2 = 0;
      for (j = f - E; j <= f + E; j++) { if (j < 0 || j >= n || !um[j]) continue; var wg2 = 0.5 + 0.5 * Math.cos(Math.PI * (j - f) / (E + 1)); w2 += wg2; a2 += raw[j] * wg2; }
      y[f] = w2 ? a2 / w2 * cen * 100 : 0;
    }
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
  function tune(x, sr, ref, opts, onp, track) {
    var tr = track || f0(x, sr, onp && function (p) { onp(p * 0.6); });
    var pl = plan(tr, ref, opts); if (onp) onp(0.7);
    var y = opts.engine === "psola" ? psola(x, sr, tr, pl.cents) : slip(x, sr, tr, pl.cents); if (onp) onp(1);
    return { y: y, stats: pl.stats, track: tr, cents: pl.cents };
  }
  /* ---------- second voice: every sung note moved a third up (or down) inside the song's key at that moment.
     TD-PSOLA here, because it keeps the singer's own timbre over 3-4 semitones (a resampled voice would sound small). ---------- */
  function harmony(x, sr, track, cents0, o) {
    var hop = track.hop, n = track.f0.length, um = new Float32Array(n), f, dir = o.dir < 0 ? -1 : 1, semi = o.semi || 0, lag = o.lag || 0, km = o.keys;
    for (f = 0; f < n; f++) um[f] = track.f0[f] ? midi(track.f0[f]) + (cents0 ? cents0[f] / 100 : 0) : 0;
    var pc = new Float64Array(12), un = notes(track, false);
    un.forEach(function (u) { var w = []; for (var q = u.s; q < u.e; q++) if (um[q]) w.push(um[q]); w.sort(function (a, b) { return a - b; }); u.pm = w.length ? w[w.length >> 1] : u.m; pc[((Math.round(u.pm) % 12) + 12) % 12] += u.e - u.s; });
    var own = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].sort(function (a, b) { return pc[b] - pc[a]; }).slice(0, 7).sort(function (a, b) { return a - b; });
    var scaleAt = function (t) { if (!km || !km.k || !km.k.length) return own; var i = Math.max(0, Math.min(km.k.length - 1, Math.floor(t / (km.hop || 1)))); return keyScale(km.k[i], semi).slice(0, 7); };
    var cents = new Float32Array(n);
    un.forEach(function (u) {
      if (u.e - u.s < 6) return;
      var sc = scaleAt((u.s + u.e) / 2 * hop + lag), b = Math.round(u.pm), bp = ((b % 12) + 12) % 12, d = sc.indexOf(bp), iv;
      if (d >= 0) { var hp = sc[(d + (dir > 0 ? 2 : 5)) % 7]; iv = dir > 0 ? (hp - bp + 12) % 12 : -((bp - hp + 12) % 12); }
      else iv = dir * (sc.indexOf((bp + dir * 4 + 12) % 12) >= 0 ? 4 : 3);
      if (Math.abs(iv) < 3 || Math.abs(iv) > 4) iv = dir * 3;
      var c = (b + iv - u.pm) * 100; for (var q = u.s; q < u.e; q++) cents[q] = c;
    });
    // steps between notes rounded over 40 ms
    var sm = new Float32Array(n); for (f = 0; f < n; f++) { if (!cents[f]) continue; var a = 0, w2 = 0; for (var j = f - 2; j <= f + 2; j++) if (j >= 0 && j < n && cents[j]) { a += cents[j]; w2++; } sm[f] = a / w2; }
    var y = psola(x, sr, { f0: track.f0, hop: hop }, sm);
    // only the moved notes are kept (an unmoved copy would just double the lead), with short fades; a softer top end keeps it behind the lead
    var g = new Float32Array(n), i; for (f = 0; f < n; f++) g[f] = sm[f] && track.f0[f] ? 1 : 0;
    var out = new Float32Array(x.length), gs = 0, k = 1 - Math.exp(-1 / (0.012 * sr));
    for (i = 0; i < x.length; i++) { var fi = Math.min(n - 1, Math.floor(i / sr / hop)); gs += (g[fi] - gs) * k; out[i] = y[i] * gs; }
    return filt(out, coef("lp", 6500, 0.7071, 0, sr));
  }
  /* ---------- noise reduction: spectral, decision-directed (keeps the voice natural, no "underwater") ---------- */
  function denoise(x, sr, amount) {
    if (!amount) return x;
    var N = sr > 32000 ? 2048 : 1024, H = N / 4, T = tables(N), w = T.win, K = N / 2 + 1, n = x.length, i, k, f;
    var frames = Math.ceil(n / H) + 3, re = new Float64Array(N), im = new Float64Array(N), specs = [], en = new Float64Array(frames);
    for (f = 0; f < frames; f++) {
      var s0 = f * H - N; for (i = 0; i < N; i++) { var q = s0 + i; re[i] = q >= 0 && q < n ? x[q] * w[i] : 0; im[i] = 0; }
      fft(re, im, T, false); var p = new Float32Array(K), e = 0; for (k = 0; k < K; k++) { p[k] = re[k] * re[k] + im[k] * im[k]; e += p[k]; } specs.push(p); en[f] = e;
    }
    // noise per frequency: a low percentile of that bin over the whole take (works even with little silence)
    var live = []; for (f = 0; f < frames; f++) if (en[f] > 0) live.push(f);
    var noise = new Float64Array(K), col = new Float32Array(live.length), pc = Math.floor(live.length * 0.1);
    for (k = 0; k < K; k++) { for (i = 0; i < live.length; i++) col[i] = specs[live[i]][k]; col.sort(); noise[k] = Math.max(col[pc] * 2.0, 1e-12); }
    var nE = 0; for (k = 0; k < K; k++) nE += noise[k];
    var floor = Math.pow(10, -(4 + amount * 10) / 20), alpha = 0.96, prevG = new Float64Array(K).fill(1), prevPost = new Float64Array(K).fill(1), held = new Float64Array(K).fill(1);
    var rel = Math.exp(-H / sr / 0.08), y = new Float32Array(n + 2 * N), ws = new Float32Array(n + 2 * N), G = new Float64Array(K);
    for (f = 0; f < frames; f++) {
      var s1 = f * H - N; for (i = 0; i < N; i++) { var q2 = s1 + i; re[i] = q2 >= 0 && q2 < n ? x[q2] * w[i] : 0; im[i] = 0; }
      fft(re, im, T, false);
      // while someone sings (frame well above the noise) never take more than 6 dB away: the voice masks the noise anyway
      var snrF = en[f] / nE, fl = snrF > 6 ? Math.max(floor, 0.5) : snrF > 2 ? Math.max(floor, 0.3) : floor;
      for (k = 0; k < K; k++) {
        var post = specs[f][k] / noise[k], prio = alpha * prevG[k] * prevG[k] * prevPost[k] + (1 - alpha) * Math.max(post - 1, 0);
        var g = prio / (1 + prio); prevG[k] = g; prevPost[k] = post;
        held[k] = Math.max(g, held[k] * rel); // gains open fast and close slowly: no chopping
        G[k] = Math.max(fl, held[k]);
      }
      for (k = 1; k < K - 1; k++) G[k] = 0.25 * G[k - 1] + 0.5 * G[k] + 0.25 * G[k + 1];
      for (k = 0; k < K; k++) { re[k] *= G[k]; im[k] *= G[k]; if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; } }
      fft(re, im, T, true);
      for (i = 0; i < N; i++) { var o = s1 + i + N; if (o < 0 || o >= y.length) continue; y[o] += re[i] * w[i]; ws[o] += w[i] * w[i]; }
    }
    var out = new Float32Array(n); for (i = 0; i < n; i++) { var g2 = ws[i + N]; out[i] = g2 > 1e-3 ? y[i + N] / g2 : 0; }
    return out;
  }
  /* ---------- where the playback sits inside the recording (GCC-PHAT): the round-trip latency, measured from the take itself ---------- */
  function decim(x, sr, D) {
    if (D <= 1) return x;
    var c = coef("lp", sr / D * 0.42, 0.7071, 0, sr), lp = filtfilt(filtfilt(x, c), c), n = Math.floor(lp.length / D), y = new Float32Array(n);
    for (var i = 0; i < n; i++) y[i] = lp[i * D]; return y;
  }
  function gccDelay(mic, ref, sr, maxLag) {
    var D = Math.max(1, Math.round(sr / 16000)), fs = sr / D, a = decim(mic, sr, D), b = decim(ref, sr, D), n = Math.min(a.length, b.length);
    var N = 32768; while (N > n && N > 2048) N >>= 1; if (n < N) return { delay: 0, conf: 0 };
    var T = tables(N), w = T.win, re = new Float64Array(N), im = new Float64Array(N), cr = new Float64Array(N), ci = new Float64Array(N), i, k;
    var starts = [], H = N >> 1; for (var s = 0; s + N <= n; s += H) starts.push(s);
    var step = Math.max(1, Math.ceil(starts.length / 40)), k0 = Math.round(150 / fs * N), k1 = Math.round(Math.min(7000, fs * 0.45) / fs * N), used = 0;
    for (var q = 0; q < starts.length; q += step) {
      var s0 = starts[q], eb = 0, ea = 0; for (i = 0; i < N; i++) { re[i] = a[s0 + i] * w[i]; im[i] = b[s0 + i] * w[i]; eb += im[i] * im[i]; ea += re[i] * re[i]; }
      if (eb / N < 1e-9 || ea / N < 1e-10) continue;
      fft(re, im, T, false);
      for (k = k0; k <= k1; k++) {
        var nk = N - k, zr = re[k], zi = im[k], c2 = re[nk], d2 = -im[nk];
        var ar = (zr + c2) / 2, ai = (zi + d2) / 2, br = (zi - d2) / 2, bi = -(zr - c2) / 2; // A = mic, B = ref
        var xr = ar * br + ai * bi, xi = ai * br - ar * bi, mg = Math.sqrt(xr * xr + xi * xi) + 1e-20; // A * conj(B), whitened
        cr[k] += xr / mg; ci[k] += xi / mg;
      }
      used++;
    }
    if (!used) return { delay: 0, conf: 0 };
    for (k = k0; k <= k1; k++) { cr[N - k] = cr[k]; ci[N - k] = -ci[k]; }
    fft(cr, ci, T, true);
    var lo = -Math.round(0.03 * fs), hi = Math.min(H - 1, Math.round((maxLag || 0.6) * fs)), best = 0, bv = 0, sum = 0, sq = 0, cnt = 0;
    for (var l = lo; l <= hi; l++) { var v = Math.abs(cr[(l + N) % N]); sum += v; sq += v * v; cnt++; if (v > bv) { bv = v; best = l; } }
    var mean = sum / cnt, sd = Math.sqrt(Math.max(1e-30, sq / cnt - mean * mean));
    var y0 = Math.abs(cr[(best - 1 + N) % N]), y2 = Math.abs(cr[(best + 1 + N) % N]), den = y0 - 2 * bv + y2, fr = den ? 0.5 * (y0 - y2) / den : 0;
    // a real acoustic path gives one sharp peak; tonal music against an unrelated voice gives many similar ones, or one at the edge
    var second = 0, guard = Math.round(0.003 * fs); for (l = lo; l <= hi; l++) { if (Math.abs(l - best) <= guard) continue; var v2 = Math.abs(cr[(l + N) % N]); if (v2 > second) second = v2; }
    var conf = (bv - mean) / sd; if (best <= lo + 1 || best >= hi - 1 || bv < second * 1.35) conf = Math.min(conf, 1);
    return { delay: (best + Math.max(-1, Math.min(1, fr))) / fs, conf: conf, ratio: bv / (second + 1e-20) };
  }
  /* ---------- where is the playback inside the recording, moment by moment ----------
     The speaker and the microphone do not have to share a clock (Bluetooth speakers, some phones), streams drop a few
     milliseconds now and then, and two speakers give two arrivals. So the delay is not one number: it is found per
     second (PHAT correlation of 1 s frames), the frames vote for the coarse value, one smooth path is followed through
     the per-frame peaks, and the result is a few straight segments: a start delay, a drift, and steps between them. */
  function phat(a, b, s0, ob, N, T, k0, k1, re, im, cr, ci) {
    var w = T.win, i, k, ea = 0, eb = 0, q;
    for (i = 0; i < N; i++) { q = s0 + i; re[i] = q < a.length ? a[q] * w[i] : 0; q -= ob; im[i] = q >= 0 && q < b.length ? b[q] * w[i] : 0; ea += re[i] * re[i]; eb += im[i] * im[i]; }
    if (eb / N < 1e-9 || ea / N < 1e-10) return false;
    fft(re, im, T, false); cr.fill(0); ci.fill(0);
    for (k = k0; k <= k1; k++) {
      var nk = N - k, zr = re[k], zi = im[k], c2 = re[nk], d2 = -im[nk];
      var ar = (zr + c2) / 2, ai = (zi + d2) / 2, br = (zi - d2) / 2, bi = -(zr - c2) / 2; // A = mic, B = ref
      var xr = ar * br + ai * bi, xi = ai * br - ar * bi, mg = Math.sqrt(xr * xr + xi * xi) + 1e-20; // A * conj(B), whitened
      cr[k] = xr / mg; ci[k] = xi / mg; cr[nk] = cr[k]; ci[nk] = -ci[k];
    }
    fft(cr, ci, T, true); return true;
  }
  function delayTrack(mic, ref, sr, maxLag) {
    var none = { found: false, delay: 0, conf: 0, ratio: 1, votes: 0, segs: [], ppm: 0, steps: 0, varies: false };
    var D = Math.max(1, Math.round(sr / 16000)), fs = sr / D, a = decim(mic, sr, D), b = decim(ref, sr, D), n = Math.min(a.length, b.length), i, l, f;
    var N = 32768; while (N > n && N > 4096) N >>= 1; if (n < N) return none;
    var T = tables(N), re = new Float64Array(N), im = new Float64Array(N), cr = new Float64Array(N), ci = new Float64Array(N), H = N >> 1;
    var k0 = Math.round(150 / fs * N), k1 = Math.round(Math.min(7000, fs * 0.45) / fs * N), lo = -Math.round(0.03 * fs), hi = Math.min(H - 1, Math.round((maxLag || 0.9) * fs));
    // 1. coarse: every frame names its strongest lag; the lag most frames agree on (within a few ms) is the playback
    var starts = []; for (var s = 0; s + N <= n; s += H) starts.push(s);
    var step = Math.max(1, Math.ceil(starts.length / 60)), votes = [], zs2 = [], nf = 0, hist = new Float32Array(hi - lo + 1), mg = new Float32Array(hi - lo + 1);
    for (var q = 0; q < starts.length; q += step) {
      if (!phat(a, b, starts[q], 0, N, T, k0, k1, re, im, cr, ci)) continue; nf++;
      var sum = 0, sq = 0, bv = 0, best = 0;
      for (l = lo; l <= hi; l++) { var v = 0; for (i = -2; i <= 2; i++) v += Math.abs(cr[(l + i + N) % N]); mg[l - lo] = v; sum += v; sq += v * v; if (v > bv) { bv = v; best = l; } }
      var mean = sum / mg.length, sd = Math.sqrt(Math.max(1e-30, sq / mg.length - mean * mean)), z = (bv - mean) / sd;
      if (z >= 6 && best > lo + 2 && best < hi - 2) { votes.push(best); zs2.push(z); }
    }
    if (!nf || !votes.length) return none;
    var R = Math.round(0.006 * fs); votes.forEach(function (v) { for (var d = -R; d <= R; d++) { var x = v + d - lo; if (x >= 0 && x < hist.length) hist[x] += 1 - Math.abs(d) / (R + 1); } });
    var Dc = 0, hb = 0; for (i = 0; i < hist.length; i++) if (hist[i] > hb) { hb = hist[i]; Dc = i + lo; }
    var near = Math.round(0.012 * fs), nMode = 0, zm = []; votes.forEach(function (v, ix) { if (Math.abs(v - Dc) <= near) { nMode++; zm.push(zs2[ix]); } });
    zm.sort(function (x, y) { return x - y; }); var share = nMode / nf;
    var res = { found: nMode >= Math.min(3, nf) && share >= 0.3, delay: Dc / fs, votes: share, z: zm.length ? zm[zm.length >> 1] : 0, segs: [], ppm: 0, steps: 0, varies: false };
    res.conf = res.found ? 20 + 10 * share : 5 * share; res.ratio = 1 + 2 * share;
    if (!res.found) return res;
    // 2. fine: 1 s frames against the playback shifted by the coarse delay; candidates are the peaks within +-60 ms
    var N2 = Math.min(N, 16384), T2 = tables(N2), H2 = N2 >> 1, W = Math.min(H2 - 2, Math.round(0.06 * fs)), k20 = Math.round(150 / fs * N2), k21 = Math.round(Math.min(7000, fs * 0.45) / fs * N2);
    var re2 = new Float64Array(N2), im2 = new Float64Array(N2), cr2 = new Float64Array(N2), ci2 = new Float64Array(N2), fr = [];
    for (s = 0; s + N2 <= n; s += H2) {
      if (!phat(a, b, s, Dc, N2, T2, k20, k21, re2, im2, cr2, ci2)) continue;
      var sm = 0, s2 = 0, pk = 0, c = [];
      for (l = -W; l <= W; l++) { var av = Math.abs(cr2[(l + N2) % N2]); sm += av; s2 += av * av; if (av > pk) pk = av; }
      var mn = sm / (2 * W + 1), sdv = Math.sqrt(Math.max(1e-30, s2 / (2 * W + 1) - mn * mn)); if ((pk - mn) / sdv < 5) continue;
      for (l = -W + 1; l < W; l++) {
        var y1 = Math.abs(cr2[(l + N2) % N2]); if (y1 < 0.3 * pk) continue; var y0 = Math.abs(cr2[(l - 1 + N2) % N2]), y2 = Math.abs(cr2[(l + 1 + N2) % N2]); if (y1 < y0 || y1 < y2) continue;
        var den = y0 - 2 * y1 + y2; c.push({ d: (Dc + l + (den ? Math.max(-1, Math.min(1, 0.5 * (y0 - y2) / den)) : 0)) / fs, v: y1 / pk, cost: 0, from: -1 });
      }
      c.sort(function (x, y) { return y.v - x.v; }); if (c.length > 5) c.length = 5;
      if (c.length) fr.push({ t: (s + H2) / fs, c: c });
    }
    if (!fr.length) { res.segs = [{ t0: 0, t1: 1e9, a: res.delay, b: 0 }]; return res; }
    // one smooth path through the candidates: staying costs nothing, a jump costs up to 3 - a few frames' worth of a stronger peak -
    // so the path does not hop between two speakers' arrivals, but a real step (the old peak is gone) is still followed
    for (f = 0; f < fr.length; f++) fr[f].c.forEach(function (x) {
      if (!f) { x.cost = -x.v; return; }
      var bc = 1e9, bf = -1; fr[f - 1].c.forEach(function (p, ix) { var tc = p.cost + Math.min(3, Math.abs(x.d - p.d) * 1000); if (tc < bc) { bc = tc; bf = ix; } });
      x.cost = bc - x.v; x.from = bf;
    });
    var last = fr[fr.length - 1].c, bi2 = 0; last.forEach(function (x, ix) { if (x.cost < last[bi2].cost) bi2 = ix; });
    var pts = []; for (f = fr.length - 1; f >= 0; f--) { var cc = fr[f].c[bi2]; pts.unshift({ t: fr[f].t, d: cc.d }); bi2 = cc.from; }
    // 3. straight segments: split where the delay steps by more than 1.5 ms and stays there; a line (start + drift) per segment
    var md = pts.map(function (p, ix) { var w3 = [pts[Math.max(0, ix - 1)].d, p.d, pts[Math.min(pts.length - 1, ix + 1)].d].sort(function (x, y) { return x - y; }); return w3[1]; });
    var segs = [], st = 0;
    var fit = function (i0, i1) {
      var xs = [], ys = [], j; for (j = i0; j < i1; j++) if (md[j] === md[j]) { xs.push(pts[j].t); ys.push(md[j]); }
      var line = function () { var m = xs.length, sx = 0, sy = 0, sxx = 0, sxy = 0; for (var u = 0; u < m; u++) { sx += xs[u]; sy += ys[u]; sxx += xs[u] * xs[u]; sxy += xs[u] * ys[u]; } var dn = m * sxx - sx * sx; if (m < 4 || Math.abs(dn) < 1e-9) { var srt = ys.slice().sort(function (x, y) { return x - y; }); return { a: srt[srt.length >> 1], b: 0 }; } var bb = (m * sxy - sx * sy) / dn; return { a: (sy - bb * sx) / m, b: bb }; };
      var L1 = line(), kx = [], ky = []; for (j = 0; j < xs.length; j++) if (Math.abs(ys[j] - L1.a - L1.b * xs[j]) < 0.0006) { kx.push(xs[j]); ky.push(ys[j]); }
      if (kx.length >= 4 && kx.length < xs.length) { xs = kx; ys = ky; L1 = line(); }
      if (Math.abs(L1.b) > 250e-6 || xs.length < 40) { var s3 = ys.slice().sort(function (x, y) { return x - y; }); L1 = { a: s3[s3.length >> 1], b: 0 }; } // no clock is that far off, and under 20 s a drift cannot be told from noise
      return L1;
    };
    for (i = 1; i <= pts.length; i++) {
      if (i < pts.length && Math.abs(md[i] - md[i - 1]) <= 0.0015) continue;
      segs.push({ i0: st, i1: i }); st = i;
    }
    // a segment of one or two frames is noise: it joins its longer neighbour
    for (i = 0; i < segs.length && segs.length > 1;) { if (segs[i].i1 - segs[i].i0 >= 3) { i++; continue; } if (i > 0) { segs[i - 1].i1 = segs[i].i1; segs.splice(i, 1); } else { segs[1].i0 = segs[0].i0; segs.splice(0, 1); } }
    // a few seconds at either end that sit on another arrival: same thing, seen once
    if (segs.length > 1 && segs[0].i1 - segs[0].i0 <= 8) { for (i = segs[0].i0; i < segs[0].i1; i++) md[i] = NaN; segs[1].i0 = segs[0].i0; segs.splice(0, 1); }
    if (segs.length > 1 && segs[segs.length - 1].i1 - segs[segs.length - 1].i0 <= 8) { var lg0 = segs.pop(); for (i = lg0.i0; i < lg0.i1; i++) md[i] = NaN; segs[segs.length - 1].i1 = lg0.i1; }
    // away and back again (A, B, A) is the path visiting another arrival of the same playback, not a change of delay: B joins A
    var lvl = function (g) { var w = md.slice(g.i0, g.i1).sort(function (x, y) { return x - y; }); return w[w.length >> 1]; };
    for (i = 1; i < segs.length - 1;) { if (Math.abs(lvl(segs[i - 1]) - lvl(segs[i + 1])) < 0.001) { for (var j2 = segs[i].i0; j2 < segs[i].i1; j2++) md[j2] = NaN; segs[i - 1].i1 = segs[i + 1].i1; segs.splice(i, 2); if (i > 1) i--; } else i++; }
    res.segs = segs.map(function (g, ix) { var L2 = fit(g.i0, g.i1); return { t0: ix ? (pts[g.i0 - 1].t + pts[g.i0].t) / 2 : 0, t1: ix < segs.length - 1 ? (pts[g.i1 - 1].t + pts[g.i1].t) / 2 : 1e9, a: L2.a, b: L2.b, n: g.i1 - g.i0 }; });
    var all = [], dur = n / fs; for (var t = 0.25; t < dur; t += 0.5) all.push(dAt(res.segs, t)); all.sort(function (x, y) { return x - y; });
    res.delay = all.length ? all[all.length >> 1] : res.delay; res.steps = res.segs.length - 1;
    var lg = res.segs.reduce(function (x, y) { return y.n > x.n ? y : x; }); res.ppm = lg.b * 1e6;
    res.varies = all.length > 1 && (all[all.length - 1] - all[0] > 0.0004 || res.steps > 0);
    return res;
  }
  function dAt(segs, t) { for (var i = 0; i < segs.length; i++) if (t < segs[i].t1 || i === segs.length - 1) return segs[i].a + segs[i].b * t; return 0; }
  // 8-tap windowed-sinc read of x at a fractional position
  function sincAt(x, pos) { var n = x.length, ip = Math.floor(pos), o = Math.round((pos - ip) * 512) * 8, b = ip - 3; if (b < 0 || b + 8 > n) return ip >= 0 && ip < n ? x[ip] : 0; return x[b] * SNC[o] + x[b + 1] * SNC[o + 1] + x[b + 2] * SNC[o + 2] + x[b + 3] * SNC[o + 3] + x[b + 4] * SNC[o + 4] + x[b + 5] * SNC[o + 5] + x[b + 6] * SNC[o + 6] + x[b + 7] * SNC[o + 7]; }
  // the playback as the microphone's clock heard it: out[i] = ref(i - (delay(i) - lead)); done inside `ref` itself when the shift allows (saves memory on phones)
  function warpRef(ref, sr, segs, lead, n) {
    var minSh = 1e9, i, t; for (t = 0; t <= n / sr; t += 0.5) minSh = Math.min(minSh, (dAt(segs, t) - lead) * sr);
    var out = ref.length === n && minSh >= 12 ? ref : new Float32Array(n), flat = segs.length === 1 && Math.abs(segs[0].b) < 1e-9, sh0 = Math.round((segs[0].a - lead) * sr);
    for (i = n - 1; i >= 0; i--) {
      if (flat) { var q = i - sh0; out[i] = q >= 0 && q < ref.length ? ref[q] : 0; continue; }
      out[i] = sincAt(ref, i - (dAt(segs, i / sr) - lead) * sr);
    }
    return out;
  }
  // the cleaned take with one constant delay (the median): out[j] = y(j + delay(j) - median)
  function retime(y, sr, segs, dmed) { var n = y.length, out = new Float32Array(n); for (var j = 0; j < n; j++) out[j] = sincAt(y, j + (dAt(segs, j / sr) - dmed) * sr); return out; }
  /* ---------- playback removal with the known playback as reference ----------
     Each frequency band gets its own short filter (6 taps over ~60 ms, re-fitted every ~2.7 s by least squares) that
     turns the playback into what the microphone heard of it; that estimate is subtracted, and what is left of the
     music (reverb tail, speaker distortion) is pushed down by a Wiener gain driven by the same estimate. */
  function aec(mic, ref, sr, d0, onp, dbg, cfg, refS) {
    cfg = cfg || {};
    var N = 2048, H = 512, T = tables(N), w = T.win, K = N / 2 + 1, n = mic.length, i, k, f, a, b2;
    var TD = [-1, 0, 1, 2, 3, 4], KLO = Math.round(6000 / sr * N), PADL = 4, PADR = 1, B = 512, A = 256, BW = B + PADL + PADR, M = Math.ceil(n / H) + 3, ST = refS ? 2 : 1, LM = 12;
    var Yr = new Float32Array(BW * K), Yi = new Float32Array(BW * K), Xr = new Float32Array(BW * K), Xi = new Float32Array(BW * K), Sr = refS ? new Float32Array(BW * K) : null, Si = refS ? new Float32Array(BW * K) : null;
    var re = new Float64Array(N), im = new Float64Array(N);
    function analyze(m, idx) {
      var s0 = m * H - N, o = idx * K, q, r;
      if (m < 0 || m >= M) { Yr.fill(0, o, o + K); Yi.fill(0, o, o + K); Xr.fill(0, o, o + K); Xi.fill(0, o, o + K); if (refS) { Sr.fill(0, o, o + K); Si.fill(0, o, o + K); } return; }
      for (i = 0; i < N; i++) { q = s0 + i; r = q - d0; re[i] = q >= 0 && q < n ? mic[q] * w[i] : 0; im[i] = r >= 0 && r < ref.length ? ref[r] * w[i] : 0; }
      fft(re, im, T, false);
      for (k = 0; k < K; k++) { var nk = (N - k) % N, zr = re[k], zi = im[k], c2 = re[nk], d2 = -im[nk]; Yr[o + k] = (zr + c2) / 2; Yi[o + k] = (zi + d2) / 2; Xr[o + k] = (zi - d2) / 2; Xi[o + k] = -(zr - c2) / 2; }
      if (refS) { for (i = 0; i < N; i++) { r = s0 + i - d0; re[i] = r >= 0 && r < refS.length ? refS[r] * w[i] : 0; im[i] = 0; } fft(re, im, T, false); for (k = 0; k < K; k++) { Sr[o + k] = re[k]; Si[o + k] = im[k]; } }
    }
    var BETA = cfg.beta || 2, ALPHA = cfg.alpha == null ? 0.85 : cfg.alpha, GMIN = cfg.gmin || 0.1, HOLD = cfg.hold || 0.5, PCT = cfg.pct || 0.25, DEC = cfg.dec || 2;
    var out = new Float32Array(n + 2 * N), ws = new Float32Array(n + 2 * N);
    var prevR = new Float32Array(A * K), prevI = new Float32Array(A * K), curR = new Float32Array(B * K), curI = new Float32Array(B * K), havePrev = false;
    var gam = new Float32Array(K).fill(0.1), gamInit = false, hold = new Float64Array(K), pG = new Float64Array(K).fill(1), pPost = new Float64Array(K).fill(1), G = new Float64Array(K);
    var ratio = new Float32Array(B), Ar = new Float64Array(LM * LM), Ai = new Float64Array(LM * LM), pr = new Float64Array(LM), pi = new Float64Array(LM), hr = new Float64Array(LM), hi = new Float64Array(LM), xr = new Float64Array(LM), xi = new Float64Array(LM);
    var sY = 0, sE = 0, sO = 0, sEst = 0, pend = null, er = new Float64Array(N), ei = new Float64Array(N), W0;
    function solve(L) { // complex Gaussian elimination with pivoting; a dead column (no such signal) gets a zero tap
      var c, r, j, t;
      for (c = 0; c < L; c++) {
        var pv = c, pm = 0; for (r = c; r < L; r++) { var mg = Ar[r * LM + c] * Ar[r * LM + c] + Ai[r * LM + c] * Ai[r * LM + c]; if (mg > pm) { pm = mg; pv = r; } }
        if (pm < 1e-30) { for (j = 0; j < L; j++) { Ar[c * LM + j] = 0; Ai[c * LM + j] = 0; } Ar[c * LM + c] = 1; pr[c] = 0; pi[c] = 0; continue; }
        if (pv !== c) { for (j = 0; j < L; j++) { t = Ar[c * LM + j]; Ar[c * LM + j] = Ar[pv * LM + j]; Ar[pv * LM + j] = t; t = Ai[c * LM + j]; Ai[c * LM + j] = Ai[pv * LM + j]; Ai[pv * LM + j] = t; } t = pr[c]; pr[c] = pr[pv]; pr[pv] = t; t = pi[c]; pi[c] = pi[pv]; pi[pv] = t; }
        var dr = Ar[c * LM + c], di = Ai[c * LM + c], dm = dr * dr + di * di;
        for (r = c + 1; r < L; r++) {
          var fr = (Ar[r * LM + c] * dr + Ai[r * LM + c] * di) / dm, fi = (Ai[r * LM + c] * dr - Ar[r * LM + c] * di) / dm; if (fr === 0 && fi === 0) continue;
          for (j = c; j < L; j++) { Ar[r * LM + j] -= fr * Ar[c * LM + j] - fi * Ai[c * LM + j]; Ai[r * LM + j] -= fr * Ai[c * LM + j] + fi * Ar[c * LM + j]; }
          pr[r] -= fr * pr[c] - fi * pi[c]; pi[r] -= fr * pi[c] + fi * pr[c];
        }
      }
      for (c = L - 1; c >= 0; c--) {
        var sr2 = pr[c], si = pi[c]; for (j = c + 1; j < L; j++) { sr2 -= Ar[c * LM + j] * hr[j] - Ai[c * LM + j] * hi[j]; si -= Ar[c * LM + j] * hi[j] + Ai[c * LM + j] * hr[j]; }
        var d3 = Ar[c * LM + c], d4 = Ai[c * LM + c], dn = d3 * d3 + d4 * d4; hr[c] = (sr2 * d3 + si * d4) / dn; hi[c] = (si * d3 - sr2 * d4) / dn;
      }
    }
    function emit(m, sR, sI) { // one finished frame (spectrum of the cleaned signal): two frames share one inverse FFT
      if (!pend) { pend = { m: m, r: Float64Array.from(sR), i: Float64Array.from(sI) }; return; }
      for (k = 0; k < K; k++) { er[k] = pend.r[k] - sI[k]; ei[k] = pend.i[k] + sR[k]; if (k > 0 && k < N / 2) { er[N - k] = pend.r[k] + sI[k]; ei[N - k] = -pend.i[k] + sR[k]; } }
      fft(er, ei, T, true);
      var o1 = pend.m * H, o2 = m * H; // frame m starts at m*H - N, plus the N offset of `out`
      for (i = 0; i < N; i++) { out[o1 + i] += er[i] * w[i]; ws[o1 + i] += w[i] * w[i]; if (m >= 0) { out[o2 + i] += ei[i] * w[i]; ws[o2 + i] += w[i] * w[i]; } }
      pend = null;
    }
    var fR = new Float64Array(K), fI = new Float64Array(K), Gs = new Float64Array(K);
    function finish(m, yo, eR, eI, eo) { // residual suppression for frame m: Y at Yr[yo..], playback estimate at eR[eo..]
      for (k = 0; k < K; k++) {
        var yr = Yr[yo + k], yi = Yi[yo + k], qr = eR[eo + k], qi = eI[eo + k], e1 = yr - qr, e2 = yi - qi, pe = e1 * e1 + e2 * e2, pq = qr * qr + qi * qi;
        hold[k] = Math.max(pq, hold[k] * HOLD); // the music rings on a little after each frame (room)
        var res = BETA * gam[k] * hold[k] + 1e-14, post = pe / res, prio = ALPHA * pG[k] * pG[k] * pPost[k] + (1 - ALPHA) * Math.max(post - 1, 0), g = prio / (1 + prio);
        pG[k] = g; pPost[k] = post; G[k] = g < GMIN ? GMIN : g; fR[k] = e1; fI[k] = e2; sY += yr * yr + yi * yi; sE += pe; sEst += pq;
      }
      Gs[0] = G[0]; Gs[K - 1] = G[K - 1]; for (k = 1; k < K - 1; k++) Gs[k] = 0.25 * G[k - 1] + 0.5 * G[k] + 0.25 * G[k + 1];
      for (k = 0; k < K; k++) { fR[k] *= Gs[k]; fI[k] *= Gs[k]; sO += fR[k] * fR[k] + fI[k] * fI[k]; }
      if (dbg) dbg(m, Gs, eR, eI, eo);
      emit(m, fR, fI);
    }
    for (var b = 0, first = true; b < M; b += A, first = false) {
      W0 = b - PADL;
      if (first) { for (f = 0; f < BW; f++) analyze(W0 + f, f); }
      else { Yr.copyWithin(0, A * K); Yi.copyWithin(0, A * K); Xr.copyWithin(0, A * K); Xi.copyWithin(0, A * K); if (refS) { Sr.copyWithin(0, A * K); Si.copyWithin(0, A * K); } for (f = BW - A; f < BW; f++) analyze(W0 + f, f); }
      for (k = 0; k < K; k++) {
        // taps: the mono sum over 6 frames (2 above 6 kHz), and the same again for the stereo difference when the speakers are stereo
        var L1 = k <= KLO ? 6 : 2, t0 = k <= KLO ? 0 : 1, L = L1 * ST, tr = 0, xo;
        for (a = 0; a < L; a++) { pr[a] = 0; pi[a] = 0; for (b2 = 0; b2 < L; b2++) { Ar[a * LM + b2] = 0; Ai[a * LM + b2] = 0; } }
        for (f = (b / A) % DEC === 0 ? 0 : 1; f < B; f += DEC) { // neighbouring frames overlap by 75%: every second one is enough for the fit
          var fo = (f + PADL) * K + k, yr0 = Yr[fo], yi0 = Yi[fo];
          for (a = 0; a < L1; a++) { xo = fo - TD[t0 + a] * K; xr[a] = Xr[xo]; xi[a] = Xi[xo]; if (refS) { xr[L1 + a] = Sr[xo]; xi[L1 + a] = Si[xo]; } }
          for (a = 0; a < L; a++) {
            var xar = xr[a], xai = xi[a]; pr[a] += yr0 * xar + yi0 * xai; pi[a] += yi0 * xar - yr0 * xai; // Y * conj(x_a)
            for (b2 = a; b2 < L; b2++) { Ar[a * LM + b2] += xr[b2] * xar + xi[b2] * xai; Ai[a * LM + b2] += xi[b2] * xar - xr[b2] * xai; } // x_b * conj(x_a)
          }
        }
        for (a = 0; a < L; a++) { tr += Ar[a * LM + a]; for (b2 = 0; b2 < a; b2++) { Ar[a * LM + b2] = Ar[b2 * LM + a]; Ai[a * LM + b2] = -Ai[b2 * LM + a]; } }
        var reg = tr / L * 1e-3 + 1e-12; for (a = 0; a < L; a++) Ar[a * LM + a] += reg;
        solve(L);
        for (f = 0; f < B; f++) {
          var fo2 = (f + PADL) * K + k, qr2 = 0, qi2 = 0;
          for (a = 0; a < L1; a++) { xo = fo2 - TD[t0 + a] * K; qr2 += hr[a] * Xr[xo] - hi[a] * Xi[xo]; qi2 += hr[a] * Xi[xo] + hi[a] * Xr[xo]; if (refS) { qr2 += hr[L1 + a] * Sr[xo] - hi[L1 + a] * Si[xo]; qi2 += hr[L1 + a] * Si[xo] + hi[L1 + a] * Sr[xo]; } }
          curR[f * K + k] = qr2; curI[f * K + k] = qi2;
          var e3 = Yr[fo2] - qr2, e4 = Yi[fo2] - qi2, pq2 = qr2 * qr2 + qi2 * qi2;
          ratio[f] = pq2 > 1e-13 ? (e3 * e3 + e4 * e4) / pq2 : 1e9;
        }
        // how much of the estimate is typically left over in this band when nobody sings: a low percentile
        ratio.sort(); var g25 = ratio[Math.floor(B * PCT)]; if (g25 > 1e8) g25 = gam[k]; g25 = Math.max(0.002, Math.min(1, g25));
        gam[k] = gamInit ? 0.5 * gam[k] + 0.5 * g25 : g25;
      }
      gamInit = true;
      for (f = 0; f < A; f++) { // the first half of the block is final: blend with the previous block's estimate
        var m = b + f; if (m >= M) break;
        if (havePrev) { var wc = (f + 0.5) / A, po = f * K, co = f * K; for (k = 0; k < K; k++) { prevR[po + k] = prevR[po + k] * (1 - wc) + curR[co + k] * wc; prevI[po + k] = prevI[po + k] * (1 - wc) + curI[co + k] * wc; } finish(m, (f + PADL) * K, prevR, prevI, po); }
        else finish(m, (f + PADL) * K, curR, curI, f * K);
      }
      prevR.set(curR.subarray(A * K, 2 * A * K)); prevI.set(curI.subarray(A * K, 2 * A * K)); havePrev = true;
      if (onp) onp(Math.min(1, (b + A) / M));
    }
    if (pend) emit(-1, new Float64Array(K), new Float64Array(K));
    var y = new Float32Array(n); for (i = 0; i < n; i++) { var g2 = ws[i + N]; y[i] = g2 > 1e-3 ? out[i + N] / g2 : 0; }
    return { y: y, share: sEst / (sY + 1e-20), linDb: 10 * Math.log10((sY + 1e-20) / (sE + 1e-20)), totDb: 10 * Math.log10((sY + 1e-20) / (sO + 1e-20)) };
  }
  // after a recording: find the playback in it, take it out, report the latency
  function post(mic, ref, sr, onp, refS, keep) {
    var g = delayTrack(mic, ref, sr, 0.9), r = { delay: g.delay, conf: g.conf, ratio: g.ratio, found: g.found, votes: g.votes, ppm: g.ppm, steps: g.steps, bleed: false, y: mic, share: 0, cutDb: 0 }, i;
    if (!g.found || g.delay < -0.01) return r;
    if (refS) { var es = 0, em = 0; for (i = 0; i < ref.length; i += 16) { es += refS[i] * refS[i]; em += ref[i] * ref[i]; } if (es < em * 1e-4) refS = null; } // a mono song has no difference channel
    var n = mic.length, P = Math.round(8 * sr), ra = warpRef(ref, sr, g.segs, 0.004, n), rs = null;
    if (n > 2 * P) { // a quick look at 8 seconds first: with headphones only a trace of the playback leaks in, and the full pass is not needed
      var probe = function (s0, st) { return aec(mic.subarray(s0, s0 + P), ra.subarray(s0, s0 + P), sr, 0, null, null, null, st ? rs.subarray(s0, s0 + P) : null); };
      var sA = Math.floor((n - P) / 2), sB = Math.floor((n - P) / 5), pre = probe(sA, false); r.share = pre.share; if (pre.share < 0.012) return r;
      // one speaker (or two that sound the same at the mic) needs only the mono sum; the second reference is used when it clearly explains more
      if (refS) { rs = warpRef(refS, sr, g.segs, 0.004, n); if (Math.max(probe(sA, true).linDb - pre.linDb, probe(sB, true).linDb - probe(sB, false).linDb) < 0.3) rs = null; }
    } else if (refS) rs = warpRef(refS, sr, g.segs, 0.004, n);
    var a = aec(mic, ra, sr, 0, onp, null, null, rs);
    r.share = a.share; r.cutDb = a.totDb; r.linDb = a.linDb; r.stereo = !!rs;
    if (a.share > 0.02) { r.bleed = true; if (keep) r.yMic = a.y; r.y = g.varies ? retime(a.y, sr, g.segs, g.delay) : a.y; }
    return r;
  }
  // no playback in the take (headphones): how late is the singing against the original singer's melody? (note starts, +-0.4 s)
  function melLag(user, ref, lag0) {
    var un = notes(user, true), rn = notes(ref, true), ro = rn.map(function (r) { return r.s * ref.hop; }), d = [], i, j;
    for (i = 0; i < un.length; i++) {
      if (un[i].e - un[i].s < 10) continue; var t = un[i].s * user.hop + lag0, best = 9, bd = 0;
      for (j = 0; j < rn.length; j++) { var dt = t - ro[j]; if (Math.abs(dt) > 0.4) continue; var pd = un[i].m - rn[j].m; pd -= 12 * Math.round(pd / 12); if (Math.abs(pd) > 1.2) continue; if (Math.abs(dt) < best) { best = Math.abs(dt); bd = dt; } }
      if (best < 9) d.push(bd);
    }
    if (d.length < 8) return { lag: 0, conf: 0, n: d.length };
    d.sort(function (p, q) { return p - q; }); var med = d[d.length >> 1], mad = 0; for (i = 0; i < d.length; i++) mad += Math.abs(d[i] - med); mad /= d.length;
    return { lag: med, conf: d.length / (1 + mad * 40), n: d.length, mad: mad };
  }
  /* ---------- automatic trim: silence before, after and between sung parts, with fades ---------- */
  function gate(x, sr, track, amount) {
    if (!amount) return { y: x, kept: 1 };
    var hop = Math.round(sr * track.hop), nf = Math.ceil(x.length / hop), e = new Float32Array(nf), F = track.f0, f, i, j;
    for (f = 0; f < nf; f++) { var s = 0, a = Math.max(0, f * hop - hop), b = Math.min(x.length, f * hop + hop); for (i = a; i < b; i += 2) s += x[i] * x[i]; e[f] = Math.sqrt(s / Math.max(1, (b - a) / 2)); }
    var srt = Float32Array.from(e).sort(), lvl = srt[Math.floor(nf * 0.9)] || 1e-4, nz = srt[Math.floor(nf * 0.1)] || 0, thr = Math.max(nz * 3.2, lvl * 0.04);
    var v = new Uint8Array(nf), act = new Uint8Array(nf); for (f = 0; f < nf; f++) { v[f] = f < F.length && F[f] > 0 ? 1 : 0; act[f] = v[f] || e[f] > thr ? 1 : 0; }
    // distance to the nearest voiced frame; loud but unvoiced stretches far from any singing (bumps, clicks, rustle) are dropped
    var dist = new Int32Array(nf).fill(1e6), last = -1e6; for (f = 0; f < nf; f++) { if (v[f]) last = f; dist[f] = f - last; } last = 1e6; for (f = nf - 1; f >= 0; f--) { if (v[f]) last = f; dist[f] = Math.min(dist[f], last - f); }
    for (f = 0; f < nf; f++) if (act[f] && !v[f] && dist[f] > 30) act[f] = 0;
    for (f = 0; f < nf;) { if (!act[f]) { f++; continue; } var en = f, vc = 0; while (en < nf && act[en]) { vc += v[en]; en++; } if (vc < 4 && en - f < 60) { var near = false; for (j = Math.max(0, f - 30); j < Math.min(nf, en + 30); j++) if (v[j] && (j < f || j >= en)) near = true; if (!near) for (j = f; j < en; j++) act[j] = 0; } f = en; }
    // before the first sung note and after the last one nothing is kept but a short lead-in and tail (handling noises live there)
    var fv = -1, lv = -1, run = 0; for (f = 0; f < nf; f++) { run = v[f] ? run + 1 : 0; if (run >= 8) { if (fv < 0) fv = f - 7; lv = f; } }
    if (fv >= 0) for (f = 0; f < nf; f++) if (f < fv - 10 || f > lv + 40) act[f] = 0;
    // open 120 ms early, stay 250 ms after, bridge pauses shorter than 0.45 s
    var tg = new Float32Array(nf), firstA = -1, lastA = -1; for (f = 0; f < nf; f++) if (act[f]) { if (firstA < 0) firstA = f; lastA = f; for (j = Math.max(0, f - 12); j <= Math.min(nf - 1, f + 25); j++) tg[j] = 1; }
    if (firstA < 0) return { y: x, kept: 1 };
    for (f = 0; f < nf;) { if (tg[f]) { f++; continue; } var g0 = f; while (f < nf && !tg[f]) f++; if (g0 > 0 && f < nf && f - g0 < 45) for (j = g0; j < f; j++) tg[j] = 1; }
    var floor = Math.pow(10, -amount * 40 / 20), kept = 0; for (f = 0; f < nf; f++) { kept += tg[f]; if (!tg[f]) tg[f] = f < firstA || f > lastA + 25 ? 0 : floor; }
    // fades: 80 ms in, 220 ms out (raised cosine), applied per sample
    var gs = new Float32Array(nf), up = 8, dn = 22;
    for (f = 0; f < nf; f++) {
      var mx = tg[f], c;
      for (j = 1; j <= up && f + j < nf; j++) if (tg[f + j] > tg[f]) { c = tg[f] + (tg[f + j] - tg[f]) * (0.5 + 0.5 * Math.cos(Math.PI * j / (up + 1))); if (c > mx) mx = c; }
      for (j = 1; j <= dn && f - j >= 0; j++) if (tg[f - j] > tg[f]) { c = tg[f] + (tg[f - j] - tg[f]) * (0.5 + 0.5 * Math.cos(Math.PI * j / (dn + 1))); if (c > mx) mx = c; }
      gs[f] = mx;
    }
    var y = new Float32Array(x.length); for (i = 0; i < x.length; i++) { var p = i / hop, fi = Math.min(nf - 1, Math.floor(p)), fj = Math.min(nf - 1, fi + 1), fr = p - fi; y[i] = x[i] * (gs[fi] + (gs[fj] - gs[fi]) * fr); }
    return { y: y, kept: kept / nf };
  }
  /* ---------- the Auto-Tune way of moving pitch: resample, and now and then repeat or drop one cycle ----------
     The voice is read slightly faster or slower (that is the pitch change, exact and clean). Reading faster runs ahead
     of time, so when the lead reaches half a cycle the reader steps back exactly one cycle of the voice, at the lag where
     the two cycles match best, cross-faded over one cycle. Small corrections mean a splice only every few dozen cycles. */
  var SNC = (function () { var TP = 8, PH = 512, t = new Float32Array(TP * (PH + 1)); for (var p = 0; p <= PH; p++) { var fr = p / PH, s = 0, j; for (j = 0; j < TP; j++) { var u = j - 3 - fr, v = Math.abs(u) < 1e-9 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u), wn = 0.5 + 0.5 * Math.cos(Math.PI * u / 4); if (Math.abs(u) >= 4) wn = 0; t[p * TP + j] = v * wn; s += v * wn; } for (j = 0; j < TP; j++) t[p * TP + j] /= s; } return t; })();
  function slip(x, sr, track, cents) {
    var n = x.length, y = new Float32Array(n), hop = track.hop * sr, F = track.f0, nf = F.length, rr = new Float32Array(nf + 2).fill(1), f, any = false;
    for (f = 0; f < nf; f++) if (F[f] && Math.abs(cents[f]) > 0.5) { rr[f] = Math.pow(2, cents[f] / 1200); any = true; }
    if (!any) return new Float32Array(x);
    function rd(pos) { var ip = Math.floor(pos), o = Math.round((pos - ip) * 512) * 8, b = ip - 3; if (b < 0 || b + 8 > n) return ip >= 0 && ip < n ? x[ip] : 0; return x[b] * SNC[o] + x[b + 1] * SNC[o + 1] + x[b + 2] * SNC[o + 2] + x[b + 3] * SNC[o + 3] + x[b + 4] * SNC[o + 4] + x[b + 5] * SNC[o + 5] + x[b + 6] * SNC[o + 6] + x[b + 7] * SNC[o + 7]; }
    var pos = 0, posB = 0, xf = 0, xfLen = 1, wait = 0, splices = 0;
    for (var t = 0; t < n; t++) {
      var fp = pos / hop, f0i = Math.floor(fp); if (f0i < 0) f0i = 0; if (f0i >= nf) f0i = nf - 1; var r = rr[f0i] + (rr[f0i + 1] - rr[f0i]) * (fp - f0i);
      if (xf > 0) {
        var a = 0.5 - 0.5 * Math.cos(Math.PI * (1 - xf / xfLen)); y[t] = (1 - a) * rd(pos) + a * rd(posB); pos += r; posB += r;
        if (--xf === 0) pos = posB; continue;
      }
      y[t] = rd(pos); pos += r;
      var drift = pos - (t + 1); if (wait > 0) { wait--; continue; }
      if (drift > -1 && drift < 1) continue;
      var fc = Math.round(pos / hop); if (fc >= nf) fc = nf - 1; var hz = F[fc];
      if (hz > 0) {
        var P = sr / hz, ad = drift < 0 ? -drift : drift; if (ad < P * 0.5) continue;
        var sg = drift > 0 ? 1 : -1, base = Math.floor(pos), W = Math.round(P), L0 = Math.round(P * 0.88), L1 = Math.round(P * 1.12), bestL = Math.round(P), bc = -2;
        if (base - L1 - 4 < 0 || base + L1 + W + 4 >= n) { continue; }
        var ea = 0, i; for (i = 0; i < W; i++) ea += x[base + i] * x[base + i];
        for (var L = L0; L <= L1; L++) { var o2 = base - sg * L, cr = 0, eb = 0; for (i = 0; i < W; i += 2) { cr += x[base + i] * x[o2 + i]; eb += x[o2 + i] * x[o2 + i]; } var nc = cr / Math.sqrt(ea * eb * 0.5 + 1e-20); if (nc > bc) { bc = nc; bestL = L; } }
        if (bc < 0.5 && ad < P) { wait = Math.round(P * 0.25); continue; } // not a steady cycle here: try again a little later
        posB = pos - sg * bestL; xfLen = Math.max(16, Math.min(W, Math.round(0.012 * sr))); xf = xfLen; splices++;
      } else if (fc > 0 && fc + 2 < nf && !F[fc - 1] && !F[fc + 1] && !F[fc + 2]) { // between sung sounds: step back onto the exact time
        posB = t + 1; xfLen = Math.round(0.004 * sr); xf = xfLen;
      }
    }
    return y;
  }
  /* the whole offline voice chain for a take */
  function voice(x, sr, o, onp) {
    var y = highpass(removeDC(x), 75, sr), st = null, tr = o.track || null, cz = null;
    if (o.nr) y = denoise(y, sr, o.nr); if (onp) onp(0.25);
    if (o.tune && o.ref) { var r = tune(y, sr, o.ref, o.tune, onp && function (p) { onp(0.25 + p * 0.55); }, tr); y = r.y; st = r.stats; tr = r.track; cz = r.cents; if (st) st.neural = !!(o.track && o.track.neural); }
    if ((o.gate || o.harm) && !tr) tr = f0(y, sr);
    if (o.gate) { var g = gate(y, sr, tr, o.gate); y = g.y; if (st) st.kept = g.kept; else st = { kept: g.kept }; }
    if (onp) onp(0.9);
    if (o.deess) y = deess(y, sr, o.deess);
    var yh = null; if (o.harm && tr) yh = harmony(y, sr, tr, cz, { dir: o.harm.dir, semi: o.harm.semi, lag: o.harm.lag, keys: o.harm.keys });
    if (onp) onp(1);
    return { y: y, yh: yh, stats: st };
  }
  /* ---------- neural pitch track: FCPE (MIT, CNChTu) in onnxruntime-web; YIN stays as the fallback ---------- */
  var ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/", NN = { p: null };
  var FCC = (function () { var c = new Float64Array(360), a = 1200 * Math.log2(3.27), b = 1200 * Math.log2(197.55); for (var i = 0; i < 360; i++) c[i] = a + (b - a) * i / 359; return c; })();
  function nnLoad(note) {
    if (NN.p) return NN.p;
    NN.p = new Promise(function (res, rej) {
      if (typeof importScripts !== "function") return rej(new Error("no worker"));
      try { if (typeof ort === "undefined") importScripts(ORT + "ort.wasm.min.js"); } catch (e) { return rej(e); }
      ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = ORT;
      if (note) note();
      ort.InferenceSession.create(new URL("models/fcpe.onnx", self.location.href).href, { executionProviders: ["wasm"] }).then(res, rej);
    });
    NN.p.catch(function () { NN.p = null; });
    return NN.p;
  }
  function nf0(x, sr, onp, note) {
    var r = sr / 16000, n16 = Math.floor(x.length / r), y = resample(x, r, n16);
    return nnLoad(note).then(function (sess) {
      var CH = 16000 * 30, OV = 16000, total = Math.floor(n16 / 160) + 1, f = new Float32Array(total), starts = [], i;
      for (var s0 = 0; s0 < n16; s0 += CH) starts.push(s0);
      var chain = Promise.resolve();
      starts.forEach(function (s0, ci) {
        chain = chain.then(function () {
          var a = Math.max(0, s0 - OV), b = Math.min(n16, s0 + CH + OV), seg = y.slice(a, b);
          var feeds = {}; feeds[sess.inputNames[0]] = new ort.Tensor("float32", seg, [1, seg.length]);
          return sess.run(feeds).then(function (out) {
            var sal = out[sess.outputNames[0]].data, T = out[sess.outputNames[0]].dims[1], f0a = Math.floor(a / 160);
            var keepFrom = Math.floor(s0 / 160), keepTo = Math.min(total, Math.floor((s0 + CH) / 160));
            for (var k = 0; k < T; k++) {
              var g = f0a + k; if (g < keepFrom || g >= keepTo) continue;
              var o = k * 360, best = 0, bv = -1; for (i = 0; i < 360; i++) if (sal[o + i] > bv) { bv = sal[o + i]; best = i; }
              if (bv <= 0.25) { f[g] = 0; continue; }
              var ws = 0, cs = 0; for (i = Math.max(0, best - 4); i <= Math.min(359, best + 4); i++) { ws += sal[o + i]; cs += sal[o + i] * FCC[i]; }
              f[g] = 10 * Math.pow(2, cs / ws / 1200);
            }
            if (onp) onp((ci + 1) / starts.length);
          });
        });
      });
      return chain.then(function () {
        // FCPE frames sit at i*10 ms + 5 ms: move them onto the 10 ms grid
        var gr = new Float32Array(total); for (i = 0; i < total; i++) gr[i] = i && f[i] && f[i - 1] ? Math.sqrt(f[i] * f[i - 1]) : f[i];
        return { f0: clean(gr), hop: 0.01, neural: true };
      });
    });
  }
  return { gccDelay: gccDelay, delayTrack: delayTrack, dAt: dAt, warpRef: warpRef, retime: retime, aec: aec, post: post, melLag: melLag, gate: gate, slip: slip, shift: shift, stretch: stretch, resample: resample, f0: f0, nf0: nf0, keymap: keymap, keyScale: keyScale, clean: clean, notes: notes, plan: plan, psola: psola, tune: tune, harmony: harmony, denoise: denoise, voice: voice, deess: deess, coef: coef, filt: filt, filtfilt: filtfilt, highpass: highpass, removeDC: removeDC, follower: follower, fft: fft, tables: tables, midi: midi };
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
      } else if (m.op === "nf0") {
        KSDSP.nf0(m.x, m.sr, prog, function () { self.postMessage({ id: m.id, progress: 0, note: "model" }); })
          .then(function (t) { self.postMessage({ id: m.id, ok: true, f0: t.f0, hop: t.hop, neural: true }); })
          .catch(function () { var t = KSDSP.f0(m.x, m.sr, prog); self.postMessage({ id: m.id, ok: true, f0: t.f0, hop: t.hop, neural: false }); });
      } else if (m.op === "keymap") {
        var km = KSDSP.keymap({ f0: m.ref, hop: m.refHop }, m.inst, m.sr); self.postMessage({ id: m.id, ok: true, k: km.k, hop: km.hop });
      } else if (m.op === "post") {
        // right after a recording: latency + playback removal, then the take's pitch map (and, with headphones, timing against the melody)
        var pr = KSDSP.post(m.mic, m.ref, m.sr, function (p) { prog(p * 0.7); }, m.refS || null);
        var done = function (t, neural) {
          var mel = null; if (!pr.bleed && m.refTrack) { mel = KSDSP.melLag(t, { f0: m.refTrack, hop: m.refHop }, m.p0 - m.lat0); if (mel.conf > 15 && Math.abs(mel.lag) > 0.1) { var m2 = KSDSP.melLag(t, { f0: m.refTrack, hop: m.refHop }, m.p0 - m.lat0 + mel.lag); if (m2.conf > 15) mel = { lag: mel.lag + m2.lag, conf: m2.conf, n: m2.n }; } }
          var y = pr.y === m.mic ? new Float32Array(m.mic) : pr.y;
          self.postMessage({ id: m.id, ok: true, y: y, delay: pr.delay, conf: pr.conf, ratio: pr.ratio, bleed: pr.bleed, found: !!pr.found, votes: pr.votes || 0, ppm: pr.ppm || 0, steps: pr.steps || 0, stereo: !!pr.stereo, share: pr.share, cutDb: pr.cutDb, f0: t.f0, hop: t.hop, neural: neural, mel: mel }, [y.buffer]);
        };
        KSDSP.nf0(pr.y, m.sr, function (p) { prog(0.7 + p * 0.3); }, function () { self.postMessage({ id: m.id, progress: 0.7, note: "model" }); })
          .then(function (t) { done(t, true); }, function () { done(KSDSP.f0(pr.y, m.sr), false); });
      } else if (m.op === "voice") {
        var vo = { nr: m.nr, deess: m.deess, gate: m.gate, tune: m.tune, harm: m.harm || null, ref: m.ref ? { f0: m.ref, hop: m.refHop } : null };
        var finish = function (track) { try { var v = KSDSP.voice(m.x, m.sr, Object.assign(vo, { track: track }), prog); self.postMessage({ id: m.id, ok: true, y: v.y, yh: v.yh, stats: v.stats }, v.yh ? [v.y.buffer, v.yh.buffer] : [v.y.buffer]); } catch (err) { self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) }); } };
        if (m.track) finish({ f0: m.track, hop: 0.01, neural: !!m.trackNeural });
        else if ((m.tune || m.gate || m.harm) && m.neural) KSDSP.nf0(m.x, m.sr, function (p) { prog(p * 0.2); }, function () { self.postMessage({ id: m.id, progress: 0, note: "model" }); }).then(finish, function () { finish(null); });
        else finish(null);
      } else if (m.op === "deess") {
        var d = KSDSP.deess(m.x, m.sr, m.amount); self.postMessage({ id: m.id, ok: true, y: d }, [d.buffer]);
      } else self.postMessage({ id: m.id, ok: false, error: "unknown op" });
    } catch (err) { self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) }); }
  };
}
