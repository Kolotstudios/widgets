/** שאלון כתיבת מילים – אולפני קולות (lyrics.gs, בפרויקט "Kolot - פרסום קליפים מקאלה")
 *
 * הניתוב: doPost שולח לכאן כל בקשה עם app:'lyrics' (lyrPost_).
 * הקוד משתמש ב-KALA_KEY ובפונקציות kalaGet_ / kkKala_ שכבר קיימות בפרויקט, ולא משנה אותן.
 *
 * תהליך:
 *  1. הלקוח שולח את השאלון באתר (עמוד טופס-כתיבת-מילים-מקוריות). הטופס של Exite שולח לאורן את המייל הרגיל,
 *     ומיד אחריו הדף שולח את התשובות לכאן (action:'submit').
 *  2. בודקים בקאלה לפי הטלפון הראשי בהזמנה:
 *       - הזמנת קליפ פעילה (סוג 2626, לא טייקליפ) → כתיבת המילים כלולה.
 *       - מוצר כתיבת מילים ששולם במלואו (1795), או כתיבת מילים "חלק מחבילה" בהזמנה סגורה → שולם.
 *  3. כלול/שולם + נבחרה מנגינה → מייל לליאור עם כל השאלון (העתק לאולפן).
 *     כלול/שולם בלי מנגינה → וואטסאפ ללקוח (אוטומציה 719, תבנית 327) עם לינק לבחירת מנגינה.
 *     לא שולם → וואטסאפ ללקוח (אוטומציה 718, תבנית 326) עם לינק לעגלה של "כתיבת מילים וגייד" (75982).
 *  4. אחרי תשלום: אוטומציה בקאלה (מוצר 2619 → שולם במלואו) קוראת לכאן עם action:'paid', ובנוסף lyrSweep
 *     רץ כל שעה ובודק שוב שאלונים שממתינים לתשלום (גיבוי, וגם לתשלום שנרשם ידנית – העברה, מזומן, הוספת קליפ).
 *
 * מצב בדיקה: כל עוד LYR.LIVE=false, וואטסאפ יוצא רק לטלפונים שב-LYR.TEST_PHONES, ומייל "לליאור" מגיע רק לאולפן
 * (עם הכותרת [בדיקה]) – כך אפשר לראות על פניות אמיתיות מה המערכת הייתה עושה, בלי שום השפעה.
 */
/* ------------------------------- setup (editor) ------------------------------ */
/** מריצים פעם אחת מהעורך: מתקין את הבדיקה השעתית ויוצר את תיקיית השאלונים. */
function lyrInstall() {
  const P = PropertiesService.getScriptProperties();
  P.deleteProperty('LYR_SECRET');   // לא בשימוש – ההודעה מקאלה רק מפעילה בדיקה מול קאלה עצמה
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'lyrSweep').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('lyrSweep').timeBased().everyHours(1).create();
  lyrFolder_();
  Logger.log('lyrSweep hourly trigger installed; folder ' + P.getProperty('LYR_FOLDER'));
}

/** בדיקה מהעורך: מה המערכת מחליטה עבור טלפון מסוים (בלי לשלוח כלום) */
function lyrTestStatus() { Logger.log(JSON.stringify(lyrStatus_('547689850'))); }

const LYR = {
  LIVE: true,                                    // נפתח ללקוחות 07/11/2026 באישור אורן
  TEST_PHONES: ['547689850'],                    // הטלפון של אורן
  WRITER_TO: 'liorip.music@gmail.com',           // ליאור פרץ
  STUDIO: 'kolot.studios@gmail.com',
  PRODUCT_ID: 75982, PRICE: '550 ₪',
  CART: 'https://kolot.kala-crm.co.il/order/cart_buy?id=75982',
  TRG_PAY: 718, TRG_SONG: 719, TRG_SENT: 722,   // 722 → תבנית 328 "השאלון עבר לכתיבה"
  PAGE: 'https://www.kolot-studios.com/category/' + encodeURIComponent('טופס-כתיבת-מילים-מקוריות'),
  CLIP_TYPE: 2626,
  WON: [1794, 1795, 1800, 1801, 1815, 1816, 1819, 1907],   // סטטוסים של הזמנה סגורה (closed_won)
  PAID: 1795,
  LYRIC_IDS: [75982, 75863, 75893, 75942, 76100, 76147, 76233],  // מוצרי כתיבת מילים (בנוסף לזיהוי לפי שם)
  MAX_PER_HOUR: 40, MAX_PER_PHONE_DAY: 4, DAYS: 45
};

