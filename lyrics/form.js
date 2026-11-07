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
    '#klq .k-song{background:#fff8e6;border:2px solid var(--g);border-radius:18px;padding:14px 14px 10px}'+
    '#klq .k-song>label{font-size:19px}#klq .k-song input[type=text]{font-size:18px;font-weight:700;background:#fff;border-color:#e9c46a}'+
    '#klq .k-song .k-hint a{color:var(--p2);font-weight:700}'+
    '#klq .k-songs{margin:4px 0 6px}#klq .k-sgt{font-weight:800;color:var(--p);font-size:14.5px;margin:10px 0 6px}#klq .k-hidden{display:none}#klq .k-sgmore{margin-top:4px;border-radius:999px;padding:9px 14px;font:700 14px/1.3 inherit;cursor:pointer}'+
    '#klq .k-song .k-chips button{background:#fff}#klq .k-song .k-chips button.on{background:var(--p);color:#fff}'+
    '#klq .k-quiet{font-size:13.5px!important;color:var(--mu)!important;font-weight:400}#klq .k-quiet input{width:17px!important;height:17px!important}'+
    '#klq .k-more{border:1.5px dashed var(--ln)!important;background:transparent!important;color:var(--p2)!important}'+
    '#klq .k-mic{float:left;border:1.5px solid var(--ln);background:#fff;color:var(--p2);border-radius:999px;padding:6px 12px;font:700 13.5px/1 inherit;cursor:pointer;margin-top:-2px}'+
    '#klq .k-mic.on{background:#c93434;border-color:#c93434;color:#fff;animation:kpulse 1.2s infinite}@keyframes kpulse{50%{opacity:.7}}'+
    '#klq .k-mic-msg{font-size:13px;color:var(--p2);margin-top:4px;min-height:0}'+
    '#klq .k-f>label::after{content:"";display:table;clear:both}'+
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
    '#klq .k-chips{gap:7px}#klq .k-chips button{padding:9px 13px;font-size:14.5px}#klq .k-how{grid-template-columns:1fr;gap:6px}#klq .k-how div{display:flex;gap:10px;align-items:center;text-align:right;padding:9px 12px}#klq .k-how b{display:inline;margin:0}' +
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
  var TONES = ['מרגש', 'מצחיק', 'קצבי', 'קליל', 'אישי', 'משולב'];
  // שירים מומלצים: המנגינות שנכתבו אצלנו הכי הרבה + תבנית "המלצות לשירים" בקאלה + עמוד השירים באתר.
  // [שם, מבצע] – מבצע רק כשהוא ודאי; אחרת הלקוח משלים בעצמו.
  var SONGS = [
    { t: '⭐ הכי מבוקשים אצלנו', open: 1, s: [['מהפכה של שמחה', 'עומר אדם'], ['שבט אחים ואחיות', ''], ['מכתב לאחי', ''], ['קרמלה', ''], ['הנה זה בא', ''], ['זהב', ''], ['אם תרצי', ''], ['להשתטות לפעמים', ''], ['אבא', '']] },
    { t: 'קצביים', s: [['רק רוצה לרקוד', ''], ['כביש החוף', ''], ['בית משוגעים', ''], ['לך לישון', ''], ['מי זאת', ''], ['פנתרה', ''], ['מי לא יבוא', ''], ['מיליון דולר', ''], ['תל אביב', 'עומר אדם'], ['Unicorn', 'נועה קירל']] },
    { t: 'שמחים', s: [['קרן שמש', ''], ['מסע', ''], ['שבוע טוב', ''], ['סיבת הסיבות', ''], ['לאן שלא תלכי', 'שירי מימון']] },
    { t: 'מרגשים', s: [['מתנות קטנות', 'רמי קלינשטיין'], ['אני ואתה', 'אריק איינשטיין'], ['כמעט לאהוב', ''], ['יש בך', ''], ['יש לך אותך', ''], ['מה שאת אוהבת', ''], ['זה מתחיל בצעד', ''], ['תודה', ''], ['שרק תחייך', ''], ['שלמים', ''], ['ילד של אבא', ''], ['תפילה', ''], ['מודה אני', ''], ['תמיד בשבילך', 'אייל גולן ואלין גולן'], ['חלק ממני', 'שרית חדד'], ['חוזרת אליך', 'אגם בוחבוט'], ['ילדה קטנה', 'משה פרץ ואגם בוחבוט'], ['על כל אלה', 'נעמי שמר']] },
    { t: 'באנגלית', s: [['Happy', 'Pharrell Williams'], ['Dance Monkey', 'Tones and I'], ['Señorita', 'Shawn Mendes, Camila Cabello'], ['Count on Me', 'Bruno Mars'], ['Shake It Off', 'Taylor Swift'], ['A Million Dreams', 'The Greatest Showman']] }
  ];
  var wed = function () { return V.occ === 'חתונה'; };
  var couple = function () { return V.occ === 'חתונה' || V.occ === 'יום נישואין'; };
  /** מי החוגג: teen (בר/בת מצווה ו-13–19), kid, adult, senior, couple */
  function prof() {
    if (couple()) return 'couple';
    if (V.occ === 'בת מצווה' || V.occ === 'בר מצווה') return 'teen';
    var a = parseInt(String(V.age || '').replace(/\D/g, ''), 10);
    if (!a) return 'adult';
    return a < 13 ? 'kid' : a < 20 ? 'teen' : a < 60 ? 'adult' : 'senior';
  }
  /** מגדר: מבר/בת מצווה, או מהבחירה בן/בת. 'm' / 'f' / '' (לא ידוע – משאירים "/") */
  function sex() { return V.occ === 'בר מצווה' ? 'm' : V.occ === 'בת מצווה' ? 'f' : V.gender === 'בן' ? 'm' : V.gender === 'בת' ? 'f' : ''; }
  var SP = { 'הוא/היא': ['הוא', 'היא'], 'לו/ה': ['לו', 'לה'], 'אותו/ה': ['אותו', 'אותה'], 'עליו/ה': ['עליו', 'עליה'], 'בחייו/ה': ['בחייו', 'בחייה'], 'שלו/ה': ['שלו', 'שלה'], 'בו/ה': ['בו', 'בה'], 'החוגג/ת': ['החוגג', 'החוגגת'], 'קטן/ה': ['קטן', 'קטנה'], 'היה/הייתה': ['היה', 'הייתה'], 'בן/בת': ['בן', 'בת'], 'החבר/ה': ['החבר', 'החברה'], 'שר/ה': ['שר', 'שרה'], 'בעצמו/ה': ['בעצמו', 'בעצמה'], 'אשתו/בעלה': ['אשתו', 'בעלה'] };
  /** "מצחיק/ה" → מצחיק / מצחיקה לפי המגדר */
  function gx(s) {
    var g = sex(); if (!g) return s;
    return String(s).replace(/[֐-׿"']+\/[֐-׿"']+/g, function (w) {
      if (SP[w]) return SP[w][g === 'm' ? 0 : 1];
      var p = w.split('/');
      if (p[1].length <= 3) return g === 'm' ? p[0] : p[0] + p[1];
      return g === 'm' ? p[0] : p[1];
    });
  }
  var who = function () { var g = sex(); return couple() ? 'הם' : g === 'm' ? 'הוא' : g === 'f' ? 'היא' : 'הוא/היא'; };

  var C = {   // אפשרויות לבחירה לפי סוג החוגג
    traits: {
      base: ['מצחיק/ה', 'טוב/ת לב', 'רגיש/ה', 'מתחשב/ת', 'חכם/ה', 'חברותי/ת', 'אוהב/ת לעזור', 'מלא/ת אנרגיה', 'יצירתי/ת', 'אחראי/ת', 'נדיב/ה', 'אופטימי/ת', 'עם חיוך שלא יורד'],
      kid: ['שובב/ה', 'סקרן/ית', 'מתוק/ה', 'ספורטיבי/ת', 'ביישן/ית', 'דרמטי/ת', 'תמיד בתנועה', 'חולם/ת', 'עם תלתלים', 'עיניים גדולות'],
      teen: ['ספורטיבי/ת', 'מנהיג/ה', 'ביישן/ית', 'דרמטי/ת', 'סקרן/ית', 'אוהב/ת להיות במרכז', 'חולם/ת', 'שובב/ה', 'עם תלתלים', 'גבוה/ה', 'תמיד מסודר/ת'],
      adult: ['חרוץ/ה', 'מסור/ה למשפחה', 'אוהב/ת לפנק', 'הרפתקן/ית', 'מארח/ת בחסד', 'עם הומור עוקצני', 'תמיד בשביל כולם'],
      senior: ['חם/ה ואוהב/ת', 'סבלני/ת', 'עמוד התווך של המשפחה', 'מארח/ת בחסד', 'תמיד דואג/ת לכולם', 'צעיר/ה ברוח', 'מלא/ת סיפורים', 'מפנק/ת את הנכדים', 'צנוע/ה', 'חרוץ/ה'],
      couple: ['משלימים זה את זו', 'צוחקים כל הזמן', 'רומנטיים', 'הרפתקנים', 'החברים הכי טובים', 'ביתיים', 'אוהבים לארח', 'תמיד ביחד', 'נשמות תאומות', 'תומכים זה בזו', 'מצחיקים', 'רגישים ומתחשבים']
    },
    hobbies: {
      kidm: ['כדורגל', 'פלייסטיישן', 'לגו', 'אופניים', 'קורקינט', 'שחייה', 'טרמפולינה', 'ציור', 'משחקים בחצר', 'ג\'ודו / קראטה', 'טיקטוק', 'יוטיוב', 'ריקוד', 'שירה', 'בעלי חיים'],
      kidf: ['ריקוד', 'שירה', 'התעמלות', 'ציור ויצירה', 'בובות ומשחקי דמיון', 'אופניים', 'קורקינט', 'שחייה', 'טרמפולינה', 'טיקטוק', 'בעלי חיים', 'לגו', 'אפייה', 'יוטיוב'],
      teenm: ['כדורגל', 'כדורסל', 'פלייסטיישן', 'גיימינג', 'אופניים', 'סקייטבורד', 'קורקינט', 'שחייה', 'טניס', 'ג\'ודו / קראטה', 'נגינה', 'שירה', 'ריקוד', 'טיקטוק', 'יוטיוב', 'מחשבים ותכנות', 'לגו', 'בישול', 'ציור', 'קריאה', 'טיולים', 'דיג', 'שחמט'],
      teenf: ['ריקוד', 'שירה', 'התעמלות', 'ציור ויצירה', 'טיקטוק', 'איפור וטיפוח', 'אופנה', 'בישול ואפייה', 'קריאה', 'בעלי חיים', 'רכיבה על סוסים', 'שחייה', 'כדורעף', 'נגינה', 'תיאטרון', 'יוגה', 'סקייטבורד', 'אופניים', 'גיימינג', 'כדורגל', 'יוטיוב'],
      adult: ['ספורט', 'ריצה', 'חדר כושר', 'טיולים', 'בישול', 'נגינה', 'קריאה', 'יוגה', 'אופניים', 'טיסות לחו"ל', 'צילום', 'מוזיקה', 'ים', 'גינון', 'כדורגל עם החבר\'ה', 'פודקאסטים', 'ריקודים'],
      senior: ['טיולים עם הנכדים', 'לארח את המשפחה', 'בישול ואפייה', 'גינון', 'קריאה ועיתון', 'תשבצים', 'הליכות בבוקר', 'שחייה', 'ריקודי עם', 'טיולים בארץ ובעולם', 'שש-בש', 'קלפים', 'נגינה', 'התנדבות', 'כדורגל בטלוויזיה', 'נסיעות לחו"ל', 'מוזיקה ישנה'],
      couple: ['טיולים', 'טיסות לחו"ל', 'ים', 'בישול ביחד', 'ערבי סרטים וסדרות', 'ספורט', 'הכלב שלנו', 'מסעדות', 'הופעות', 'משחקי קופסה', 'לארח חברים', 'ריקודים', 'קמפינג']
    },
    happy: {
      kid: ['חופשות עם המשפחה', 'הכלב / החתול', 'ממתקים ושוקולד', 'ים ובריכה', 'חברים', 'מסיבות פיג\'מה', 'נסיעות לחו"ל', 'האוכל של סבתא', 'מוזיקה', 'ימי הולדת', 'פיצה', 'מתנות', 'לישון עד מאוחר'],
      adult: ['המשפחה', 'זמן עם הילדים', 'ארוחות שישי', 'טיולים', 'הצלחה בעבודה', 'מוזיקה', 'ים', 'קפה של בוקר', 'חברים טובים', 'שקט בבית'],
      senior: ['הנכדים', 'ארוחות שישי עם כל המשפחה', 'חגים', 'כשכולם ביחד', 'מוזיקה ישנה', 'הגינה', 'טיולים', 'חברים ותיקים', 'לבשל לכולם', 'תמונות של המשפחה'],
      couple: ['להיות ביחד', 'הבית שבנו', 'הילדים', 'החיות', 'טיולים', 'ארוחות עם המשפחה', 'חברים', 'ים', 'בוקר עצל ביחד']
    },
    clubs: {
      kid: ['בית הספר והכיתה', 'תנועת נוער', 'צופים', 'בני עקיבא', 'קבוצת ספורט', 'להקת מחול', 'חוג דרמה', 'קונסרבטוריון', 'מקהלה', 'רובוטיקה', 'חוג אומנות', 'נבחרת שחייה', 'שחמט', 'הגן'],
      adult: ['העבודה', 'הצבא', 'הלימודים', 'חדר הכושר', 'קבוצת ריצה', 'הקהילה / בית הכנסת', 'התנדבות', 'להקה / הרכב'],
      senior: ['שנות העבודה', 'הצבא', 'חוג תנועה', 'מקהלה', 'קבוצת הליכה', 'התנדבות', 'מועדון / בית הכנסת', 'האוניברסיטה העממית', 'הקיבוץ / המושב'],
      couple: ['איפה הכירו', 'הצבא', 'הלימודים', 'העבודה שלו', 'העבודה שלה', 'החברים המשותפים']
    },
    people: {
      kid: ['אמא', 'אבא', 'אחים', 'אחיות', 'סבא', 'סבתא', 'החבר/ה הכי טוב/ה', 'בני הדודים', 'הדודים', 'הכלב / החתול', 'המורה', 'החברים מהכיתה'],
      adult: ['אשתו/בעלה', 'הילדים', 'ההורים', 'האחים', 'החברים הכי טובים', 'הכלב / החתול', 'החברים מהעבודה'],
      senior: ['אשתו/בעלה', 'הילדים', 'הנכדים', 'הנינים', 'האחים', 'החברים הוותיקים', 'הכלות והחתנים'],
      couple: ['ההורים שלו', 'ההורים שלה', 'האחים', 'החברים', 'הסבים', 'השושבינים', 'הילדים', 'הכלב / החתול']
    },
    story: {
      kid: ['משפט שהוא/היא תמיד אומר/ת: ', 'הפעם ש', 'טיול משפחתי שלא נשכח: ', 'כשהיה/הייתה קטן/ה ', 'משהו מצחיק שקרה: ', 'רגע שהיינו גאים בו/ה: '],
      adult: ['משפט קבוע שלו/ה: ', 'הפעם ש', 'רגע מרגש: ', 'משהו מצחיק שקרה: ', 'טיול שלא נשכח: '],
      senior: ['משפט שהוא/היא תמיד אומר/ת: ', 'מהילדות שלו/ה: ', 'איך הכירו בני הזוג: ', 'סיפור עם הנכדים: ', 'המאכל המפורסם שלו/ה: ', 'רגע שכולם זוכרים: '],
      couple: ['איך הכירו: ', 'הדייט הראשון: ', 'ההצעה: ', 'טיול משותף שלא נשכח: ', 'הבדיחה הפנימית שלהם: ', 'משהו מצחיק שקרה: ']
    },
    notes: ['חשוב שיופיע: ', 'לא להזכיר: ', 'בדיחה פנימית: ', 'ביטוי שחייב להיכנס: ', 'לשלב את השמות: ']
  };
  function pick(map) {
    var p = prof(), g = sex() || 'm';
    var arr = map[p + g] || map[p] || (p === 'teen' ? map.kid : null) || (p === 'kid' ? map.kid : null) || map.adult || map.base || [];
    if (map === C.traits) arr = (p === 'couple' ? [] : map.base).concat(map[p] || []);
    if (map === C.hobbies && (p === 'kid' || p === 'teen') && !sex()) arr = uniq(map[p + 'm'].concat(map[p + 'f']));
    return uniq(arr.map(gx));
  }
  function uniq(a) { var o = []; a.forEach(function (x) { if (o.indexOf(x) < 0) o.push(x); }); return o; }
  function sings() {
    if (couple()) return ['החתן והכלה שרים', 'המשפחה והחברים שרים להם', 'כולם ביחד', 'זמר/ת מהאולפן'];
    var p = prof();
    return [gx('החוגג/ת שר/ה בעצמו/ה'), gx('המשפחה שרה ל') + (sex() === 'm' ? 'חוגג' : sex() === 'f' ? 'חוגגת' : 'חוגג/ת'), p === 'senior' ? 'הילדים והנכדים שרים' : 'החברים שרים', 'כולם ביחד', 'זמר/ת מהאולפן'];
  }

  // field: [key, label, opts]   chipsAdd = רשימה להוספה בפסיקים · starters = פתיחי משפטים בשורה חדשה
  var STEPS = [
    { t: 'קודם כל – מי ממלא את השאלון?', d: 'כדי שנוכל לשלוח לכם את המילים והגייד', f: [
      ['contact', 'השם שלכם', { req: 1, ph: 'למשל: מיכל לוי' }],
      ['phone', 'טלפון נייד', { req: 1, type: 'tel', ph: '050-0000000', hint: 'אותו מספר שמופיע בהזמנה שלכם, אם כבר הזמנתם' }],
      ['email', 'אימייל', { req: 1, type: 'email', ph: 'name@example.com', hint: 'לכאן יישלחו המילים והגייד' }]
    ] },
    { t: 'על מי השיר?', d: 'נתחיל מהבסיס – לפי זה נתאים את כל האפשרויות בהמשך', f: [
      ['occ', 'מה חוגגים?', { req: 1, chips: OCC, single: 1, rerender: 1 }],
      ['gender', 'השיר מוקדש ל…', { chips: ['בן', 'בת'], single: 1, opt: 1, rerender: 1, when: function () { return V.occ && !couple() && V.occ !== 'בר מצווה' && V.occ !== 'בת מצווה'; } }],
      ['honoree', function () { return couple() ? (wed() ? 'שמות החתן והכלה' : 'שמות בני הזוג') : gx('שם החוגג/ת'); }, { req: 1, ph: function () { return couple() ? 'למשל: דנה ויואב' : 'למשל: נועה כהן'; } }],
      ['nick', 'שם חיבה', { ph: 'למשל: נוני', opt: 1 }],
      ['age', function () { return V.occ === 'יום נישואין' ? 'כמה שנים ביחד?' : 'גיל'; }, { req: 1, ph: 'למשל: 12', when: function () { return !wed(); }, numeric: 1, rerenderOnBlur: 1 }],
      ['date', 'מתי האירוע?', { type: 'date', opt: 1 }],
      ['place', 'איפה?', { ph: 'למשל: אולם גני הדר, ראשון לציון', opt: 1 }]
    ] },
    { t: function () { return couple() ? 'ספרו לנו עליהם' : gx('ספרו לנו עליו/ה'); }, d: 'לחצו על מה שמתאים והוסיפו במילים שלכם – ככל שתפרטו יותר, השיר יהיה אישי יותר', f: [
      ['traits', function () { return couple() ? 'איך הייתם מתארים אותם? מה מיוחד בהם כזוג' : gx('איך הייתם מתארים אותו/ה? אופי, מראה, מה מיוחד'); }, { req: 1, area: 1, chipsAdd: function () { return pick(C.traits); }, ph: 'בחרו למעלה והוסיפו במילים שלכם', mic: 1 }],
      ['hobbies', function () { return couple() ? 'מה הם אוהבים לעשות ביחד?' : gx('תחביבים ודברים ש' + who() + ' הכי אוהב/ת לעשות'); }, { area: 1, chipsAdd: function () { return pick(C.hobbies); }, ph: 'בחרו למעלה או כתבו', mic: 1 }],
      ['happy', function () { return couple() ? 'מה עושה להם שמח?' : gx('מה עושה לו/ה שמח?'); }, { area: 1, chipsAdd: function () { return pick(C.happy); }, opt: 1, mic: 1 }],
      ['clubs', function () { var p = prof(); return p === 'kid' || p === 'teen' ? 'בית ספר, חוגים ותנועות נוער' : p === 'couple' ? 'איך הכירו, עבודה, צבא, לימודים' : 'עבודה, צבא, חוגים ומסגרות'; }, { area: 1, chipsAdd: function () { return pick(C.clubs); }, opt: 1, mic: 1 }]
    ] },
    { t: 'אנשים ורגעים', d: 'אלה בדרך כלל השורות שכולם מתרגשים מהן', f: [
      ['people', function () { return couple() ? 'מי האנשים החשובים להם?' : gx('מי האנשים החשובים בחייו/ה, ומה מיוחד בקשר איתם?'); }, { req: 1, area: 1, chipsAdd: function () { return pick(C.people); }, ph: 'למשל: אמא ואבא, האחים יואב ומאיה, סבתא רחל שמפנקת', mic: 1 }],
      ['story', 'סיפור, רגע או זיכרון מצחיק / מרגש שתרצו בשיר', { area: 1, starters: function () { return pick(C.story); }, opt: 1, mic: 1, rows: 5 }]
    ] },
    { t: 'השיר', d: 'על איזו מנגינה נכתוב, ובאיזה אופי', f: [
      ['song', 'על איזה שיר מוכר נכתוב את המילים?', { req: 1, ph: 'שם השיר – למשל: מתנות קטנות', song: 1 }],
      ['artist', 'מי שר את השיר המקורי?', { ph: 'למשל: רמי קלינשטיין', opt: 1, songDep: 1 }],
      ['sings', 'מי ישיר את השיר?', { req: 1, chips: function () { return sings(); }, single: 1 }],
      ['tone', 'מה השיר צריך לשדר?', { chips: TONES, opt: 1, multi: 1 }],
      ['notes', 'עוד משהו שחשוב לכם?', { area: 1, opt: 1, starters: function () { return C.notes; }, ph: 'מילים שחייבות להופיע, דברים שעדיף לא להזכיר, בדיחות פנימיות…', mic: 1 }]
    ] },
    { t: 'סיכום ושליחה', d: 'בדקו שהכול נכון, ושלחו', review: 1, f: [] }
  ];
  var cur = Math.min(S.step || 0, STEPS.length - 1);
  var fv = function (x) { return typeof x === 'function' ? x() : x; };

  function intro() {
    return h('div', { 'class': 'k-how' }, [
      h('div', { html: '<i>📝</i><b>ממלאים</b>כ-5 דקות, בעיקר בלחיצות' }),
      h('div', { html: '<i>✍️</i><b>אנחנו כותבים</b>מילים אישיות על המנגינה שבחרתם' }),
      h('div', { html: '<i>🎧</i><b>מקבלים</b>מילים + גייד מוקלט לתרגול' })
    ]);
  }

  /* ---- הקלטה ותמלול (זיהוי דיבור של הדפדפן, עברית). מוצג רק כשהדפדפן תומך. ---- */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recNow = null;
  function micBtn(inp, key, w) {
    if (!SR) return null;
    var b = h('button', { type: 'button', 'class': 'k-mic', 'aria-label': 'הקלטה ותמלול' }, ['🎤 הקלטה']);
    b.onclick = function () {
      if (recNow) { recNow.stop(); return; }
      var r; try { r = new SR(); } catch (e) { return; }
      r.lang = 'he-IL'; r.continuous = true; r.interimResults = true;
      var base = inp.value, fin = '';
      r.onresult = function (ev) {
        var interim = '';
        for (var i = ev.resultIndex; i < ev.results.length; i++) { var t = ev.results[i][0].transcript; if (ev.results[i].isFinal) fin += t + ' '; else interim += t; }
        inp.value = (base ? base.replace(/\s+$/, '') + (/[.,\n]$/.test(base.trim()) ? ' ' : ', ') : '') + (fin + interim).trim();
        V[key] = inp.value; save(); w.classList.remove('k-bad');
      };
      r.onend = function () { recNow = null; b.classList.remove('on'); b.textContent = '🎤 הקלטה'; };
      r.onerror = function (e) { var m = w.querySelector('.k-mic-msg'); if (m) m.textContent = e.error === 'not-allowed' ? 'צריך לאשר גישה למיקרופון בדפדפן' : 'ההקלטה נעצרה – אפשר לנסות שוב'; };
      try { r.start(); recNow = r; b.classList.add('on'); b.textContent = '⏹ סיום הקלטה'; var m = w.querySelector('.k-mic-msg'); if (m) m.textContent = 'מדברים – והטקסט נכתב לבד. לחצו "סיום" כשמסיימים.'; } catch (e) { }
    };
    return b;
  }

  function songPicker() {
    var box = h('div', { 'class': 'k-songs' });
    var cur0 = function (n) { return !V.noSong && V.song === n; };
    SONGS.forEach(function (g, gi) {
      var sec = h('div', { 'class': 'k-sg' + (g.open ? '' : ' k-hidden') });
      sec.appendChild(h('div', { 'class': 'k-sgt', text: g.t }));
      sec.appendChild(chipRow(g.s.map(function (x) { return x[1] ? x[0] + ' – ' + x[1] : x[0]; }), function (c) { return cur0(c.split(' – ')[0]); }, function (c) {
        var it = g.s.filter(function (x) { return (x[1] ? x[0] + ' – ' + x[1] : x[0]) === c; })[0];
        V.song = it[0]; V.artist = it[1] || ''; V.noSong = false; save(); render();
        setTimeout(function () { var e = root.querySelector('.k-song'); if (e) top(e); }, 50);
      }));
      box.appendChild(sec);
    });
    var more = h('button', { type: 'button', 'class': 'k-more k-sgmore' }, ['עוד שירים מומלצים: קצביים, שמחים, מרגשים, באנגלית +']);
    more.onclick = function () { [].forEach.call(box.querySelectorAll('.k-hidden'), function (x) { x.classList.remove('k-hidden'); }); more.remove(); };
    box.appendChild(more);
    return box;
  }

  function chipRow(list, isOn, onTap, limit) {
    var box = h('div', { 'class': 'k-chips' }), more = null;
    list.forEach(function (c, i) {
      var b = h('button', { type: 'button', 'aria-pressed': isOn(c) ? 'true' : 'false', 'class': isOn(c) ? 'on' : '' }, [c]);
      if (limit && i >= limit && !isOn(c)) b.style.display = 'none';
      b.onclick = function () { onTap(c, b); };
      box.appendChild(b);
    });
    if (limit && list.length > limit) {
      more = h('button', { type: 'button', 'class': 'k-more' }, ['עוד אפשרויות +']);
      more.onclick = function () { [].forEach.call(box.children, function (x) { x.style.display = ''; }); more.remove(); };
      box.appendChild(more);
    }
    return box;
  }

  function field(def) {
    var key = def[0], o = def[2] || {};
    if (o.when && !o.when()) return null;
    if (o.songDep && V.noSong) return null;
    var lab = fv(def[1]);
    var w = h('div', { 'class': 'k-f' + (o.song ? ' k-song' : ''), 'data-k': key });
    var l = h('label', { 'for': 'klq-' + key }, [lab]); if (o.opt) l.appendChild(h('small', { text: '(לא חובה)' }));
    w.appendChild(l);
    if (o.hint) w.appendChild(h('div', { 'class': 'k-hint', text: o.hint }));
    var chips = fv(o.chips);
    if (chips) {
      var multiSel = function () { return String(V[key] || '').split(/,\s*/).filter(Boolean); };
      var box = chipRow(chips, function (c) { return o.multi ? multiSel().indexOf(c) >= 0 : V[key] === c; }, function (c, b) {
        if (o.single) V[key] = V[key] === c && o.opt ? '' : c;
        else { var a = multiSel(); var i = a.indexOf(c); if (i >= 0) a.splice(i, 1); else a.push(c); V[key] = a.join(', '); }
        save(); w.classList.remove('k-bad');
        if (o.rerender) { render(); return; }
        [].forEach.call(box.querySelectorAll('button:not(.k-more)'), function (x) { var on = o.multi ? multiSel().indexOf(x.textContent) >= 0 : V[key] === x.textContent; x.className = on ? 'on' : ''; x.setAttribute('aria-pressed', on); });
      });
      w.appendChild(box);
      w.appendChild(h('div', { 'class': 'k-err', text: errText(key) }));
      return w;
    }
    var inp;
    if (o.area) inp = h('textarea', { id: 'klq-' + key, rows: o.rows || 3 });
    else inp = h('input', { id: 'klq-' + key, type: o.type || 'text' });
    if (o.type === 'tel') { inp.setAttribute('inputmode', 'tel'); inp.setAttribute('autocomplete', 'tel'); inp.setAttribute('dir', 'ltr'); inp.style.textAlign = 'right'; }
    if (o.type === 'email') { inp.setAttribute('autocomplete', 'email'); inp.setAttribute('dir', 'ltr'); inp.style.textAlign = 'right'; }
    if (o.numeric) inp.setAttribute('inputmode', 'numeric');
    if (key === 'contact') inp.setAttribute('autocomplete', 'name');
    if (o.ph) inp.setAttribute('placeholder', fv(o.ph));
    inp.value = V[key] || '';
    inp.oninput = function () { V[key] = inp.value; save(); w.classList.remove('k-bad'); };
    if (o.rerenderOnBlur) inp.onchange = function () { V[key] = inp.value; save(); };
    var add = fv(o.chipsAdd);
    if (add && add.length) {
      var has = function (c) { return (', ' + (inp.value || '') + ',').indexOf(', ' + c + ',') >= 0 || (inp.value || '').split(/,\s*/).indexOf(c) >= 0; };
      w.appendChild(chipRow(add, has, function (c, b) {
        var parts = (inp.value || '').split(/,\s*/).filter(function (x) { return x.trim(); });
        var i = parts.indexOf(c);
        if (i >= 0) { parts.splice(i, 1); b.className = ''; } else { parts.push(c); b.className = 'on'; }
        inp.value = parts.join(', '); V[key] = inp.value; save(); w.classList.remove('k-bad');
      }, 10));
    }
    var st = fv(o.starters);
    if (st && st.length) {
      w.appendChild(h('div', { 'class': 'k-hint', text: 'לחצו על פתיח והמשיכו לכתוב:' }));
      w.appendChild(chipRow(st, function () { return false; }, function (c) {
        var v = inp.value.replace(/\s+$/, ''); inp.value = (v ? v + '\n' : '') + c; V[key] = inp.value; save();
        try { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) { }
      }));
    }
    if (o.song) {
      if (V.noSong) { inp.disabled = true; inp.value = ''; inp.setAttribute('placeholder', 'נבחר בהמשך'); }
      w.appendChild(inp);
      w.appendChild(h('div', { 'class': 'k-hint', text: 'כותבים מילים חדשות על המנגינה של שיר קיים. לא בטוחים? בחרו מהשירים המומלצים:' }));
      w.appendChild(songPicker(w));
      var ck = h('input', { type: 'checkbox' }); ck.checked = !!V.noSong;
      ck.onchange = function () { V.noSong = ck.checked; if (ck.checked) { V.song = ''; V.artist = ''; } save(); render(); };
      w.appendChild(h('label', { 'class': 'k-chk k-quiet' }, [ck, 'עוד לא בחרנו – נבחר בהמשך']));
      if (V.noSong) w.appendChild(h('div', { 'class': 'k-note', text: 'אין בעיה. אחרי השליחה נשלח לכם לינק קצר לבחירת המנגינה, ונתחיל לכתוב ברגע שתבחרו.' }));
    } else {
      w.appendChild(inp);
    }
    if (o.mic) { var mb = micBtn(inp, key, w); if (mb) { l.appendChild(mb); w.appendChild(h('div', { 'class': 'k-mic-msg' })); } }
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
    a.push([couple() ? 'בני הזוג' : 'החוגג/ת', V.honoree + (V.nick ? ' (שם חיבה: ' + V.nick + ')' : '') + (V.gender && !couple() ? ', ' + V.gender : '') + (!wed() && V.age ? (V.occ === 'יום נישואין' ? ', ' + V.age + ' שנים ביחד' : ', גיל ' + V.age) : '')]);
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
        '<p>בדרך כלל תוך 3–4 ימי עסקים תקבלו את המילים לאישור' + (V.email ? ' במייל' : '') + ', ואחרי האישור – גייד מוקלט לתרגול תוך יומיים.</p>';
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
