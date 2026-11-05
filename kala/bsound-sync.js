/* B-Sound: push b-sound-catalog.json into the Kala products (title, price, description).
 * Run inside the Kala admin (kolot.kala-crm.co.il/admin, signed in): window.bsSync(catalogUrl) → report.
 * Only products with a kala_id are touched; nothing is created or deleted here. */
window.bsSync = async function (url) {
  const cat = await fetch(url, { cache: 'no-store' }).then(r => r.json());
  const hdr = { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  const ex = p => p.subtitle + '<br />\n<br />\n' + p.meta + '<br />\n<br />\n<b>מה כלול:</b><br />\n' +
    p.includes.map(i => '✔️ ' + i).join('<br />\n') + '<br />\n<br />\n<i>' + p.footer + '</i><br />\n<i>המחיר כולל מע"מ</i>';
  const out = [];
  for (const p of cat.products) {
    if (!p.kala_id) continue;
    const cur = (await (await fetch('/api/v1/page/' + p.kala_id, { headers: { 'Accept': 'application/json' } })).json()).payload;
    const body = { title: p.title, excerpt: ex(p), attributes: Object.assign({}, cur.attributes || {}, { price: p.price, description: p.subtitle }) };
    const changed = cur.title !== body.title || cur.excerpt !== body.excerpt || Number((cur.attributes || {}).price) !== p.price;
    if (!changed) { out.push(p.key + ': ללא שינוי'); continue; }
    const r = await fetch('/api/v1/page/' + p.kala_id, { method: 'PUT', headers: hdr, body: JSON.stringify(body) });
    out.push(p.key + ': ' + (r.ok ? 'עודכן' : 'שגיאה ' + r.status));
  }
  return { version: cat.version, out };
};