/* ---------------------------------- entry ---------------------------------- */
function lyrPost_(d) {
  try {
    if (d.action === 'submit') return lyrOut_(lyrSubmit_(d));
    if (d.action === 'song_get') return lyrOut_(lyrSongGet_(d));
    if (d.action === 'song_set') return lyrOut_(lyrSongSet_(d));
    if (d.action === 'paid') return lyrOut_(lyrPaid_(d));
    return lyrOut_({ ok: false, error: 'unknown action' });
  } catch (err) {
    lyrLog_('error', { action: d && d.action, error: String(err && err.message || err) });
    return lyrOut_({ ok: false, error: 'תקלה זמנית – נסו שוב בעוד רגע' });
  }
}
function lyrOut_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* --------------------------------- storage --------------------------------- */
// כל שאלון = קובץ JSON בתיקיית Drive "Kolot - שאלוני כתיבת מילים". אינדקס קטן ב-Script Properties.
function lyrFolder_() {
  const P = PropertiesService.getScriptProperties(); const id = P.getProperty('LYR_FOLDER');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { } }
  const f = DriveApp.createFolder('Kolot - שאלוני כתיבת מילים'); P.setProperty('LYR_FOLDER', f.getId()); return f;
}
function lyrIndex_() { try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('LYR_INDEX') || '{}'); } catch (e) { return {}; } }
function lyrSaveIndex_(idx) {
  const cut = Date.now() - 120 * 86400000;      // שומרים באינדקס 120 יום
  Object.keys(idx).forEach(k => { if ((idx[k].ts || 0) < cut) delete idx[k]; });
  PropertiesService.getScriptProperties().setProperty('LYR_INDEX', JSON.stringify(idx));
}
function lyrGet_(id) {
  const e = lyrIndex_()[id]; if (!e || !e.file) return null;
  try { return JSON.parse(DriveApp.getFileById(e.file).getBlob().getDataAsString('UTF-8')); } catch (x) { return null; }
}
function lyrPut_(rec) {
  const idx = lyrIndex_(); const e = idx[rec.id] || {};
  const body = JSON.stringify(rec, null, 1);
  if (e.file) { try { DriveApp.getFileById(e.file).setContent(body); } catch (x) { e.file = null; } }
  if (!e.file) e.file = lyrFolder_().createFile('lyrics-' + rec.id + '.json', body, 'application/json').getId();
  idx[rec.id] = { file: e.file, ts: rec.ts, phone: rec.phone9, state: rec.state, name: (rec.contact || '').slice(0, 30) };
  lyrSaveIndex_(idx);
}
function lyrTok_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 20); }
function lyrD9_(x) { return String(x || '').replace(/\D/g, '').slice(-9); }
function lyrLog_(kind, o) { try { console.log('[lyrics] ' + kind + ' ' + JSON.stringify(o).slice(0, 900)); } catch (e) { } }

/* --------------------------------- submit ---------------------------------- */
function lyrClean_(v, n) { return String(v == null ? '' : v).replace(/\r/g, '').replace(/[<>]/g, '').trim().slice(0, n || 2000); }

