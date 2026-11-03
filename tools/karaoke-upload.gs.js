
/* ===================== Karaoke – personal upload links (e.g. for whoever records the guide) =====================
 * An uploader link (#u=KEY) can only: find the customer's clip order by phone, run the line placement, create the song and send its link.
 * It cannot list, open or change any other song. Staff can create / disable uploader links.
 */
function kkUploaders_(P) { try { return JSON.parse(P.getProperty('KK_UPLOADERS') || '{}'); } catch (e) { return {}; } }
function kkUp_(P, u) { const x = kkUploaders_(P)[String(u || '')]; return x && x.active ? x : null; }
function kkUpStaff_(d, P) {
  const m = kkUploaders_(P);
  if (d.action === 'kk_up_list') return { ok: true, items: Object.keys(m).map(k => Object.assign({ key: k }, m[k])) };
  if (d.action === 'kk_up_create') { const name = String(d.name || '').trim().slice(0, 40); if (!name) return { ok: false, error: 'חסר שם' }; const key = kkTok_(); m[key] = { name: name, active: true, created: Date.now(), count: 0 }; P.setProperty('KK_UPLOADERS', JSON.stringify(m)); return { ok: true, key: key }; }
  if (d.action === 'kk_up_set') { const x = m[String(d.key || '')]; if (!x) return { ok: false, error: 'לא נמצא' }; if (d.active != null) x.active = !!d.active; if (d.name) x.name = String(d.name).trim().slice(0, 40); P.setProperty('KK_UPLOADERS', JSON.stringify(m)); return { ok: true }; }
  if (d.action === 'kk_review_done') { const idx = kkIndex_(P); const e = idx[d.k]; if (!e) return { ok: false, error: 'לא נמצא' }; delete e.needsReview; idx[d.k] = e; kkSaveIndex_(P, idx); return { ok: true }; }
  return null;
}
/** Find the customer's clip order by phone (and name as a tie-breaker). Read-only. */
function kkFindByPhone_(phone, name) {
  const want = String(phone || '').replace(/\D/g, '').slice(-9); if (want.length < 9) return { ok: false, error: 'מספר טלפון לא תקין' };
  const since = Math.floor(Date.now() / 1000) - 400 * 86400;
  const j = kalaGet_('/api/v1/order_product?limit=1000&page_type_id=2626&order_from_date=' + since + '&virtual_fields[]=order_data&virtual_fields[]=order_is_deleted');
  const hits = {};
  (j.payload || []).forEach(p => {
    if (p.order_is_deleted || p.deleted == 1) return;
    let od = p.order_data || {}; if (typeof od === 'string') { try { od = JSON.parse(od); } catch (e) { od = {}; } }
    const phones = [p.phone, p.mobile, od.phone, od.mobile].map(x => String(x || '').replace(/\D/g, '').slice(-9));
    if (phones.indexOf(want) < 0) return;
    let attrs = p.order_attributes || od.order_attributes || {}; if (typeof attrs === 'string') { try { attrs = JSON.parse(attrs); } catch (e) { attrs = {}; } }
    const id = String(p.order_id);
    if (!hits[id]) hits[id] = { orderId: id, name: p.full_name || od.full_name || '', product: String(p.title || ''), date: kkIsoDate_(attrs.event_date || '') };
  });
  let list = Object.keys(hits).map(k => hits[k]);
  if (list.length > 1) { const today = Utilities.formatDate(new Date(Date.now() - 86400000), 'Asia/Jerusalem', 'yyyy-MM-dd'); const fut = list.filter(x => x.date && x.date >= today); if (fut.length) list = fut; }
  if (list.length > 1 && name) { const n = String(name).replace(/\s+/g, ''); const byName = list.filter(x => String(x.name).replace(/\s+/g, '').indexOf(n) >= 0 || n.indexOf(String(x.name).replace(/\s+/g, '')) >= 0); if (byName.length) list = byName; }
  if (!list.length) return { ok: true, found: 0 };
  if (list.length > 1) return { ok: true, found: list.length };
  const h = list[0]; const rg = kkRange_(h.product);
  return { ok: true, found: 1, orderId: h.orderId, name: h.name, product: h.product, maxP: rg.max, minP: rg.min, date: h.date };
}
function kkUpload_(d, P) {
  const up = kkUp_(P, d.u); if (!up) return { ok: false, error: 'הלינק להעלאה לא פעיל. פנו לאולפני קולות.' };
  if (d.action === 'kk_u_check') return { ok: true, name: up.name };
  if (d.action === 'kk_u_find') return kkFindByPhone_(d.phone, d.name);
  if (d.action === 'kk_u_transcribe') return kkTranscribe_(d, P);
  if (d.action === 'kk_u_save') {
    const lock = LockService.getScriptLock(); lock.waitLock(20000);
    try {
      const idx = kkIndex_(P); const k = kkTok_(); const m = d.meta || {}; const e = { created: Date.now() };
      e.name = String(m.name || '').slice(0, 80); e.phone = String(m.phone || '').replace(/\D/g, '').slice(-10); e.orderId = String(m.orderId || '').replace(/\D/g, '');
      e.recDate = /^\d{4}-\d{2}-\d{2}$/.test(m.recDate || '') ? m.recDate : ''; e.expires = kkExpires_(e.recDate, e.created);
      e.product = String(m.product || '').slice(0, 80); e.maxP = +m.maxP || 0; e.minP = +m.minP || 0;
      if (m.review) e.needsReview = String(m.review).slice(0, 120);
      e.json = kkPut_(P, null, k + '.json', Utilities.newBlob(JSON.stringify(d.project || {}), 'application/json'));
      if (d.audio) e.audio = kkPut_(P, null, k + '.audio', Utilities.newBlob(Utilities.base64Decode(d.audio), d.mime || 'audio/mpeg'));
      e.title = String((d.project || {}).title || '').slice(0, 80); e.updated = Date.now(); e.by = 'uploader'; e.uploader = String(d.u); e.uploaderName = up.name;
      idx[k] = e; kkSaveIndex_(P, idx);
      if (e.needsReview) kkAlertSong_('⚠ קריוקי: גייד ממתין לבדיקה – ' + (e.name || e.phone), k, e, 'הלינק לא נשלח ללקוח. הסיבה: ' + e.needsReview);
      const mm = kkUploaders_(P); if (mm[d.u]) { mm[d.u].count = (mm[d.u].count || 0) + 1; P.setProperty('KK_UPLOADERS', JSON.stringify(mm)); }
      return { ok: true, k: k };
    } finally { lock.releaseLock(); }
  }
  if (d.action === 'kk_u_send') {
    const e = kkIndex_(P)[String(d.k || '')]; if (!e || e.uploader !== String(d.u)) return { ok: false, error: 'לא נמצא' };
    if (e.needsReview) return { ok: false, error: 'ממתין לבדיקה של הצוות' };
    const r = kkSend_(P, String(d.k));
    if (!r.ok) kkAlertSong_('⚠ קריוקי: הלינק לא נשלח ללקוח – ' + (e.name || e.phone), String(d.k), e, 'השליחה בוואטסאפ לא בוצעה: ' + (r.error || '') + '\nצריך לשלוח ידנית.');
    return r;
  }
  return { ok: false, error: 'unknown action' };
}
