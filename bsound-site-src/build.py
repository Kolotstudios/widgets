# B-Sound static site generator. Run: python3 bsound-site-src/build.py  -> writes bsound-site/
# Keeps the Wix URLs (same slugs) so Google rankings carry over when the domain moves.
import json, os, re, html, shutil, datetime, sys
sys.path.insert(0, os.path.dirname(__file__))
from content_pages import PAGES, REDIRECTS
from content_articles import ARTICLES

ROOT = os.path.join(os.path.dirname(__file__), '..', 'bsound-site')
DOMAIN = 'https://www.b-sound.co.il'
PREVIEW = True          # True = noindex (preview on GitHub Pages). Set False when the domain points here.
ORDER = 'order'   # relative: works on the preview and on the domain
PHONE, PHONE_INTL = '03-6500031', '+97236500031'
WA = 'https://wa.me/972555170280'
TODAY = datetime.date.today().isoformat()

NAV = [('music-on-hold', 'צליל המתנה'), ('extensions', 'נתב שיחות'), ('business-tune', "ג'ינגל מושר"),
       ('sound-cleaning', 'ניקוי רעשים'), ('vinyl-tape', 'דיגיטציה'), ('blog', 'מאמרים'), ('contact', 'צור קשר')]

BUSINESS = {
    "@context": "https://schema.org", "@type": "ProfessionalService", "@id": DOMAIN + "/#business",
    "name": "B-Sound בי סאונד", "alternateName": ["בי סאונד", "B-Sound"],
    "description": "אולפן הקלטות לעסקים בחולון: צליל המתנה, קריינות לנתב שיחות, ג'ינגלים מושרים, ניקוי רעשים מהקלטות ודיגיטציה.",
    "url": DOMAIN + "/", "telephone": PHONE_INTL, "priceRange": "₪₪",
    "image": DOMAIN + "/assets/og.png",
    "address": {"@type": "PostalAddress", "streetAddress": "תמנע 3", "addressLocality": "חולון", "postalCode": "5881305", "addressCountry": "IL"},
    "areaServed": {"@type": "Country", "name": "ישראל"},
    "parentOrganization": {"@type": "Organization", "name": "אולפני קולות", "url": "https://www.kolot-studios.com"},
}

def rel(depth, path):
    """relative link from a page `depth` folders deep to site path ('' = home)"""
    up = '../' * depth
    if path == '': return up or './'
    if path == 'assets': return up + 'assets/'
    return up + path

def esc(s): return html.escape(s, quote=True)