function lyrSubmit_(d) {
  if (d.hp) return { ok: true, state: 'sent' };                              // מלכודת בוטים – נראה הצלחה, לא עושים כלום
  if (Number(d.ms || 0) < 25000) return { ok: false, error: 'נראה שהשאלון מולא מהר מדי. נסו שוב.' };
  const phone9 = lyrD9_(d.phone);
  if (!/^5\d{8}$/.test(phone9)) return { ok: false, error: 'מספר טלפון נייד לא תקין' };
  const contact = lyrClean_(d.contact, 80), email = lyrClean_(d.email, 120);
  if (!contact) return { ok: false, error: 'חסר שם איש הקשר' };
  const ans = Array.isArray(d.answers) ? d.answers.slice(0, 30).map(a => [lyrClean_(a && a[0], 140), lyrClean_(a && a[1], 3000)]).filter(a => a[0]) : [];
  if (ans.filter(a => a[1]).length < 5) return { ok: false, error: 'חסרות תשובות בשאלון' };

  // הגבלות קצב – כל שליחה כאן יכולה להוביל להודעת וואטסאפ, אז לא נותנים לבוט להציף
  const C = CacheService.getScriptCache();
  const hk = 'lyr_h_' + Math.floor(Date.now() / 3600000), pk = 'lyr_p_' + phone9;
  const h = Number(C.get(hk) || 0), p = Number(C.get(pk) || 0);
  if (h >= LYR.MAX_PER_HOUR || p >= LYR.MAX_PER_PHONE_DAY) return { ok: false, error: 'התקבלו יותר מדי שליחות. נסו שוב מאוחר יותר או כתבו לנו בוואטסאפ.' };
  C.put(hk, String(h + 1), 3700); C.put(pk, String(p + 1), 86400);

  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    // אותו שאלון שנשלח שוב תוך 10 דקות (רענון, לחיצה כפולה) → לא יוצרים רשומה ולא שולחים שוב
    const sig = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, phone9 + JSON.stringify(ans)));
    const dup = C.get('lyr_sig_' + sig); if (dup) { const r0 = lyrGet_(dup); if (r0) return lyrPublic_(r0); }
    const rec = {
      id: lyrTok_(), ts: Date.now(), state: 'new', phone9: phone9, phone: '0' + phone9, contact: contact, email: email,
      honoree: lyrClean_(d.honoree, 80), occasion: lyrClean_(d.occasion, 120), eventDate: lyrClean_(d.eventDate, 40),
      song: lyrClean_(d.song, 120), artist: lyrClean_(d.artist, 80), answers: ans, log: []
    };
    rec.hasSong = !!rec.song && !d.noSong;
    if (!rec.hasSong) { rec.song = ''; rec.artist = ''; }
    const st = lyrStatus_(phone9);
    rec.coverage = st; rec.orderId = st.orderId || null;
    lyrRoute_(rec);
    lyrPut_(rec);
    C.put('lyr_sig_' + sig, rec.id, 600);
    lyrLog_('submit', { id: rec.id, state: rec.state, cov: st.kind, order: rec.orderId });
    return lyrPublic_(rec);
  } finally { lock.releaseLock(); }
}

/** מה הלקוח רואה – בלי פרטים מקאלה */
function lyrPublic_(rec) {
  const o = { ok: true, state: rec.state, id: rec.id };
  if (rec.state === 'await_pay') { o.payUrl = LYR.CART; o.price = LYR.PRICE; o.wa = !!rec.waPay; }
  if (rec.state === 'need_song') { o.songUrl = LYR.PAGE + '#s=' + rec.id; o.wa = !!rec.waSong; }
  return o;
}

