/** Kolot – remote blessing recorder backend on Cloudflare Workers + R2.
 * Bindings: BUCKET (R2 bucket). Secrets for B-Sound (bs_*): ELEVENLABS_API_KEY (voice), GEMINI_API_KEY (reads the client's site and writes scripts). Optional var BS_VOICES (JSON {id: elevenlabs voice id}). No secrets: the studio password is set on first use from the admin page
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
  PRICE_BASE = 150, PRICE_EXTRA = 50, PRICE_DRASHA = 150, // ₪ – keep in sync with PRICING in recorder.html
  DRAFT_DAYS = 14, PAID_DAYS = 14, MAX_DRAFTS_PER_DAY = 8, MAX_FINALS = 20;
const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json; charset=utf-8' };
const out = (o) => new Response(JSON.stringify(o), { headers: H });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: H });
    if (req.method !== 'POST') return out({ ok: true, service: 'kolot-recorder' });
    const raw = await req.text();
    let d; try { d = JSON.parse(raw); } catch (e) { d = lenient(raw); if (!d) return out({ ok: false, error: 'bad request' }); }
    try { return out(await handle(d, env, req.headers.get('CF-Connecting-IP') || '')); } catch (err) { return out({ ok: false, error: String((err && err.message) || err).slice(0, 200) }); }
  }
};

// Kala fills customer text (comments) into the webhook body as is, so a quote or a line break can break the JSON
function lenient(raw) {
  if (!/"action"\s*:\s*"kala_paid"/.test(raw)) return null;
  const o = { action: 'kala_paid' };
  for (const key of ['secret', 'page_id', 'price', 'quantity', 'order_id', 'mobile', 'phone', 'name']) {
    const m = raw.match(new RegExp('"' + key + '"\\s*:\\s*"([^"\\n]*)"')); if (m) o[key] = m[1];
  }
  const c = raw.match(/"comments"\s*:\s*"([\s\S]*)"\s*}\s*$/); if (c) o.comments = c[1];
  return o;
}

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
const single = (m) => m === 'drasha' || m === 'kala'; // one speaker: drasha or ברכת כלה (same price)
const priceOf = (mode, n) => single(mode) ? PRICE_DRASHA : PRICE_BASE + PRICE_EXTRA * Math.max(0, (n | 0) - 1);
// drafts are paid per blesser: more blessers than were paid for need a top-up before the final file
const extraDue = (e) => (e.draft && isPaid(e) && e.paidBlessers != null) ? Math.max(0, (e.nb | 0) - e.paidBlessers) : 0;
const state = (e) => ({ paid: isPaid(e), draft: !!e.draft, nb: e.nb | 0, paidBlessers: e.paidBlessers == null ? null : e.paidBlessers, extraDue: extraDue(e), price: priceOf(e.mode, e.nb || 1), status: e.status || 'open', expires: e.expires, expired: Date.now() > e.expires, device: !!((e.devices && e.devices.length) || e.device), devices: (e.devices || (e.device ? [e.device] : [])).length });

/* ---------- router ---------- */
async function handle(d, env, ip) {
  if (d.action === 'rc_c_draft') return draft(d, env, ip);
  if (d.action === 'kala_paid') return kalaPaid(d, env);
  if (/^bs_/.test(d.action)) return bsound(d, env, ip);
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
  if (d.action === 'rc_kala') {
    let cfg = (await getJ(env, 'config/kala.json')) || {};
    if (!cfg.secret || d.renew) { cfg.secret = 'kk_' + tok() + tok(); cfg.at = Date.now(); await putJ(env, 'config/kala.json', cfg); }
    return { ok: true, secret: cfg.secret, log: ((await getJ(env, 'config/kala_log.json')) || []).slice(0, 30) };
  }
  return staff(d, env);
}

/* ---------- payment from Kala ----------
 * A Kala automation posts here when one of the recorder products is paid (order product status → "שולם במלואו").
 * The body carries a shared secret that the studio copies from the admin page into the automation.
 * The draft is found by the code the customer wrote in the order comments, or by the phone they gave in the recorder. */
