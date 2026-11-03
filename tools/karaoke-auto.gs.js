
/* ===================== Karaoke – automatic send + 3-day check =====================
 * Kala automations (incoming webhook) that message the customer. 0 = not active yet (nothing is sent).
 */
const KK_TRIGGER_LINK = 712;    // Kala automation (incoming webhook) -> WhatsApp template 323 "הלינק לחלוקה מוכן" to {{send_to}}
const KK_TRIGGER_REMIND = 713;  // Kala automation (incoming webhook) -> WhatsApp template 324 "תזכורת: החלוקה לא הושלמה" to {{send_to}}
/** TEST MODE: messages go out only to these phones (last 9 digits). Empty list [] = send to every customer. */
const KK_ONLY_TO = ['547689850'];
const KK_PAGE = 'https://www.kolot-studios.com/category/' + encodeURIComponent('קריוקי-משפחתי');
function kkLink_(k) { return KK_PAGE + '#k=' + k; }
/** Participants range from the clip product's name (catalog: בייסיק 5, משפחתי 10, סמארטפונים 10, מורחב 11-30, משפחתי + 20, נייד 15, פרימיום 30). */
function kkRange_(title) {
  const t = String(title || '');
  let m = t.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})/); if (m) return { min: +m[1] > 1 ? +m[1] : 0, max: +m[2] };
  m = t.match(/עד\s*(\d{1,2})/); if (m) return { min: 0, max: +m[1] };
  const map = [[/פרימיום/, 30], [/משפחתי\s*\+|\+/, 20], [/מורחב/, 30, 11], [/נייד/, 15], [/סמארטפונ/, 10], [/משפחתי/, 10], [/בייסיק|בסיסי/, 5]];
  for (const x of map) if (x[0].test(t)) return { min: x[2] || 0, max: x[1] };
  return { min: 0, max: 0 };
}
function kkD9_(x) { return String(x || '').replace(/\D/g, '').slice(-9); }
/** Who may receive a message for this song: ONLY the primary phone of that same order.
 *  Never the order's second phone, never another order of the same person (e.g. a surprise clip a husband orders for his wife,
 *  whose old order lists his number as the second phone). If the phone typed at upload does not match the order's primary phone - nothing is sent. */