/* ------------------------------ payment status ----------------------------- */
/** בודק בקאלה לפי הטלפון הראשי בלבד (phone / mobile של ההזמנה), אף פעם לא לפי טלפון שני בהזמנה. */
function lyrStatus_(phone9) {
  const res = { kind: 'none', orderId: null, msgOrderId: null, detail: '' };
  const j = kalaGet_('/api/v1/order?search=0' + phone9 + '&limit=40&sort[0][]=id&sort[0][]=DESC');
  if (!j || j.error || !Array.isArray(j.payload)) { res.kind = 'error'; res.detail = String(j && j.error || 'no payload').slice(0, 120); return res; }
  const since = Date.now() / 1000 - 540 * 86400;
  const orders = j.payload.filter(o => !o.deleted && [o.phone, o.mobile].map(lyrD9_).indexOf(phone9) >= 0);
  if (orders.length) res.msgOrderId = String(orders[0].id);       // ההזמנה הכי חדשה – לשליחת וואטסאפ
  for (const o of orders) {
    if ((o.created || 0) < since) continue;
    const pj = kalaGet_('/api/v1/order_product?order_id=' + o.id + '&limit=100');
    const prods = (pj && Array.isArray(pj.payload)) ? pj.payload.filter(p => !p.deleted && String(p.order_id) === String(o.id)) : [];
    for (const p of prods) {
      const t = String(p.title || ''), s = Number(p.status_id), pid = Number(p.page_id);
      const won = LYR.WON.indexOf(s) >= 0;
      const isClip = Number(p.page_type_id) === LYR.CLIP_TYPE && !/טייק|^\s*X\s*$/i.test(t) && !/דמי ביטול|מקדמה|קיזוז/.test(t);
      const isLyr = LYR.LYRIC_IDS.indexOf(pid) >= 0 || /כתיבת מילים/.test(t);
      if (isClip && won) return Object.assign(res, { kind: 'clip', orderId: String(o.id), detail: t });
      if (isLyr && (s === LYR.PAID || (won && /חלק מחבילה/.test(t)))) return Object.assign(res, { kind: 'paid', orderId: String(o.id), detail: t });
    }
  }
  return res;
}

/* --------------------------------- routing --------------------------------- */
function lyrRoute_(rec) {
  const k = rec.coverage && rec.coverage.kind;
  if (k === 'clip' || k === 'paid') {
    if (rec.hasSong) { lyrSendWriter_(rec); rec.state = 'sent'; }
    else { rec.state = 'need_song'; lyrAskSong_(rec); }
    return;
  }
  rec.state = 'await_pay';
  if (k === 'error') { lyrAlert_('לא הצלחתי לבדוק בקאלה – שאלון ממתין', rec, 'הבדיקה בקאלה נכשלה (' + rec.coverage.detail + '). השאלון סומן כממתין לתשלום, והבדיקה תחזור כל שעה.'); }
  lyrAskPay_(rec);
}

function lyrTarget_(rec) {
  if (!LYR.LIVE && LYR.TEST_PHONES.indexOf(rec.phone9) < 0) return { ok: false, test: true };
  return { ok: true, phone: rec.phone };
}

function lyrWa_(rec, trg, data, what) {
  const t = lyrTarget_(rec);
  if (!t.ok) { rec.log.push([Date.now(), what + ': מצב בדיקה – לא נשלח ללקוח']); return false; }
  let orderId = (rec.coverage && rec.coverage.msgOrderId) || rec.orderId;
  if (!orderId) orderId = lyrCreateOrder_(rec);
  if (!orderId) { rec.log.push([Date.now(), what + ': אין הזמנה בקאלה ולא הצלחתי ליצור – לא נשלח']); lyrAlert_('לא נשלח וואטסאפ ללקוח', rec, 'אין לטלפון הזה הזמנה בקאלה, ויצירת הזמנה נכשלה. צריך לשלוח ללקוח ידנית: ' + what); return false; }
  const r = lyrKala_(trg, orderId, Object.assign({ send_to: t.phone, first_name: lyrFirst_(rec.contact) }, data));
  rec.log.push([Date.now(), what + (r.ok ? ': נשלח (הזמנה ' + orderId + ')' : ': נכשל ' + JSON.stringify(r).slice(0, 160))]);
  if (!r.ok) lyrAlert_('שליחת וואטסאפ נכשלה', rec, what + ' – ' + JSON.stringify(r).slice(0, 300));
  return !!r.ok;
}
/** מפעיל אוטומציה מסוג "קריאה נכנסת" בקאלה (718 / 719).
 *  לאוטומציות האלה הוגדר בקאלה אותו מפתח כמו לאוטומציית הקריוקי 712, שכבר שמור בפרויקט (KALA_TRIGGER_KEY_712),
 *  כך שלא היה צורך להעתיק מפתחות חדשים. אפשר לתת לכל אחת מפתח משלה: KALA_TRIGGER_KEY_718 / _719 גוברים אם קיימים. */
