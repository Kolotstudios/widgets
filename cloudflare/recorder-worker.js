/** Kolot – remote blessing recorder backend on Cloudflare Workers + R2.
 * Bindings: BUCKET (R2 bucket). No secrets: the studio password is set on first use from the admin page
 * and stored hashed in the bucket (config/admin.json).
 * Same API as the Apps Script version: POST JSON {action, ...}, actions rc_ping / rc_setup / rc_login / rc_* (studio) / rc_c_* (client link).
 *
 * A project = one order. The client link carries a random key (#k=...). The first two devices that open the link
 * (e.g. a phone and a computer) are bound to it; a third device gets "locked" until the studio resets it.
 * After the first recording the text can still be changed up to MAX_EDITS times; takes of unchanged sentences follow
 * their sentence, takes of removed sentences are archived. Every take of a sentence is kept (up to MAX_TAKES) so the client can pick a version.
 * Free drafts: anyone can start a recording (rc_c_draft, limited per connection per day). A draft records and plays
 * like a paid link, but the final file is refused until the studio marks it paid (rc_meta {paid:true}).
 * Links the studio creates in the admin page are paid from the start.
 * Storage layout: e/<k>.json (entry), p/<k>.json (project), f/<k>/<name> (audio).
 */
const MAX_TAKES = 10, MAX_UPLOADS = 600, DAYS = 30, MAX_DEVICES = 2, MAX_EDITS = 5,
  DRAFT_DAYS = 14, PAID_DAYS = 14, MAX_DRAFTS_PER_DAY = 8, MAX_FINALS = 20;
const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json; charset=utf-8' };
const out = (o) => new Response(JSON.stringify(o), { headers: H });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: H });
    if (req.method !== 'POST') return out({ ok: true, service: 'kolot-recorder' });
    let d; try { d = JSON.parse(await req.text()); } catch (e) { return out({ ok: false, error: 'bad request' }); }
    try { return out(await handle(d, env, req.headers.get('CF-Connecting-IP') || '')); } catch (err) { return out({ ok: false, error: String((err && err.message) || err).slice(0, 200) }); }
  }
};

/* ---------- storage helpers ---------- */
async function getJ(env, key) { const o = await env.BUCKET.get(key); return o ? o.json() : null; }
async function putJ(env, key, v) { await env.BUCKET.put(key, JSON.stringify(v), { httpMetadata: { contentType: 'application/json' } }); }
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function bytesToB64(u) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
async function putBin(env, key, b64, type) { await env.BUCKET.put(key, b64ToBytes(b64), { httpMetadata: { contentType: type } }); return key; }
async function getBin(env, key) { const o = await env.BUCKET.get(key); return o ? new Uint8Array(await o.arrayBuffer()) : null; }
function tok() { const a = new Uint8Array(14); crypto.getRandomValues(a); return [...a].map(x => x.toString(16).padStart(2, '0')).join(''); }
async function sha(s) { const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return btoa(String.fromCharCode(...new Uint8Array(h))).replace(/[+/=]/g, '').slice(0, 32); }
const isPaid = (e) => e.paid !== false;
const state = (e) => ({ paid: isPaid(e), draft: !!e.draft, status: e.status || 'open', expires: e.expires, expired: Date.now() > e.expires, device: !!((e.devices && e.devices.length) || e.device), devices: (e.devices || (e.device ? [e.device] : [])).length });

/* ---------- router ---------- */
async function handle(d, env, ip) {
  if (d.action === 'rc_c_draft') return draft(d, env, ip);
  if (d.action === 'rc_ping') { const c = await getJ(env, 'config/admin.json'); return { ok: true, service: 'kolot-recorder', admin: !!c }; }
  if (/^rc_c_/.test(d.action)) return client(d, env);
  const c = await getJ(env, 'config/admin.json');
  if (d.action === 'rc_setup') {
    if (c && (await sha(c.salt + String(d.pass || ''))) !== c.hash) return { ok: false, error: 'כבר הוגדרה סיסמה' };
    const np = String(d.newPass || '').trim(); if (np.length < 6) return { ok: false, error: 'סיסמה של 6 תווים לפחות' };
    const salt = tok(); await putJ(env, 'config/admin.json', { salt, hash: await sha(salt + np) }); return { ok: true };
  }
  if (!c || (await sha(c.salt + String(d.pass || ''))) !== c.hash) return { ok: false, error: 'סיסמה שגויה' };
  if (d.action === 'rc_login') return { ok: true };
  return staff(d, env);
}