def head(p, depth):
    canon = DOMAIN + '/' + p['slug']
    ld = [BUSINESS] + p.get('ld', [])
    crumbs = p.get('crumbs')
    if crumbs:
        ld.append({"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": n, "item": DOMAIN + '/' + s} for i, (s, n) in enumerate(crumbs)]})
    if p.get('faq'):
        ld.append({"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
            {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": re.sub('<[^>]+>', '', a)}} for q, a in p['faq']]})
    return f'''<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(p['title'])}</title>
<meta name="description" content="{esc(p['desc'])}">
{'<meta name="robots" content="noindex,follow">' if PREVIEW else '<meta name="robots" content="index,follow,max-image-preview:large">'}
<link rel="canonical" href="{canon}">
<meta property="og:type" content="{'article' if p.get('article') else 'website'}">
<meta property="og:locale" content="he_IL">
<meta property="og:site_name" content="B-Sound בי סאונד">
<meta property="og:title" content="{esc(p['title'])}">
<meta property="og:description" content="{esc(p['desc'])}">
<meta property="og:url" content="{canon}">
<meta property="og:image" content="{DOMAIN}/assets/og.png">
<meta name="theme-color" content="#0E1116">
<link rel="icon" href="{rel(depth, 'assets')}favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700;800;900&display=swap">
<link rel="stylesheet" href="{rel(depth, 'assets')}site.css">
<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>
</head>
<body>
<a class="skip" href="#main">דילוג לתוכן</a>
<header class="top"><div class="wrap bar">
<a class="logo" href="{rel(depth, '')}" aria-label="B-Sound – דף הבית"><span class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span dir="ltr">B·SOUND</span></a>
<button class="menu-btn" type="button" aria-expanded="false" aria-controls="nav">תפריט</button>
<nav id="nav" aria-label="ניווט ראשי">{''.join(f'<a href="{rel(depth, s)}"' + (' aria-current="page"' if p['slug'].split('/')[0] == s else '') + f'>{n}</a>' for s, n in NAV)}</nav>
<div class="cta-top"><a class="tel" href="tel:{PHONE_INTL}" dir="ltr">{PHONE}</a><a class="btn sm" href="{rel(depth, 'order')}">הזמנה אונליין</a></div>
</div></header>
<main id="main">
'''

def foot(depth):
    return f'''</main>
<footer class="foot"><div class="wrap cols">
<div><a class="logo" href="{rel(depth, '')}"><span class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span dir="ltr">B·SOUND</span></a>
<p>אולפן הקלטות לעסקים. צליל המתנה, קריינות לנתבי שיחות, ג'ינגלים מושרים, ניקוי רעשים ודיגיטציה. חלק מ<a href="https://www.kolot-studios.com">אולפני קולות</a>.</p></div>
<div><b>שירותים</b><a href="{rel(depth, 'music-on-hold')}">צליל המתנה לעסק</a><a href="{rel(depth, 'extensions')}">קריינות לנתב שיחות</a><a href="{rel(depth, 'business-tune')}">ג'ינגל מושר לעסק</a><a href="{rel(depth, 'vo-slidshow-movies-adr')}">קריינות מקצועית</a><a href="{rel(depth, 'sound-cleaning')}">ניקוי רעשים מהקלטה</a><a href="{rel(depth, 'secret-recordings')}">חידוד הקלטות ותמלול</a><a href="{rel(depth, 'vinyl-tape')}">המרת קלטות ותקליטים</a></div>
<div><b>עוד</b><a href="{rel(depth, 'order')}">הזמנה אונליין</a><a href="{rel(depth, 'blog')}">מאמרים</a><a href="{rel(depth, 'audio-gain')}">הגברת הקלטה</a><a href="{rel(depth, 'restoration')}">שחזור הקלטות</a><a href="{rel(depth, 'sound-editing')}">עריכת סאונד</a><a href="{rel(depth, 'send-us-your-files')}">שליחת קבצים</a></div>
<div><b>יצירת קשר</b><a href="tel:{PHONE_INTL}" dir="ltr">{PHONE}</a><a href="{WA}">וואטסאפ</a><span>תמנע 3, חולון</span><a href="{rel(depth, 'contact')}">כל הפרטים</a></div>
</div><div class="wrap legal">© {datetime.date.today().year} B-Sound · אולפני קולות · כל המחירים באתר כוללים מע"מ</div></footer>
<a class="wa-float" href="{WA}" aria-label="שליחת הודעת וואטסאפ"><svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.2 2.2 2.2 0 0 0 .2-1.3c-.1-.1-.3-.2-.5-.3Z"/></svg></a>
<script src="{rel(depth, 'assets')}site.js" defer></script>
</body>
</html>
'''

def fill(s, depth):
    """placeholders inside content: {{order}} {{wa}} {{tel}} {{phone}} {{p:slug}} {{api}}"""
    s = s.replace('{{order}}', rel(depth, 'order')).replace('{{wa}}', WA).replace('{{tel}}', 'tel:' + PHONE_INTL).replace('{{phone}}', PHONE)
    return re.sub(r'\{\{p:([a-z0-9\-/]*)\}\}', lambda m: rel(depth, m.group(1)), s)

def faq_html(faq):
    if not faq: return ''
    return '<section class="wrap faq"><h2>שאלות נפוצות</h2>' + ''.join(f'<details><summary>{esc(q)}</summary><div>{a}</div></details>' for q, a in faq) + '</section>'

def write(path, text):
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    open(full, 'w', encoding='utf-8').write(text)

def page(p):
    depth = p['slug'].count('/')
    body = fill(p['body'], depth) + faq_html(p.get('faq'))
    if p.get('related'):
        body += '<section class="wrap related"><h2>כדאי לקרוא</h2><div class="cards">' + ''.join(
            f'<a class="card link" href="{rel(depth, "blog/" + a["slug"])}"><b>{esc(a["h1"])}</b><span>{esc(a["desc"])}</span></a>'
            for a in ARTICLES if a['slug'] in p['related']) + '</div></section>'
    body += fill(CTA, depth)
    write((p['slug'] or 'index') + '.html', head(p, depth) + body + foot(depth))

CTA = '''<section class="wrap cta-band"><div><h2>רוצים לשמוע איך זה יישמע אצלכם?</h2><p>כותבים את שם העסק, בוחרים קול ומוזיקה ושומעים את התוצאה. בחינם וללא התחייבות.</p></div>
<div class="acts"><a class="btn" href="{{order}}">לשמוע את צליל ההמתנה שלי</a><a class="btn ghost" href="{{wa}}">שאלה בוואטסאפ</a></div></section>'''

def article(a):
    depth = 1
    words = len(re.sub('<[^>]+>', ' ', a['body']).split())
    p = {'slug': 'blog/' + a['slug'], 'title': a['title'], 'desc': a['desc'], 'article': True,
         'crumbs': [('', 'דף הבית'), ('blog', 'מאמרים'), ('blog/' + a['slug'], a['h1'])], 'faq': a.get('faq'),
         'ld': [{"@context": "https://schema.org", "@type": "Article", "headline": a['h1'], "description": a['desc'], "inLanguage": "he",
                 "datePublished": a.get('date', TODAY), "dateModified": TODAY, "wordCount": words,
                 "author": {"@type": "Person", "name": "אורן כהן", "jobTitle": "מפיק ובעלים, אולפני קולות"},
                 "publisher": {"@id": DOMAIN + "/#business"}, "mainEntityOfPage": DOMAIN + '/blog/' + a['slug']}]}
    svc = next((x for x in PAGES if x['slug'] == a['service']), None)
    body = f'''<article class="wrap prose">
<nav class="crumbs" aria-label="פירורי לחם"><a href="{rel(depth, '')}">דף הבית</a> / <a href="{rel(depth, 'blog')}">מאמרים</a></nav>
<h1>{esc(a['h1'])}</h1>
<p class="meta">אורן כהן, אולפני קולות · {max(3, round(words / 200))} דקות קריאה</p>
{fill(a['body'], depth)}
{f'<aside class="note"><b>{esc(svc["h1"])}</b><p>{esc(svc["desc"])}</p><a class="btn sm" href="{rel(depth, svc["slug"])}">לפרטים ומחירים</a></aside>' if svc else ''}
</article>'''
    body += faq_html(a.get('faq'))
    others = [x for x in ARTICLES if x['slug'] != a['slug'] and x['service'] == a['service']][:2] or [x for x in ARTICLES if x['slug'] != a['slug']][:2]
    body += '<section class="wrap related"><h2>עוד מאמרים</h2><div class="cards">' + ''.join(
        f'<a class="card link" href="{rel(depth, "blog/" + o["slug"])}"><b>{esc(o["h1"])}</b><span>{esc(o["desc"])}</span></a>' for o in others) + '</div></section>'
    body += fill(CTA, depth)
    write(p['slug'] + '.html', head(p, depth) + body + foot(depth))
    return words

def blog_index():
    p = {'slug': 'blog', 'title': 'מאמרים על צליל המתנה, נתבי שיחות, ג׳ינגלים וניקוי רעשים | B-Sound',
         'desc': 'מדריכים מעשיים מהאולפן: כמה עולה צליל המתנה, איך כותבים תפריט לנתב שיחות, ג׳ינגל מושר מול הודעת המתנה, וניקוי רעשים מהקלטות.',
         'crumbs': [('', 'דף הבית'), ('blog', 'מאמרים')]}
    body = '<section class="wrap hero-s"><h1>מאמרים ומדריכים</h1><p class="lead">תשובות לשאלות שעסקים שואלים אותנו כל שבוע. בלי מילים מיותרות.</p></section><section class="wrap"><div class="cards">' + ''.join(
        f'<a class="card link" href="blog/{a["slug"]}"><small>{esc(a["tag"])}</small><b>{esc(a["h1"])}</b><span>{esc(a["desc"])}</span></a>' for a in ARTICLES) + '</div></section>'
    write('blog.html', head(p, 0) + body + fill(CTA, 0) + foot(0))

def redirect(src, dst):
    up = '../' * src.count('/')
    t = f'''<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>הועבר</title><link rel="canonical" href="{DOMAIN}/{dst}"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0; url={up}{dst}"></head><body><a href="{up}{dst}">המשך</a></body></html>'''
    write(src + '.html', t)

def main():
    if os.path.isdir(ROOT):
        for n in os.listdir(ROOT):
            if n != 'assets': shutil.rmtree(os.path.join(ROOT, n)) if os.path.isdir(os.path.join(ROOT, n)) else os.remove(os.path.join(ROOT, n))
    for p in PAGES: page(p)
    counts = {a['slug']: article(a) for a in ARTICLES}
    blog_index()
    for s, d in REDIRECTS.items(): redirect(s, d)
    urls = [''] + [p['slug'] for p in PAGES if p['slug']] + ['blog'] + ['blog/' + a['slug'] for a in ARTICLES]
    write('sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + ''.join(
        f'<url><loc>{DOMAIN}/{u}</loc><lastmod>{TODAY}</lastmod></url>\n' for u in urls) + '</urlset>\n')
    write('robots.txt', ('User-agent: *\nDisallow: /\n' if PREVIEW else 'User-agent: *\nAllow: /\n') + f'Sitemap: {DOMAIN}/sitemap.xml\n')
    write('404.html', head({'slug': '404', 'title': 'העמוד לא נמצא | B-Sound', 'desc': 'העמוד לא נמצא'}, 0) +
          '<section class="wrap hero-s"><h1>העמוד לא נמצא</h1><p class="lead">אולי הוא עבר מקום. <a href="/">לדף הבית</a></p></section>' + foot(0))
    # Cloudflare Pages: old Wix paths -> new (301)
    write('_redirects', ''.join(f'/{s} /{d} 301\n' for s, d in REDIRECTS.items()))
    # the order app lives on the domain too: /order (source: b-sound/hold.html)
    src = open(os.path.join(os.path.dirname(__file__), '..', 'b-sound', 'hold.html'), encoding='utf-8').read()
    src = src.replace('href="../bsound-site/"', 'href="./"').replace('"music/', '"https://kolotstudios.github.io/widgets/b-sound/music/')
    write('order.html', src)
    print('pages', len(PAGES), 'articles', counts)

if __name__ == '__main__':
    main()