const KALA_PACKS = { 76252: 1, 76253: 2, 76254: 3, 76255: 4, 76256: 5, 76258: 1, 76261: 1 }, KALA_EXTRA = 76257;
const last9 = (p) => String(p || '').replace(/\D/g, '').slice(-9);
async function kalaPaid(d, env) {
  const cfg = await getJ(env, 'config/kala.json');
  if (!cfg || !cfg.secret || String(d.secret || '') !== cfg.secret) return { ok: false, error: 'bad secret' };
  const pageId = parseInt(d.page_id, 10), qty = Math.max(1, parseInt(d.quantity, 10) || 1);
  if (pageId in BS_PAGES) return bsPaid(d, env, pageId);
  if (!(pageId in KALA_PACKS) && pageId !== KALA_EXTRA) return { ok: true, ignored: true };
  const orderKey = String(d.order_id || '') + ':' + pageId;
  const phones = [last9(d.mobile), last9(d.phone)].filter(p => p.length === 9);
  const codes = String(d.comments || '').match(/\d{6}/g) || [];
  const cands = [];
  let cursor;
  do {
    const l = await env.BUCKET.list({ prefix: 'e/', cursor }); cursor = l.truncated ? l.cursor : undefined;
    for (const o of l.objects) {
      const e = await getJ(env, o.key); if (!e || !e.draft) continue;
      if ((e.kalaOrders || []).some(x => x.key === orderKey)) return { ok: true, duplicate: true };
      const byCode = e.code && codes.includes(e.code), byPhone = e.contact && phones.includes(last9(e.contact.phone));
      if (byCode || byPhone) cands.push({ k: o.key.slice(2), e, score: (byCode ? 2 : 0) + (byPhone ? 1 : 0) });
    }
  } while (cursor);
  const log = (await getJ(env, 'config/kala_log.json')) || [];
  const entry = { at: Date.now(), order_id: String(d.order_id || ''), page_id: pageId, price: Number(d.price) || 0, qty, name: String(d.name || '').slice(0, 60), phone: phones[0] || '', codes: codes.slice(0, 3) };
  if (!cands.length) { entry.matched = null; await putJ(env, 'config/kala_log.json', [entry].concat(log).slice(0, 100)); return { ok: true, matched: false }; }
  // best match: code beats phone; among equals the most recent payment request
  cands.sort((a, b) => b.score - a.score || ((b.e.contact || {}).at || 0) - ((a.e.contact || {}).at || 0));
  const { k, e } = cands[0];
  if (pageId === KALA_EXTRA) e.paidBlessers = Math.max(1, (e.paidBlessers | 0) + qty);
  else e.paidBlessers = Math.max(e.paidBlessers | 0, KALA_PACKS[pageId]);
  e.paid = true; e.paidAt = Date.now(); e.paidBy = 'kala'; e.expires = Math.max(e.expires, Date.now() + PAID_DAYS * 86400000);
  e.kalaOrders = (e.kalaOrders || []).concat([{ key: orderKey, order_id: entry.order_id, page_id: pageId, price: entry.price, at: Date.now() }]).slice(-20);
  if (!e.orderId && entry.order_id) e.orderId = entry.order_id.replace(/\D/g, '').slice(0, 12);
  e.updated = Date.now(); await putJ(env, 'e/' + k, e);
  entry.matched = k; await putJ(env, 'config/kala_log.json', [entry].concat(log).slice(0, 100));
  return { ok: true, matched: true };
}