function lyrKala_(trg, orderId, data) {
  const P = PropertiesService.getScriptProperties();
  const tk = P.getProperty('KALA_TRIGGER_KEY_' + trg) || P.getProperty('KALA_TRIGGER_KEY_712');
  if (!tk) return { ok: false, error: 'חסר מפתח אוטומציה בקאלה' };
  const r = UrlFetchApp.fetch('https://kolot.kala-crm.co.il/trigger/' + trg + '?trigger_key=' + encodeURIComponent(tk) + '&order_id=' + encodeURIComponent(orderId),
    { method: 'post', contentType: 'application/json', payload: JSON.stringify(Object.assign({ order_id: orderId }, data)), muteHttpExceptions: true, followRedirects: false });
  const code = r.getResponseCode(), body = r.getContentText().slice(0, 200);
  if (code < 300 && !/"error"\s*:\s*true/.test(body)) return { ok: true };
  return { ok: false, error: 'קאלה החזירה ' + code, detail: body };
}
function lyrFirst_(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }

function lyrAskPay_(rec) {
  if (rec.waPay && Date.now() - rec.waPay < 20 * 3600000) return;
  if (lyrWa_(rec, LYR.TRG_PAY, { lyr_price: LYR.PRICE, lyr_pay_link: LYR.CART }, 'לינק לתשלום')) rec.waPay = Date.now();
}
function lyrAskSong_(rec) {
  if (rec.waSong && Date.now() - rec.waSong < 20 * 3600000) return;
  if (lyrWa_(rec, LYR.TRG_SONG, { lyr_song_link: LYR.PAGE + '#s=' + rec.id }, 'בקשה לבחור מנגינה')) rec.waSong = Date.now();
}

