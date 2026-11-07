/** Kolot – remote blessing recorder backend on Cloudflare Workers + R2.
 * Bindings: BUCKET (R2 bucket). Secrets for B-Sound (bs_*): ELEVENLABS_API_KEY (voice), GEMINI_API_KEY (reads the client's site and writes scripts). Optional var BS_VOICES (JSON {id: elevenlabs voice id}). No secrets: the studio password is set on first use from the admin page
 * and stored hashed in the bucket (config/admin.json).
 * Karaoke studio (ks_* actions, ?ks= binary routes): secrets MVSEP_API_TOKEN (stem separation), optional OPENAI_API_KEY (Whisper; otherwise Gemini transcribes).
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
    const u = new URL(req.url);
    if (u.searchParams.get('ks')) { try { return await ksHttp(req, env, u); } catch (err) { return out({ ok: false, error: String((err && err.message) || err).slice(0, 200) }); } }
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
  if (/^ks_/.test(d.action)) return ksAction(d, env, ip);
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
// Jingle lyrics: short lines (2-4 words; rap/hip-hop gets more words), rhymed, the business name repeated,
// a call to action at the end. 4 versions each time, "write again" gives 4 new ones.
const BS_RAP = /ראפ|היפ|hip|rap/i;
function bsJShape(len, rap) {
  const w = rap ? '4–7 מילים' : '2–4 מילים';
  if (len <= 15) return { lines: rap ? '3–4' : '2–4', words: w, form: 'שם העסק + הסלוגן בלבד. שם העסק מופיע לפחות פעמיים (למשל בתחילה ובסוף). בלי בית ובלי פזמון.' };
  if (len <= 30) return { lines: rap ? '6–8' : '4–6', words: w, form: 'פזמון אחד. שם העסק מופיע לפחות 3 פעמים. השורה האחרונה היא הנעה לפעולה קצרה.' };
  return { lines: rap ? '10–14' : '8–10', words: w, form: 'בית קצר על מה שהעסק עושה, שורה ריקה, ואז פזמון שבו שם העסק חוזר לפחות 3 פעמים. השורה האחרונה היא הנעה לפעולה קצרה.' };
}
async function bsJingle(d, env, ip) {
  if (!(await bsIpOk(env, ip, 'site', 40))) return { ok: false, error: 'הגעתם למספר הכתיבות היומי. נסו מחר או פנו אלינו' };
  const f = bsFacts(d), len = Math.max(7, Math.min(60, d.len | 0 || 12)), style = String(d.style || '').slice(0, 30), rap = BS_RAP.test(style);
  const sh = bsJShape(len, rap);
  const avoid = (Array.isArray(d.avoid) ? d.avoid : []).slice(0, 8).map(x => String(x).slice(0, 200)).join('\n---\n');
  const prompt = `אתה קופירייטר וכותב ג'ינגלים מנוסה בישראל. כתוב מילים לג'ינגל מושר לעסק.
שם העסק: "${f.name}". סלוגן: "${f.slogan}". שירותים: ${f.services.join(', ')}. תחום: "${f.field}".
אורך: ${len} שניות. סגנון: "${style}". קולות: "${String(d.vocal || '').slice(0, 30)}".
מבנה: ${sh.form}
כמות טקסט: ${sh.lines} שורות בסך הכול, ${sh.words} בכל שורה.${rap ? ' זה ראפ/היפ הופ: קצב דיבורי, חריזה פנימית מותרת.' : ' מינימליסטי: מעט מילים, הרבה חזרתיות.'}
כללים:
- הכי חשוב בג'ינגל: חזרתיות על שם העסק. שם העסק נשמע ברור, בתחילה ובסוף.
- כל שורה קצרה (${sh.words}). עברית פשוטה, טבעית ותקנית, קלה לשיר ולזכור.
- חריזה מלאה בין שורות סמוכות. חריזה מוכרת עדיפה על חריזה מאולצת. אף שורה לא נכתבת רק בשביל החריזה.
- המילים מכוונות לתחום של העסק ולמה שהלקוח מקבל.
- הנעה לפעולה קצרה כשמתאים (למשל "התקשרו עכשיו", "בואו לטעום", "היכנסו לאתר").
- בלי להמציא עובדות, מחירים או מבצעים. בלי סימני פיסוק מיותרים.
${avoid ? 'אל תחזור על הגרסאות האלה, כתוב רעיונות חדשים:\n' + avoid + '\n' : ''}החזר JSON בלבד: {"versions":[{"lyrics":""},{"lyrics":""},{"lyrics":""},{"lyrics":""}]} – 4 גרסאות שונות זו מזו ברעיון, שורות מופרדות ב-\\n.`;
  try { const j = await bsLLM(env, prompt); return { ok: true, ai: true, versions: (j.versions || []).map(v => bsClean(v.lyrics)).filter(Boolean).slice(0, 4) }; }
  catch (e) { return { ok: true, ai: false, busy: /429|503|timeout/.test(String(e)), llmError: String((e && e.message) || e).slice(0, 300) }; }
}
// Sung jingle audio (ElevenLabs Music). BS_JINGLE_FREE = true while testing: anyone can generate and download.
// Set it to false to bring back payment (then only a paid jingle order gets audio).
const BS_JINGLE_FREE = true;
const BS_JSTYLE = {
  'מתאים לתחום': ['modern Israeli pop', 'bright', 'catchy'], 'פופ': ['modern pop', 'catchy hook', 'bright synths'],
  'ים תיכוני': ['Mediterranean Israeli pop', 'darbuka', 'oud', 'festive'], 'רוק': ['pop rock', 'electric guitars', 'live drums', 'energetic'],
  'היפ הופ': ['hip hop', 'rap vocals', 'punchy drums', 'groovy bass'], "ג'אז / סווינג": ['swing jazz', 'big band brass', 'walking bass', 'playful'],
  'אלקטרוני': ['electronic dance pop', 'synth bass', 'four on the floor'], 'אקוסטי': ['acoustic', 'acoustic guitar', 'warm', 'claps'],
  'שמח ומקפיץ': ['happy upbeat pop', 'claps', 'bouncy', 'feel-good']
};
const BS_JVOCAL = { 'זמר': 'male lead vocal', 'זמרת': 'female lead vocal', 'דואט': 'male and female duet vocals', 'מקהלה': 'group choir vocals', 'קולות ילדים': "children's choir vocals" };
async function bsJingleAudio(d, env, ip) {
  if (!BS_JINGLE_FREE) {
    const o = d.k ? await getJ(env, 'bs/o/' + String(d.k).replace(/[^\w-]/g, '') + '.json') : null;
    if (!o || !o.paid || o.pkg !== 'jingle') return { ok: false, error: "הפקת הג'ינגל זמינה אחרי ההזמנה" };
  }
  if (!env.ELEVENLABS_API_KEY) return { ok: false, error: 'חסר מפתח ElevenLabs בשרת' };
  const lyrics = bsClean(String(d.lyrics || '')).slice(0, 900).trim();
  if (lyrics.length < 4) return { ok: false, error: "כתבו קודם את מילות הג'ינגל" };
  const len = Math.max(10, Math.min(60, d.len | 0 || 12)), style = String(d.style || 'מתאים לתחום').slice(0, 30), vocal = String(d.vocal || 'זמרת').slice(0, 30);
  const take = Math.max(0, Math.min(20, d.take | 0));
  const key = 'bs/j/' + (await bsHash([lyrics, len, style, vocal, take].join('|'))) + '.mp3';
  let b = await getBin(env, key);
  if (!b) {
    if (!(await bsIpOk(env, ip, 'jg', 15))) return { ok: false, error: 'הגעתם למספר ההפקות היומי. נסו מחר' };
    if (!(await bsIpOk(env, 'all', 'jg-all', 300))) return { ok: false, error: 'השירות עמוס היום. נסו מחר' };
    const rap = BS_RAP.test(style);
    const styles = ['catchy commercial jingle', 'radio advertisement', 'Hebrew lyrics', 'clear intelligible vocals', 'memorable hook', 'professional mix']
      .concat(BS_JSTYLE[style] || BS_JSTYLE['מתאים לתחום'], [BS_JVOCAL[vocal] || 'female lead vocal']);
    const neg = ['long intro', 'instrumental only', 'mumbled vocals', 'fade out'].concat(rap ? [] : ['rap', 'spoken word']);
    const parts = lyrics.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
    const total = len * 1000, nLines = parts.map(x => x.split('\n').length), sum = nLines.reduce((a, c) => a + c, 0);
    let chunks = parts.map((t, i) => ({
      text: '[' + (parts.length > 1 && i < parts.length - 1 ? 'Verse' : 'Chorus') + ']\n' + t,
      duration_ms: Math.max(3000, Math.round(total * nLines[i] / sum / 100) * 100),
      positive_styles: styles, negative_styles: neg
    }));
    const over = chunks.reduce((a, c) => a + c.duration_ms, 0) - total; if (over) chunks[chunks.length - 1].duration_ms = Math.max(3000, chunks[chunks.length - 1].duration_ms - over);
    const call = (body) => fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', {
      method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' }, body: JSON.stringify(body)
    });
    let r = await call({ model_id: 'music_v2_5', composition_plan: { chunks } }), errs = [];
    if (!r.ok) {
      errs.push('v2.5 ' + r.status + ': ' + (await r.text()).slice(0, 200));
      // plan without the newer model: a text prompt with the lyrics
      r = await call({ model_id: 'music_v1', music_length_ms: total, prompt: 'A ' + styles.join(', ') + ' jingle, sung in Hebrew. Sing exactly these lyrics, repeat the brand name clearly:\n' + lyrics });
    }
    if (!r.ok) { errs.push('v1 ' + r.status + ': ' + (await r.text()).slice(0, 200)); return { ok: false, error: "הפקת הג'ינגל נכשלה. נסו שוב בעוד רגע", detail: errs.join(' | ') }; }
    b = new Uint8Array(await r.arrayBuffer());
    await env.BUCKET.put(key, b, { httpMetadata: { contentType: 'audio/mpeg' } });
  }
  return { ok: true, free: BS_JINGLE_FREE, mp3: bytesToB64(b) };
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
  if (d.action === 'bs_jingle_audio') return bsJingleAudio(d, env, ip);
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

/* ===================== Karaoke studio (ks_*) =====================
 * Anyone with a personal access link (#a=KEY, made by the studio) can upload songs up to the link's quota.
 * A song: the original goes straight to MVSEP (never stored here); the vocal + playback stems come back into R2.
 * Everything of a song is deleted after KS_DAYS. Takes stay in the singer's browser; a take sent for music
 * removal (speaker recordings) comes back as a vocal-only stem.
 * Storage: ks/a/<key>.json (access link), ks/s/<id>.json (song), ks/f/<id>/<name> (audio).
 */
