# צ׳אט האתר של אולפני קולות (kolot-site-chat)

מחליף את Chatbase באתר kolot-studios.com. עונה מתוך מאגר הסוכן של קאלה (מסמכים 01–07) ומכוון את הגולש להמשיך בוואטסאפ של העסק (972555170280 – הסוכן של קאלה).

- `worker.js` – השרת (Cloudflare Worker `kolot-site-chat`). Bindings: `KB` (KV `kolot-site-chat`), `AI` (Workers AI). סוד: `ADMIN_KEY`.
- `channel.js` – הנחיות הערוץ לאתר (גוברות על המאגר) ומספר הוואטסאפ. כאן משנים את הכיוון לוואטסאפ.
- `widget.js` – הווידג'ט (אייקון בלבד, בלי בועות שנפתחות לבד, RTL, מסך מלא בנייד). מוגש מהשרת ב־`/widget.js`.
- `build.mjs` – `node site-chat/build.mjs` יוצר `dist/worker.js` אחד להעלאה.

באתר (EXITE, קוד ב־head במקום הסקריפט של Chatbase):
```html
<script src="https://kolot-site-chat.kolot-studios.workers.dev/widget.js" async></script>
```

## עדכון המאגר
המאגר שמור ב־KV (מפתח `kb`) ולא בקוד. עדכון: `POST /admin/kb` עם הכותרת `x-admin-key` וגוף `{"docs":[{"title":"01_...","text":"..."}]}`. מסמך שמתחיל ב־`00_` מתעלמים ממנו (הנחיות הערוץ ב־`channel.js`).
כל שינוי מחיר או מוצר בקאלה צריך להגיע גם לכאן.

## מעקב
- `GET /admin/logs?n=30` (עם המפתח) – השיחות האחרונות (נשמרות 30 יום).
- אירועים לאנליטיקס: `chat_open`, `chat_first_message`, `chat_whatsapp_click` (gtag/dataLayer), ו־`Contact` בפיקסל של מטא בלחיצה על וואטסאפ.

## מודל ועלות
Workers AI: ברירת מחדל `@cf/google/gemma-4-26b-a4b-it` (בלי מצב חשיבה, 2–6 שניות, כ־340 neurons לתשובה עם המאגר המלא), גיבוי `gpt-oss-120b`. משנים עם המשתנה `MODEL` או `MODELS`.
בתוכנית החינמית של Workers יש 10,000 neurons ביום – בערך 29 תשובות ביום. מעבר לזה צריך Workers Paid (5$ לחודש + כ־0.004$ לתשובה). אם נגמרים – הווידג'ט מציג הודעה וכפתור וואטסאפ, כך שאף פנייה לא הולכת לאיבוד.