/* ---------- free draft (no key yet) ---------- */
async function draft(d, env, ip) {
  const dev = String(d.dev || ''); if (!/^[a-f0-9]{24,64}$/.test(dev)) return { ok: false, error: 'bad device' };
  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10), rk = 'rl/' + (await sha('ip|' + ip));
  const rl = (await getJ(env, rk)) || {};
  const n = rl.day === day ? (rl.n | 0) : 0;
  if (n >= MAX_DRAFTS_PER_DAY) return { ok: false, error: 'נפתחו היום יותר מדי הקלטות מהחיבור הזה. נסו שוב מחר או פנו לאולפני קולות.' };
  await putJ(env, rk, { day, n: n + 1 });
  const mode = ['blessing', 'family', 'drasha'].includes(d.mode) ? d.mode : 'blessing', k = tok();
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000)), h = await sha('kolot-rec|' + dev);
  const e = { created: now, updated: now, name: String(d.name || '').slice(0, 80), orderId: '', mode, maxBlessers: mode === 'family' ? 5 : 1,
    expires: now + DRAFT_DAYS * 86400000, status: 'open', draft: true, paid: false, code, src: String(d.src || '').slice(0, 20), devices: [h], device: h, devAt: now };
  const blessers = (d.blessers || []).slice(0, e.maxBlessers).map(b => ({ name: String(b.name || '').slice(0, 60), text: String(b.text || '').slice(0, 6000) }));
  await putJ(env, 'p/' + k, { mode, blessers, textLocked: false });
  await putJ(env, 'e/' + k, e);
  return { ok: true, k, code };
}

