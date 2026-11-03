/** Kolot – remote blessing recorder, hosted inside the "Kolot - קריוקי" Apps Script project
 * (same permissions as the karaoke: drive.file + external requests, so no new approval is needed).
 * Routing: the karaoke doPost sends every action that starts with "rc_" to rcHandle_.
 * It runs on its own web-app deployment, so the karaoke deployment is never touched.
 * Storage: Drive folder "Kolot Recorder" (only files this script creates). Script properties: RECORDER_ADMIN_PASSWORD, RC_FOLDER, RC_INDEX.
 */
const RC_ROOT = 'Kolot Recorder';
const RC_MAX_TAKES = 10;          // recordings per sentence
const RC_MAX_UPLOADS = 600;       // per project
const RC_DAYS = 30;               // link lifetime

function rcHandle_(d, P) {
  try {
    if (d.action === 'rc_ping') return { ok: true, service: 'kolot-recorder', admin: !!P.getProperty('RECORDER_ADMIN_PASSWORD') };
    if (/^rc_c_/.test(d.action)) return rcClient_(d, P);
    const pw = P.getProperty('RECORDER_ADMIN_PASSWORD');
    if (d.action === 'rc_setup') {
      if (pw && String(d.pass || '') !== pw) return { ok: false, error: 'כבר הוגדרה סיסמה' };
      const np = String(d.newPass || '').trim(); if (np.length < 6) return { ok: false, error: 'סיסמה של 6 תווים לפחות' };
      P.setProperty('RECORDER_ADMIN_PASSWORD', np); return { ok: true };
    }
    if (!pw || String(d.pass || '') !== pw) return { ok: false, error: 'סיסמה שגויה' };
    if (d.action === 'rc_login') return { ok: true };
    return rcStaff_(d, P);
  } catch (err) { return { ok: false, error: String(err.message || err).slice(0, 200) }; }
}

/* ---------- Drive helpers (drive.file scope) ---------- */
function rcTok_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 28); }
function rcAuth_() { return { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }; }
function rcDrive_(method, url, opt) {
  const r = UrlFetchApp.fetch(url, Object.assign({ method: method, headers: rcAuth_(), muteHttpExceptions: true }, opt || {}));
  if (r.getResponseCode() >= 300) throw new Error('Drive ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200));
  return r;
}
function rcFolder_(P) {
  let id = P.getProperty('RC_FOLDER'); if (id) return id;
  const r = rcDrive_('post', 'https://www.googleapis.com/drive/v3/files', { contentType: 'application/json', payload: JSON.stringify({ name: RC_ROOT, mimeType: 'application/vnd.google-apps.folder' }) });
  id = JSON.parse(r.getContentText()).id; P.setProperty('RC_FOLDER', id); return id;
}
function rcPut_(P, fileId, name, blob) {
  if (fileId) { rcDrive_('patch', 'https://www.googleapis.com/upload/drive/v3/files/' + fileId + '?uploadType=media', { contentType: blob.getContentType(), payload: blob.getBytes() }); return fileId; }
  const meta = { name: name, parents: [rcFolder_(P)] }, bnd = 'rc' + Date.now();
  const head = '--' + bnd + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + bnd + '\r\nContent-Type: ' + blob.getContentType() + '\r\n\r\n';
  const body = Utilities.newBlob(head).getBytes().concat(blob.getBytes()).concat(Utilities.newBlob('\r\n--' + bnd + '--').getBytes());
  const r = rcDrive_('post', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { contentType: 'multipart/related; boundary=' + bnd, payload: body });
  return JSON.parse(r.getContentText()).id;
}
function rcGet_(fileId) { return rcDrive_('get', 'https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media'); }
function rcTrash_(fileId) { try { rcDrive_('patch', 'https://www.googleapis.com/drive/v3/files/' + fileId, { contentType: 'application/json', payload: JSON.stringify({ trashed: true }) }); } catch (e) {} }
function rcIndex_(P) { const id = P.getProperty('RC_INDEX'); if (!id) return {}; try { return JSON.parse(rcGet_(id).getContentText()); } catch (e) { return {}; } }
function rcSaveIndex_(P, idx) { const id = rcPut_(P, P.getProperty('RC_INDEX'), 'index.json', Utilities.newBlob(JSON.stringify(idx), 'application/json')); P.setProperty('RC_INDEX', id); }
function rcProject_(e) { return e.json ? JSON.parse(rcGet_(e.json).getContentText()) : {}; }
function rcSaveProject_(P, k, e, pr) { e.json = rcPut_(P, e.json, k + '.json', Utilities.newBlob(JSON.stringify(pr), 'application/json')); }
function rcHash_(s) { return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'kolot-rec|' + s)).slice(0, 32); }
function rcState_(e) { return { status: e.status || 'open', expires: e.expires, expired: Date.now() > e.expires, device: !!e.device }; }

