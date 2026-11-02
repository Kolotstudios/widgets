/** Kolot – Family karaoke backend (kolot.studios). Web app: execute as me, anyone.
 * Script properties (set by Oren, never logged): KARAOKE_ADMIN_PASSWORD, OPENAI_API_KEY.
 * Storage: Drive folder "Kolot Karaoke" (scope drive.file = only files this script creates).
 * Run kkAuthorize once from the editor to approve the permissions. */
function doGet() { return kkOut_({ ok: true, service: 'kolot-karaoke' }); }
function doPost(e) {
  let d = {}; try { d = JSON.parse(e.postData.contents); } catch (x) { return kkOut_({ ok: false, error: 'bad request' }); }
  const P = PropertiesService.getScriptProperties();
  try {
    if (d.action === 'ping') return kkOut_({ ok: true, admin: !!P.getProperty('KARAOKE_ADMIN_PASSWORD'), whisper: !!P.getProperty('OPENAI_API_KEY'), store: true });
    if (d.action === 'kk_open' || d.action === 'kk_update') return kkOut_(kkClient_(d, P));
    const pw = P.getProperty('KARAOKE_ADMIN_PASSWORD');
    if (d.action === 'setup') return kkOut_(kkSetup_(d, P, pw));
    if (!pw || String(d.pass || '') !== pw) return kkOut_({ ok: false, error: 'סיסמה שגויה' });
    if (d.action === 'login') return kkOut_({ ok: true });
    if (d.action === 'transcribe') return kkOut_(kkTranscribe_(d, P));
    if (/^kk_/.test(d.action)) return kkOut_(kkStaff_(d, P));
    return kkOut_({ ok: false, error: 'unknown action' });
  } catch (err) { return kkOut_({ ok: false, error: String(err.message || err).slice(0, 200) }); }
}
function kkSetup_(d, P, pw) {
  if (pw && String(d.pass || '') !== pw) return { ok: false, error: 'כבר הוגדרה סיסמה – צריך את הסיסמה הנוכחית כדי לשנות' };
  const key = String(d.key || '').trim(), np = String(d.newPass || '').trim();
  if (np.length < 6) return { ok: false, error: 'סיסמה של 6 תווים לפחות' };
  if (key) {
    if (!/^sk-/.test(key)) return { ok: false, error: 'המפתח צריך להתחיל ב-sk-' };
    const r = UrlFetchApp.fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + key }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return { ok: false, error: 'OpenAI לא קיבלה את המפתח (' + r.getResponseCode() + ')' };
    P.setProperty('OPENAI_API_KEY', key);
  } else if (!P.getProperty('OPENAI_API_KEY')) return { ok: false, error: 'חסר מפתח OpenAI' };
  P.setProperty('KARAOKE_ADMIN_PASSWORD', np);
  return { ok: true };
}
function kkTranscribe_(d, P) {
  const key = P.getProperty('OPENAI_API_KEY');
  if (!key) return { ok: false, error: 'חסר מפתח OpenAI' };
  if (!d.audio) return { ok: false, error: 'no audio' };
  const blob = Utilities.newBlob(Utilities.base64Decode(d.audio), d.mime || 'audio/wav', d.name || 'guide.wav');
  const r = UrlFetchApp.fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'post', headers: { Authorization: 'Bearer ' + key }, muteHttpExceptions: true,
    payload: { file: blob, model: 'whisper-1', language: 'he', response_format: 'verbose_json', 'timestamp_granularities[]': 'word', prompt: String(d.prompt || '').slice(0, 900) } });
  const code = r.getResponseCode(), txt = r.getContentText();
  if (code !== 200) return { ok: false, error: 'OpenAI ' + code + ': ' + txt.slice(0, 300) };
  const j = JSON.parse(txt);
  return { ok: true, duration: j.duration, text: j.text, words: (j.words || []).map(w => [w.word, w.start, w.end]) };
}
function kkOut_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* ===================== Karaoke – client projects & links =====================
 * Each client project = a JSON file (+ guide audio, + optional background image) in the Drive folder "Kolot Karaoke"
 * (created by this script; scope drive.file = only files this script made).
 * A client gets a link with a random key (#k=...). The key opens only that project, until the recording day ends.
 */
const KK_ROOT = 'Kolot Karaoke';
function kkTok_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 28); }
function kkAuth_() { return { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }; }
function kkDrive_(method, url, opt) {
  const r = UrlFetchApp.fetch(url, Object.assign({ method: method, headers: kkAuth_(), muteHttpExceptions: true }, opt || {}));
  if (r.getResponseCode() >= 300) throw new Error('Drive ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200));
  return r;
}
function kkFolder_(P) {
  let id = P.getProperty('KK_FOLDER');
  if (id) return id;
  const r = kkDrive_('post', 'https://www.googleapis.com/drive/v3/files', { contentType: 'application/json', payload: JSON.stringify({ name: KK_ROOT, mimeType: 'application/vnd.google-apps.folder' }) });
  id = JSON.parse(r.getContentText()).id; P.setProperty('KK_FOLDER', id); return id;
}
function kkPut_(P, fileId, name, blob) { // create or replace a file's content; returns id
  if (fileId) { kkDrive_('patch', 'https://www.googleapis.com/upload/drive/v3/files/' + fileId + '?uploadType=media', { contentType: blob.getContentType(), payload: blob.getBytes() }); return fileId; }
  const meta = { name: name, parents: [kkFolder_(P)] };
  const bnd = 'kk' + Date.now();
  const head = '--' + bnd + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + bnd + '\r\nContent-Type: ' + blob.getContentType() + '\r\n\r\n';
  const body = Utilities.newBlob(head).getBytes().concat(blob.getBytes()).concat(Utilities.newBlob('\r\n--' + bnd + '--').getBytes());
  const r = kkDrive_('post', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { contentType: 'multipart/related; boundary=' + bnd, payload: body });
  return JSON.parse(r.getContentText()).id;
}
function kkGet_(fileId) { return kkDrive_('get', 'https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media'); }
function kkIndex_(P) { const id = P.getProperty('KK_INDEX'); if (!id) return {}; try { return JSON.parse(kkGet_(id).getContentText()); } catch (e) { return {}; } }
function kkSaveIndex_(P, idx) { const id = kkPut_(P, P.getProperty('KK_INDEX'), 'index.json', Utilities.newBlob(JSON.stringify(idx), 'application/json')); P.setProperty('KK_INDEX', id); }
function kkExpires_(recDate, created) { // end of the recording day, Israel time; no date -> 60 days from creation
  if (recDate && /^\d{4}-\d{2}-\d{2}$/.test(recDate)) return new Date(recDate + 'T23:59:59+02:00').getTime() + 3600000;
  return (created || Date.now()) + 60 * 86400000;
}
function kkState_(e) { const now = Date.now(); const exp = e.expires || kkExpires_(e.recDate, e.created); return { editable: !e.closed && now <= exp, expires: exp, recDate: e.recDate || '', closed: !!e.closed }; }

function kkIsoDate_(v) {
  v = String(v || '').trim(); if (!v) return '';
  if (/^\d{9,13}$/.test(v)) { let n = +v; if (n < 1e12) n *= 1000; return Utilities.formatDate(new Date(n), 'Asia/Jerusalem', 'yyyy-MM-dd'); }
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = v.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/); if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2); }
  return '';
}

