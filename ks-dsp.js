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

  /* ---------- pitch track (YIN, 10 ms hop) ---------- */
  function f0(x, sr, onp) {
    var D = Math.max(1, Math.round(sr / 12000)), fs = sr / D, i;
    var lp = D > 1 ? filtfilt(filtfilt(x, coef("lp", fs * 0.42, 0.7071, 0, sr)), coef("lp", fs * 0.42, 0.7071, 0, sr)) : x;
    var n = Math.floor(lp.length / D), y = new Float32Array(n); for (i = 0; i < n; i++) y[i] = lp[i * D];
    var hop = Math.round(fs * 0.01), tmin = Math.floor(fs / 950), tmax = Math.ceil(fs / 70), W = 2 * tmax;
    var frames = Math.max(0, Math.floor((n - W - tmax) / hop) + 1), out = new Float32Array(frames), conf = new Float32Array(frames), lev = new Float32Array(frames);
    var d = new Float64Array(tmax + 1), cm = new Float64Array(tmax + 1);
    // level gate: frames much quieter than the voice are unvoiced
    var gpk = 0; for (var f = 0; f < frames; f++) { var s0 = f * hop, e = 0; for (i = 0; i < W; i += 2) e += y[s0 + i] * y[s0 + i]; lev[f] = Math.sqrt(e / (W / 2)); if (lev[f] > gpk) gpk = lev[f]; }
    var gate = Math.max(gpk * 0.04, 1e-4);
    for (f = 0; f < frames; f++) {
      if (lev[f] < gate) continue;
      var s = f * hop, tau;
      for (tau = 1; tau <= tmax; tau++) { var acc = 0; for (i = 0; i < W; i++) { var v = y[s + i] - y[s + i + tau]; acc += v * v; } d[tau] = acc; }
      var run = 0; cm[0] = 1;
      for (tau = 1; tau <= tmax; tau++) { run += d[tau]; cm[tau] = run > 0 ? d[tau] * tau / run : 1; }
      var best = -1;
      for (tau = tmin; tau < tmax; tau++) if (cm[tau] < 0.15) { while (tau + 1 < tmax && cm[tau + 1] < cm[tau]) tau++; best = tau; break; }
      if (best < 0) { var mn = 1e9; for (tau = tmin; tau < tmax; tau++) if (cm[tau] < mn) { mn = cm[tau]; best = tau; } if (mn > 0.3) continue; }
      var a = cm[best - 1], b = cm[best], c2 = cm[best + 1], den = a - 2 * b + c2, sh = den ? 0.5 * (a - c2) / den : 0;
      out[f] = fs / (best + Math.max(-1, Math.min(1, sh))); conf[f] = 1 - b;
      if (onp && (f & 1023) === 0) onp(f / frames);
    }
    // drop single-frame octave blips and isolated voiced frames
    for (f = 1; f < frames - 1; f++) {
      if (out[f] && !out[f - 1] && !out[f + 1]) out[f] = 0;
      else if (out[f] && out[f - 1] && out[f + 1]) { var m1 = 12 * Math.log2(out[f] / out[f - 1]), m2 = 12 * Math.log2(out[f] / out[f + 1]); if (Math.abs(m1) > 9 && Math.abs(m2) > 9) out[f] = (out[f - 1] + out[f + 1]) / 2; }
    }
    return { f0: out, conf: conf, hop: 0.01, off: tmax / fs * 0 + W / 2 / fs };
  }
  var midi = function (hz) { return 69 + 12 * Math.log2(hz / 440); };

  /* ---------- pitch correction plan ----------
     user: f0 track of the take (Hz); ref: f0 track of the original vocal (Hz), shifted by `semi`.
     lag: seconds the take starts after the reference track starts (song position of the take's first sample).
     Every voiced frame is pulled toward the nearest note the original sings around that moment (+-0.25 s,
     any octave); where the original is silent, toward the song's own scale. Returns cents per frame. */
  function plan(user, ref, opts) {
    var semi = opts.semi || 0, lag = opts.lag || 0, strength = Math.max(0, Math.min(1, opts.strength == null ? 0.7 : opts.strength));
    var speed = opts.speed || 0.06, hop = user.hop, n = user.f0.length, rn = ref.f0.length, f, j;
    var rm = new Float32Array(rn); for (j = 0; j < rn; j++) rm[j] = ref.f0[j] > 0 ? midi(ref.f0[j]) + semi : 0;
    // scale: the 7 strongest pitch classes of the original
    var pc = new Float64Array(12); for (j = 0; j < rn; j++) if (rm[j]) pc[((Math.round(rm[j]) % 12) + 12) % 12] += 1;
    var order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].sort(function (a, b) { return pc[b] - pc[a]; }), scale = order.slice(0, 7);
    var win = Math.round(0.25 / ref.hop), want = new Float32Array(n);
    for (f = 0; f < n; f++) {
      if (!user.f0[f]) continue;
      var u = midi(user.f0[f]), rc = Math.round((f * hop + lag) / ref.hop), bestD = 99, tgt = null;
      for (j = Math.max(0, rc - win); j <= Math.min(rn - 1, rc + win); j++) {
        if (!rm[j]) continue;
        var note = Math.round(rm[j]), c = note + 12 * Math.round((u - note) / 12), dd = Math.abs(u - c);
        // nearer frames win ties
        dd += Math.abs(j - rc) / win * 0.15;
        if (dd < bestD) { bestD = dd; tgt = c; }
      }
      if (tgt == null) { var base = Math.round(u); bestD = 99; for (var o = -2; o <= 2; o++) { var cand = base + o, p = ((cand % 12) + 12) % 12; if (scale.indexOf(p) >= 0 && Math.abs(u - cand) < bestD) { bestD = Math.abs(u - cand); tgt = cand; } } }
      if (tgt == null) continue;
      var dev = tgt - u, ad = Math.abs(dev);
      // far off = probably another note on purpose (or a detection error): leave it
      var k = ad <= 1 ? 1 : ad >= 2 ? 0 : 2 - ad;
      want[f] = dev * 100 * strength * k;
    }
    // retune speed: smooth the correction, let it fall back to 0 in unvoiced parts
    var a = Math.exp(-hop / speed), cents = new Float32Array(n), cur = 0;
    for (f = 0; f < n; f++) { var t = user.f0[f] ? want[f] : 0; cur = a * cur + (1 - a) * t; cents[f] = user.f0[f] ? cur : 0; if (!user.f0[f]) cur *= 0.5; }
    return cents;
  }

  /* ---------- TD-PSOLA: shift the pitch of x by cents[f] (10 ms frames), voiced frames only ---------- */
  function psola(x, sr, track, cents) {
    var n = x.length, hop = track.hop, F = track.f0, nf = F.length;
    var f0At = function (s) { var f = Math.min(nf - 1, Math.max(0, Math.round(s / sr / hop))); return F[f]; };
    var cAt = function (s) { var f = Math.min(nf - 1, Math.max(0, Math.round(s / sr / hop))); return cents[f] || 0; };
    // analysis marks: one per period in voiced parts (near the waveform peak), every 5 ms elsewhere
    var lp = filt(x, coef("lp", 900, 0.7071, 0, sr)), marks = [], per = [], pos = 0, prevV = false, uv = Math.round(sr * 0.005);
    while (pos < n) {
      var hz = f0At(pos), P = hz ? Math.round(sr / hz) : uv;
      if (hz) {
        var c = pos, r = Math.round(P * (prevV ? 0.15 : 0.5)), best = c, bv = -1e9;
        for (var s = Math.max(0, c - r); s <= Math.min(n - 1, c + r); s++) if (lp[s] > bv) { bv = lp[s]; best = s; }
        if (marks.length && best <= marks[marks.length - 1] + P * 0.5) best = marks[marks.length - 1] + P;
        pos = best;
      }
      if (pos >= n) break;
      marks.push(pos); per.push(P); prevV = !!hz; pos += P;
    }
    var y = new Float32Array(n), ws = new Float32Array(n), ts = marks.length ? marks[0] : 0, mi = 0;
    while (ts < n && marks.length) {
      while (mi < marks.length - 1 && Math.abs(marks[mi + 1] - ts) < Math.abs(marks[mi] - ts)) mi++;
      var m = marks[mi], Pa = per[mi], ratio = f0At(m) ? Math.pow(2, cAt(m) / 1200) : 1, L = Pa;
      for (var i = -L; i < L; i++) {
        var src = m + i, dst = ts + i; if (src < 0 || src >= n || dst < 0 || dst >= n) continue;
        var w = 0.5 + 0.5 * Math.cos(Math.PI * i / L);
        y[dst] += x[src] * w; ws[dst] += w;
      }
      ts += Math.max(8, Math.round(Pa / ratio));
    }
    for (var k = 0; k < n; k++) y[k] = ws[k] > 0.05 ? y[k] / ws[k] : y[k];
    return y;
  }
  function tune(x, sr, ref, opts, onp) {
    var tr = f0(x, sr, onp && function (p) { onp(p * 0.6); });
    var cents = plan(tr, ref, opts);
    if (onp) onp(0.7);
    var y = psola(x, sr, tr, cents);
    if (onp) onp(1);
    var tot = 0, cnt = 0; for (var f = 0; f < cents.length; f++) if (tr.f0[f]) { tot += Math.abs(cents[f]); cnt++; }
    return { y: y, avgCents: cnt ? tot / cnt : 0, voiced: cnt };
  }
  return { shift: shift, stretch: stretch, resample: resample, f0: f0, plan: plan, psola: psola, tune: tune, deess: deess, coef: coef, filt: filt, filtfilt: filtfilt, highpass: highpass, removeDC: removeDC, follower: follower, fft: fft, tables: tables, midi: midi };
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
        self.postMessage({ id: m.id, ok: true, y: r.y, avgCents: r.avgCents, voiced: r.voiced }, [r.y.buffer]);
      } else if (m.op === "deess") {
        var d = KSDSP.deess(m.x, m.sr, m.amount); self.postMessage({ id: m.id, ok: true, y: d }, [d.buffer]);
      } else self.postMessage({ id: m.id, ok: false, error: "unknown op" });
    } catch (err) { self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) }); }
  };
}