/* ---------- free draft (no key yet) ---------- */
async function draft(d, env, ip) {
  const dev = String(d.dev || ''); if (!/^[a-f0-9]{24,64}$/.test(dev)) return { ok: false, error: 'bad device' };
  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10), rk = 'rl/' + (await sha('ip|' + ip));
  const rl = (await getJ(env, rk)) || {};
  const n = rl.day === day ? (rl.n | 0) : 0;
  if (n >= MAX_DRAFTS_PER_DAY) return { ok: false, error: 'נפתחו היום יותר מדי הקלטות מהחיבור הזה. נסו שוב מחר או פנו לאולפני קולות.' };
  await putJ(env, rk, { day, n: n + 1 });
  const mode = ['blessing', 'family', 'drasha', 'kala'].includes(d.mode) ? d.mode : 'blessing', k = tok();
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000)), h = await sha('kolot-rec|' + dev);
  const e = { created: now, updated: now, name: String(d.name || '').slice(0, 80), orderId: '', mode, maxBlessers: single(mode) ? 1 : 5,
    expires: now + DRAFT_DAYS * 86400000, status: 'open', draft: true, paid: false, code, src: String(d.src || '').slice(0, 20), devices: [h], device: h, devAt: now };
  const blessers = (d.blessers || []).slice(0, e.maxBlessers).map(b => ({ name: String(b.name || '').slice(0, 60), text: String(b.text || '').slice(0, 6000) }));
  e.nb = blessers.filter(b => b.text.trim()).length;
  if (!single(mode)) e.mode = e.nb > 1 ? 'family' : 'blessing';
  await putJ(env, 'p/' + k, { mode: e.mode, blessers, textLocked: false });
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
      // a change or removal of an existing blessing costs an edit; adding a new blesser is free
      const changed = (pr.blessers || []).some((ob, j) => !nb[j] || nb[j].text !== ob.text);
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
    } else pr.mode = ['blessing', 'family', 'drasha', 'kala'].includes(d.mode) ? d.mode : (pr.mode || 'blessing');
    if (!single(pr.mode)) pr.mode = nb.length > 1 ? 'family' : 'blessing';
    pr.blessers = nb; e.mode = pr.mode; e.nb = nb.filter(b => b.text.trim()).length;
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
    e.due = isPaid(e) ? { n: e.nb | 0, amount: PRICE_EXTRA * extraDue(e), topUp: true, at: Date.now() } : { n: e.nb | 0, amount: priceOf(e.mode, e.nb || 1), at: Date.now() };
    if (!e.name) e.name = e.contact.name;
    e.updated = Date.now(); await putJ(env, 'e/' + k, e); return { ok: true, code: e.code || '' };
  }
  if (d.action === 'rc_c_settings') { pr.settings = d.settings || {}; pr.music = String(d.music || '').slice(0, 40); await putJ(env, 'p/' + k, pr); return { ok: true }; }
  if (d.action === 'rc_c_submit') {
    if (!isPaid(e)) return { ok: false, unpaid: true, error: 'הקובץ הסופי נפתח אחרי התשלום.' };
    if (extraDue(e)) return { ok: false, unpaid: true, extra: extraDue(e), error: 'נוספו מברכים אחרי התשלום. כדי לקבל את הקובץ צריך להשלים ' + PRICE_EXTRA * extraDue(e) + ' ₪.' };
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
      es.forEach(([k, e]) => { if (e) items.push({ k, name: e.name || '', orderId: e.orderId || '', mode: e.mode || '', created: e.created, updated: e.updated || e.created, takes: Object.keys(e.takes || {}).length, edits: e.editsUsed || 0, final: !!e.final, finals: e.finals | 0, code: e.code || '', contact: e.contact || null, due: e.due || null, paidBy: e.paidBy || '', src: e.src || '', state: state(e) }); });
    } while (cursor);
    return { ok: true, items: items.sort((a, b) => b.updated - a.updated) };
  }
  if (d.action === 'rc_create') {
    const k = tok(), mode = ['blessing', 'family', 'drasha', 'kala'].includes(d.mode) ? d.mode : 'blessing';
    const e = { created: Date.now(), updated: Date.now(), name: String(d.name || '').slice(0, 80), orderId: String(d.orderId || '').replace(/\D/g, '').slice(0, 12), mode,
      maxBlessers: Math.max(1, Math.min(5, (d.maxBlessers | 0) || (mode === 'family' ? 5 : 1))), expires: Date.now() + Math.max(1, Math.min(120, (d.days | 0) || DAYS)) * 86400000, status: 'open' };
    await putJ(env, 'p/' + k, { mode, blessers: (d.blessers || []).slice(0, 5), textLocked: false });
    await putJ(env, 'e/' + k, e);
    return { ok: true, k };
  }
  const k = String(d.k || ''); if (!/^[a-f0-9]{20,40}$/.test(k)) return { ok: false, error: 'לא נמצא' };
  const e = await getJ(env, 'e/' + k); if (!e) return { ok: false, error: 'לא נמצא' };
  if (d.action === 'rc_takes') {
    const takes = Object.entries(e.takes || {}).map(([x, t]) => { const p = x.split(':'); return { b: +p[0], i: +p[1], s: t.s || '', f: t.f, n: t.sel || t.n, vers: (t.vers || []).length || 1 }; })
      .sort((a, b) => a.b - b.b || a.i - b.i);
    return { ok: true, takes };
  }
  if (d.action === 'rc_audio') {
    const f = String(d.f || ''); if (!f.startsWith('f/' + k + '/')) return { ok: false, error: 'לא נמצא' };
    const b = await getBin(env, f); return b ? { ok: true, wav: bytesToB64(b) } : { ok: false, error: 'לא נמצא' };
  }
  if (d.action === 'rc_final') { if (!e.final) return { ok: false, error: 'אין קובץ' }; const b = await getBin(env, e.final); return b ? { ok: true, mp3: bytesToB64(b) } : { ok: false, error: 'אין קובץ' }; }
  if (d.action === 'rc_meta') {
    if (d.remove) {
      let cursor; do { const l = await env.BUCKET.list({ prefix: 'f/' + k + '/', cursor }); cursor = l.truncated ? l.cursor : undefined; if (l.objects.length) await env.BUCKET.delete(l.objects.map(o => o.key)); } while (cursor);
      await env.BUCKET.delete(['e/' + k, 'p/' + k]); return { ok: true, removed: true };
    }
    if (d.resetDevice) { e.device = null; e.devices = []; e.devAt = null; }
    if (d.reopen) e.status = 'open';
    if (typeof d.paid === 'boolean') {
      e.paid = d.paid;
      if (d.paid) { e.paidAt = Date.now(); e.paidBlessers = Math.max(e.paidBlessers | 0, e.due ? e.due.n | 0 : e.nb | 0, 1); e.expires = Math.max(e.expires, Date.now() + PAID_DAYS * 86400000); }
      else e.paidBlessers = null;
    }
    if (d.done) e.status = 'done';
    if (d.extendDays) e.expires = Math.max(Date.now(), e.expires) + (d.extendDays | 0) * 86400000;
    if (d.unlockText) e.editsUsed = 0;
    e.updated = Date.now(); await putJ(env, 'e/' + k, e); return { ok: true, state: state(e) };
  }
  return { ok: false, error: 'unknown action' };
}