/** לקוח בלי שום הזמנה בקאלה – פותחים הזמנה "מעוניין בשירות" כדי שאפשר יהיה לשלוח לו וואטסאפ ולעקוב */
function lyrCreateOrder_(rec) {
  try {
    const key = PropertiesService.getScriptProperties().getProperty('KALA_KEY');
    const body = { full_name: rec.contact, phone: rec.phone, mobile: rec.phone, email: rec.email, status_id: 1793,
      comments: 'מילא/ה שאלון כתיבת מילים באתר (' + (rec.honoree || '') + (rec.occasion ? ', ' + rec.occasion : '') + '). ממתין לתשלום על כתיבת מילים וגייד.' };
    const r = UrlFetchApp.fetch('https://kolot.kala-crm.co.il/api/v1/order', { method: 'post', contentType: 'application/json', headers: { 'X-Collect-Key': key, Accept: 'application/json' }, payload: JSON.stringify(body), muteHttpExceptions: true });
    const j = JSON.parse(r.getContentText() || '{}'); const id = j && j.payload && j.payload.id;
    if (id) { rec.createdOrder = String(id); rec.coverage.msgOrderId = String(id); rec.log.push([Date.now(), 'נפתחה הזמנה בקאלה ' + id]); return String(id); }
    rec.log.push([Date.now(), 'יצירת הזמנה נכשלה ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 120)]);
  } catch (e) { rec.log.push([Date.now(), 'יצירת הזמנה נכשלה ' + e]); }
  return null;
}

/* ------------------------------ mail to writer ------------------------------ */
function lyrEsc_(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'); }

function lyrSendWriter_(rec) {
  if (rec.sentAt) return true;
  const live = LYR.LIVE;   // במצב בדיקה המייל לכותבת מגיע רק לאולפן – גם עבור הטלפון של אורן
  const cov = rec.coverage || {};
  const why = cov.kind === 'clip' ? 'כלול בקליפ (הזמנה ' + cov.orderId + ' – ' + cov.detail + ')' : cov.kind === 'paid' ? 'שולם (הזמנה ' + cov.orderId + ' – ' + cov.detail + ')' : 'אושר';
  const subj = (live ? '' : '[בדיקה – במצב פעיל היה נשלח לליאור] ') + 'שאלון לכתיבת מילים – ' + (rec.honoree || rec.contact) + (rec.occasion ? ' (' + rec.occasion + ')' : '');
  const head = [
    ['מנגינה', rec.song + (rec.artist ? ' – ' + rec.artist : '')],
    ['החוגג/ת', rec.honoree], ['מה חוגגים', rec.occasion], ['מועד האירוע', rec.eventDate],
    ['איש קשר', rec.contact + ' · ' + rec.phone + (rec.email ? ' · ' + rec.email : '')],
    ['סטטוס', why]
  ].filter(r => r[1]);
  const rows = rec.answers.filter(a => a[1]);
  const txt = head.map(r => r[0] + ': ' + r[1]).join('\n') + '\n\n' + rows.map(a => a[0] + '\n' + a[1]).join('\n\n') +
    '\n\n—\nנשלח אוטומטית מהשאלון באתר אולפני קולות. לשאלות על הלקוח – ענו למייל הזה (הוא חוזר לאולפן).';
  const html = '<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:680px">' +
    '<div style="background:#2b1450;color:#fff;border-radius:12px;padding:14px 18px;margin-bottom:14px"><div style="font-size:19px;font-weight:bold">שאלון חדש לכתיבת מילים ✍️</div>' +
    '<div style="margin-top:6px;font-size:16px">🎵 מנגינה: <b>' + lyrEsc_(head[0][1]) + '</b></div></div>' +
    '<table style="border-collapse:collapse;width:100%;margin-bottom:16px">' + head.slice(1).map(r => '<tr><td style="padding:6px 8px;color:#666;white-space:nowrap;vertical-align:top">' + lyrEsc_(r[0]) + '</td><td style="padding:6px 8px;font-weight:bold">' + lyrEsc_(r[1]) + '</td></tr>').join('') + '</table>' +
    rows.map(a => '<div style="margin:0 0 14px"><div style="color:#5a2d91;font-weight:bold;margin-bottom:4px">' + lyrEsc_(a[0]) + '</div><div style="background:#f7f5fa;border-radius:8px;padding:10px 12px;line-height:1.6">' + lyrEsc_(a[1]) + '</div></div>').join('') +
    '<div style="color:#999;font-size:12px;margin-top:20px">נשלח אוטומטית מהשאלון באתר אולפני קולות. לשאלות על הלקוח – ענו למייל הזה (הוא חוזר לאולפן).</div></div>';
  const opt = { to: live ? LYR.WRITER_TO : LYR.STUDIO, subject: subj, body: txt, htmlBody: html, name: 'אולפני קולות – שאלון כתיבת מילים', replyTo: LYR.STUDIO };
  if (live) opt.cc = LYR.STUDIO;
  try { MailApp.sendEmail(opt); rec.sentAt = Date.now(); rec.log.push([Date.now(), live ? 'נשלח לליאור' : 'מצב בדיקה – נשלח לאולפן בלבד']); lyrTellSent_(rec); return true; }
  catch (e) { rec.log.push([Date.now(), 'שליחת מייל נכשלה ' + e]); lyrAlert_('שליחת השאלון לליאור נכשלה', rec, String(e)); return false; }
}

/** הודעה ייעודית ללקוח: השאלון עבר לכתיבה (במקום הודעת הפתיחה הכללית של הסוכן) – פעם אחת */
function lyrTellSent_(rec) {
  if (rec.waSent) return;
  if (lyrWa_(rec, LYR.TRG_SENT, { lyr_honoree: rec.honoree || 'השיר שלכם' }, 'הודעה: השאלון עבר לכתיבה')) rec.waSent = Date.now();
}

function lyrAlert_(title, rec, text) {
  try { MailApp.sendEmail({ to: LYR.STUDIO, subject: '⚠️ שאלון כתיבת מילים: ' + title, body: text + '\n\nלקוח: ' + rec.contact + ' ' + rec.phone + '\nחוגג/ת: ' + (rec.honoree || '') + '\nמזהה: ' + rec.id, name: 'מערכת שאלון כתיבת המילים' }); } catch (e) { }
}

/* ------------------------------- song update -------------------------------- */
function lyrSongGet_(d) {
  const rec = lyrGet_(String(d.id || '')); if (!rec) return { ok: false, error: 'הלינק לא נמצא או שפג תוקפו' };
  return { ok: true, name: lyrFirst_(rec.contact), honoree: rec.honoree, song: rec.song, artist: rec.artist, state: rec.state };
}
function lyrSongSet_(d) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const rec = lyrGet_(String(d.id || '')); if (!rec) return { ok: false, error: 'הלינק לא נמצא או שפג תוקפו' };
    const song = lyrClean_(d.song, 120), artist = lyrClean_(d.artist, 80);
    if (!song) return { ok: false, error: 'כתבו את שם השיר' };
    if (rec.sentAt) return { ok: true, state: 'sent', already: true };
    rec.song = song; rec.artist = artist; rec.hasSong = true;
    rec.answers.push(['מנגינה (עודכנה אחרי השליחה)', song + (artist ? ' – ' + artist : '')]);
    rec.log.push([Date.now(), 'הלקוח עדכן מנגינה']);
    if (rec.state === 'need_song') { lyrSendWriter_(rec); rec.state = rec.sentAt ? 'sent' : rec.state; }
    lyrPut_(rec);
    return lyrPublic_(rec);
  } finally { lock.releaseLock(); }
}

/* ------------------------------ payment arrived ----------------------------- */
// נקרא מאוטומציה בקאלה: מוצר מסוג 2619 עבר ל"שולם במלואו".
// אין צורך בסוד: ההודעה רק מפעילה בדיקה מול קאלה (lyrStatus_), כך שהודעה מזויפת לא יכולה להעביר שאלון בלי תשלום אמיתי.
function lyrPaid_(d) {
  const pid = Number(d.page_id || 0);
  if (pid && LYR.LYRIC_IDS.indexOf(pid) < 0) return { ok: true, ignored: true };
  const phones = [d.phone, d.mobile].map(lyrD9_).filter(x => x.length === 9);
  if (!phones.length) return { ok: false, error: 'no phone' };
  const C = CacheService.getScriptCache(), k = 'lyr_paid_' + phones[0];
  if (C.get(k)) return { ok: true, throttled: true }; C.put(k, '1', 60);
  return { ok: true, handled: lyrRecheck_(phones, 'webhook ' + (d.order_id || '')) };
}

/** בודק שוב שאלונים שממתינים לתשלום (לפי טלפון, או את כולם) */
function lyrRecheck_(phones, why) {
  const lock = LockService.getScriptLock(); lock.waitLock(25000);
  let n = 0;
  try {
    const idx = lyrIndex_(); const cut = Date.now() - LYR.DAYS * 86400000;
    Object.keys(idx).forEach(id => {
      const e = idx[id];
      if (e.state !== 'await_pay' || (e.ts || 0) < cut) return;
      if (phones && phones.indexOf(e.phone) < 0) return;
      const rec = lyrGet_(id); if (!rec) return;
      const st = lyrStatus_(rec.phone9);
      if (st.kind !== 'clip' && st.kind !== 'paid') return;
      rec.coverage = st; rec.orderId = st.orderId; rec.log.push([Date.now(), 'תשלום זוהה (' + why + ')']);
      if (rec.hasSong) { lyrSendWriter_(rec); rec.state = rec.sentAt ? 'sent' : 'await_pay'; }
      else { rec.state = 'need_song'; lyrAskSong_(rec); }
      lyrPut_(rec); n++;
    });
  } finally { lock.releaseLock(); }
  return n;
}

/** רץ כל שעה (lyrInstall): תשלומים שלא הגיעו ב-webhook, ותזכורת אחת לבחירת מנגינה אחרי יומיים */
function lyrSweep() {
  lyrRecheck_(null, 'בדיקה שעתית');
  const idx = lyrIndex_(); const now = Date.now();
  Object.keys(idx).forEach(id => {
    const e = idx[id]; if (e.state !== 'need_song' || now - (e.ts || 0) > 14 * 86400000) return;
    const rec = lyrGet_(id); if (!rec || rec.songReminded || !rec.waSong || now - rec.waSong < 48 * 3600000) return;
    rec.waSong = 0; lyrAskSong_(rec); rec.songReminded = now; lyrPut_(rec);
  });
}