/* ---------- client (key + device) ---------- */
function rcClient_(d, P) {
  const k = String(d.k || ''); if (!/^[a-f0-9]{20,40}$/.test(k)) return { ok: false, error: 'הקישור לא תקין. בדקו שהעתקתם אותו במלואו.' };
  const dev = String(d.dev || ''); if (!/^[a-f0-9]{24,64}$/.test(dev)) return { ok: false, error: 'bad device' };
  const lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    const idx = rcIndex_(P), e = idx[k];
    if (!e) return { ok: false, error: 'הקישור לא נמצא. בדקו שהעתקתם אותו במלואו.' };
    if (Date.now() > e.expires) return { ok: false, closed: true, error: 'תוקף הקישור הסתיים. לפרטים פנו לאולפני קולות.' };
    const h = rcHash_(dev);
    if (!e.device) { e.device = h; e.devAt = Date.now(); }
    else if (e.device !== h) return { ok: false, locked: true, error: 'הקישור כבר נפתח במכשיר אחר. כדי להקליט מהמכשיר הזה, פנו לאולפני קולות ונפתח אותו עבורכם.' };
    const pr = rcProject_(e);
    if (d.action === 'rc_c_open') { idx[k] = e; rcSaveIndex_(P, idx); return rcView_(k, e, pr); }
    if (d.action === 'rc_c_audio') {
      const allowed = {}; Object.keys(e.takes || {}).forEach(x => { allowed[e.takes[x].f] = 1; }); Object.keys(e.rooms || {}).forEach(x => { allowed[e.rooms[x]] = 1; });
      const out = {}; let size = 0;
      (d.ids || []).slice(0, 40).forEach(id => { if (allowed[id] && size < 24e6) { const b = rcGet_(id).getContent(); size += b.length; out[id] = Utilities.base64Encode(b); } });
      return { ok: true, files: out };
    }
    if ((e.status || 'open') !== 'open') return { ok: false, submitted: true, error: 'ההקלטה כבר נשלחה לאולפן. לשינויים פנו לאולפני קולות.' };
    if (d.action === 'rc_c_text') {
      if (pr.textLocked) return { ok: false, error: 'הטקסט ננעל אחרי תחילת ההקלטה.' };
      pr.mode = ['blessing', 'family', 'drasha'].indexOf(d.mode) >= 0 ? d.mode : (pr.mode || 'blessing');
      pr.blessers = (d.blessers || []).slice(0, e.maxBlessers || 5).map(b => ({ name: String(b.name || '').slice(0, 60), text: String(b.text || '').slice(0, 6000) }));
      rcSaveProject_(P, k, e, pr); e.updated = Date.now(); idx[k] = e; rcSaveIndex_(P, idx); return { ok: true };
    }
    if (d.action === 'rc_c_room') {
      const sid = String(d.sid || '').replace(/[^a-z0-9]/g, '').slice(0, 12); if (!sid || !d.wav) return { ok: false, error: 'bad room' };
      e.rooms = e.rooms || {}; if (Object.keys(e.rooms).length > 80) return { ok: false, error: 'יותר מדי הקלטות' };
      e.rooms[sid] = rcPut_(P, e.rooms[sid], k + '-room-' + sid + '.wav', Utilities.newBlob(Utilities.base64Decode(d.wav), 'audio/wav'));
      idx[k] = e; rcSaveIndex_(P, idx); return { ok: true };
    }
    if (d.action === 'rc_c_take') {
      const b = d.b | 0, i = d.i | 0, key = b + ':' + i;
      if (!pr.blessers || !pr.blessers[b]) return { ok: false, error: 'מברך לא קיים' };
      e.takes = e.takes || {}; e.uploads = (e.uploads || 0) + 1;
      if (e.uploads > RC_MAX_UPLOADS) return { ok: false, error: 'הגעתם למספר ההקלטות המרבי. פנו לאולפני קולות.' };
      const old = e.takes[key], n = old ? old.n + 1 : 1;
      if (n > RC_MAX_TAKES) return { ok: false, limit: true, error: 'אפשר להקליט כל משפט עד ' + RC_MAX_TAKES + ' פעמים. לעזרה פנו לאולפני קולות.' };
      const f = rcPut_(P, null, k + '-' + b + '-' + i + '-' + n + '.wav', Utilities.newBlob(Utilities.base64Decode(d.wav), 'audio/wav'));
      if (old && old.f) rcTrash_(old.f);
      e.takes[key] = { f: f, n: n, pre: d.pre | 0, sid: String(d.sid || '').slice(0, 12), flags: (d.flags || []).slice(0, 4), s: String(d.s || '').slice(0, 400), at: Date.now() };
      if (!pr.textLocked) { pr.textLocked = true; rcSaveProject_(P, k, e, pr); }
      e.updated = Date.now(); idx[k] = e; rcSaveIndex_(P, idx);
      return { ok: true, n: n, left: RC_MAX_TAKES - n };
    }
    if (d.action === 'rc_c_settings') {
      pr.settings = d.settings || {}; pr.music = String(d.music || '').slice(0, 20);
      rcSaveProject_(P, k, e, pr); idx[k] = e; rcSaveIndex_(P, idx); return { ok: true };
    }
    if (d.action === 'rc_c_submit') {
      if (!d.mp3) return { ok: false, error: 'חסר קובץ' };
      e.final = rcPut_(P, e.final, k + '-final.mp3', Utilities.newBlob(Utilities.base64Decode(d.mp3), 'audio/mpeg', (e.name || k) + '.mp3'));
      pr.settings = d.settings || pr.settings; pr.music = String(d.music || pr.music || ''); rcSaveProject_(P, k, e, pr);
      e.status = 'submitted'; e.submittedAt = Date.now(); e.updated = Date.now(); idx[k] = e; rcSaveIndex_(P, idx);
      return { ok: true };
    }
    return { ok: false, error: 'unknown action' };
  } finally { lock.releaseLock(); }
}
function rcView_(k, e, pr) {
  const takes = Object.keys(e.takes || {}).map(x => { const t = e.takes[x], p = x.split(':'); return { b: +p[0], i: +p[1], f: t.f, n: t.n, pre: t.pre, sid: t.sid, flags: t.flags, s: t.s }; });
  return { ok: true, name: e.name || '', mode: pr.mode || e.mode || 'blessing', maxBlessers: e.maxBlessers || 5, blessers: pr.blessers || [], textLocked: !!pr.textLocked,
    settings: pr.settings || null, music: pr.music || '', takes: takes, rooms: e.rooms || {}, state: rcState_(e), maxTakes: RC_MAX_TAKES };
}