function kkStaff_(d, P) {
  const lock = LockService.getScriptLock();
  if (d.action === 'kk_list') { const idx = kkIndex_(P); return { ok: true, items: Object.keys(idx).map(k => Object.assign({ k: k }, idx[k], kkState_(idx[k]))).sort((a, b) => (b.updated || 0) - (a.updated || 0)) }; }
  if (d.action === 'kk_load') { const idx = kkIndex_(P); const e = idx[d.k]; if (!e) return { ok: false, error: 'לא נמצא' }; return kkFull_(d.k, e); }
  lock.waitLock(20000);
  try {
    const idx = kkIndex_(P);
    if (d.action === 'kk_save') {
      let k = d.k && idx[d.k] ? d.k : kkTok_(); const e = idx[k] || { created: Date.now() };
      const m = d.meta || {};
      e.name = String(m.name || e.name || '').slice(0, 80); e.orderId = String(m.orderId || e.orderId || '').replace(/\D/g, '');
      if (m.recDate !== undefined) { e.recDate = /^\d{4}-\d{2}-\d{2}$/.test(m.recDate) ? m.recDate : ''; e.expires = kkExpires_(e.recDate, e.created); }
      if (!e.expires) e.expires = kkExpires_(e.recDate, e.created);
      e.json = kkPut_(P, e.json, k + '.json', Utilities.newBlob(JSON.stringify(d.project || {}), 'application/json'));
      if (d.audio) e.audio = kkPut_(P, e.audio, k + '.audio', Utilities.newBlob(Utilities.base64Decode(d.audio), d.mime || 'audio/mpeg'));
      if (d.img) e.img = kkPut_(P, e.img, k + '.img', Utilities.newBlob(Utilities.base64Decode(d.img), 'image/jpeg'));
      e.title = String((d.project || {}).title || '').slice(0, 80); e.updated = Date.now(); e.by = 'staff';
      idx[k] = e; kkSaveIndex_(P, idx); return Object.assign({ ok: true, k: k }, kkState_(e));
    }
    if (d.action === 'kk_meta') {
      const e = idx[d.k]; if (!e) return { ok: false, error: 'לא נמצא' };
      if (d.closed !== undefined) e.closed = !!d.closed;
      if (d.extendDays) e.expires = Math.max(Date.now(), e.expires || 0) + d.extendDays * 86400000;
      if (d.recDate !== undefined) { e.recDate = d.recDate; e.expires = kkExpires_(e.recDate, e.created); }
      if (d.remove) { delete idx[d.k]; kkSaveIndex_(P, idx); return { ok: true, removed: true }; }
      kkSaveIndex_(P, idx); return Object.assign({ ok: true }, kkState_(e));
    }
  } finally { lock.releaseLock(); }
  return { ok: false, error: 'unknown action' };
}
function kkFull_(k, e) {
  const out = { ok: true, k: k, name: e.name || '', state: kkState_(e) };
  out.project = JSON.parse(kkGet_(e.json).getContentText());
  if (e.audio) { const r = kkGet_(e.audio); out.audio = Utilities.base64Encode(r.getContent()); out.mime = r.getHeaders()['Content-Type'] || 'audio/mpeg'; }
  if (e.img) out.img = Utilities.base64Encode(kkGet_(e.img).getContent());
  return out;
}
/** Client side: only with the project's key; can change people / split / look while the link is open. */
function kkClient_(d, P) {
  const k = String(d.k || ''); if (!/^[a-f0-9]{20,40}$/.test(k)) return { ok: false, error: 'לינק לא תקין' };
  if (d.action === 'kk_open') { const e = kkIndex_(P)[k]; if (!e) return { ok: false, error: 'הלינק לא נמצא. בדקו שהעתקתם אותו במלואו.' }; const f = kkFull_(k, e); return f; }
  if (d.action === 'kk_update') {
    const lock = LockService.getScriptLock(); lock.waitLock(20000);
    try {
      const idx = kkIndex_(P); const e = idx[k]; if (!e) return { ok: false, error: 'הלינק לא נמצא' };
      const st = kkState_(e); if (!st.editable) return { ok: false, locked: true, error: 'מועד ההקלטה עבר – החלוקה נעולה. לשינויים צרו קשר.' };
      const pr = JSON.parse(kkGet_(e.json).getContentText());
      const c = d.changes || {};
      ['people', 'assign', 'bg', 'ratio'].forEach(f => { if (c[f] !== undefined) pr[f] = c[f]; });
      kkPut_(P, e.json, k + '.json', Utilities.newBlob(JSON.stringify(pr), 'application/json'));
      if (d.img) e.img = kkPut_(P, e.img, k + '.img', Utilities.newBlob(Utilities.base64Decode(d.img), 'image/jpeg'));
      e.updated = Date.now(); e.by = 'client'; e.people = (pr.people || []).length; idx[k] = e; kkSaveIndex_(P, idx);
      return Object.assign({ ok: true }, kkState_(e));
    } finally { lock.releaseLock(); }
  }
  return { ok: false, error: 'unknown action' };
}
/** Run once from the editor to approve the new Drive permission (only files this script creates). */
function kkAuthorize() { const P = PropertiesService.getScriptProperties(); Logger.log('folder ' + kkFolder_(P) + ' · password ' + (P.getProperty('KARAOKE_ADMIN_PASSWORD') ? 'yes' : 'no') + ' · OpenAI ' + (P.getProperty('OPENAI_API_KEY') ? 'yes' : 'no')); }