function kkTarget_(e) {
  if (!e.orderId) return { ok: false, error: 'אין מספר הזמנה – אי אפשר לשלוח' };
  const j = kalaGet_('/api/v1/order/' + e.orderId); const o = (j && (j.payload || (j.id ? j : null))) || null;
  if (!o || !o.id) return { ok: false, error: 'ההזמנה ' + e.orderId + ' לא נמצאה בקאלה' };
  if (o.deleted) return { ok: false, error: 'ההזמנה ' + e.orderId + ' מחוקה בקאלה' };
  const prim = kkD9_(o.phone); if (prim.length < 9) return { ok: false, error: 'בהזמנה ' + e.orderId + ' אין טלפון ראשי' };
  if (e.phone && kkD9_(e.phone) !== prim) return { ok: false, error: 'הטלפון שהוזן בהעלאה לא זהה לטלפון הראשי בהזמנה – לא נשלח (מניעת שליחה למספר אחר בהזמנה)' };
  if (KK_ONLY_TO.length && KK_ONLY_TO.indexOf(prim) < 0) return { ok: false, test: true, error: 'מצב בדיקה – השליחה ללקוחות עוד לא פתוחה (נשלח רק לאורן)' };
  return { ok: true, phone: '0' + prim };
}
function kkNeed_(e) { const max = +e.maxP || 0, min = +e.minP || 0; if (!max) return 0; return min || Math.ceil(max / 2); }
/** Call a Kala incoming-webhook automation for an order. Uses the API key already stored (no extra keys). */
function kkKala_(triggerId, orderId, data) {
  const P = PropertiesService.getScriptProperties(); const key = P.getProperty('KALA_KEY');
  const tries = [];
  const r1 = UrlFetchApp.fetch('https://kolot.kala-crm.co.il/api/v1/trigger/' + triggerId + '/execute?order_id=' + orderId, { method: 'post', contentType: 'application/json', headers: { 'X-Collect-Key': key }, payload: JSON.stringify(Object.assign({ order_id: orderId }, data)), muteHttpExceptions: true, followRedirects: false });
  tries.push('a:' + r1.getResponseCode() + ':' + r1.getContentText().slice(0, 100));
  if (r1.getResponseCode() < 300 && !/"error":true|unauthor|denied/i.test(r1.getContentText())) return { ok: true, via: 'api' };
  const tk = P.getProperty('KALA_TRIGGER_KEY_' + triggerId);
  if (tk) {
    const r2 = UrlFetchApp.fetch('https://kolot.kala-crm.co.il/trigger/' + triggerId + '?trigger_key=' + encodeURIComponent(tk) + '&order_id=' + orderId, { method: 'post', contentType: 'application/json', payload: JSON.stringify(Object.assign({ order_id: orderId }, data)), muteHttpExceptions: true, followRedirects: false });
    tries.push('q:' + r2.getResponseCode() + ':' + r2.getContentText().slice(0, 100));
    if (r2.getResponseCode() < 300) return { ok: true, via: 'key' };
  }
  return { ok: false, error: 'קאלה לא קיבלה את הבקשה', tries: tries };
}
function kkSend_(P, k) {
  if (!KK_TRIGGER_LINK) return { ok: false, error: 'השליחה האוטומטית עוד לא הופעלה (מחכה לאישור הנוסח)' };
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const idx = kkIndex_(P); const e = idx[k]; if (!e) return { ok: false, error: 'לא נמצא' };
    if (!e.orderId) return { ok: false, error: 'אין מספר הזמנה – אי אפשר לשלוח דרך קאלה' };
    if (e.sentAt) return { ok: true, already: true };
    const to = kkTarget_(e); if (!to.ok) return to;
    const r = kkKala_(KK_TRIGGER_LINK, e.orderId, { send_to: to.phone, karaoke_link: kkLink_(k), karaoke_title: e.title || '' });
    if (!r.ok) return r;
    e.sentAt = Date.now(); delete e.needsReview; idx[k] = e; kkSaveIndex_(P, idx); return { ok: true };
  } finally { lock.releaseLock(); }
}
/** Daily (time trigger): 3 days before the recording, remind customers whose split is missing / too small. Once per project. */
function kkDaily() {
  if (!KK_TRIGGER_REMIND) return;
  const P = PropertiesService.getScriptProperties(); const idx = kkIndex_(P); const now = Date.now(); let changed = false; const log = [];
  Object.keys(idx).forEach(k => {
    const e = idx[k]; if (!e.recDate || e.closed || e.reminded || !e.orderId || !e.sentAt) return;
    const days = (new Date(e.recDate + 'T09:00:00+02:00').getTime() - now) / 86400000;
    if (days > 3.2 || days < 0.5) return;
    let pr = {}; try { pr = JSON.parse(kkGet_(e.json).getContentText()); } catch (x) { return; }
    const lines = pr.lines || [], assign = pr.assign || {};
    const gaps = lines.filter((l, i) => !l.chorus && !(assign[i] || []).length).length;
    const singers = (pr.people || []).filter(p => !p.group).length; const need = kkNeed_(e);
    const reason = !singers ? 'no-split' : gaps ? 'gaps:' + gaps : (need && singers < need) ? 'few:' + singers + '/' + need : '';
    if (!reason) return;
    const to = kkTarget_(e); if (!to.ok) { log.push(k.slice(0, 6) + ' ' + reason + (to.test ? ' test-skip' : ' fail:' + to.error)); return; }
    const r = kkKala_(KK_TRIGGER_REMIND, e.orderId, { send_to: to.phone, karaoke_link: kkLink_(k), rec_date: e.recDate.split('-').reverse().join('/').slice(0, 5) });
    log.push(k.slice(0, 6) + ' ' + reason + ' ' + (r.ok ? 'sent' : 'fail'));
    if (r.ok) { e.reminded = now; e.remindReason = reason; changed = true; }
  });
  if (changed) kkSaveIndex_(P, idx);
  const fails = log.filter(x => / fail(:|$)/.test(x)); if (fails.length) kkAlert_('⚠ קריוקי: תזכורות שלא נשלחו (' + fails.length + ')', ['הבדיקה היומית ניסתה לשלוח תזכורת ונכשלה עבור:', fails.join('\n'), '', 'כניסת צוות: ' + KK_PAGE]);
  P.setProperty('KK_DAILY_LAST', new Date().toISOString() + ' ' + log.join(' | '));
}
/* ---------- alerts to the studio (email; needs the script.send_mail scope) ---------- */
const KK_ALERT_TO = 'kolot.studios@gmail.com';
function kkAlert_(subject, lines) {
  try { MailApp.sendEmail({ to: KK_ALERT_TO, subject: subject, body: lines.join('\n'), name: 'מערכת הקריוקי – אולפני קולות' }); return true; }
  catch (e) { try { PropertiesService.getScriptProperties().setProperty('KK_ALERT_ERR', new Date().toISOString() + ' ' + e.message); } catch (x) {} return false; }
}
function kkAlertSong_(subject, k, e, why) {
  return kkAlert_(subject, [why, '', 'לקוח/ה: ' + (e.name || '-'), 'טלפון: ' + (e.phone || '-'), 'הזמנה בקאלה: ' + (e.orderId || 'לא נמצאה'), 'מוצר: ' + (e.product || '-'), 'תאריך הקלטה: ' + (e.recDate ? e.recDate.split('-').reverse().join('/') : '-'), 'שם השיר: ' + (e.title || '-'), 'הועלה ע"י: ' + (e.uploaderName || 'צוות'), '',
    'מה עושים: נכנסים לעמוד הקריוקי ← כניסת צוות ← 📋 לקוחות. פותחים את השיר, בודקים את הסנכרון' + (e.orderId ? '' : ', משלימים מספר הזמנה ב"☁ שמירה ולינק ללקוח"') + ' ושולחים.', KK_PAGE]);
}
/** Run once from the editor (approves sending email, then sends a test email to the studio). */
function kkTestAlert() { kkAlert_('בדיקה: התראות הקריוקי עובדות ✓', ['זו הודעת בדיקה ממערכת הקריוקי. מעכשיו יגיעו לכאן התראות כשגייד לא משויך ללקוח או כשלינק לא נשלח.']); Logger.log(PropertiesService.getScriptProperties().getProperty('KK_ALERT_ERR') || 'sent'); }
/** Run once from the editor: installs the daily check at ~10:00. */
function kkInstallDaily() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'kkDaily').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('kkDaily').timeBased().everyDays(1).atHour(10).create();
  Logger.log('daily karaoke check installed');
}