/* ---------- studio ---------- */
function rcStaff_(d, P) {
  if (d.action === 'rc_list') {
    const idx = rcIndex_(P);
    return { ok: true, items: Object.keys(idx).map(k => { const e = idx[k]; return { k: k, name: e.name || '', orderId: e.orderId || '', mode: e.mode || '', created: e.created, updated: e.updated || e.created, takes: Object.keys(e.takes || {}).length, final: !!e.final, state: rcState_(e) }; }).sort((a, b) => b.updated - a.updated) };
  }
  if (d.action === 'rc_final') {
    const e = rcIndex_(P)[d.k]; if (!e || !e.final) return { ok: false, error: 'אין קובץ' };
    return { ok: true, mp3: Utilities.base64Encode(rcGet_(e.final).getContent()) };
  }
  const lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    const idx = rcIndex_(P);
    if (d.action === 'rc_create') {
      const k = rcTok_(), mode = ['blessing', 'family', 'drasha'].indexOf(d.mode) >= 0 ? d.mode : 'blessing';
      const e = { created: Date.now(), updated: Date.now(), name: String(d.name || '').slice(0, 80), orderId: String(d.orderId || '').replace(/\D/g, '').slice(0, 12), mode: mode,
        maxBlessers: Math.max(1, Math.min(5, d.maxBlessers | 0 || (mode === 'family' ? 5 : 1))), expires: Date.now() + Math.max(1, Math.min(120, d.days | 0 || RC_DAYS)) * 86400000, status: 'open' };
      const pr = { mode: mode, blessers: (d.blessers || []).slice(0, 5), textLocked: false };
      rcSaveProject_(P, k, e, pr); idx[k] = e; rcSaveIndex_(P, idx);
      return { ok: true, k: k };
    }
    const e = idx[d.k]; if (!e) return { ok: false, error: 'לא נמצא' };
    if (d.action === 'rc_meta') {
      if (d.resetDevice) { e.device = null; e.devAt = null; }
      if (d.reopen) e.status = 'open';
      if (d.done) e.status = 'done';
      if (d.extendDays) e.expires = Math.max(Date.now(), e.expires) + (d.extendDays | 0) * 86400000;
      if (d.unlockText) { const pr = rcProject_(e); pr.textLocked = false; rcSaveProject_(P, d.k, e, pr); }
      if (d.remove) { delete idx[d.k]; rcSaveIndex_(P, idx); return { ok: true, removed: true }; }
      e.updated = Date.now(); idx[d.k] = e; rcSaveIndex_(P, idx); return { ok: true, state: rcState_(e) };
    }
  } finally { lock.releaseLock(); }
  return { ok: false, error: 'unknown action' };
}

function rcCheck() { const P = PropertiesService.getScriptProperties(); Logger.log('recorder folder ' + rcFolder_(P) + ' · password ' + (P.getProperty('RECORDER_ADMIN_PASSWORD') ? 'yes' : 'no')); }
