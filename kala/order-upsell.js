/* Kolot – "משלים את האירוע": 2–3 complementary products under the cart on the Kala order form (page order-form, 75774).
   Loaded by the Kala widget "partial / order_upsell":  <script src="https://kolotstudios.github.io/widgets/kala/order-upsell.js" defer></script>
   Also on the cart page (shopping-cart, 75773). To turn it off, remove {{{widget.partial.order_upsell}}} from those page bodies in Kala. */
(function(){
var CSS="#kolot-upsell{margin:14px 0 6px}\n#kolot-upsell .ku-h{font-weight:700;font-size:16px;margin:0 0 8px}\n#kolot-upsell .ku-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}\n#kolot-upsell .ku-card{border:1px solid #e3dcea;border-radius:12px;padding:10px;display:grid;gap:6px;background:#fff;text-align:center}\n#kolot-upsell .ku-img{height:90px;border-radius:8px;background:#f2edf7 center/cover no-repeat}\n#kolot-upsell .ku-t{font-weight:600;font-size:14px;line-height:1.3}\n#kolot-upsell .ku-n{font-size:12px;color:#6f6479;line-height:1.35}\n#kolot-upsell .ku-p{font-weight:700}\n#kolot-upsell .ku-b{cursor:pointer}";
(function(){
  // product page ids on the Kala purchase page
  var SONG=[75801,76215,76247,76248,76249,76210], CLIP=[75803,76144,76236,75808,75807], TAKE=[76164],
      PRES=[75831,76038,75832], BLESS=[75898,75816,75899,76250,75985,76252,76253,76254,76255,76256,76257,76258],
      LYR=75982, UPG=76259;
  // products that are not on the purchase page: shown from here (keep the price in sync with Kala)
  var EXTRA={76259:{title:"שדרוג שיר לטייקליפ",price:"810",slug:"שדרוג-שיר-לטייקליפ"}};
  // what to offer for each kind of product already in the cart, in order of preference
  var RULES=[[SONG,[LYR,UPG,75898]],[[UPG],[LYR,75831,75899]],[CLIP,[75831,75899]],[TAKE,[LYR,75831,75899]],[PRES,[76215,75898]],[BLESS,[75831,76215]],[[LYR],[76215,76164]]];
  var NOTES={75982:"שיר אישי על מנגינה מוכרת, עם גייד מוקלט",76164:"קליפ בטייק אחד, מהיר ומשתלם",76259:"השיר שלכם הופך לקליפ בטייק אחד, עם תמונות",75898:"ברכות מרגשות באולפן, עד 5 מברכים",
    75899:"ברכות ודרשה באולפן, במחיר חבילה",75831:"מצגת מרגשת לאירוע, עד 50 תמונות",76215:"הקלטת שיר מקצועית במחיר בוקר"};
  // order form (cart summary) or the cart page (/shopping-cart, editable cart)
  var cart=document.querySelector("#widget-shopping_cart-shopping_cart")||document.querySelector("#widget-shopping_cart-cart_edit");
  if(!cart||document.getElementById("kolot-upsell")) return;
  var st=document.createElement("style");st.textContent=CSS;document.head.appendChild(st);
  var box=document.createElement("div");box.id="kolot-upsell";cart.parentNode.insertBefore(box,cart.nextSibling);
  var inCartTitles=[].map.call(cart.querySelectorAll(".cart-prod-title"),function(e){return e.textContent.trim()});
  var inCartIds=[].map.call(cart.querySelectorAll("[data-page_id]"),function(e){return +e.getAttribute("data-page_id")});
  if(!inCartTitles.length&&!inCartIds.length) return;
  fetch("/"+encodeURIComponent("רכישה"),{credentials:"same-origin"}).then(function(r){return r.text()}).then(function(html){
    var doc=new DOMParser().parseFromString(html,"text/html"),P={},byTitle={};
    [].forEach.call(doc.querySelectorAll(".widget-item"),function(it){
      var a=it.querySelector("a.add-to-cart"),t=it.querySelector(".item-title");if(!a||!t) return;
      var id=+a.getAttribute("data-page_id"),img=it.querySelector(".bg-img");
      P[id]={id:id,title:t.textContent.trim(),price:a.getAttribute("data-price"),img:img?img.style.backgroundImage:""};
      byTitle[P[id].title]=id;
    });
    Object.keys(EXTRA).forEach(function(id){if(!byTitle[EXTRA[id].title]) byTitle[EXTRA[id].title]=+id});
    var have=inCartIds.concat(inCartTitles.map(function(t){return byTitle[t]})).filter(function(x,i,a){return x&&a.indexOf(x)===i});
    var has=function(list){return have.some(function(id){return list.indexOf(id)>=0})};
    var out=[];
    have.forEach(function(id){RULES.forEach(function(r){if(r[0].indexOf(id)>=0) r[1].forEach(function(s){if(out.indexOf(s)<0) out.push(s)})})});
    out=out.filter(function(s){
      if(have.indexOf(s)>=0) return false;
      if(has(BLESS)&&BLESS.indexOf(s)>=0) return false;   // already recording a blessing or a drasha
      if(has(CLIP)&&s===LYR) return false;                 // every clip except the take-clip includes lyrics and a guide
      if(s===UPG&&(!has(SONG)||has(CLIP)||has(TAKE))) return false; // the upgrade only makes sense on top of a song
      return !!(P[s]||EXTRA[s]);
    }).slice(0,3);
    if(!out.length) return;
    // fill in products that are not on the purchase page (image from their own page)
    return Promise.all(out.filter(function(id){return !P[id]}).map(function(id){
      var x=EXTRA[id];P[id]={id:id,title:x.title,price:x.price,img:""};
      return fetch("/"+encodeURIComponent(x.slug),{credentials:"same-origin"}).then(function(r){return r.text()}).then(function(h){
        var m=h.match(/property="og:image"\s+content="([^"]+)"/)||h.match(/content="([^"]+)"\s+property="og:image"/);
        if(m) P[id].img="url("+m[1]+")";
      }).catch(function(){});
    })).then(function(){render(out,P)});
  }).catch(function(){});
  function render(out,P){
    var h='<p class="ku-h">משלים את האירוע</p><div class="ku-row">';
    out.forEach(function(id){var p=P[id];
      h+='<div class="ku-card">'+(p.img?'<div class="ku-img" style="background-image:'+p.img.replace(/"/g,"'")+'"></div>':'')+
        '<div class="ku-t"></div>'+(NOTES[id]?'<div class="ku-n">'+NOTES[id]+'</div>':'')+
        '<div class="ku-p">₪'+p.price+'</div><a class="add-to-cart ku-b btn btn-primary btn-sm" data-page_id="'+id+'" data-price="'+p.price+'" data-reload_page="1"><i class="fa fa-plus"></i> הוספה להזמנה</a></div>';
    });
    box.innerHTML=h+'</div>';
    [].forEach.call(box.querySelectorAll(".ku-t"),function(el,i){el.textContent=P[out[i]].title});
  }
})();
})();
