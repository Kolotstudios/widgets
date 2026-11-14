// KOLOT site chat | Cloudflare Worker "kolot-site-chat"
// Replaces the Chatbase widget on kolot-studios.com. Answers from the Kala agent's knowledge base (docs 01-07, stored in KV)
// plus the website-channel rules in channel.js, and steers visitors to the business WhatsApp (Kala agent).
//
// Bindings: KB (KV namespace "kolot-site-chat"), AI (Workers AI). Secret: ADMIN_KEY. Optional vars: MODEL, MODELS (comma list).
// Routes:
//   GET  /widget.js        the chat widget (one <script> tag on the site)
//   POST /chat             { sid, messages:[{role,content}], page } -> { reply, wa }
//   GET  /health
//   POST /admin/kb         x-admin-key; { docs:[{title,text}] } replaces the knowledge base
//   GET  /admin/kb         x-admin-key; titles + sizes
//   GET  /admin/logs       x-admin-key; recent conversations (kept 30 days)
import { CHANNEL_DOC, CLOSING_REMINDER, WA_NUMBER } from './channel.js';
import { WIDGET_JS } from './widget.gen.js';

// Gemma 4 with thinking off: good Hebrew, ~2-6s, ~340 neurons per answer with the full knowledge base (Workers Free = 10,000/day).
// gpt-oss-120b is only the fallback (about 3x the cost). glm-5.3-flash needs the Workers Paid plan.
const DEFAULT_MODELS = ['@cf/google/gemma-4-26b-a4b-it', '@cf/openai/gpt-oss-120b'];
const MODEL_PARAMS = {
  '@cf/google/gemma-4-26b-a4b-it': { chat_template_kwargs: { enable_thinking: false } },
  '@cf/qwen/qwen3-30b-a3b-fp8': { chat_template_kwargs: { enable_thinking: false } },
  '@cf/openai/gpt-oss-120b': { reasoning_effort: 'low' },
  '@cf/openai/gpt-oss-20b': { reasoning_effort: 'low' },
};
const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*kolot-studios\.com$|^https:\/\/kolot-site-chat\.[a-z0-9-]+\.workers\.dev$/i;
const MAX_MSG = 800, MAX_TURNS = 16, MAX_USER_MSGS = 40;

const hits = new Map(); // per-isolate rate limit: ip -> [timestamps]
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 30;
}

function cors(req, admin = false) {
  const o = req.headers.get('Origin') || '';
  const allow = admin ? (o || '*') : (ALLOWED_ORIGIN.test(o) ? o : 'https://www.kolot-studios.com');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
const json = (o, status, h) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...h } });

function sameKey(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}

let promptCache = null; // { stamp, text }
async function systemPrompt(env) {
  const kb = await env.KB.get('kb', 'json');
  const stamp = kb ? kb.updated : 'none';
  if (promptCache && promptCache.stamp === stamp) return promptCache.text;
  const docs = (kb?.docs || []).filter((d) => d && d.text && !/^00[_ ]/.test(d.title || ''))
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  const body = docs.map((d) => `===== ${d.title} =====\n${d.text.trim()}`).join('\n\n');
  const text = `${CHANNEL_DOC}\n\n${body}\n\n===== סוף המאגר =====\n${CLOSING_REMINDER}`;
  promptCache = { stamp, text };
  return text;
}

function textOf(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (typeof r.response === 'string') return r.response;
  const c = r.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => p.text || '').join('');
  if (Array.isArray(r.output)) {
    const msg = r.output.filter((o) => o.type === 'message').pop();
    if (msg) return (msg.content || []).map((p) => p.text || '').join('');
  }
  if (r.result) return textOf(r.result);
  return '';
}