/* ---------- client (key + device) ---------- */
async function client(d, env) {
  const k = String(d.k || ''); if (!/^[a-f0-9]{20,40}$/.test(k)) return { ok: false, error: 'הקישור לא תקין. בדקו שהעתקתם אותו במלואו.' };
  const dev = String(d.dev || ''); if (!/^[a-f0-9]{24,64}$/.test(dev)) return { ok: false, error: 'bad device' };
  const e = await getJ(env, 'e/' + k);
  if (!e) return { ok: false, error: 'הקישור לא נמצא. בדקו שהעתקתם אותו במלואו.' };
  if (Date.now() > e.expires) return { ok: false, closed: true, error: 'תוקף הקישור הסתיים. לפרטים פנו לאולפני קולות.' };
  const h = await sha('kolot-rec|' + dev);
  e.devices = e.devices || (e.device ? [e.device] : []);
  if (!e.devices.includes(h)) {
    if (e.devices.length >= (e.maxDevices || MAX_DEVICES)) return { ok: false, locked: true, error: 'הקישור כבר נפתח בשני מכשירים אחרים. כדי להקליט מהמכשיר הזה, פנו לאולפני קולות ונפתח אותו עבורכם.' };
    e.devices.push(h); e.device = e.devices[0]; e.devAt = Date.now(); await putJ(env, 'e/' + k, e);
  }
  const pr = (await getJ(env, 'p/' + k)) || {};
  if (d.action === 'rc_c_open') return view(k, e, pr);
  if (d.action === 'rc_c_state') return { ok: true, state: state(e), code: e.code || '' };
  if (d.action === 'rc_c_audio') {
    const allowed = new Set([...Object.values(e.takes || {}).flatMap(t => [t.f, ...(t.vers || []).map(v => v.f)]), ...Object.values(e.rooms || {})]);
    const files = {}; let size = 0;
    for (const id of (d.ids || []).slice(0, 40)) { if (!allowed.has(id) || size > 24e6) continue; const b = await getBin(env, id); if (b) { size += b.length; files[id] = bytesToB64(b); } }
    return { ok: true, files };
  }
  if ((e.status || 'open') !== 'open') return { ok: false, submitted: true, error: 'ההקלטה הזו נסגרה. לשינויים פנו לאולפני קולות.' };
  if (d.action === 'rc_c_text') {
    const src = (d.blessers || []).slice(0, e.maxBlessers || 5);
    const nb = src.map(b => ({ name: String(b.name || '').slice(0, 60), text: String(b.text || '').slice(0, 6000) }));
    if (!nb.length) return { ok: false, error: 'חסר טקסט' };
    const maxEdits = e.maxEdits == null ? MAX_EDITS : e.maxEdits;
    if (pr.textLocked) {
      const changed = nb.length !== (pr.blessers || []).length || nb.some((b, j) => b.text !== ((pr.blessers || [])[j] || {}).text);
      if (changed) {
        if ((e.editsUsed || 0) >= maxEdits) return { ok: false, noEdits: true, error: 'נגמרו השינויים בטקסט לקישור הזה. לשינוי נוסף פנו לאולפני קולות.' };
        // takes follow their sentence: same blesser (by its previous index) and same sentence text
        const old = e.takes || {}, nt = {}, used = new Set();
        src.forEach((b, j) => {
          const from = Number.isInteger(b.from) ? b.from : -1; if (from < 0) return;
          (b.sentences || []).slice(0, 300).forEach((sen, i) => {
            const hit = Object.keys(old).find(key => !used.has(key) && +key.split(':')[0] === from && old[key].s === String(sen));
            if (hit) { used.add(hit); nt[j + ':' + i] = old[hit]; }
          });
        });
        e.archived = (e.archived || []).concat(Object.keys(old).filter(key => !used.has(key)).map(key => ({ key, ...old[key], archivedAt: Date.now() }))).slice(-300);
        e.takes = nt; e.editsUsed = (e.editsUsed || 0) + 1;
        pr.history = (pr.history || []).concat([{ at: Date.now(), blessers: pr.blessers }]).slice(-12);
      }
    } else pr.mode = ['blessing', 'family', 'drasha'].includes(d.mode) ? d.mode : (pr.mode || 'blessing');
    pr.blessers = nb;
    await putJ(env, 'p/' + k, pr); e.updated = Date.now(); await putJ(env, 'e/' + k, e);
    return { ok: true, editsLeft: Math.max(0, maxEdits - (e.editsUsed || 0)) };
  }
  if (d.action === 'rc_c_room') {
    const sid = String(d.sid || '').replace(/[^a-z0-9]/g, '').slice(0, 12); if (!sid || !d.wav) return { ok: false, error: 'bad room' };
    e.rooms = e.rooms || {}; if (Object.keys(e.rooms).length > 80) return { ok: false, error: 'יותר מדי הקלטות' };
    e.rooms[sid] = await putBin(env, 'f/' + k + '/room-' + sid + '.wav', d.wav, 'audio/wav');
    await putJ(env, 'e/' + k, e); return { ok: true };
  }
  if (d.action === 'rc_c_take') {
    const b = d.b | 0, i = d.i | 0, key = b + ':' + i;
    if (!pr.blessers || !pr.blessers[b]) return { ok: false, error: 'מברך לא קיים' };
    e.takes = e.takes || {}; e.uploads = (e.uploads || 0) + 1;
    if (e.uploads > MAX_UPLOADS) return { ok: false, error: 'הגעתם למספר ההקלטות המרבי. פנו לאולפני קולות.' };
    const old = e.takes[key], n = old ? Math.max(old.n | 0, ...(old.vers || []).map(v => v.n | 0)) + 1 : 1;
    if (n > MAX_TAKES) return { ok: false, limit: true, error: 'אפשר להקליט כל משפט עד ' + MAX_TAKES + ' פעמים. לעזרה פנו לאולפני קולות.' };
    const f = await putBin(env, 'f/' + k + '/' + b + '-' + i + '-' + n + '-' + tok().slice(0, 6) + '.wav', d.wav, 'audio/wav');
    const v = { f, n, pre: d.pre | 0, sid: String(d.sid || '').slice(0, 12), flags: (d.flags || []).slice(0, 4), at: Date.now() };
    const vers = old ? (old.vers || [{ f: old.f, n: old.n, pre: old.pre, sid: old.sid, flags: old.flags, at: old.at }]) : [];
    vers.push(v);
    e.takes[key] = { ...v, s: String(d.s || '').slice(0, 400), vers };
    if (!pr.textLocked) { pr.textLocked = true; await putJ(env, 'p/' + k, pr); }
    e.updated = Date.now(); await putJ(env, 'e/' + k, e);
    return { ok: true, n, left: MAX_TAKES - n };
  }
  if (d.action === 'rc_c_select') {
    const key = (d.b | 0) + ':' + (d.i | 0), t = (e.takes || {})[key]; if (!t) return { ok: false, error: 'לא נמצא' };
    const v = (t.vers || []).find(x => x.n === (d.n | 0)); if (!v) return { ok: false, error: 'לא נמצא' };
    Object.assign(t, { f: v.f, pre: v.pre, sid: v.sid, flags: v.flags, sel: v.n });
    e.updated = Date.now(); await putJ(env, 'e/' + k, e); return { ok: true };
  }
  if (d.action === 'rc_c_contact') {
    const phone = String(d.phone || '').replace(/\D/g, '').slice(0, 13);
    if (phone.length < 9) return { ok: false, error: 'צריך מספר טלפון תקין.' };
    e.contact = { name: String(d.name || '').slice(0, 60), phone, at: Date.now() };
    if (!e.name) e.name = e.contact.name;
    e.updated = Date.now(); await putJ(env, 'e/' + k, e); return { ok: true, code: e.code || '' };
  }
  if (d.action === 'rc_c_settings') { pr.settings = d.settings || {}; pr.music = String(d.music || '').slice(0, 40); await putJ(env, 'p/' + k, pr); return { ok: true }; }
  if (d.action === 'rc_c_submit') {
    if (!isPaid(e)) return { ok: false, unpaid: true, error: 'הקובץ הסופי נפתח אחרי התשלום.' };
    if (!d.mp3) return { ok: false, error: 'חסר קובץ' };
    if ((e.finals | 0) >= MAX_FINALS) return { ok: false, error: 'הגעתם למספר הקבצים המרבי. פנו לאולפני קולות.' };
    e.final = await putBin(env, 'f/' + k + '/final.mp3', d.mp3, 'audio/mpeg'); e.finals = (e.finals | 0) + 1;
    pr.settings = d.settings || pr.settings; pr.music = String(d.music || pr.music || '').slice(0, 40); await putJ(env, 'p/' + k, pr);
    e.submittedAt = Date.now(); e.updated = Date.now(); await putJ(env, 'e/' + k, e);
    return { ok: true };
  }
  return { ok: false, error: 'unknown action' };
}
function view(k, e, pr) {
  const takes = Object.entries(e.takes || {}).map(([x, t]) => { const p = x.split(':'); return { b: +p[0], i: +p[1], f: t.f, n: t.sel || t.n, pre: t.pre, sid: t.sid, flags: t.flags, s: t.s, vers: (t.vers || []).map(v => ({ f: v.f, n: v.n, pre: v.pre, sid: v.sid, flags: v.flags })) }; });
  return { ok: true, name: e.name || '', mode: pr.mode || e.mode || 'blessing', maxBlessers: e.maxBlessers || 5, blessers: pr.blessers || [], textLocked: !!pr.textLocked,
    settings: pr.settings || null, music: pr.music || '', takes, rooms: e.rooms || {}, state: state(e), maxTakes: MAX_TAKES,
    paid: isPaid(e), draft: !!e.draft, code: e.code || '', contact: !!e.contact,
    editsLeft: Math.max(0, (e.maxEdits == null ? MAX_EDITS : e.maxEdits) - (e.editsUsed || 0)), maxEdits: e.maxEdits == null ? MAX_EDITS : e.maxEdits };
}

