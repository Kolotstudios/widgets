(function(){
"use strict";
var API="https://kolot-recorder.kolot-studios.workers.dev";
var MUSIC="https://kolotstudios.github.io/widgets/b-sound/music/";
var WA="https://wa.me/972555170280";

// mobile menu
var mb=document.querySelector(".menu-btn"),nav=document.getElementById("nav");
if(mb&&nav) mb.addEventListener("click",function(){var o=nav.classList.toggle("open");mb.setAttribute("aria-expanded",o?"true":"false")});

// one player for everything: click again = stop
var audio=new Audio(),cur=null,urls={};
function reset(){if(cur){cur.classList.remove("on");var pi=cur.querySelector(".pi");if(pi) pi.textContent="▶";cur.setAttribute("aria-pressed","false")}cur=null}
function stop(){audio.pause();reset()}
audio.addEventListener("ended",stop);
function play(btn,src){
  if(cur===btn){stop();return}
  stop();cur=btn;btn.classList.add("on");btn.setAttribute("aria-pressed","true");
  var pi=btn.querySelector(".pi");
  Promise.resolve(src).then(function(u){if(cur!==btn) return;audio.src=u;audio.currentTime=0;return audio.play()}).then(function(){if(cur===btn&&pi) pi.textContent="■"})
  .catch(function(){if(cur===btn){reset();if(pi){pi.textContent="!";setTimeout(function(){pi.textContent="▶"},1500)}}});
  if(pi) pi.innerHTML='<span class="spin"></span>';
}
function voiceUrl(v){
  if(urls[v]) return urls[v];
  urls[v]=fetch(API,{method:"POST",headers:{"Content-Type":"text/plain"},body:JSON.stringify({action:"bs_voice_sample",voice:v})})
    .then(function(r){return r.json()}).then(function(j){if(!j.ok) throw new Error(j.error);var b=atob(j.mp3),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++) u[i]=b.charCodeAt(i);return URL.createObjectURL(new Blob([u],{type:"audio/mpeg"}))})
    .catch(function(e){delete urls[v];throw e});
  return urls[v];
}
document.querySelectorAll("[data-voices]").forEach(function(box){
  var warmed=false;
  function warm(){if(warmed) return;warmed=true;box.querySelectorAll("[data-v]").forEach(function(b,i){setTimeout(function(){voiceUrl(b.dataset.v).catch(function(){})},i*150)})}
  if("IntersectionObserver" in window){var io=new IntersectionObserver(function(es){if(es[0].isIntersecting){warm();io.disconnect()}},{rootMargin:"300px"});io.observe(box)}
  box.addEventListener("click",function(e){var b=e.target.closest("[data-v]");if(b) play(b,voiceUrl(b.dataset.v))});
});

// music library
document.querySelectorAll("[data-music]").forEach(function(box){
  fetch(MUSIC+"library.json").then(function(r){return r.json()}).then(function(L){
    var cat=L.categories[0].id;
    function draw(){
      box.innerHTML='<div class="chips" role="tablist" aria-label="סגנון מוזיקה">'+L.categories.map(function(c){return '<button type="button" role="tab" class="chip'+(c.id===cat?" on":"")+'" aria-selected="'+(c.id===cat)+'" data-c="'+c.id+'">'+c.name+'</button>'}).join("")+'</div>'+
        '<div class="mlist">'+L.tracks.filter(function(t){return t.cat===cat}).map(function(t){return '<button type="button" class="vbtn" data-t="'+t.id+'" aria-pressed="false"><span class="pi">▶</span><b>'+t.name+'</b></button>'}).join("")+'</div>';
    }
    draw();
    box.addEventListener("click",function(e){
      var c=e.target.closest("[data-c]"),t=e.target.closest("[data-t]");
      if(c){stop();cat=c.dataset.c;draw();return}
      if(t) play(t,MUSIC+t.dataset.t+".mp3");
    });
  }).catch(function(){box.innerHTML=""});
});

// sample players (jingle examples): <div data-audio><button data-src>
document.querySelectorAll("[data-audio]").forEach(function(box){
  box.addEventListener("click",function(e){var b=e.target.closest("[data-src]");if(b) play(b,b.dataset.src)});
});

// contact form -> WhatsApp
document.querySelectorAll("[data-wa-form]").forEach(function(f){
  f.addEventListener("submit",function(e){e.preventDefault();var d=new FormData(f);
    var t="שלום, שמי "+d.get("name")+" ("+d.get("phone")+").\n"+d.get("msg");
    window.open(WA+"?text="+encodeURIComponent(t),"_blank","noopener")});
});
})();
(function(){
"use strict";
var reduce=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
// reveal on scroll
var els=document.querySelectorAll(".rv");
if(!("IntersectionObserver" in window)||reduce){els.forEach(function(e){e.classList.add("in")})}
else{var io=new IntersectionObserver(function(es){es.forEach(function(x){if(x.isIntersecting){x.target.classList.add("in");io.unobserve(x.target)}})},{rootMargin:"0px 0px -8% 0px"});els.forEach(function(e){io.observe(e)})}
// light + slight 3D tilt that follows the mouse on cards
if(!reduce&&window.matchMedia("(hover:hover)").matches){
  document.querySelectorAll(".card").forEach(function(c){
    c.addEventListener("mousemove",function(e){var r=c.getBoundingClientRect(),x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;
      c.style.setProperty("--mx",x*100+"%");c.style.setProperty("--my",y*100+"%");
      c.style.transform="perspective(900px) rotateX("+((.5-y)*5).toFixed(2)+"deg) rotateY("+((x-.5)*6).toFixed(2)+"deg) translateY(-3px)"});
    c.addEventListener("mouseleave",function(){c.style.transform=""});
  });
  var ph=document.querySelector(".phone"),hv=document.querySelector(".hero-vis");
  if(ph&&hv) hv.addEventListener("mousemove",function(e){var r=hv.getBoundingClientRect(),x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;ph.style.animation="none";ph.style.transform="rotateY("+(-20+x*16)+"deg) rotateX("+(8-y*12)+"deg)"});
  if(ph&&hv) hv.addEventListener("mouseleave",function(){ph.style.transform="";ph.style.animation=""});
}
// the phone shows the business name as it is typed
var bizIn=document.querySelector("[data-start] input[name=biz]");
if(bizIn) bizIn.addEventListener("input",function(){var v=bizIn.value.trim()||"העסק שלכם";document.querySelectorAll("[data-phone-name],[data-phone-name2]").forEach(function(n){n.textContent=v})});
// call timer on the phone
var tm=document.querySelector(".ph-time");if(tm&&!reduce){var s=12;setInterval(function(){s++;tm.textContent=("0"+Math.floor(s/60)).slice(-2)+":"+("0"+s%60).slice(-2)},1000)}
// sticky CTA on mobile after the hero
var sc=document.querySelector(".sticky-cta");
if(sc){var hero=document.querySelector(".hero,.hero-s"),onS=function(){var h=hero?hero.getBoundingClientRect().bottom:300;var on=h<0&&(window.innerHeight+window.scrollY)<document.body.scrollHeight-80;sc.classList.toggle("show",on);var wa=document.querySelector(".wa-float");if(wa) wa.classList.toggle("show",h<0)};window.addEventListener("scroll",onS,{passive:true});onS()}
// don't send an empty site field
document.querySelectorAll("[data-start]").forEach(function(f){f.addEventListener("submit",function(){var s=f.querySelector("[name=site]");if(s&&!s.value.trim()) s.disabled=true})});
})();