const KS_DAYS = 30, KS_MAX_BYTES = 60e6, KS_MAX_CLEANS = 3, KS_SWEEP_MS = 6 * 3600e3;
const KS_SEP = { sep_type: '40', add_opt1: '81', add_opt2: '2', output_format: '0' }; // BS Roformer 2025.07, mp3 320
const KS_DAY = 86400000;
// keys may be saved under other names: OpenAI keys start with sk-, anything else is the MVSEP token
function ksKeys(env) {
  const vals = [env.MVSEP_API_TOKEN, env.OPENAI_API_KEY, env.MVSEP, env.KARAOKE4ALL, env.MVSEP_TOKEN].map(v => String(v || '').trim()).filter(Boolean);
  return { mvsep: vals.find(v => !/^sk-/.test(v)) || '', openai: vals.find(v => /^sk-/.test(v)) || '' };
}
async function ksStaffTok(c, day) { return sha(c.hash + ':ks:' + day); }
async function ksWho(env, d) {
  if (d.st) {
    const c = await getJ(env, 'config/admin.json'); const day = Math.floor(Date.now() / KS_DAY);
    if (c && (d.st === await ksStaffTok(c, day) || d.st === await ksStaffTok(c, day - 1))) return { staff: true, owner: 'staff', name: 'צוות קולות' };
    throw new Error('הכניסה של הצוות פגה. נכנסים שוב');
  }
  const a = String(d.a || '').replace(/[^a-f0-9]/g, '');
  if (!a) throw new Error('חסר קישור אישי');
  const acc = await getJ(env, 'ks/a/' + a + '.json');
  if (!acc || !acc.active) throw new Error('הקישור לא פעיל. פונים לאולפני קולות');
  if (acc.expires && Date.now() > acc.expires) throw new Error('תוקף הקישור הסתיים. פונים לאולפני קולות');
  return { staff: false, owner: a, acc, name: acc.name };
}
async function ksSong(env, who, id) {
  id = String(id || '').replace(/[^a-f0-9]/g, '');
  const s = id && await getJ(env, 'ks/s/' + id + '.json');
  if (!s || (!who.staff && s.owner !== who.owner)) throw new Error('השיר לא נמצא');
  if (Date.now() > s.expires) throw new Error('השיר נמחק (עברו ' + KS_DAYS + ' יום)');
  return s;
}
const ksPut = (env, s) => env.BUCKET.put('ks/s/' + s.id + '.json', JSON.stringify(s), { httpMetadata: { contentType: 'application/json' }, customMetadata: { exp: String(s.expires), owner: s.owner } });
const ksPub = (s) => ({ id: s.id, title: s.title, status: s.status, created: s.created, expires: s.expires, dur: s.dur || 0, hasLyrics: !!(s.lyrics && s.lyrics.length), err: s.err || '' });
async function ksDeleteSong(env, id) {
  let cursor;
  do { const l = await env.BUCKET.list({ prefix: 'ks/f/' + id + '/', cursor }); const keys = l.objects.map(o => o.key); if (keys.length) await env.BUCKET.delete(keys); cursor = l.truncated ? l.cursor : null; } while (cursor);
  await env.BUCKET.delete('ks/s/' + id + '.json');
}
async function ksSweep(env) {
  const m = (await getJ(env, 'config/ks_sweep.json')) || {}; if (Date.now() - (m.at || 0) < KS_SWEEP_MS) return;
  await putJ(env, 'config/ks_sweep.json', { at: Date.now() });
  let cursor, n = 0;
  do {
    const l = await env.BUCKET.list({ prefix: 'ks/s/', cursor, include: ['customMetadata'] });
    for (const o of l.objects) { const exp = +((o.customMetadata || {}).exp || 0); if (exp && Date.now() > exp) { await ksDeleteSong(env, o.key.slice(5, -5)); n++; } }
    cursor = l.truncated ? l.cursor : null;
  } while (cursor && n < 200);
}
async function mvsep(env, path, form) {
  const tokn = ksKeys(env).mvsep; if (!tokn) throw new Error('ההפרדה עוד לא חוברה (חסר מפתח MVSEP)');
  form.append('api_token', tokn);
  const r = await fetch('https://mvsep.com/api/separation/' + path, { method: 'POST', body: form });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { throw new Error('MVSEP ' + r.status + ': ' + t.slice(0, 120)); }
  if (!j.success) throw new Error('MVSEP: ' + String(((j.data || {}).message) || j.message || r.status).slice(0, 160));
  return j.data || {};
}
async function ksStart(env, bytes, type, name) {
  const f = new FormData();
  f.append('audiofile', new Blob([bytes], { type: type || 'audio/mpeg' }), name || 'song.mp3');
  for (const k in KS_SEP) f.append(k, KS_SEP[k]);
  const d = await mvsep(env, 'create', f);
  if (!d.hash) throw new Error('MVSEP לא החזיר מספר עבודה');
  return d.hash;
}
// the result's file list: entries (array or object) with a link and a label; vocals vs. everything-but-vocals
function ksFiles(data) {
  let list = data.files || [];
  if (!Array.isArray(list)) list = Object.keys(list).map(k => Object.assign({ _label: k }, typeof list[k] === 'string' ? { url: list[k] } : list[k]));
  const out = {};
  for (const f of list) {
    const url = [f.url, f.link, f.download, f.href].find(x => /^https?:/.test(String(x || '')));
    if (!url) continue;
    const label = [f._label, f.type, f.name, f.stem, String(f.download || f.file || url).split(/[/?#]/).filter(Boolean).pop()].filter(x => typeof x === 'string').join(' ').toLowerCase();
    if (/instrum|no[ _-]?vocal|other|accomp|karaoke/.test(label)) { if (!out.i) out.i = url; }
    else if (/vocal|voice/.test(label)) { if (!out.v) out.v = url; }
  }
  return out;
}
async function ksFetchTo(env, url, key) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('הורדה מ-MVSEP נכשלה (' + r.status + ')');
  const len = +(r.headers.get('content-length') || 0);
  if (len) await env.BUCKET.put(key, r.body, { httpMetadata: { contentType: 'audio/mpeg' } });
  else await env.BUCKET.put(key, await r.arrayBuffer(), { httpMetadata: { contentType: 'audio/mpeg' } });
}
// job = {hash, status}; want = ['v','i'] or ['v']; names = {v: file name, i: file name}
async function ksPoll(env, s, job, want, names) {
  if (job.status === 'done' || job.status === 'failed') return job;
  if (job.fetching && Date.now() - job.fetching < 90000) return job;
  const r = await fetch('https://mvsep.com/api/separation/get?hash=' + encodeURIComponent(job.hash));
  const j = await r.json().catch(() => ({}));
  const st = j.status || 'waiting', data = j.data || {};
  if (st === 'failed' || st === 'not_found') { job.status = 'failed'; job.err = String(data.message || st).slice(0, 160); return job; }
  if (st !== 'done') { job.status = st; job.queue = data.current_order != null ? +data.current_order : (data.queue_count != null ? +data.queue_count : null); if (data.all_chunks) job.chunks = [data.finished_chunks | 0, data.all_chunks | 0]; return job; }
  const files = ksFiles(data);
  if (want.some(w => !files[w])) { job.status = 'failed'; job.err = 'לא נמצאו הערוצים בתשובה'; job.dbg = JSON.stringify(data.files || data).slice(0, 600); return job; }
  job.fetching = Date.now(); await ksPut(env, s);
  for (const w of want) await ksFetchTo(env, files[w], 'ks/f/' + s.id + '/' + names[w]);
  job.status = 'done'; job.fetching = 0;
  try { const f = new FormData(); f.append('hash', job.hash); await mvsep(env, 'delete', f); } catch (e) {} // no copy left at MVSEP
  return job;
}
async function ksTranscribe(env, d) {
  const b64 = String(d.audio || ''); if (!b64) throw new Error('אין שמע');
  const lang = /^(he|en|ar|ru|fr|es)$/.test(d.lang) ? d.lang : '';
  const oai = ksKeys(env).openai;
  if (oai) {
    const f = new FormData();
    f.append('file', new Blob([b64ToBytes(b64)], { type: d.mime || 'audio/mpeg' }), 'vocals.' + (/wav/.test(d.mime) ? 'wav' : 'mp3'));
    f.append('model', 'whisper-1'); f.append('response_format', 'verbose_json'); f.append('timestamp_granularities[]', 'word');
    if (lang) f.append('language', lang);
    if (d.prompt) f.append('prompt', String(d.prompt).slice(0, 900));
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + oai }, body: f });
    if (!r.ok) throw new Error('Whisper ' + r.status + ': ' + (await r.text()).slice(0, 160));
    const j = await r.json();
    return { via: 'whisper', lang: j.language || lang, words: (j.words || []).map(w => [w.word, +w.start, +w.end]) };
  }
  if (!env.GEMINI_API_KEY) throw new Error('התמלול לא מחובר');
  const key = String(env.GEMINI_API_KEY).trim(); const models = await bsModels(env, key); const errs = [];
  const prompt = 'This is an isolated lead-vocal track of a song. Transcribe the sung lyrics exactly as sung' + (lang ? ' (language: ' + lang + ')' : ' in the original language') +
    ', split into the natural sung lines (phrases of about 3-9 words). For every line give its start and end time in seconds from the start of the audio, as precisely as possible. Ignore non-lyric sounds. ' +
    (d.prompt ? 'The lyrics may be close to: ' + String(d.prompt).slice(0, 1500) + '. ' : '') +
    'Answer as JSON only: {"lines":[{"start":12.3,"end":15.8,"text":"..."}]}';
  for (const model of models) {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inline_data: { mime_type: d.mime || 'audio/mpeg', data: b64 } }, { text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } }) });
    if (!r.ok) { errs.push(model + ' ' + r.status); continue; }
    const j = await r.json(); const t = ((((j.candidates || [])[0] || {}).content || {}).parts || []).filter(x => !x.thought).map(x => x.text || '').join('').replace(/^```(?:json)?\s*|\s*```$/g, '');
    try { const o = JSON.parse(t); return { via: 'gemini', lang, lines: (o.lines || []).map(l => ({ t: +l.start || 0, e: +l.end || 0, text: String(l.text || '').trim() })).filter(l => l.text) }; } catch (e) { errs.push(model + ' bad json'); }
  }
  throw new Error('התמלול נכשל: ' + errs.join(' | ').slice(0, 160));
}
// the strongest Gemini that listens: newest "pro" first, then the flash list used elsewhere
async function ksModels(env, key) {
  const c = await getJ(env, 'config/ks_models.json');
  if (c && Date.now() - c.at < 86400000 && c.models.length) return c.models;
  let pro = [];
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    if (r.ok) {
      const ver = (n) => { const m = n.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
      pro = ((await r.json()).models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''))
        .filter(n => /^gemini-[\d.]+-pro/.test(n) && !/(image|tts|audio|live|vision|embedding|exp|computer)/.test(n) && !/^gemini-[12]\./.test(n))
        .sort((a, b) => ver(b) - ver(a) || (/preview/.test(a) ? 1 : 0) - (/preview/.test(b) ? 1 : 0)).slice(0, 2);
    }
  } catch (e) {}
  const models = pro.concat(['gemini-pro-latest'].filter(x => !pro.includes(x)), (await bsModels(env, key)).slice(0, 2));
  await putJ(env, 'config/ks_models.json', { at: Date.now(), models });
  return models;
}
// a second pass over the recognised lyrics: listen to the vocal and fix wrong / garbled / missing words, line by line
async function ksFix(env, d) {
  const key = String(env.GEMINI_API_KEY || '').trim(); if (!key) throw new Error('הבדיקה לא מחוברת');
  const lines = (Array.isArray(d.lines) ? d.lines : []).map(x => String(x || '').slice(0, 200)).slice(0, 300); if (!lines.length) throw new Error('אין שורות');
  const lang = d.lang === 'en' ? 'English' : d.lang === 'he' || !d.lang ? 'Hebrew' : d.lang;
  const prompt = 'You get the isolated lead-vocal track of a song (' + lang + ') and an automatic speech-recognition transcript of it, one sung line per row (numbered).\n' +
    'Listen to the whole track and correct the transcript so it is exactly what is sung: fix misheard words, garbled or misspelled words, words that make no sense in context, wrongly joined or split words, and add words that were sung but missed. ' +
    'Use correct standard spelling' + (lang === 'Hebrew' ? ' (Hebrew ktiv male, no nikud, no punctuation)' : ', no punctuation') + '. ' +
    'Keep exactly the same number of rows in the same order - each row must stay the line sung at that point; a word may move to the neighbouring row only if it clearly belongs there. Do not rewrite style, do not translate, do not invent lyrics; if a row is unclear keep it as it is. ' +
    'If you recognise the song, you may use your knowledge of its real lyrics, but only where it matches what is sung.\n\n' +
    lines.map((l, i) => (i + 1) + '. ' + l).join('\n') +
    '\n\nAnswer as JSON only: {"lines":["...", ...], "changed":[row numbers you changed]}';
  const models = await ksModels(env, key), errs = [];
  for (const model of models) {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inline_data: { mime_type: d.mime || 'audio/mpeg', data: String(d.audio || '') } }, { text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } }) });
    if (!r.ok) { errs.push(model + ' ' + r.status); continue; }
    const j = await r.json(); const t = ((((j.candidates || [])[0] || {}).content || {}).parts || []).filter(x => !x.thought).map(x => x.text || '').join('').replace(/^```(?:json)?\s*|\s*```$/g, '');
    try {
      const o = JSON.parse(t); const out = (o.lines || []).map(x => String(x || '').replace(/\s+/g, ' ').trim());
      if (out.length !== lines.length || out.some(x => !x)) { errs.push(model + ' rows ' + out.length); continue; }
      return { lines: out, changed: out.map((x, i) => x !== lines[i] ? i : -1).filter(i => i >= 0), model };
    } catch (e) { errs.push(model + ' bad json'); }
  }
  throw new Error('הבדיקה נכשלה: ' + errs.join(' | ').slice(0, 160));
}
async function ksAction(d, env, ip) {
  if (d.action === 'ks_s_login') {
    const c = await getJ(env, 'config/admin.json');
    if (!c || (await sha(c.salt + String(d.pass || ''))) !== c.hash) return { ok: false, error: 'סיסמה שגויה' };
    return { ok: true, st: await ksStaffTok(c, Math.floor(Date.now() / KS_DAY)) };
  }
  const who = await ksWho(env, d);
  try { await ksSweep(env); } catch (e) {}
  if (/^ks_s_/.test(d.action)) {
    if (!who.staff) throw new Error('רק לצוות');
    if (d.action === 'ks_s_links') {
      const items = []; let cursor;
      do { const l = await env.BUCKET.list({ prefix: 'ks/a/', cursor }); for (const o of l.objects) { const a = await getJ(env, o.key); if (a) items.push(Object.assign({ key: o.key.slice(5, -5) }, a, { songs: (a.songs || []).length })); } cursor = l.truncated ? l.cursor : null; } while (cursor);
      items.sort((x, y) => y.created - x.created); return { ok: true, items };
    }
    if (d.action === 'ks_s_link_new') {
      const name = String(d.name || '').trim().slice(0, 60); if (!name) return { ok: false, error: 'חסר שם' };
      const key = tok(), days = Math.max(1, Math.min(730, d.days | 0 || 90));
      await putJ(env, 'ks/a/' + key + '.json', { name, phone: String(d.phone || '').replace(/[^\d+]/g, '').slice(0, 15), quota: Math.max(1, Math.min(500, d.quota | 0 || 5)), used: 0, created: Date.now(), expires: Date.now() + days * KS_DAY, active: true, songs: [] });
      return { ok: true, key };
    }
    if (d.action === 'ks_s_link_set') {
      const k = 'ks/a/' + String(d.key || '').replace(/[^a-f0-9]/g, '') + '.json'; const a = await getJ(env, k); if (!a) return { ok: false, error: 'לא נמצא' };
      if (d.active != null) a.active = !!d.active; if (d.quota != null) a.quota = Math.max(0, d.quota | 0); if (d.days) a.expires = Date.now() + Math.min(730, d.days | 0) * KS_DAY; if (d.name) a.name = String(d.name).slice(0, 60);
      await putJ(env, k, a); return { ok: true };
    }
    return { ok: false, error: 'unknown action' };
  }
  if (d.action === 'ks_hello') {
    let ids = [];
    if (who.staff) { const l = await env.BUCKET.list({ prefix: 'ks/s/', include: ['customMetadata'] }); ids = l.objects.filter(o => (o.customMetadata || {}).owner === 'staff').map(o => o.key.slice(5, -5)); }
    else ids = (who.acc.songs || []).slice(-60);
    const songs = [];
    for (const id of ids) { const s = await getJ(env, 'ks/s/' + id + '.json'); if (s && Date.now() < s.expires) songs.push(ksPub(s)); }
    songs.sort((a, b) => b.created - a.created);
    return { ok: true, name: who.name, staff: who.staff, left: who.staff ? null : Math.max(0, who.acc.quota - who.acc.used), quota: who.staff ? null : who.acc.quota, expires: who.staff ? null : who.acc.expires, songs, days: KS_DAYS, transcriber: ksKeys(env).openai ? 'whisper' : (env.GEMINI_API_KEY ? 'gemini' : ''), separator: !!ksKeys(env).mvsep };
  }
  const s = await ksSong(env, who, d.id);
  if (d.action === 'ks_status') {
    if (s.status !== 'done' && s.status !== 'failed') {
      const job = await ksPoll(env, s, s.job, ['v', 'i'], { v: 'vocals.mp3', i: 'inst.mp3' });
      s.status = job.status === 'done' ? 'done' : job.status === 'failed' ? 'failed' : 'working'; if (job.err) s.err = job.err; await ksPut(env, s);
    }
    return { ok: true, song: ksPub(s), stage: (s.job || {}).status || '', queue: (s.job || {}).queue, chunks: (s.job || {}).chunks || null, dbg: (s.job || {}).dbg || '' };
  }
  if (d.action === 'ks_song') return { ok: true, song: ksPub(s), lyrics: s.lyrics || null, words: s.words || null, lang: s.lang || '', ref: s.ref || null, cleans: (s.cleans || []).map((c, n) => ({ n, status: c.status, err: c.err || '', at: c.at })) };
  if (d.action === 'ks_save') {
    if (d.title != null) s.title = String(d.title).trim().slice(0, 80) || s.title;
    if (Array.isArray(d.lyrics)) s.lyrics = d.lyrics.slice(0, 400).map(l => ({ text: String(l.text || '').slice(0, 160), t: +l.t || 0, e: +l.e || 0, w: Array.isArray(l.w) ? l.w.slice(0, 40).map(x => [+(+x[0]).toFixed(2), +(+x[1]).toFixed(2)]) : null }));
    if (d.lang != null) s.lang = String(d.lang).slice(0, 5);
    if (d.ref != null && /^[A-Za-z0-9+/=]{0,400000}$/.test(String(d.ref))) s.ref = String(d.ref); // the original singer's pitch map (int16 cents, base64)
    await ksPut(env, s); return { ok: true };
  }
  if (d.action === 'ks_tr') {
    const r = await ksTranscribe(env, d);
    if (r.words) s.words = r.words.slice(0, 4000); s.lang = r.lang || s.lang || ''; s.trAt = Date.now(); await ksPut(env, s);
    return Object.assign({ ok: true }, r);
  }
  if (d.action === 'ks_fix') { const r = await ksFix(env, d); s.fixAt = Date.now(); await ksPut(env, s); return Object.assign({ ok: true }, r); }
  if (d.action === 'ks_clean_status') {
    const c = (s.cleans || [])[d.n | 0]; if (!c) return { ok: false, error: 'לא נמצא' };
    if (c.status !== 'done' && c.status !== 'failed') { await ksPoll(env, s, c, ['v'], { v: 'c' + (d.n | 0) + '.mp3' }); await ksPut(env, s); }
    return { ok: true, status: c.status, err: c.err || '', queue: c.queue };
  }
  if (d.action === 'ks_del') { await ksDeleteSong(env, s.id); if (!who.staff) { const k = 'ks/a/' + who.owner + '.json'; const a = await getJ(env, k); if (a) { a.songs = (a.songs || []).filter(x => x !== s.id); await putJ(env, k, a); } } return { ok: true }; }
  return { ok: false, error: 'unknown action' };
}
// binary routes: POST ?ks=up (new song) · POST ?ks=clean&id= (a take to remove music from) · GET ?ks=f&id=&f=v|i|c0..
async function ksHttp(req, env, u) {
  const q = Object.fromEntries(u.searchParams); const who = await ksWho(env, q);
  if (q.ks === 'f' && req.method === 'GET') {
    const s = await ksSong(env, who, q.id); const f = String(q.f || '');
    const name = f === 'v' ? 'vocals.mp3' : f === 'i' ? 'inst.mp3' : /^c\d$/.test(f) ? f + '.mp3' : '';
    const o = name && await env.BUCKET.get('ks/f/' + s.id + '/' + name);
    if (!o) return new Response('not found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
    return new Response(o.body, { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'audio/mpeg', 'Content-Length': String(o.size), 'Cache-Control': 'private, max-age=86400' } });
  }
  if (req.method !== 'POST') return out({ ok: false, error: 'bad request' });
  const len = +(req.headers.get('content-length') || 0);
  if (len > KS_MAX_BYTES) return out({ ok: false, error: 'הקובץ גדול מדי (עד 60MB)' });
  const type = (req.headers.get('content-type') || 'audio/mpeg').split(';')[0];
  if (q.ks === 'up') {
    if (!who.staff && who.acc.used >= who.acc.quota) return out({ ok: false, error: 'נוצלו כל השירים בקישור הזה. אפשר לפנות לאולפני קולות להרחבה' });
    const bytes = await req.arrayBuffer(); if (bytes.byteLength < 20000) return out({ ok: false, error: 'הקובץ קטן מדי' });
    const hash = await ksStart(env, bytes, type, 'song.' + (/wav/.test(type) ? 'wav' : /mp4|m4a|aac/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : /flac/.test(type) ? 'flac' : 'mp3')); // neutral name: the stems are told apart by their names
    const id = tok(), now = Date.now();
    const s = { id, owner: who.owner, title: String(q.title || 'שיר').slice(0, 80), created: now, expires: now + KS_DAYS * KS_DAY, status: 'working', dur: Math.round(+q.dur || 0), job: { hash, status: 'waiting', at: now }, terms: { at: now, v: String(q.tv || '1').slice(0, 8) } };
    await ksPut(env, s);
    if (!who.staff) { const k = 'ks/a/' + who.owner + '.json'; const a = await getJ(env, k); a.used = (a.used | 0) + 1; a.songs = (a.songs || []).concat([id]); await putJ(env, k, a); }
    return out({ ok: true, id, song: ksPub(s) });
  }
  if (q.ks === 'clean') {
    const s = await ksSong(env, who, q.id); s.cleans = s.cleans || [];
    if (s.cleans.length >= KS_MAX_CLEANS) return out({ ok: false, error: 'אפשר לנקות עד ' + KS_MAX_CLEANS + ' הקלטות לשיר' });
    const bytes = await req.arrayBuffer();
    const hash = await ksStart(env, bytes, type, 'take.' + (/wav/.test(type) ? 'wav' : 'mp3'));
    s.cleans.push({ hash, status: 'waiting', at: Date.now() }); await ksPut(env, s);
    return out({ ok: true, n: s.cleans.length - 1 });
  }
  return out({ ok: false, error: 'bad request' });
}