function splitWa(raw) {
  let t = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  let wa = null;
  const i = t.search(/\[WA\]/);
  if (i >= 0) { wa = t.slice(i + 4).replace(/\s+/g, ' ').trim().replace(/^["'“”:]+|["'“”]+$/g, '').slice(0, 500) || null; t = t.slice(0, i).trim(); }
  t = t.replace(/\[WA\][^\n]*/g, '').trim();
  return { reply: t, wa };
}

async function ask(env, messages) {
  const list = (env.MODELS ? env.MODELS.split(',') : env.MODEL ? [env.MODEL, ...DEFAULT_MODELS] : DEFAULT_MODELS).map((s) => s.trim()).filter(Boolean);
  const errors = [];
  for (const model of [...new Set(list)]) {
    const t0 = Date.now();
    try {
      const r = await env.AI.run(model, { messages, max_tokens: 900, temperature: 0.5, ...(MODEL_PARAMS[model] || {}) });
      const t = textOf(r);
      if (t && t.trim()) return { text: t, model, ms: Date.now() - t0, usage: r.usage || null, errors };
      errors.push(model + ': empty ' + JSON.stringify(r).slice(0, 200));
    } catch (e) { errors.push(model + ': ' + String(e && e.message || e).slice(0, 200) + ' (' + (Date.now() - t0) + 'ms)'); }
  }
  const err = new Error('all models failed'); err.errors = errors; throw err;
}

async function chat(req, env, ctx) {
  const ip = req.headers.get('CF-Connecting-IP') || 'x';
  if (limited(ip)) return { status: 429, body: { reply: 'רגע, יש הרבה הודעות ברצף 🙂 אפשר להמשיך איתנו בוואטסאפ.', wa: 'היי, הגעתי מהצ׳אט באתר ואשמח לעזרה.' } };
  let b; try { b = await req.json(); } catch { return { status: 400, body: { error: 'bad json' } }; }
  const sid = String(b.sid || '').slice(0, 40).replace(/[^a-zA-Z0-9_-]/g, '') || 'anon';
  const msgs = (Array.isArray(b.messages) ? b.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return { status: 400, body: { error: 'no question' } };
  const userCount = msgs.filter((m) => m.role === 'user').length;
  if (userCount > MAX_USER_MSGS) return { status: 200, body: { reply: 'כדי שנוכל להמשיך ולטפל בכל הפרטים, הכי טוב להמשיך איתנו בוואטסאפ 😊', wa: 'היי, הגעתי מהצ׳אט באתר ואשמח להמשיך כאן.' } };
  const history = msgs.slice(-MAX_TURNS);
  while (history.length && history[0].role !== 'user') history.shift();
  const page = String(b.page || '').slice(0, 200);
  const sys = await systemPrompt(env) + (page ? `\n\n(הגולש נמצא כרגע בעמוד: ${page})` : '');
  let out, model = '', failed = false, meta = {};
  try { const r = await ask(env, [{ role: 'system', content: sys }, ...history]); out = splitWa(r.text); model = r.model; meta = { ms: r.ms, usage: r.usage, errors: r.errors }; }
  catch (e) {
    failed = true; meta = { errors: e.errors || [String(e)] }; console.log('ai error', JSON.stringify(meta));
    out = { reply: 'אופס, משהו השתבש אצלי לרגע 🙈 הכי מהיר להמשיך איתנו בוואטסאפ – שם עונים מיד.', wa: 'היי, הגעתי מהצ׳אט באתר ואשמח לעזרה.' };
  }
  if (!out.reply) out.reply = 'אשמח להמשיך איתך בוואטסאפ 😊';
  const day = new Date().toISOString().slice(0, 10);
  ctx.waitUntil((async () => {
    try {
      await env.KB.put(`log:${day}:${sid}`, JSON.stringify({ t: Date.now(), page, model, failed, ...meta, messages: [...history, { role: 'assistant', content: out.reply + (out.wa ? `\n[WA] ${out.wa}` : '') }] }), { expirationTtl: 30 * 86400 });
    } catch {}
  })());
  return { status: 200, body: { reply: out.reply, wa: out.wa, n: WA_NUMBER } };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const isAdmin = path.startsWith('/admin/');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, isAdmin) });

    if (path === '/widget.js') {
      return new Response(WIDGET_JS.replace('__API__', url.origin).replace('__WA__', WA_NUMBER), {
        headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=600', 'Access-Control-Allow-Origin': '*' },
      });
    }
    if (path === '/health') {
      const kb = await env.KB.get('kb', 'json');
      return json({ ok: true, kbDocs: kb?.docs?.length || 0, kbUpdated: kb?.updated || null }, 200, cors(req));
    }
    if (path === '/chat' && req.method === 'POST') {
      const r = await chat(req, env, ctx);
      return json(r.body, r.status, cors(req));
    }
    if (isAdmin) {
      const h = cors(req, true);
      if (!sameKey(req.headers.get('x-admin-key') || url.searchParams.get('key') || '', env.ADMIN_KEY || '')) return json({ error: 'unauthorized' }, 401, h);
      if (path === '/admin/kb' && req.method === 'POST') {
        let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400, h); }
        const docs = (b.docs || []).filter((d) => d && typeof d.title === 'string' && typeof d.text === 'string' && d.text.length < 200000)
          .map((d) => ({ title: d.title.slice(0, 200), text: d.text }));
        if (!docs.length) return json({ error: 'no docs' }, 400, h);
        const kb = { updated: new Date().toISOString(), source: String(b.source || '').slice(0, 200), docs };
        await env.KB.put('kb', JSON.stringify(kb));
        promptCache = null;
        return json({ ok: true, docs: docs.map((d) => [d.title, d.text.length]), updated: kb.updated }, 200, h);
      }
      if (path === '/admin/try' && req.method === 'POST') {
        // experiment: { model, params, system?, question } -> raw answer + usage (does not touch the live prompt)
        const b = await req.json();
        const sys = b.system === 'live' ? await systemPrompt(env) : (b.system || 'ענה בעברית בקצרה.');
        const t0 = Date.now();
        try {
          const r = await env.AI.run(b.model, { messages: [{ role: 'system', content: sys }, { role: 'user', content: b.question || 'היי' }], ...(b.params || {}) });
          return json({ ms: Date.now() - t0, text: textOf(r), usage: r.usage || null, raw: JSON.stringify(r).slice(0, 1500) }, 200, h);
        } catch (e) { return json({ ms: Date.now() - t0, error: String(e && e.message || e) }, 200, h); }
      }
      if (path === '/admin/kb' && url.searchParams.get('full')) return json(await env.KB.get('kb', 'json'), 200, h);
      if (path === '/admin/kb') {
        const kb = await env.KB.get('kb', 'json');
        return json({ updated: kb?.updated, source: kb?.source, docs: (kb?.docs || []).map((d) => [d.title, d.text.length]), promptChars: (await systemPrompt(env)).length }, 200, h);
      }
      if (path === '/admin/logs') {
        const list = await env.KB.list({ prefix: 'log:', limit: 1000 });
        const keys = list.keys.map((k) => k.name).sort().reverse().slice(0, Math.min(+url.searchParams.get('n') || 30, 100));
        const items = await Promise.all(keys.map(async (k) => ({ key: k, ...(await env.KB.get(k, 'json')) })));
        return json({ count: list.keys.length, items }, 200, h);
      }
      return json({ error: 'not found' }, 404, h);
    }
    if (path === '/') return new Response('KOLOT site chat', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    return new Response('not found', { status: 404 });
  },
};
