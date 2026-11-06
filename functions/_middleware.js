// B-Sound site (Cloudflare Pages): one address for Google - b-sound.co.il and *.pages.dev -> https://www.b-sound.co.il
export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);
  if (url.hostname === 'b-sound.co.il' || url.hostname === 'bsound-site.pages.dev') {
    url.hostname = 'www.b-sound.co.il'; url.protocol = 'https:'; url.port = '';
    return Response.redirect(url.toString(), 301);
  }
  return ctx.next();
}