/* ---------- B-Sound: online hold tone and IVR (bs_*) ----------
An order (bs/o/<k>.json) holds a package and its messages (items). Each item has a type:
  ivr (main menu, no music – accessibility rules), sub (sub-menu, no music), hold (hold tone, with music, max 30 s),
  closed / custom (extra announcements, no music). Items can have a language (he by default).
Before payment the client saves drafts and hears previews: ElevenLabs TTS with a spoken watermark, so clean audio
never leaves the server unpaid. Payment arrives from Kala (same webhook as the recorder): a package product marks the
order paid; credit products (revision, extra message, extra language) add credits to a paid order. Matching is by the
6-digit order code in the Kala order comments, or by phone.
After payment: bs_final returns the clean voice of an approved item (cached per version), the page mixes and encodes.
Changes after payment: bs_edit (uses a revision: package revisions per rolling year, then bought credits),
bs_add (extra message, uses a message credit), bs_lang (translation with Gemini, uses a language credit).
New items (added message, translated language) stay drafts – free edits and watermarked previews – until bs_approve. */
const BS_PAGES = {
  76262: { pkg: 'hold' }, 76264: { pkg: 'ivr-basic' }, 76265: { pkg: 'ivr-standard' }, 76266: { pkg: 'ivr-premium' },
  76274: { test: true }, 76277: { credit: 'test' }, 76275: { credit: 'revision' }, 76276: { credit: 'message' }, 76270: { credit: 'language' }
}; // Kala page ids – keep in sync with kala/b-sound-catalog.json
const BS_PKG = {
  'hold': { items: ['hold'], rev: 0, lang: 0, sub: false },
  'ivr-basic': { items: ['ivr', 'hold', 'closed'], rev: 0, lang: 0, sub: false },
  'ivr-standard': { items: ['ivr', 'hold', 'closed'], rev: 2, lang: 0, sub: true },
  'ivr-premium': { items: ['ivr', 'hold', 'closed'], rev: 7, lang: 2, sub: true }
};
const BS_TYPES = { ivr: 'תפריט ניתוב', sub: 'תת־נתב', hold: 'צליל המתנה', closed: 'העסק סגור', custom: 'הודעה' };
const BS_LANGS = { he: 'עברית', en: 'אנגלית', ar: 'ערבית', ru: 'רוסית', fr: 'צרפתית', es: 'ספרדית', uk: 'אוקראינית', ro: 'רומנית', fa: 'פרסית', th: 'תאית', fil: 'פיליפינית', hi: 'הינדית', zh: 'סינית', ka: 'גאורגית', tr: 'טורקית', pt: 'פורטוגזית', de: 'גרמנית', it: 'איטלקית', pl: 'פולנית' };
const BS_MAX_CHARS = 1200, BS_MAX_ITEMS = 16, BS_PREVIEWS_DRAFT = 40, BS_PREVIEWS_PAID = 60, BS_IP_DAY = 40, BS_DAYS = 30, BS_YEAR = 365 * 86400000;
const BS_VOICES_DEFAULT = { f1: 'EXAVITQu4vr4xnSDxMaL', f2: '21m00Tcm4TlvDq8ikWAM', m1: 'pNInz6obpgDQGcFmaJgB', m2: 'TxGEqnHWrfWFTfGW9XjX' };
const BS_WM = { he: 'B-Sound, תצוגה מקדימה.', en: 'B-Sound preview.', ar: 'B-Sound.', ru: 'B-Sound.' };
function bsVoices(env) { try { return Object.assign({}, BS_VOICES_DEFAULT, env.BS_VOICES ? JSON.parse(env.BS_VOICES) : {}); } catch (e) { return BS_VOICES_DEFAULT; } }
const bsClean = (t) => String(t || '').replace(/[<>{}\[\]]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, BS_MAX_CHARS);
function bsWatermark(t, lang) {
  const wm = BS_WM[lang] || 'B-Sound.';
  const parts = t.split(/(?<=[.!?…])\s+/).filter(Boolean);
  if (parts.length < 2) return wm + ' ' + t + ' ' + wm;
  const out = [wm]; parts.forEach((x, i) => { out.push(x); if (i % 2 === 1 || i === parts.length - 1) out.push(wm); });
  return out.join(' ');
}
async function bsTts(env, text, voiceId) {
  if (!env.ELEVENLABS_API_KEY) throw new Error('חסר מפתח ElevenLabs בשרת');
  const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId + '?output_format=mp3_44100_128', {
    method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: 'eleven_v3' })
  });
  if (!r.ok) throw new Error('הפקת הקול נכשלה (' + r.status + '): ' + (await r.text()).slice(0, 160));
  return new Uint8Array(await r.arrayBuffer());
}
// Gemini models change often: list the models this key can use (cached a day) and try the newest flash models first
async function bsModels(env, key) {
  const c = await getJ(env, 'config/gemini_models2.json');
  if (c && Date.now() - c.at < 86400000 && c.models.length) return c.models;
  let models = [];
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    if (r.ok) {
      const j = await r.json();
      const ver = (n) => { const m = n.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
      models = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => m.name.replace(/^models\//, ''))
        .filter(n => /^gemini-[\d.]+-flash/.test(n) && !/(image|tts|audio|live|vision|thinking|embedding|exp)/.test(n))
        .sort((a, b) => ver(b) - ver(a) || (/preview/.test(a) ? 1 : 0) - (/preview/.test(b) ? 1 : 0) || (/lite/.test(a) ? 1 : 0) - (/lite/.test(b) ? 1 : 0))
        .slice(0, 5);
    }
  } catch (e) {}
  models = ['gemini-3.8-flash'].concat(models.filter(x => x !== 'gemini-3.8-flash' && !/^gemini-2\./.test(x)), ['gemini-flash-latest', 'gemini-flash-lite-latest'].filter(x => !models.includes(x)));
  await putJ(env, 'config/gemini_models2.json', { at: Date.now(), models });
  return models;
}
async function bsLLM(env, prompt) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
  const key = String(env.GEMINI_API_KEY).trim(), errs = [], t0 = Date.now();
  const models = await bsModels(env, key);
  const call = async (model, thinking) => {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 30000);
    const gc = { responseMimeType: 'application/json', temperature: 0.6 };
    if (thinking) gc.thinkingConfig = { thinkingLevel: 'low' };
    try {
      return await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: gc })
      });
    } catch (e) { return { ok: false, status: 504, text: async () => 'timeout after 30s' }; } finally { clearTimeout(timer); }
  };
  for (const model of models) {
    if (Date.now() - t0 > 50000) break;
    let r = await call(model, /^gemini-3/.test(model));
    if (!r.ok && r.status === 400) r = await call(model, false); // model without thinking levels
    if (!r.ok) {
      errs.push(model + ' ' + r.status + ': ' + (await r.text()).replace(/\s+/g, ' ').slice(0, 140));
      if (r.status === 404) await putJ(env, 'config/gemini_models2.json', { at: 0, models: [] });
      continue;
    }
    const j = await r.json();
    const t = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    const txt = t.filter(x => !x.thought).map(x => x.text || '').join('').replace(/^```(?:json)?\s*|\s*```$/g, '');
    try { return JSON.parse(txt); } catch (e) { errs.push(model + ' bad json'); }
  }
  throw new Error(errs.join(' | ') || 'llm failed');
}
function bsCode() { const a = new Uint32Array(1); crypto.getRandomValues(a); return String(100000 + (a[0] % 900000)); }
async function bsIpOk(env, ip, kind, max) {
  const day = new Date().toISOString().slice(0, 10), key = 'bs/ip/' + kind + '-' + day + '.json';
  const m = (await getJ(env, key)) || {}; const n = (m[ip] | 0) + 1; if (n > max) return false;
  m[ip] = n; await putJ(env, key, m); return true;
}
function bsSiteText(html) {
  const pick = (re) => { const m = html.match(re); return m ? m[1].replace(/\s+/g, ' ').trim() : ''; };
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const desc = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)/i);
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|\/p|\/h\d|\/li|\/div)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { title, desc, text: body.slice(0, 7000) };
}
async function bsSite(d, env, ip) {
  if (!(await bsIpOk(env, ip, 'site', 20))) return { ok: false, error: 'הגעתם למספר הניתוחים היומי. אפשר להמשיך עם הנוסחים המוכנים' };
  const biz = String(d.biz || '').slice(0, 80), field = String(d.field || '').slice(0, 40);
  let url = String(d.url || '').trim(), site = { title: '', desc: '', text: '' };
  if (url) {
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      const u = new URL(url); if (!/\./.test(u.hostname) || /^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname)) throw new Error('bad');
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 9000);
      const r = await fetch(u.toString(), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; B-Sound script writer)', 'Accept': 'text/html' }, redirect: 'follow', signal: ac.signal });
      clearTimeout(t);
      if (r.ok && /html/i.test(r.headers.get('content-type') || 'text/html')) site = bsSiteText((await r.text()).slice(0, 600000));
    } catch (e) { site.error = 'לא הצלחנו לקרוא את האתר'; }
  }
  const prompt = `אתה קופירייטר בכיר באולפן הקלטות שכותב הודעות למרכזיות טלפון של עסקים בישראל.
שם העסק כפי שהלקוח כתב: "${biz}". תחום שהלקוח בחר: "${field}".
מידע מהאתר של העסק (אם יש):
כותרת: ${site.title}
תיאור: ${site.desc}
תוכן:
${site.text}

החזר JSON בלבד, במבנה:
{"name":"","slogan":"","services":[""],"departments":[""],"hours":"","hold":[{"tone":"חם ואישי","text":""},{"tone":"רשמי ועסקי","text":""},{"tone":"קליל וצעיר","text":""}],"closed":"","ivr_intro":""}

כללים:
- עברית טבעית, תקנית ופשוטה, כמו שמדברים בטלפון. משפטים שלמים והגיוניים, נושא אחד בכל משפט, בלי ניסוחים מאולצים ובלי סלנג מוגזם.
- אסור להמציא עובדות שלא מופיעות במידע: שעות, מחירים, כתובות, מבצעים, מספרים. אם חסר – לא לכתוב.
- name: שם העסק כפי שהוא מופיע באתר (או כפי שהלקוח כתב).
- slogan: אם יש באתר סלוגן או משפט מיתוג – השתמש בו כמעט מילה במילה. אחרת נסח משפט קצר (עד 8 מילים) שנאמן למה שהעסק עושה.
- services: 3 עד 6 השירותים או המוצרים המרכזיים, כל אחד בשתיים־שלוש מילים.
- departments: 2 עד 5 מחלקות הגיוניות לתפריט טלפוני של העסק הזה (למשל: מכירות, שירות לקוחות, תיאום תורים, הנהלת חשבונות). מילה או שתיים כל אחת, בלי "ל" בהתחלה.
- hours: שעות הפעילות אם מופיעות באתר, אחרת מחרוזת ריקה.
- hold: שלושה נוסחים לצליל המתנה, כל אחד 30 עד 45 מילים (עד 30 שניות). כל נוסח: פותח בשם העסק, משלב את הסלוגן ושירות אחד או שניים בצורה טבעית, ומסתיים בבקשה להישאר על הקו. בלי מספרי טלפון.
- closed: הודעה שהעסק סגור כרגע, עד 35 מילים. אם יש שעות פעילות שלב אותן, אחרת כתוב בדיוק: [שעות הפעילות].
- ivr_intro: משפט פתיחה אחד לתפריט: "שלום, הגעתם ל..." עם השם והסלוגן. בלי האפשרויות עצמן.`;
  try {
    const j = await bsLLM(env, prompt);
    return { ok: true, ai: true, site: { title: site.title, desc: site.desc, read: !!site.text, error: site.error || '' }, result: j };
  } catch (e) {
    return { ok: true, ai: false, llmError: String((e && e.message) || e).slice(0, 900), site: { title: site.title, desc: site.desc, read: !!site.text, error: site.error || '' } };
  }
}
const bsYearUsed = (o) => (o.revLog || []).filter(t => Date.now() - t < BS_YEAR).length;
function bsCredits(o) {
  const p = BS_PKG[o.pkg] || BS_PKG.hold, c = o.credits || {};
  const langsUsed = [...new Set((o.items || []).map(x => x.lang || 'he'))].filter(l => l !== 'he').length;
  return {
    revPkg: p.rev, revUsed: bsYearUsed(o), revLeft: Math.max(0, p.rev - bsYearUsed(o)) + (c.revision | 0),
    msgLeft: c.message | 0, langPkg: p.lang, langUsed: langsUsed, langLeft: Math.max(0, p.lang - (o.langsFromPkg | 0)) + (c.language | 0)
  };
}
function bsPublic(o) {
  return {
    ok: true, paid: !!o.paid, code: o.code, pkg: o.pkg, test: !!o.test, voice: o.voice, music: o.music, mix: o.mix || {}, biz: o.biz,
    credits: bsCredits(o), langs: BS_LANGS,
    items: (o.items || []).map(x => ({ id: x.id, type: x.type, title: x.title, lang: x.lang || 'he', script: x.script, draft: !!x.draft, ver: x.ver | 0, pending: x.pending || '' }))
  };
}
function bsItemsIn(arr, pkg) {
  const p = BS_PKG[pkg]; if (!p) throw new Error('חבילה לא מוכרת');
  const out = [];
  for (const x of (Array.isArray(arr) ? arr : []).slice(0, BS_MAX_ITEMS)) {
    const type = BS_TYPES[x.type] ? x.type : null; if (!type) continue;
    if (!p.items.includes(type) && !(type === 'sub' && p.sub)) continue;
    const script = bsClean(x.script); if (script.length < 6) continue;
    out.push({ id: String(x.id || type).replace(/[^a-z0-9-]/gi, '').slice(0, 24) || type, type, title: String(x.title || BS_TYPES[type]).slice(0, 40), lang: 'he', script, draft: true, ver: 0 });
  }
  for (const need of p.items) if (!out.some(x => x.type === need)) throw new Error('חסר נוסח ל' + BS_TYPES[need]);
  return out;
}
async function bsSave(env, k, o) { o.updated = Date.now(); await putJ(env, 'bs/o/' + k + '.json', o); }
async function bsound(d, env, ip) {
  if (d.action === 'bs_site') return bsSite(d, env, ip);
  const k = String(d.k || '').replace(/[^a-f0-9]/g, '').slice(0, 28);
  const vmap = bsVoices(env);
  if (d.action === 'bs_save') {
    let o = k ? await getJ(env, 'bs/o/' + k + '.json') : null, key = k;
    if (o && o.paid) return { ok: false, error: 'ההזמנה כבר שולמה. שינויים נעשים באזור הלקוח' };
    if (!o) { if (!(await bsIpOk(env, ip, 'order', BS_IP_DAY))) return { ok: false, error: 'הגעתם למספר ההזמנות היומי. פנו אלינו ונשמח לעזור' }; key = tok(); o = { code: bsCode(), created: Date.now(), previews: 0 }; }
    const pkg = BS_PKG[d.pkg] ? d.pkg : 'hold';
    Object.assign(o, { pkg, items: bsItemsIn(d.items, pkg), voice: vmap[d.voice] ? d.voice : 'f1', music: String(d.music || '').slice(0, 40), mix: d.mix || {},
      biz: String(d.biz || '').slice(0, 80), site: String(d.site || '').slice(0, 120), name: String(d.name || '').slice(0, 60),
      phone: String(d.phone || '').replace(/[^\d+]/g, '').slice(0, 15), email: String(d.email || '').slice(0, 80), expires: Date.now() + BS_DAYS * 86400000 });
    await bsSave(env, key, o);
    return Object.assign(bsPublic(o), { k: key });
  }
  const o = k ? await getJ(env, 'bs/o/' + k + '.json') : null;
  if (!o) return { ok: false, error: 'ההזמנה לא נמצאה' };
  if (d.action === 'bs_state') return bsPublic(o);
  const item = (o.items || []).find(x => x.id === String(d.id || ''));
  if (d.action === 'bs_preview') {
    if (!item) return { ok: false, error: 'ההודעה לא נמצאה' };
    const limit = o.paid ? BS_PREVIEWS_PAID : BS_PREVIEWS_DRAFT;
    if ((o.previews | 0) >= limit) return { ok: false, error: 'הגעתם למספר ההאזנות. פנו אלינו ונשמח לעזור' };
    // a paid, approved item is previewed with the proposed new text; the clean file stays the approved version
    let text = item.script;
    if (d.script != null) { text = bsClean(d.script); if (text.length < 6) return { ok: false, error: 'הנוסח קצר מדי' }; if (item.draft) item.script = text; else item.pending = text; }
    o.previews = (o.previews | 0) + 1;
    const mp3 = await bsTts(env, bsWatermark(text, item.lang || 'he'), vmap[o.voice] || BS_VOICES_DEFAULT.f1);
    await bsSave(env, k, o);
    return { ok: true, mp3: bytesToB64(mp3), previewsLeft: limit - o.previews };
  }
  if (d.action === 'bs_mix') { o.mix = d.mix || o.mix || {}; if (!o.paid && d.music) o.music = String(d.music).slice(0, 40); await bsSave(env, k, o); return { ok: true }; }
  if (!o.paid) return { ok: false, error: 'ההזמנה עוד לא שולמה' };
  if (d.action === 'bs_final') {
    if (!item) return { ok: false, error: 'ההודעה לא נמצאה' };
    if (item.draft) return { ok: false, error: 'צריך לאשר את ההודעה לפני ההורדה' };
    const fk = 'bs/f/' + k + '/' + item.id + '-v' + item.ver + '.mp3';
    let b = await getBin(env, fk);
    if (!b) { b = await bsTts(env, item.script, vmap[o.voice] || BS_VOICES_DEFAULT.f1); await env.BUCKET.put(fk, b, { httpMetadata: { contentType: 'audio/mpeg' } }); }
    return { ok: true, mp3: bytesToB64(b), type: item.type, music: o.music, mix: o.mix || {}, code: o.code };
  }
  if (d.action === 'bs_edit') {
    if (!item) return { ok: false, error: 'ההודעה לא נמצאה' };
    const text = bsClean(d.script != null ? d.script : item.pending); if (text.length < 6) return { ok: false, error: 'הנוסח קצר מדי' };
    if (item.draft) { item.script = text; item.pending = ''; await bsSave(env, k, o); return bsPublic(o); }
    if (text === item.script) return { ok: false, error: 'לא שיניתם את הנוסח' };
    const p = BS_PKG[o.pkg] || BS_PKG.hold;
    if (bsYearUsed(o) < p.rev) o.revLog = (o.revLog || []).concat([Date.now()]);
    else if ((o.credits || {}).revision > 0) o.credits.revision -= 1;
    else return { ok: false, error: 'נגמרו התיקונים בחבילה', need: 'revision' };
    item.script = text; item.pending = ''; item.ver = (item.ver | 0) + 1; item.editedAt = Date.now();
    await bsSave(env, k, o); return bsPublic(o);
  }
  if (d.action === 'bs_add') {
    const type = ['closed', 'custom', 'sub'].includes(d.type) ? d.type : 'custom';
    if ((o.items || []).length >= BS_MAX_ITEMS) return { ok: false, error: 'הגעתם למספר ההודעות המרבי' };
    if (!((o.credits || {}).message > 0)) return { ok: false, error: 'כדי להוסיף הודעה צריך לרכוש הודעה נוספת', need: 'message' };
    const script = bsClean(d.script); if (script.length < 6) return { ok: false, error: 'כתבו את נוסח ההודעה' };
    o.credits.message -= 1;
    const id = type + '-' + tok().slice(0, 6);
    o.items.push({ id, type, title: String(d.title || BS_TYPES[type]).slice(0, 40), lang: 'he', script, draft: true, ver: 0 });
    await bsSave(env, k, o); return bsPublic(o);
  }
  if (d.action === 'bs_approve') {
    if (!item) return { ok: false, error: 'ההודעה לא נמצאה' };
    if (!item.draft) return bsPublic(o);
    item.draft = false; item.ver = 1; item.approvedAt = Date.now(); await bsSave(env, k, o); return bsPublic(o);
  }
  if (d.action === 'bs_lang') {
    const lang = String(d.lang || ''); if (!BS_LANGS[lang] || lang === 'he') return { ok: false, error: 'שפה לא מוכרת' };
    if ((o.items || []).some(x => x.lang === lang)) return { ok: false, error: 'השפה הזאת כבר קיימת' };
    const p = BS_PKG[o.pkg] || BS_PKG.hold;
    let fromPkg = false;
    if ((o.langsFromPkg | 0) < p.lang) fromPkg = true;
    else if (!((o.credits || {}).language > 0)) return { ok: false, error: 'כדי להוסיף שפה צריך לרכוש שפה נוספת', need: 'language' };
    const src = o.items.filter(x => (x.lang || 'he') === 'he' && !x.draft);
    if (!src.length) return { ok: false, error: 'אין הודעות מאושרות לתרגום' };
    let tr;
    try {
      tr = await bsLLM(env, `תרגם הודעות של מרכזיית טלפון של עסק ישראלי ל${BS_LANGS[lang]}. ניסוח טבעי ומקצועי כמו שמדברים בטלפון, לא תרגום מילולי. שם העסק נשאר כפי שהוא (בתעתיק אם צריך). מספרי שלוחות נשארים מספרים. [שעות הפעילות] נשאר בסוגריים כפי שהוא.
החזר JSON בלבד: {"items":[{"id":"","text":""}]}
ההודעות:
${JSON.stringify(src.map(x => ({ id: x.id, text: x.script })))}`);
    } catch (e) { return { ok: false, error: 'התרגום לא זמין כרגע. נסו שוב בעוד כמה דקות' }; }
    const map = {}; for (const t of (tr.items || [])) map[t.id] = bsClean(t.text);
    for (const x of src) if (map[x.id]) o.items.push({ id: (x.id + '-' + lang).slice(0, 24), type: x.type, title: x.title + ' · ' + BS_LANGS[lang], lang, script: map[x.id], draft: true, ver: 0 });
    if (fromPkg) o.langsFromPkg = (o.langsFromPkg | 0) + 1; else o.credits.language -= 1;
    await bsSave(env, k, o); return bsPublic(o);
  }
  return { ok: false, error: 'פעולה לא מוכרת' };
}
async function bsPaid(d, env, pageId) {
  const cfg = await getJ(env, 'config/kala.json');
  if (!cfg || !cfg.secret || String(d.secret || '') !== cfg.secret) return { ok: false, error: 'bad secret' };
  const info = BS_PAGES[pageId], qty = Math.max(1, parseInt(d.quantity, 10) || 1);
  const phones = [last9(d.mobile), last9(d.phone)].filter(p => p.length === 9);
  const codes = String(d.comments || '').match(/\d{6}/g) || [];
  const orderKey = String(d.order_id || '') + ':' + pageId;
  const wantPaid = !!info.credit; // credits go to an order that is already paid; packages to one that is not
  const cands = []; let cursor;
  do {
    const l = await env.BUCKET.list({ prefix: 'bs/o/', cursor }); cursor = l.truncated ? l.cursor : undefined;
    for (const ob of l.objects) {
      const o = await getJ(env, ob.key); if (!o) continue;
      if ((o.kalaOrders || []).includes(orderKey)) return { ok: true, duplicate: true };
      if (!!o.paid !== wantPaid) continue;
      const byCode = codes.includes(o.code), byPhone = o.phone && phones.includes(last9(o.phone));
      if (byCode || byPhone) cands.push({ key: ob.key, o, score: (byCode ? 2 : 0) + (byPhone ? 1 : 0) });
    }
  } while (cursor);
  const log = (await getJ(env, 'config/kala_log.json')) || [];
  const entry = { at: Date.now(), order_id: String(d.order_id || ''), page_id: pageId, price: Number(d.price) || 0, qty, name: String(d.name || '').slice(0, 60), phone: phones[0] || '', codes: codes.slice(0, 3), bsound: true };
  if (!cands.length) { entry.matched = null; await putJ(env, 'config/kala_log.json', [entry].concat(log).slice(0, 100)); return { ok: true, matched: false }; }
  cands.sort((a, b) => b.score - a.score || (b.o.updated || 0) - (a.o.updated || 0));
  const { key, o } = cands[0];
  if (info.credit) {
    o.credits = o.credits || {};
    for (const c of info.credit === 'test' ? ['revision', 'message', 'language'] : [info.credit]) o.credits[c] = (o.credits[c] | 0) + qty;
  }
  else {
    if (info.pkg) o.pkg = info.pkg; if (info.test) o.test = true;
    for (const x of o.items || []) { if (x.draft) { x.draft = false; x.ver = 1; x.approvedAt = Date.now(); } }
    Object.assign(o, { paid: true, paidAt: Date.now(), paidBy: 'kala', orderId: entry.order_id, price: entry.price, expires: Date.now() + BS_YEAR });
  }
  o.kalaOrders = (o.kalaOrders || []).concat([orderKey]).slice(-30);
  o.updated = Date.now(); await putJ(env, key, o);
  entry.matched = key; await putJ(env, 'config/kala_log.json', [entry].concat(log).slice(0, 100));
  return { ok: true, matched: true };
}
