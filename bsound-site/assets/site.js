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

// contact form -> WhatsApp
document.querySelectorAll("[data-wa-form]").forEach(function(f){
  f.addEventListener("submit",function(e){e.preventDefault();var d=new FormData(f);
    var t="שלום, שמי "+d.get("name")+" ("+d.get("phone")+").\n"+d.get("msg");
    window.open(WA+"?text="+encodeURIComponent(t),"_blank","noopener")});
});
})();
