# איך הווידג'ט מוטמע באתר (זמנית, דרך ה-Worker `kolot-seo`)

אין לי גישה לממשק הניהול של EXITE (צריך סיסמה), לכן הווידג'ט הוטמע דרך ה-Worker `kolot-seo` שכבר יושב מול www.kolot-studios.com:
- הוא מוחק מה-`<head>` כל סקריפט inline שמכיל `chatbase` (הקוד של Chatbase עדיין שמור בהגדרות EXITE).
- הוא מוסיף בסוף ה-`<body>` את הסקריפט של הצ'אט החדש.

נפרס ב-14.11.2026. הגרסה הקודמת של `kolot-seo` שמורה ב-KV `kolot-site-chat` במפתח `backup:kolot-seo:2026-11-14`, וגם ב-Deployments של ה-Worker ב-Cloudflare (Rollback).

**חשוב:** אם פורסים מחדש את `kolot-seo` מהמקור שבמחשב, צריך להוסיף את שני הדברים האלה למקור, אחרת הצ'אט ייעלם:

```js
const KOLOT_CHAT='<script src="https://kolot-site-chat.kolot-studios.workers.dev/widget.js" async></script>';
function KCB(){let b="";return{element(){b=""},text(t){b+=t.text;if(t.lastInTextNode){t.replace(/chatbase/i.test(b)?"":b,{html:!0});b=""}else t.remove()}}}
// ...ובשרשרת של HTMLRewriter:
new HTMLRewriter()
  .on("head script:not([src])", KCB())
  .on("body", { element(i) { i.append(KOLOT_CHAT, { html: true }) } })
  // ...שאר ה-handlers הקיימים
```

## הפתרון הקבוע (כשנכנסים ל-EXITE)
1. בהגדרות האתר ב-EXITE (קוד ב-head) למחוק את הסקריפט של Chatbase ולשים במקומו:
   `<script src="https://kolot-site-chat.kolot-studios.workers.dev/widget.js" async></script>`
2. במובייל להחליף ב-CSS את `#chatbase-bubble-button{bottom:82px!important}`: הווידג'ט החדש כבר מסתדר מעל סרגל הכפתורים התחתון לבד.
3. להסיר את שני ה-handlers מ-`kolot-seo`.
