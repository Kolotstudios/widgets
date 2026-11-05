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
  76263: { pkg: 'hold', human: true }, 76267: { pkg: 'ivr-basic', human: true }, 76268: { pkg: 'ivr-standard', human: true }, 76269: { pkg: 'ivr-premium', human: true },
  76272: { pkg: 'jingle' }, 76273: { pkg: 'jingle', human: true },
  76274: { test: true }, 76277: { credit: 'test' }, 76275: { credit: 'revision' }, 76276: { credit: 'message' }, 76270: { credit: 'language' }
}; // Kala page ids – keep in sync with kala/b-sound-catalog.json
const BS_PKG = {
  'hold': { items: ['hold'], rev: 0, lang: 0, sub: false },
  'ivr-basic': { items: ['ivr', 'hold', 'closed'], rev: 0, lang: 0, sub: false },
  'ivr-standard': { items: ['ivr', 'hold', 'closed'], rev: 2, lang: 0, sub: true },
  'ivr-premium': { items: ['ivr', 'hold', 'closed'], rev: 7, lang: 2, sub: true },
  'jingle': { items: ['jingle'], rev: 0, lang: 0, sub: false }
};
const BS_TYPES = { ivr: 'תפריט ניתוב', sub: 'תת־נתב', hold: 'צליל המתנה', closed: 'העסק סגור', custom: 'הודעה', jingle: "ג'ינגל מושר" };
const BS_LANGS = { he: 'עברית', en: 'אנגלית', ar: 'ערבית', ru: 'רוסית', fr: 'צרפתית', es: 'ספרדית', uk: 'אוקראינית', ro: 'רומנית', fa: 'פרסית', th: 'תאית', fil: 'פיליפינית', hi: 'הינדית', zh: 'סינית', ka: 'גאורגית', tr: 'טורקית', pt: 'פורטוגזית', de: 'גרמנית', it: 'איטלקית', pl: 'פולנית' };
const BS_MAX_CHARS = 1200, BS_MAX_ITEMS = 16, BS_PREVIEWS_DRAFT = 40, BS_PREVIEWS_PAID = 60, BS_IP_DAY = 40, BS_DAYS = 30, BS_YEAR = 365 * 86400000;
// women: f1 Rachel (business), f2 Jessica (young), f3 Lily (soft) · men: m1 Josh (young), m2 Brian (warm), m3 Daniel (authoritative). Override any of them with the BS_VOICES variable
const BS_VOICES_DEFAULT = { f1: '21m00Tcm4TlvDq8ikWAM', f2: 'cgSgspJ2msm6clMCkdW9', f3: 'pFZP5JQG7iQjIQuC4Bku', m1: 'TxGEqnHWrfWFTfGW9XjX', m2: 'nPczCjzI2devNBz1zQrb', m3: 'onwK4e9ZLuTAKqWW03F9' };
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
// ElevenLabs v3 audio tags: a delivery style is set by a tag in front of each sentence
const BS_TONES = { normal: '', happy: '[cheerfully]', excited: '[excited]', energetic: '[energetic]', calm: '[calmly]', warm: '[warmly]', formal: '[professional tone]' };
function bsTone(t, tone) {
  const tag = BS_TONES[tone] || ''; if (!tag) return t;
  return t.split(/(?<=[.!?…])\s+/).filter(Boolean).map(x => tag + ' ' + x).join(' ');
}
async function bsTts(env, text, voiceId, fmt) {
  if (!env.ELEVENLABS_API_KEY) throw new Error('חסר מפתח ElevenLabs בשרת');
  const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId + '?output_format=' + (fmt || 'mp3_44100_128'), {
    method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': fmt && /^pcm/.test(fmt) ? 'audio/pcm' : 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: 'eleven_v3' })
  });
  if (!r.ok) throw new Error('הפקת הקול נכשלה (' + r.status + '): ' + (await r.text()).slice(0, 160));
  return new Uint8Array(await r.arrayBuffer());
}
// One clean take per (voice, tone, text), kept only on the server. The preview is the same take with hiss bursts over it,
// and after payment the customer gets exactly that take without the hiss.
const BS_SR = 22050;
async function bsHash(t) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join(''); }
async function bsTake(env, text, voiceId, tone) {
  const key = 'bs/c/' + (await bsHash(voiceId + '|' + (tone || 'normal') + '|' + text)) + '.pcm';
  let b = await getBin(env, key);
  if (!b) { b = await bsTts(env, bsTone(text, tone), voiceId, 'pcm_' + BS_SR); if (b.length % 2) b = b.subarray(0, b.length - 1); await env.BUCKET.put(key, b); }
  return b;
}
function bsWav(pcm) {
  const out = new Uint8Array(44 + pcm.length), v = new DataView(out.buffer), w = (o, t) => { for (let i = 0; i < t.length; i++) out[o + i] = t.charCodeAt(i); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, BS_SR, true); v.setUint32(28, BS_SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, pcm.length, true);
  out.set(pcm, 44); return out;
}
// hiss burst of 1.2 s every 8 s (first at 2 s), loud enough that the take can't be reused
function bsMark(pcm) {
  const src = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2), x = new Int16Array(src), n = x.length;
  const len = Math.round(1.2 * BS_SR), fade = Math.round(0.04 * BS_SR);
  for (let start = 2 * BS_SR; start < n; start += 8 * BS_SR) {
    for (let i = 0; i < len && start + i < n; i++) {
      const g = Math.min(1, i / fade, (len - i) / fade), noise = (Math.random() * 2 - 1) * 0.3 * 32767 * g;
      x[start + i] = Math.max(-32768, Math.min(32767, Math.round(x[start + i] * (1 - 0.35 * g) + noise)));
    }
  }
  return new Uint8Array(x.buffer);
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
    const gc = { responseMimeType: 'application/json', temperature: 0.5 };
    if (thinking) gc.thinkingConfig = { thinkingLevel: 'low' };
    try {
      return await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: gc })
      });
    } catch (e) { return { ok: false, status: 504, text: async () => 'timeout after 30s' }; } finally { clearTimeout(timer); }
  };
  // busy (503) or per-minute quota (429): wait a moment and go over the list a second time
  const list = models.concat(['__wait__'], models);
  for (const model of list) {
    if (Date.now() - t0 > 50000) break;
    if (model === '__wait__') { await new Promise(r => setTimeout(r, 2500)); continue; }
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
function bsHours(t) {
  const lines = String(t || '').split('\n').map(x => x.trim()).filter(x => x.length < 140);
  const re = /(שעות|ימים|א['׳]?\s*[-–]\s*ה['׳]?|ראשון|שישי|ו['׳]|פתוח|sunday|monday|hours)/i, tm = /\d{1,2}[:.]\d{2}/;
  const hit = []; lines.forEach((x, i) => { if (tm.test(x) && (re.test(x) || re.test(lines[i - 1] || ''))) hit.push(x); });
  return [...new Set(hit)].slice(0, 4).join(' · ');
}
function bsFacts(d) {
  const f = d.facts || {};
  return { name: String(f.name || d.biz || '').slice(0, 80), slogan: String(f.slogan || '').slice(0, 120), hours: String(f.hours || '').slice(0, 120),
    services: (Array.isArray(f.services) ? f.services : String(f.services || '').split(/[\n,]/)).map(x => String(x).trim()).filter(Boolean).slice(0, 8).map(x => x.slice(0, 50)),
    field: String(d.field || '').slice(0, 40) };
}
async function bsReadSite(url) {
  const site = { title: '', desc: '', text: '' };
  if (!url) return site;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url); if (!/\./.test(u.hostname) || /^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname)) throw new Error('bad');
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 9000);
    const r = await fetch(u.toString(), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; B-Sound script writer)', 'Accept': 'text/html' }, redirect: 'follow', signal: ac.signal });
    clearTimeout(t);
    if (r.ok && /html/i.test(r.headers.get('content-type') || 'text/html')) {
      const html = (await r.text()).slice(0, 600000), out = bsSiteText(html);
      // hours and contact details usually live on the contact page: read it too
      const links = [...html.matchAll(/href=["']([^"'#]+)["']/gi)].map(m => m[1]).filter(h => /contact|צור|קשר|%D7%A6%D7%95%D7%A8|about|אודות/i.test(h));
      const base = new URL(r.url || u.toString());
      const seen = new Set();
      for (const h of links) {
        let lu; try { lu = new URL(h, base); } catch (e) { continue; }
        if (lu.hostname !== base.hostname || seen.has(lu.pathname) || lu.pathname === base.pathname) continue;
        seen.add(lu.pathname); if (seen.size > 2) break;
        try {
          const ac2 = new AbortController(); const t2 = setTimeout(() => ac2.abort(), 6000);
          const r2 = await fetch(lu.toString(), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; B-Sound script writer)', 'Accept': 'text/html' }, redirect: 'follow', signal: ac2.signal });
          clearTimeout(t2);
          if (r2.ok) out.text += '\n\n[עמוד ' + decodeURIComponent(lu.pathname) + ']\n' + bsSiteText((await r2.text()).slice(0, 400000)).text.slice(0, 3500);
        } catch (e) {}
      }
      out.hoursHint = bsHours(out.text);
      return out;
    }
  } catch (e) { site.error = 'לא הצלחנו לקרוא את האתר'; }
  return site;
}
const BS_STYLE = `כללי כתיבה:
- עברית טבעית, תקנית ופשוטה, כמו שאדם נעים מדבר בטלפון. משפטים קצרים, שלמים והגיוניים, נושא אחד בכל משפט.
- בלי ניסוחים מאולצים או "פרסומיים" מדי, בלי קלישאות כמו "אנו מתחייבים" או "המענה שלכם חשוב לנו", בלי לוכסנים (לא "בר/בת"), בלי רשימות ארוכות.
- אסור להמציא עובדות שלא נמסרו: שעות, מחירים, כתובות, מבצעים, מספרים.`;
async function bsWrite(env, facts, site) {
  const prompt = `אתה קופירייטר בכיר באולפן הקלטות שכותב הודעות למרכזיות טלפון של עסקים בישראל.
פרטים שהלקוח מסר או אישר:
שם העסק: "${facts.name}"
סלוגן: "${facts.slogan}"
שירותים עיקריים: ${facts.services.join(', ')}
שעות פעילות: "${facts.hours}"
תחום: "${facts.field}"
${site && site.text ? `מידע מהאתר של העסק:
${site.hoursHint ? 'שורות שנראות כמו שעות פעילות: ' + site.hoursHint + '\n' : ''}כותרת: ${site.title}
תיאור: ${site.desc}
תוכן:
${site.text}
` : ''}
החזר JSON בלבד, במבנה:
{"name":"","slogan":"","services":[""],"departments":[""],"hours":"","hold":[{"tone":"חם ואישי","text":""},{"tone":"רשמי ועסקי","text":""},{"tone":"קליל וצעיר","text":""}],"closed":"","ivr_intro":""}

${BS_STYLE}
- name: שם העסק. אם הלקוח מסר שם – בדיוק אותו שם.
- slogan: אם נמסר סלוגן – בדיוק אותו סלוגן. אחרת: סלוגן או משפט מיתוג מהאתר כמעט מילה במילה, ואם אין – משפט קצר (עד 7 מילים) שנאמן למה שהעסק עושה.
- services: אם נמסרו שירותים – אותם שירותים. אחרת 3 עד 5 השירותים המרכזיים מהאתר, כל אחד בשתיים־שלוש מילים.
- departments: 2 עד 4 מחלקות הגיוניות לתפריט טלפוני של העסק (למשל: מכירות, שירות לקוחות, תיאום תורים, הנהלת חשבונות). מילה או שתיים, בלי "ל" בהתחלה.
- hours: שעות הפעילות כפי שנמסרו או כפי שמופיעות באתר (גם בעמוד צור קשר), בקיצור, למשל "א׳–ה׳ 9:00–18:00, ו׳ 9:00–13:00". אם אין – מחרוזת ריקה.
- hold: שלושה נוסחים לצליל המתנה, כל אחד 35 עד 45 מילים (כ־20 שניות דיבור, כדי שעם המוזיקה זה יגיע לכ־25 שניות). מבנה: (1) פתיחה מלאה – "שלום ותודה שהתקשרתם ל..." או "שלום, הגעתם ל...". (2) משפט אחד או שניים על העסק – הסלוגן, או שירות אחד או שניים (לא יותר) במשפט שלם וטבעי. (3) בקשה להישאר על הקו ושנציג יענה בקרוב. (4) משפט סיום קצר ("תודה על הסבלנות"). בלי מספרי טלפון.
  דוגמה טובה (לסגנון ולאורך בלבד, לא להעתיק): "שלום ותודה שהתקשרתם למאפיית הכיכר. אצלנו כל בוקר יוצאים מהתנור לחמים טריים, ואנחנו מכינים גם עוגות מעוצבות לאירועים. כל הנציגים שלנו עסוקים כרגע, אבל השיחה שלכם חשובה לנו ונענה לכם ממש בקרוב. אנא הישארו על הקו. תודה על הסבלנות."
- closed: הודעה שהעסק סגור כרגע, עד 30 מילים. אם יש שעות פעילות – שלב אותן, אחרת כתוב בדיוק: [שעות הפעילות].
- בדיקה לפני שמחזירים: קרא כל נוסח בקול. כל משפט שלם תחבירית, בלי מילים חסרות ("שלום ותודה שהתקשרתם", לא "שלום שהתקשרתם"; "שלום, הגעתם ל...", לא "שלום והגעתם ל..."), בלי חזרות ובלי צירופים לא טבעיים. ספור מילים: אם נוסח המתנה קצר מ־35 מילים – הוסף לו משפט על העסק.
- ivr_intro: משפט פתיחה קצר לתפריט, עד 14 מילים: "שלום, הגעתם ל[שם העסק]." ואם הסלוגן קצר – אחריו. בלי רשימת שירותים ובלי האפשרויות עצמן.`;
  return bsLLM(env, prompt);
}
async function bsSite(d, env, ip) {
  if (!(await bsIpOk(env, ip, 'site', 25))) return { ok: false, error: 'הגעתם למספר הניתוחים היומי. אפשר להמשיך עם הנוסחים המוכנים' };
  const facts = bsFacts(d);
  const site = d.action === 'bs_site' ? await bsReadSite(String(d.url || '').trim()) : { title: '', desc: '', text: '' };
  const meta = { title: site.title, desc: site.desc, read: !!site.text, error: site.error || '', hours: site.hoursHint || '' };
  try { return { ok: true, ai: true, site: meta, result: await bsWrite(env, facts, site) }; }
  catch (e) { const m = String((e && e.message) || e); return { ok: true, ai: false, busy: /429|503|timeout/.test(m), llmError: m.slice(0, 900), site: meta }; }
}
async function bsJingle(d, env, ip) {
  if (!(await bsIpOk(env, ip, 'site', 25))) return { ok: false, error: 'הגעתם למספר הכתיבות היומי. נסו מחר או פנו אלינו' };
  const f = bsFacts(d), len = Math.max(7, Math.min(60, d.len | 0 || 30));
  const shape = len <= 15 ? 'שם העסק והסלוגן בלבד, מושרים בצורה קליטה (2 שורות קצרות).' : len <= 30 ? 'פזמון אחד של 3–4 שורות, שם העסק מופיע פעמיים.' : 'בית אחד של 4 שורות מחורזות על מה שהעסק עושה, ואחריו פזמון של 3–4 שורות ששם העסק מופיע בו פעמיים.';
  const prompt = `אתה כותב ג'ינגלים מנוסה בישראל. כתוב מילים לג'ינגל מושר לעסק.
שם העסק: "${f.name}". סלוגן: "${f.slogan}". שירותים: ${f.services.join(', ')}. תחום: "${f.field}".
אורך: ${len} שניות. סגנון: "${String(d.style || '').slice(0, 30)}". קולות: "${String(d.vocal || '').slice(0, 30)}".
מבנה: ${shape}
כללים:
- עברית פשוטה, טבעית ותקנית. כל שורה היא משפט הגיוני שעומד בפני עצמו. אף שורה לא נכתבת רק בשביל החריזה.
- חריזה מלאה ומוכרת עדיפה על חריזה מקורית ומאולצת. בלי מילים מוזרות או לא טבעיות.
- שם העסק בפזמון. הפזמון קליט, קל לשיר ולזכור.
- בלי להמציא עובדות, מחירים או מבצעים.
החזר JSON בלבד: {"versions":[{"lyrics":""},{"lyrics":""}]} – שתי גרסאות שונות, שורות מופרדות ב-\\n.`;
  try { const j = await bsLLM(env, prompt); return { ok: true, ai: true, versions: (j.versions || []).map(v => bsClean(v.lyrics)).filter(Boolean).slice(0, 2) }; }
  catch (e) { return { ok: true, ai: false, llmError: String((e && e.message) || e).slice(0, 300) }; }
}
async function bsVoiceSample(d, env, ip) {
  const vmap = bsVoices(env), v = vmap[d.voice] ? d.voice : null; if (!v) return { ok: false, error: 'קול לא מוכר' };
  const tone = BS_TONES[d.tone] ? d.tone : 'normal';
  const key = 'bs/vs/' + v + '-' + vmap[v] + (tone === 'normal' ? '' : '-' + tone) + '.mp3';
  let b = await getBin(env, key);
  if (!b) {
    if (!(await bsIpOk(env, ip, 'vs', 30))) return { ok: false, error: 'נסו שוב מאוחר יותר' };
    b = await bsTts(env, bsTone('שלום, הגעתם לבי סאונד. כל הנציגים שלנו עסוקים כרגע, אבל השיחה שלכם תיענה בהקדם. תודה שהמתנתם.', tone), vmap[v]);
    await env.BUCKET.put(key, b, { httpMetadata: { contentType: 'audio/mpeg' } });
  }
  return { ok: true, mp3: bytesToB64(b) };
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
    ok: true, paid: !!o.paid, code: o.code, pkg: o.pkg, human: !!o.human, studio: !!o.human || o.pkg === 'jingle', jingle: o.jingle || null,
    test: !!o.test, voice: o.voice, tone: o.tone || 'normal', music: o.music, mix: o.mix || {}, biz: o.biz,
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
  if (d.action === 'bs_site' || d.action === 'bs_write') return bsSite(d, env, ip);
  if (d.action === 'bs_jingle') return bsJingle(d, env, ip);
  if (d.action === 'bs_voice_sample') return bsVoiceSample(d, env, ip);
  // lost the link? order code + the phone used in the order bring it back
  if (d.action === 'bs_find') {
    if (!(await bsIpOk(env, ip, 'find', 20))) return { ok: false, error: 'יותר מדי ניסיונות. נסו שוב מחר או כתבו לנו בוואטסאפ' };
    const code = String(d.code || '').replace(/\D/g, ''), ph = last9(d.phone);
    const ix = code.length === 6 ? await getJ(env, 'bs/idx/' + code + '.json') : null;
    const o = ix ? await getJ(env, 'bs/o/' + ix.k + '.json') : null;
    if (!o || !o.phone || last9(o.phone) !== ph || ph.length !== 9) return { ok: false, error: 'לא מצאנו הזמנה עם הקוד והטלפון האלה' };
    return { ok: true, k: ix.k };
  }
  const k = String(d.k || '').replace(/[^a-f0-9]/g, '').slice(0, 28);
  const vmap = bsVoices(env);
  if (d.action === 'bs_save') {
    let o = k ? await getJ(env, 'bs/o/' + k + '.json') : null, key = k;
    if (o && o.paid) return { ok: false, error: 'ההזמנה כבר שולמה. שינויים נעשים באזור הלקוח' };
    if (!o) { if (!(await bsIpOk(env, ip, 'order', BS_IP_DAY))) return { ok: false, error: 'הגעתם למספר ההזמנות היומי. פנו אלינו ונשמח לעזור' }; key = tok(); o = { code: bsCode(), created: Date.now(), previews: 0 }; await putJ(env, 'bs/idx/' + o.code + '.json', { k: key }); }
    const pkg = BS_PKG[d.pkg] ? d.pkg : 'hold';
    Object.assign(o, { pkg, items: bsItemsIn(d.items, pkg), voice: vmap[d.voice] ? d.voice : 'f1', tone: BS_TONES[d.tone] ? d.tone : 'normal', music: String(d.music || '').slice(0, 40), mix: d.mix || {},
      human: !!d.human, jingle: pkg === 'jingle' ? { len: Math.max(7, Math.min(60, d.jingle && d.jingle.len | 0 || 30)), style: String(d.jingle && d.jingle.style || '').slice(0, 30), vocal: String(d.jingle && d.jingle.vocal || '').slice(0, 30) } : null,
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
    const mp3 = bsWav(bsMark(await bsTake(env, text, vmap[o.voice] || BS_VOICES_DEFAULT.f1, o.tone)));
    await bsSave(env, k, o);
    return { ok: true, mp3: bytesToB64(mp3), previewsLeft: limit - o.previews };
  }
  if (d.action === 'bs_mix') { o.mix = d.mix || o.mix || {}; if (!o.paid && d.music) o.music = String(d.music).slice(0, 40); await bsSave(env, k, o); return { ok: true }; }
  if (!o.paid) return { ok: false, error: 'ההזמנה עוד לא שולמה' };
  if (d.action === 'bs_final') {
    if (!item) return { ok: false, error: 'ההודעה לא נמצאה' };
    if (o.human || o.pkg === 'jingle') return { ok: false, studio: true, error: 'ההפקה נעשית באולפן. הקבצים יגיעו אליכם במייל' };
    if (item.draft) return { ok: false, error: 'צריך לאשר את ההודעה לפני ההורדה' };
    const b = bsWav(await bsTake(env, item.script, vmap[o.voice] || BS_VOICES_DEFAULT.f1, o.tone));
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
    if (info.pkg) { o.pkg = info.pkg; o.human = !!info.human; } if (info.test) o.test = true;
    for (const x of o.items || []) { if (x.draft) { x.draft = false; x.ver = 1; x.approvedAt = Date.now(); } }
    Object.assign(o, { paid: true, paidAt: Date.now(), paidBy: 'kala', orderId: entry.order_id, price: entry.price, expires: Date.now() + BS_YEAR });
  }
  o.kalaOrders = (o.kalaOrders || []).concat([orderKey]).slice(-30);
  o.updated = Date.now(); await putJ(env, key, o);
  entry.matched = key; await putJ(env, 'config/kala_log.json', [entry].concat(log).slice(0, 100));
  return { ok: true, matched: true };
}