/* ---------- studio ---------- */
async function staff(d, env) {
  if (d.action === 'rc_list') {
    const items = []; let cursor;
    do {
      const l = await env.BUCKET.list({ prefix: 'e/', cursor }); cursor = l.truncated ? l.cursor : undefined;
      const es = await Promise.all(l.objects.map(o => getJ(env, o.key).then(e => [o.key.slice(2), e])));
      es.forEach(([k, e]) => { if (e) items.push({ k, name: e.name || '', orderId: e.orderId || '', mode: e.mode || '', created: e.created, updated: e.updated || e.created, takes: Object.keys(e.takes || {}).length, edits: e.editsUsed || 0, final: !!e.final, finals: e.finals | 0, code: e.code || '', contact: e.contact || null, src: e.src || '', state: state(e) }); });
    } while (cursor);
    return { ok: true, items: items.sort((a, b) => b.updated - a.updated) };
  }
  if (d.action === 'rc_create') {
    const k = tok(), mode = ['blessing', 'family', 'drasha'].includes(d.mode) ? d.mode : 'blessing';
    const e = { created: Date.now(), updated: Date.now(), name: String(d.name || '').slice(0, 80), orderId: String(d.orderId || '').replace(/\D/g, '').slice(0, 12), mode,
      maxBlessers: Math.max(1, Math.min(5, (d.maxBlessers | 0) || (mode === 'family' ? 5 : 1))), expires: Date.now() + Math.max(1, Math.min(120, (d.days | 0) || DAYS)) * 86400000, status: 'open' };
    await putJ(env, 'p/' + k, { mode, blessers: (d.blessers || []).slice(0, 5), textLocked: false });
    await putJ(env, 'e/' + k, e);
    return { ok: true, k };
  }
  const k = String(d.k || ''); if (!/^[a-f0-9]{20,40}$/.test(k)) return { ok: false, error: 'לא נמצא' };
  const e = await getJ(env, 'e/' + k); if (!e) return { ok: false, error: 'לא נמצא' };
  if (d.action === 'rc_final') { if (!e.final) return { ok: false, error: 'אין קובץ' }; const b = await getBin(env, e.final); return b ? { ok: true, mp3: bytesToB64(b) } : { ok: false, error: 'אין קובץ' }; }
  if (d.action === 'rc_meta') {
    if (d.remove) {
      let cursor; do { const l = await env.BUCKET.list({ prefix: 'f/' + k + '/', cursor }); cursor = l.truncated ? l.cursor : undefined; if (l.objects.length) await env.BUCKET.delete(l.objects.map(o => o.key)); } while (cursor);
      await env.BUCKET.delete(['e/' + k, 'p/' + k]); return { ok: true, removed: true };
    }
    if (d.resetDevice) { e.device = null; e.devices = []; e.devAt = null; }
    if (d.reopen) e.status = 'open';
    if (typeof d.paid === 'boolean') { e.paid = d.paid; if (d.paid) { e.paidAt = Date.now(); e.expires = Math.max(e.expires, Date.now() + PAID_DAYS * 86400000); } }
    if (d.done) e.status = 'done';
    if (d.extendDays) e.expires = Math.max(Date.now(), e.expires) + (d.extendDays | 0) * 86400000;
    if (d.unlockText) e.editsUsed = 0;
    e.updated = Date.now(); await putJ(env, 'e/' + k, e); return { ok: true, state: state(e) };
  }
  return { ok: false, error: 'unknown action' };
}
