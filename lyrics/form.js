/* שאלון כתיבת מילים – אולפני קולות
 * נטען בעמוד category/טופס-כתיבת-מילים-מקוריות (טופס Exite מספר 4) ומחליף את התצוגה שלו בשאלון בשלבים.
 * השליחה: קודם לטופס Exite (המייל הרגיל לאולפן + שאלת האבטחה של Exite), ואחר כך לשרת (Apps Script, app:'lyrics')
 * שבודק בקאלה אם כתיבת המילים כלולה/שולמה ומנתב: לליאור / לינק לתשלום / בקשה לבחור מנגינה.
 * #s=<id> בכתובת: מסך קצר לבחירת מנגינה (מהלינק שנשלח בוואטסאפ).
 */
(function () {
  'use strict';
  var API = 'https://script.google.com/macros/s/AKfycbwkXeC3Cvm8KT_5Iuq5HBheWdq5OoUCZgr33CIT1aNUqhTKsnWo-sh0iqDOL8U4Cs03/exec';
  var WA = 'https://wa.me/972555170280?text=';
  var KEY = 'kLyrDraft2';

  var F = document.getElementById('contact_form');
  if (!F) return;
  var fid = F.querySelector('input[name=formID]');
  if (!fid || fid.value != '4') return;
  if (window.__klq) return; window.__klq = 1;

  /* ------------------------------ styles ------------------------------ */
  var css = '' +
    '#contact_layer,#lw-wrap,#lw-done{display:none!important}' +
    '#klq{--p:#2b1450;--p2:#5a2d91;--g:#f2b635;--bg:#faf8fd;--ln:#e6def2;--mu:#756d8a;--er:#c93434;--ok:#1f8a4c;' +
    'max-width:720px;margin:0 auto 40px;direction:rtl;text-align:right;font-family:almoni-dl-aaa-400,"Assistant",Arial,sans-serif;color:#2a2438;box-sizing:border-box}' +
    '#klq *{box-sizing:border-box}' +
    '#klq .k-card{background:#fff;border:1px solid var(--ln);border-radius:22px;padding:22px 20px;box-shadow:0 10px 30px rgba(43,20,80,.07)}' +
    '#klq .k-how{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:0 0 14px}' +
    '#klq .k-how div{background:#fff;border:1px solid var(--ln);border-radius:16px;padding:12px 10px;text-align:center;font-size:14px;line-height:1.35;color:var(--mu)}' +
    '#klq .k-how b{display:block;color:var(--p);font-size:15.5px;margin:4px 0 2px}#klq .k-how i{font-style:normal;font-size:22px}' +
    '#klq .k-head{display:flex;justify-content:space-between;align-items:flex-end;gap:10px;margin-bottom:6px}' +
    '#klq .k-step{font-size:13.5px;color:var(--mu)}#klq h2.k-ttl{font-size:23px;line-height:1.25;font-weight:800;color:var(--p);margin:2px 0 0!important;padding:0!important}' +
    '#klq .k-sub{font-size:15px;color:var(--mu);margin:4px 0 14px}' +
    '#klq .k-bar{display:flex;gap:5px;margin:10px 0 18px}#klq .k-bar span{flex:1;height:6px;border-radius:9px;background:#ece6f5}#klq .k-bar span.on{background:var(--p2)}#klq .k-bar span.dn{background:var(--g)}' +
    '#klq .k-f{margin:0 0 18px}#klq .k-f>label{display:block;font-weight:800;font-size:17px;color:var(--p);margin-bottom:6px;line-height:1.35}' +
    '#klq .k-f>label small{font-weight:400;color:var(--mu);font-size:13.5px;margin-right:6px}' +
    '#klq .k-f .k-hint{font-size:13.5px;color:var(--mu);margin:-2px 0 8px;line-height:1.4}' +
    '#klq input[type=text],#klq input[type=tel],#klq input[type=email],#klq input[type=date],#klq textarea{width:100%;background:var(--bg);border:1.5px solid var(--ln);border-radius:14px;padding:12px 14px;font:16px/1.45 inherit;color:#2a2438;outline:none;-webkit-appearance:none;margin:0}' +
    '#klq textarea{min-height:96px;resize:vertical}#klq input:focus,#klq textarea:focus{border-color:var(--p2);background:#fff}' +
    '#klq .k-bad input,#klq .k-bad textarea{border-color:var(--er)!important;background:#fff6f6!important}#klq .k-err{color:var(--er);font-size:13.5px;font-weight:700;margin-top:6px;display:none}#klq .k-bad .k-err{display:block}' +
    '#klq .k-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
    '#klq .k-chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 10px}' +
    '#klq .k-chips button{border:1.5px solid var(--ln);background:#fff;color:var(--p);border-radius:999px;padding:9px 15px;font:700 14.5px/1 inherit;cursor:pointer;min-height:40px}' +
    '#klq .k-chips button.on{background:var(--p);border-color:var(--p);color:#fff}' +
    '#klq .k-chk{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:15px;cursor:pointer;color:var(--p)}#klq .k-chk input{width:20px;height:20px;accent-color:var(--p2)}' +
    '#klq .k-note{background:#fff8e6;border:1px solid #f3dfa6;border-radius:14px;padding:11px 13px;font-size:14.5px;line-height:1.45;color:#5c4a14;margin:4px 0 14px}' +
    '#klq .k-nav{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-top:6px}' +
    '#klq .k-btn{border:0;border-radius:999px;padding:15px 28px;font:800 17px/1 inherit;cursor:pointer;background:var(--g);color:var(--p);min-height:52px;text-decoration:none!important;display:inline-flex;align-items:center;justify-content:center;gap:8px}' +
    '#klq .k-btn[disabled]{opacity:.6;cursor:wait}#klq .k-btn.k-pri{background:var(--p);color:#fff}' +
    '#klq .k-back{background:none;border:0;color:var(--p2);text-decoration:underline;font:700 15.5px inherit;cursor:pointer;padding:10px 4px}' +
    '#klq .k-save{font-size:12.5px;color:#9a93ad;margin-top:12px;text-align:center}' +
    '#klq .k-msg{color:var(--er);font-weight:700;font-size:14.5px;min-height:20px;margin:0 0 8px}' +
    '#klq .k-rev{border:1px solid var(--ln);border-radius:16px;margin:0 0 12px;overflow:hidden}' +
    '#klq .k-rev h4{margin:0!important;padding:10px 14px!important;background:var(--bg);font-size:15.5px;color:var(--p);display:flex;justify-content:space-between;align-items:center}' +
    '#klq .k-rev h4 button{background:none;border:0;color:var(--p2);text-decoration:underline;font:700 14px inherit;cursor:pointer}' +
    '#klq .k-rev dl{margin:0;padding:6px 14px 10px}#klq .k-rev dt{font-size:13px;color:var(--mu);margin-top:8px}#klq .k-rev dd{margin:2px 0 0;font-size:15px;white-space:pre-wrap;word-break:break-word}' +
    '#klq .k-done{text-align:center;background:linear-gradient(135deg,#2b1450,#4a2280);color:#fff;border-radius:22px;padding:30px 22px}' +
    '#klq .k-done h2{color:#fff!important;font-size:25px;margin:6px 0 10px!important;line-height:1.3}#klq .k-done p{color:#fff!important;font-size:16px;line-height:1.55;margin:0 0 12px!important;opacity:.95}' +
    '#klq .k-done .k-ico{font-size:42px}#klq .k-done .k-small{font-size:14px;opacity:.8}' +
    '#klq .k-done .k-box{background:#fff;color:#2a2438;border-radius:16px;padding:16px;text-align:right;margin:14px 0 4px}#klq .k-done .k-box label{color:var(--p);font-weight:800}' +
    '#klq .k-wa{background:#25D366!important;color:#fff!important}' +
    '#klq .k-hp{position:absolute!important;left:-5000px!important;width:1px;height:1px;overflow:hidden}' +
    '@media (max-width:600px){#klq{padding:0 12px;margin-bottom:110px}#klq .k-card{padding:18px 15px;border-radius:18px}#klq h2.k-ttl{font-size:21px}#klq .k-row{grid-template-columns:1fr}' +
    '#klq .k-how{grid-template-columns:1fr;gap:6px}#klq .k-how div{display:flex;gap:10px;align-items:center;text-align:right;padding:9px 12px}#klq .k-how b{display:inline;margin:0}' +
    '#klq .k-nav .k-btn{flex:1}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  /* ------------------------------ helpers ------------------------------ */
  function h(t, a, c) { var e = document.createElement(t); if (a) for (var k in a) { if (k === 'text') e.textContent = a[k]; else if (k === 'html') e.innerHTML = a[k]; else e.setAttribute(k, a[k]); } (c || []).forEach(function (x) { if (x) e.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); }); return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function d9(x) { return String(x || '').replace(/\D/g, '').slice(-9); }
  function post(body) {
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); });
  }
  function top(el) { try { var y = (el || root).getBoundingClientRect().top + window.pageYOffset - 110; window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' }); } catch (e) { } }   // 110 = מתחת לכותרת הקבועה של האתר
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { } }

  var L = document.getElementById('contact_layer');
  var root = h('div', { id: 'klq' });
  (L && L.parentNode ? L.parentNode : F.parentNode).insertBefore(root, L || F);

  /* ------------------------- melody-only mode (#s=) ------------------------- */
  var sm = (location.hash || '').match(/[#&]s=([A-Za-z0-9]{8,40})/);
  if (sm) { songMode(sm[1]); return; }

  /* ------------------------------ the form ------------------------------ */
  var S = load(); S.v = S.v || {}; if (!S.t0) S.t0 = Date.now();
  var V = S.v;
  var OCC = ['בת מצווה', 'בר מצווה', 'חתונה', 'יום הולדת', 'יום נישואין', 'אחר'];
  var TRAITS = ['מצחיק/ה', 'טוב/ת לב', 'חכם/ה', 'חברותי/ת', 'ספורטיבי/ת', 'יצירתי/ת', 'רקדן/ית', 'אוהב/ת לעזור', 'שקט/ה ורגיש/ה', 'מלא/ת אנרגיה'];
  var SINGS = ['החוגג/ת שר/ה בעצמו/ה', 'המשפחה שרה לחוגג/ת', 'החוגג/ת והמשפחה יחד', 'זמר/ת מהאולפן'];
  var TONES = ['מרגש', 'מצחיק', 'קצבי', 'קליל', 'אישי', 'משולב'];
  var wed = function () { return V.occ === 'חתונה'; };

  // field: [key, label, opts]
  var STEPS = [
    { t: 'קודם כל – מי ממלא את השאלון?', d: 'כדי שנוכל לשלוח לכם את המילים והגייד', f: [
      ['contact', 'השם שלכם', { req: 1, ph: 'למשל: מיכל לוי' }],
      ['phone', 'טלפון נייד', { req: 1, type: 'tel', ph: '050-0000000', hint: 'אותו מספר שמופיע בהזמנה שלכם, אם כבר הזמנתם' }],
      ['email', 'אימייל', { req: 1, type: 'email', ph: 'name@example.com', hint: 'לכאן יישלחו המילים והגייד' }]
    ] },
    { t: 'על מי השיר?', d: 'נתחיל מהבסיס', f: [
      ['occ', 'מה חוגגים?', { req: 1, chips: OCC, single: 1 }],
      ['honoree', function () { return wed() ? 'שמות החתן והכלה' : 'שם החוגג/ת'; }, { req: 1, ph: function () { return wed() ? 'למשל: דנה ויואב' : 'למשל: נועה כהן'; } }],
      ['nick', 'שם חיבה', { ph: 'למשל: נוני', opt: 1 }],
      ['age', 'גיל', { req: 1, ph: 'למשל: 12', when: function () { return !wed(); }, small: 1 }],
      ['date', 'מתי האירוע?', { type: 'date', opt: 1 }],
      ['place', 'איפה?', { ph: 'למשל: אולם גני הדר, ראשון לציון', opt: 1 }]
    ] },
    { t: function () { return wed() ? 'ספרו לנו עליהם' : 'ספרו לנו עליו/ה'; }, d: 'ככל שתפרטו יותר – השיר יהיה אישי יותר', f: [
      ['traits', function () { return wed() ? 'איך הייתם מתארים אותם? אופי, מראה, מה מיוחד בהם' : 'איך הייתם מתארים אותו/ה? אופי, מראה, מה מיוחד'; }, { req: 1, area: 1, chipsAdd: TRAITS, ph: 'אפשר לבחור למעלה ולהוסיף במילים שלכם' }],
      ['hobbies', 'תחביבים ודברים שהוא/היא הכי אוהב/ת לעשות', { area: 1, ph: 'למשל: ריקוד, כדורגל, טיקטוק, בישול עם סבתא' }],
      ['happy', 'מה עושה לו/ה שמח?', { area: 1, ph: 'למשל: חופשות עם המשפחה, הכלב שלנו, שוקולד', opt: 1 }],
      ['clubs', 'חוגים, מסגרות או תנועות נוער', { area: 1, ph: 'למשל: חוג דרמה, הצופים, נבחרת כדורסל', opt: 1 }]
    ] },
    { t: 'אנשים ורגעים', d: 'אלה בדרך כלל השורות שכולם מתרגשים מהן', f: [
      ['people', 'מי האנשים החשובים בחייו/ה, ומה מיוחד בקשר איתם?', { req: 1, area: 1, ph: 'למשל: אמא ואבא, האחים יואב ומאיה, סבתא רחל שמפנקת, החברה הכי טובה שירה' }],
      ['story', 'סיפור, רגע או זיכרון מצחיק / מרגש שתרצו בשיר', { area: 1, ph: 'למשל: הפעם שהלכנו לאיבוד בטיול בצפון וכולם צחקו', opt: 1 }]
    ] },
    { t: 'השיר', d: 'על איזו מנגינה נכתוב, ובאיזה אופי', f: [
      ['song', 'על איזה שיר מוכר לכתוב את המילים?', { req: 1, ph: 'שם השיר', song: 1, hint: 'כותבים מילים חדשות על המנגינה של שיר קיים. כדאי לוודא איתנו שיש לו פלייבק במאגר.' }],
      ['artist', 'מי שר את השיר המקורי?', { ph: 'למשל: נועה קירל', opt: 1, songDep: 1 }],
      ['sings', 'מי ישיר את השיר?', { req: 1, chips: SINGS, single: 1 }],
      ['tone', 'מה השיר צריך לשדר?', { chips: TONES, opt: 1, multi: 1 }],
      ['notes', 'עוד משהו שחשוב לכם?', { area: 1, opt: 1, ph: 'מילים שחייבות להופיע, דברים שעדיף לא להזכיר, בדיחות פנימיות…' }]
    ] },
    { t: 'סיכום ושליחה', d: 'בדקו שהכול נכון, ושלחו', review: 1, f: [] }
  ];
  var cur = Math.min(S.step || 0, STEPS.length - 1);
  var fv = function (x) { return typeof x === 'function' ? x() : x; };

  function intro() {
    return h('div', { 'class': 'k-how' }, [
      h('div', { html: '<i>📝</i><b>ממלאים</b>כ-5 דקות, בשלבים קצרים' }),
      h('div', { html: '<i>✍️</i><b>אנחנו כותבים</b>מילים אישיות על המנגינה שבחרתם' }),
      h('div', { html: '<i>🎧</i><b>מקבלים</b>מילים + גייד מוקלט לתרגול' })
    ]);
  }

  function field(def) {
    var key = def[0], o = def[2] || {};
    if (o.when && !o.when()) return null;
    var lab = fv(def[1]);
    var w = h('div', { 'class': 'k-f', 'data-k': key });
    var l = h('label', { 'for': 'klq-' + key }, [lab]); if (o.opt) l.appendChild(h('small', { text: '(לא חובה)' }));
    w.appendChild(l);
    if (o.hint) w.appendChild(h('div', { 'class': 'k-hint', text: o.hint }));
    if (o.chips) {
      var box = h('div', { 'class': 'k-chips', role: o.single ? 'radiogroup' : 'group' });
      var sel = o.multi ? String(V[key] || '').split(/,\s*/).filter(Boolean) : [V[key]];
      o.chips.forEach(function (c) {
        var b = h('button', { type: 'button', 'aria-pressed': sel.indexOf(c) >= 0 ? 'true' : 'false', 'class': sel.indexOf(c) >= 0 ? 'on' : '' }, [c]);
        b.onclick = function () {
          if (o.single) { V[key] = c; }
          else { var a = String(V[key] || '').split(/,\s*/).filter(Boolean); var i = a.indexOf(c); if (i >= 0) a.splice(i, 1); else a.push(c); V[key] = a.join(', '); }
          save(); if (key === 'occ') render(); else { [].forEach.call(box.children, function (x) { var on = o.single ? x.textContent === V[key] : String(V[key] || '').split(/,\s*/).indexOf(x.textContent) >= 0; x.className = on ? 'on' : ''; x.setAttribute('aria-pressed', on); }); w.classList.remove('k-bad'); }
        };
        box.appendChild(b);
      });
      w.appendChild(box);
    }
    if (!o.chips) {
      var inp;
      if (o.area) inp = h('textarea', { id: 'klq-' + key, rows: 4 });
      else inp = h('input', { id: 'klq-' + key, type: o.type || 'text' });
      if (o.type === 'tel') { inp.setAttribute('inputmode', 'tel'); inp.setAttribute('autocomplete', 'tel'); inp.setAttribute('dir', 'ltr'); inp.style.textAlign = 'right'; }
      if (o.type === 'email') { inp.setAttribute('autocomplete', 'email'); inp.setAttribute('dir', 'ltr'); inp.style.textAlign = 'right'; }
      if (key === 'contact') inp.setAttribute('autocomplete', 'name');
      if (o.ph) inp.setAttribute('placeholder', fv(o.ph));
      inp.value = V[key] || '';
      inp.oninput = function () { V[key] = inp.value; save(); w.classList.remove('k-bad'); };
      if (o.chipsAdd) {
        var cb = h('div', { 'class': 'k-chips' });
        o.chipsAdd.forEach(function (c) {
          var b = h('button', { type: 'button', 'class': (V[key] || '').indexOf(c) >= 0 ? 'on' : '' }, [c]);
          b.onclick = function () {
            var v = inp.value; if (v.indexOf(c) >= 0) { v = v.replace(new RegExp('(,\\s*)?' + c.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')), '').replace(/^,\s*/, ''); b.className = ''; }
            else { v = v.trim() ? v.replace(/[,\s]+$/, '') + ', ' + c : c; b.className = 'on'; }
            inp.value = v; V[key] = v; save(); w.classList.remove('k-bad');
          };
          cb.appendChild(b);
        });
        w.appendChild(cb);
      }
      if (o.songDep && V.noSong) { return null; }
      if (o.song && V.noSong) { inp.disabled = true; inp.value = ''; inp.setAttribute('placeholder', 'נבחר בהמשך'); }
      w.appendChild(inp);
      if (o.song) {
        var ck = h('input', { type: 'checkbox' }); ck.checked = !!V.noSong;
        ck.onchange = function () { V.noSong = ck.checked; if (ck.checked) { V.song = ''; V.artist = ''; } save(); render(); };
        w.appendChild(h('label', { 'class': 'k-chk' }, [ck, 'עוד לא בחרנו מנגינה']));
        if (V.noSong) w.appendChild(h('div', { 'class': 'k-note', text: 'אין בעיה. אחרי השליחה נשלח לכם לינק קצר לבחירת המנגינה, ונתחיל לכתוב ברגע שתבחרו.' }));
      }
    }
    w.appendChild(h('div', { 'class': 'k-err', text: errText(key) }));
    return w;
  }
  function errText(k) {
    return { phone: 'מספר נייד ישראלי, למשל 050-1234567', email: 'כתובת אימייל לא תקינה', occ: 'בחרו מה חוגגים', sings: 'בחרו מי ישיר' }[k] || 'זה שדה חובה';
  }
  function valid(k) {
    var v = String(V[k] || '').trim();
    if (k === 'phone') return /^5\d{8}$/.test(d9(v)) && v.replace(/\D/g, '').length >= 9;
    if (k === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
    if (k === 'song' && V.noSong) return true;
    return !!v;
  }
  function check(i) {
    var ok = true, first = null;
    STEPS[i].f.forEach(function (def) {
      var o = def[2] || {}; if (o.when && !o.when()) return;
      var need = o.req || (def[0] === 'email' && V.email);
      if (!need && !(def[0] === 'phone')) return;
      var good = valid(def[0]);
      var el = root.querySelector('.k-f[data-k="' + def[0] + '"]');
      if (!good && el) { el.classList.add('k-bad'); if (!first) first = el; ok = false; }
    });
    if (first) { var inp = first.querySelector('input,textarea,button'); try { first.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { } if (inp && inp.focus && inp.tagName !== 'BUTTON') setTimeout(function () { inp.focus(); }, 300); }
    return ok;
  }

  var CAP = null;   // שאלת האבטחה של Exite
  function captcha() {
    var q = F.querySelector('[name^=input_question]'); if (!q) return null;
    var row = q.closest('[id^=short_cell]') || q.parentNode;
    var txt = (row.textContent || '').replace(/\s+/g, ' ').replace(/\(על מנת[^)]*\)/, '').replace(/\*/g, '').trim();
    return { name: q.name, q: txt };
  }

  function review() {
    var box = h('div');
    STEPS.forEach(function (s, i) {
      if (s.review) return;
      var dl = h('dl'), n = 0;
      s.f.forEach(function (def) {
        var o = def[2] || {}; if (o.when && !o.when()) return;
        var v = def[0] === 'date' ? fmtDate(V.date) : V[def[0]];
        if (def[0] === 'song' && V.noSong) v = 'עוד לא נבחרה – נשלח לינק לבחירה';
        if (!v) return; n++;
        dl.appendChild(h('dt', { text: fv(def[1]) })); dl.appendChild(h('dd', { text: v }));
      });
      if (!n) return;
      var ed = h('button', { type: 'button', text: 'עריכה' }); ed.onclick = function () { go(i); };
      box.appendChild(h('div', { 'class': 'k-rev' }, [h('h4', {}, [fv(s.t), ed]), dl]));
    });
    return box;
  }
  function fmtDate(v) { var m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[3] + '/' + m[2] + '/' + m[1] : (v || ''); }

  var hp = h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'class': 'k-hp', 'aria-hidden': 'true' });

  function render() {
    var s = STEPS[cur];
    root.innerHTML = '';
    if (cur === 0) root.appendChild(intro());
    var card = h('div', { 'class': 'k-card' });
    var bar = h('div', { 'class': 'k-bar' }); STEPS.forEach(function (x, i) { bar.appendChild(h('span', { 'class': i < cur ? 'dn' : (i === cur ? 'on' : '') })); });
    card.appendChild(h('div', { 'class': 'k-step', text: 'שלב ' + (cur + 1) + ' מתוך ' + STEPS.length }));
    card.appendChild(h('h2', { 'class': 'k-ttl', text: fv(s.t) }));
    card.appendChild(h('div', { 'class': 'k-sub', text: s.d }));
    card.appendChild(bar);
    s.f.forEach(function (def) { var el = field(def); if (el) card.appendChild(el); });
    if (s.review) {
      card.appendChild(review());
      card.appendChild(h('div', { 'class': 'k-note', html: '<b>מה קורה אחרי השליחה?</b><br>אם הזמנתם קליפ – כתיבת המילים כלולה, והשאלון עובר ישר לכותבת שלנו.<br>בשיר או בטייקליפ – כתיבת המילים והגייד עולים 550 ₪, ונשלח לכם לינק לתשלום מאובטח. מיד אחרי התשלום מתחילים לכתוב.' }));
      CAP = captcha();
      if (CAP) {
        var cw = h('div', { 'class': 'k-f', 'data-k': 'cap' });
        cw.appendChild(h('label', { 'for': 'klq-cap' }, ['שאלה קטנה לפני השליחה: ' + CAP.q]));
        var ci = h('input', { id: 'klq-cap', type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'התשובה במספרים' });
        ci.oninput = function () { cw.classList.remove('k-bad'); };
        cw.appendChild(ci); cw.appendChild(h('div', { 'class': 'k-err', text: 'כתבו את התשובה במספרים' }));
        card.appendChild(cw);
      }
      card.appendChild(hp);
    }
    var msg = h('div', { 'class': 'k-msg', role: 'alert' }); card.appendChild(msg);
    var back = h('button', { type: 'button', 'class': 'k-back', text: 'הקודם' }); back.style.visibility = cur ? 'visible' : 'hidden';
    back.onclick = function () { go(cur - 1); };
    var next = h('button', { type: 'button', 'class': 'k-btn' + (s.review ? ' k-pri' : ''), text: s.review ? 'שליחת השאלון' : 'המשך' });
    next.onclick = function () {
      msg.textContent = '';
      if (s.review) { submit(next, msg); return; }
      if (!check(cur)) { msg.textContent = 'כדי להמשיך, השלימו את השדות המסומנים'; return; }
      go(cur + 1);
    };
    card.appendChild(h('div', { 'class': 'k-nav' }, [back, next]));
    card.appendChild(h('div', { 'class': 'k-save', text: 'התשובות נשמרות אוטומטית במכשיר שלכם – אפשר לסגור ולהמשיך אחר כך.' }));
    root.appendChild(card);
  }
  function go(i) { cur = Math.max(0, Math.min(STEPS.length - 1, i)); S.step = cur; save(); render(); top(); }

  /* ------------------------------ submit ------------------------------ */
  function answers() {
    var a = [];
    a.push(['מה חוגגים', [V.occ, fmtDate(V.date), V.place].filter(Boolean).join(' · ')]);
    a.push([wed() ? 'החתן והכלה' : 'החוגג/ת', V.honoree + (V.nick ? ' (שם חיבה: ' + V.nick + ')' : '') + (!wed() && V.age ? ', גיל ' + V.age : '')]);
    a.push(['תיאור – אופי ומראה', V.traits]);
    a.push(['תחביבים', V.hobbies]); a.push(['מה עושה לו/ה שמח', V.happy]); a.push(['חוגים ומסגרות', V.clubs]);
    a.push(['אנשים חשובים', V.people]); a.push(['סיפור / זיכרון', V.story]);
    a.push(['מי שר', V.sings]); a.push(['אופי השיר', V.tone]); a.push(['הערות', V.notes]);
    return a.map(function (x) { return [x[0], String(x[1] || '').trim()]; });
  }
  function exiteFields() {
    var occLine = [V.occ, fmtDate(V.date), V.place].filter(Boolean).join(', ');
    return {
      input_10: V.honoree + (V.nick ? ' – שם חיבה: ' + V.nick : ''),
      input_11: wed() ? 'חתונה' : (V.age || ''),
      input_12: occLine,
      input_13: V.traits || '', input_15: V.hobbies || '', input_16: V.happy || '', input_17: V.clubs || '',
      input_18: V.story || '', input_19: V.people || '',
      input_66: V.tone || '', input_20: V.sings || '',
      input_21: V.noSong ? 'עוד לא נבחרה מנגינה (יישלח ללקוח לינק לבחירה)' : (V.song + (V.artist ? ' – ' + V.artist : '')),
      input_38: V.notes || '', input_22: V.contact || '', input_23: V.email || '', input_24: V.phone || ''
    };
  }
  function submit(btn, msg) {
    for (var i = 0; i < STEPS.length - 1; i++) { if (!check(i)) { go(i); setTimeout(function () { var m = root.querySelector('.k-msg'); if (m) m.textContent = 'חסר כאן משהו – השלימו והמשיכו לסיכום'; check(cur); }, 50); return; } }
    var ci = document.getElementById('klq-cap');
    if (CAP && (!ci || !ci.value.trim())) { var cw = root.querySelector('[data-k=cap]'); if (cw) cw.classList.add('k-bad'); msg.textContent = 'נשאר לענות על השאלה הקטנה'; return; }
    btn.disabled = true; btn.textContent = 'שולחים…';
    var fail = function (t) { btn.disabled = false; btn.textContent = 'שליחת השאלון'; msg.textContent = t; };
    // 1) Exite – המייל הרגיל לאולפן + בדיקת שאלת האבטחה
    var p = new URLSearchParams();
    [].forEach.call(F.elements, function (e) { if (e.name && e.type !== 'submit') p.append(e.name, e.value); });
    var ef = exiteFields(); Object.keys(ef).forEach(function (k) { p.set(k, ef[k]); });
    if (CAP) p.set(CAP.name, ci.value.trim());
    p.append('lp_scrollPercent', '100');
    fetch('/sendCustomForm.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: p.toString(), credentials: 'same-origin' })
      .then(function (r) { return r.text(); })
      .then(function (t) {
        var al = t.match(/alert\((['"])([\s\S]*?)\1\)/);
        if (al) { var m = al[2].replace(/:\?!$/, '').replace(/!$/, ''); if (/ספאם|שאלה|תשובה|נכונ/.test(m) || /question/.test(t)) { var cw = root.querySelector('[data-k=cap]'); if (cw) cw.classList.add('k-bad'); } fail(m.indexOf('יש למלא') === 0 ? m + ' – בדקו את השלבים הקודמים' : m); return; }
        // 2) השרת – בדיקת תשלום וניתוב
        btn.textContent = 'בודקים את ההזמנה שלכם…';
        post({ app: 'lyrics', action: 'submit', hp: hp.value, ms: Date.now() - (S.t0 || Date.now()), contact: V.contact, phone: V.phone, email: V.email,
          honoree: V.honoree, occasion: V.occ, eventDate: fmtDate(V.date), song: V.noSong ? '' : V.song, artist: V.noSong ? '' : V.artist, noSong: !!V.noSong, answers: answers() })
          .then(function (r) { done(r && r.ok ? r : { state: 'unknown' }); })
          .catch(function () { done({ state: 'unknown' }); });
      })
      .catch(function () { fail('לא הצלחנו לשלוח – בדקו את החיבור לאינטרנט ונסו שוב'); });
  }

  /* ------------------------------ result ------------------------------ */
  function done(r) {
    var name = String(V.contact || '').trim().split(/\s+/)[0];
    try { localStorage.removeItem(KEY); } catch (e) { }
    try { if (window.gtag) window.gtag('event', 'lyrics_questionnaire_sent', { state: r.state }); if (window.fbq) window.fbq('track', 'Lead', { content_name: 'שאלון כתיבת מילים' }); } catch (e) { }
    root.innerHTML = '';
    var c = h('div', { 'class': 'k-done' });
    var waBtn = function (t) { return h('a', { 'class': 'k-btn k-wa', href: WA + encodeURIComponent(t), target: '_blank', rel: 'noopener' }, ['כתבו לנו בוואטסאפ']); };
    if (r.state === 'sent') {
      c.innerHTML = '<div class="k-ico">✍️</div><h2>תודה' + (name ? ' ' + esc(name) : '') + '! השאלון עבר לכתיבה</h2>' +
        '<p>הכותבת שלנו כבר קיבלה את כל מה שסיפרתם, ומתחילה לעבוד על השיר' + (V.honoree ? ' ל' + esc(V.honoree) : '') + '.</p>' +
        '<p>כשהמילים והגייד יהיו מוכנים נשלח אותם אליכם' + (V.email ? ' למייל' : '') + '.</p>';
      c.appendChild(waBtn('היי, מילאתי עכשיו את שאלון כתיבת המילים באתר ורציתי להוסיף משהו'));
    } else if (r.state === 'await_pay') {
      c.innerHTML = '<div class="k-ico">🎶</div><h2>קיבלנו את השאלון' + (name ? ', ' + esc(name) : '') + '!</h2>' +
        '<p>כדי שנתחיל לכתוב, נשאר רק להסדיר את התשלום על <b>כתיבת המילים והגייד (' + esc(r.price || '550 ₪') + ')</b>.<br>מיד אחרי התשלום השאלון עובר לכותבת שלנו.</p>';
      c.appendChild(h('a', { 'class': 'k-btn', href: r.payUrl, target: '_blank', rel: 'noopener' }, ['לתשלום מאובטח ←']));
      if (r.wa) c.appendChild(h('p', { 'class': 'k-small', style: 'margin-top:12px!important', text: 'שלחנו לכם את הלינק גם בוואטסאפ.' }));
      c.appendChild(h('p', { 'class': 'k-small', style: 'margin-top:14px!important', html: 'כבר הזמנתם קליפ אצלנו? אז כתיבת המילים כלולה – כנראה ההזמנה רשומה על מספר טלפון אחר. כתבו לנו ונסדר.' }));
      c.appendChild(waBtn('היי, מילאתי את שאלון כתיבת המילים. כבר הזמנתי קליפ – ההזמנה על שם: ' + (V.contact || '')));
    } else if (r.state === 'need_song') {
      c.innerHTML = '<div class="k-ico">🎵</div><h2>תודה' + (name ? ' ' + esc(name) : '') + '! רק עוד דבר אחד</h2><p>כדי שנוכל להתחיל לכתוב, צריך לבחור על איזו מנגינה נכתוב את המילים.</p>';
      c.appendChild(songBox(r.id, function () { root.innerHTML = ''; root.appendChild(h('div', { 'class': 'k-done', html: '<div class="k-ico">✍️</div><h2>מעולה, השאלון עבר לכתיבה</h2><p>כשהמילים והגייד יהיו מוכנים נשלח אותם אליכם.</p>' })); top(); }));
      c.appendChild(h('p', { 'class': 'k-small', style: 'margin-top:12px!important', text: r.wa ? 'אפשר גם אחר כך – שלחנו לכם לינק בוואטסאפ.' : 'אפשר גם אחר כך – נשלח לכם לינק לבחירה.' }));
    } else {
      c.innerHTML = '<div class="k-ico">🙏</div><h2>תודה! השאלון התקבל</h2><p>נעבור על התשובות ונחזור אליכם בהקדם.</p>';
      c.appendChild(waBtn('היי, מילאתי עכשיו את שאלון כתיבת המילים באתר'));
    }
    root.appendChild(c); top();
  }

  function songBox(id, onOk) {
    var b = h('div', { 'class': 'k-box' });
    var s1 = h('input', { type: 'text', placeholder: 'שם השיר' }), s2 = h('input', { type: 'text', placeholder: 'מי שר את המקור (לא חובה)' });
    var m = h('div', { 'class': 'k-msg' });
    var go2 = h('button', { type: 'button', 'class': 'k-btn k-pri', text: 'שמירת המנגינה' });
    go2.onclick = function () {
      if (!s1.value.trim()) { m.textContent = 'כתבו את שם השיר'; s1.focus(); return; }
      go2.disabled = true; go2.textContent = 'שומרים…';
      post({ app: 'lyrics', action: 'song_set', id: id, song: s1.value, artist: s2.value }).then(function (r) {
        if (r && r.ok) onOk(r); else { go2.disabled = false; go2.textContent = 'שמירת המנגינה'; m.textContent = (r && r.error) || 'לא הצלחנו לשמור, נסו שוב'; }
      }).catch(function () { go2.disabled = false; go2.textContent = 'שמירת המנגינה'; m.textContent = 'לא הצלחנו לשמור, נסו שוב'; });
    };
    [h('div', { 'class': 'k-f' }, [h('label', { text: 'על איזה שיר מוכר לכתוב?' }), s1]), h('div', { 'class': 'k-f' }, [s2]), h('div', { 'class': 'k-hint', text: 'כדאי לבחור שיר שיש לו פלייבק. לא בטוחים? כתבו לנו בוואטסאפ.' }), m, go2].forEach(function (x) { b.appendChild(x); });
    return b;
  }

  function songMode(id) {
    root.innerHTML = '<div class="k-card"><div class="k-sub">טוען…</div></div>';
    post({ app: 'lyrics', action: 'song_get', id: id }).then(function (r) {
      root.innerHTML = '';
      if (!r || !r.ok) { root.appendChild(h('div', { 'class': 'k-done', html: '<div class="k-ico">🤔</div><h2>הלינק לא נמצא</h2><p>אולי הוא כבר שומש. כתבו לנו בוואטסאפ ונסדר.</p>' })); return; }
      if (r.state === 'sent') { root.appendChild(h('div', { 'class': 'k-done', html: '<div class="k-ico">✍️</div><h2>המנגינה כבר אצלנו</h2><p>השאלון כבר עבר לכתיבה. כשהמילים יהיו מוכנות נשלח אותן אליכם.</p>' })); return; }
      var c = h('div', { 'class': 'k-done', html: '<div class="k-ico">🎵</div><h2>היי' + (r.name ? ' ' + esc(r.name) : '') + ', על איזו מנגינה נכתוב?</h2><p>בחרו שיר מוכר, ועל המנגינה שלו נכתוב את המילים החדשות' + (r.honoree ? ' ל' + esc(r.honoree) : '') + '.</p>' });
      c.appendChild(songBox(id, function (x) { root.innerHTML = ''; root.appendChild(h('div', { 'class': 'k-done', html: '<div class="k-ico">✍️</div><h2>תודה! קיבלנו את המנגינה</h2><p>' + (x && x.state === 'await_pay' ? 'נשאר רק להסדיר את התשלום בלינק ששלחנו לכם, ומתחילים לכתוב.' : 'השאלון עבר לכותבת שלנו. כשהמילים והגייד יהיו מוכנים נשלח אותם אליכם.') + '</p>' })); top(); }));
      root.appendChild(c); setTimeout(function () { top(c); }, 300);   // מגיעים מוואטסאפ – ישר לתיבת המנגינה
    }).catch(function () { root.innerHTML = '<div class="k-card"><div class="k-msg">לא הצלחנו לטעון. רעננו את הדף.</div></div>'; });
  }

  render();
})();
