
/* ===================== Karaoke – automatic send + 3-day check =====================
 * Kala automations (incoming webhook) that message the customer. 0 = not active yet (nothing is sent).
 */
const KK_TRIGGER_LINK = 0;    // "הלינק לחלוקה מוכן"
const KK_TRIGGER_REMIND = 0;  // "תזכורת: החלוקה לא הושלמה"
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
    const r = kkKala_(KK_TRIGGER_LINK, e.orderId, { karaoke_link: kkLink_(k), karaoke_title: e.title || '' });
    if (!r.ok) return r;
    e.sentAt = Date.now(); idx[k] = e; kkSaveIndex_(P, idx); return { ok: true };
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
    const r = kkKala_(KK_TRIGGER_REMIND, e.orderId, { karaoke_link: kkLink_(k), rec_date: e.recDate.split('-').reverse().join('/') });
    log.push(k.slice(0, 6) + ' ' + reason + ' ' + (r.ok ? 'sent' : 'fail'));
    if (r.ok) { e.reminded = now; e.remindReason = reason; changed = true; }
  });
  if (changed) kkSaveIndex_(P, idx);
  P.setProperty('KK_DAILY_LAST', new Date().toISOString() + ' ' + log.join(' | '));
}
/** Run once from the editor: installs the daily check at ~10:00. */
function kkInstallDaily() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'kkDaily').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('kkDaily').timeBased().everyDays(1).atHour(10).create();
  Logger.log('daily karaoke check installed');
}
