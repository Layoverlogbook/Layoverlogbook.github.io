/* Crew chat: a floating bubble that opens a chat panel, for invited crew only.
   Rooms: the Crew lounge (everyone) and one room per city (crew on the same layover).
   Messages and photos are private to crew members; access is checked by the database
   (crew_messages and the crew_chat_* functions, see backend/crew-chat.sql).
   The bubble stays hidden until the chat exists in the database.
   Ask AI: a help assistant in the same bubble (its own tab) that answers questions about the app.
   Any signed-in user can use it, crew invite or not. Answers come from the ask-ai function (backend/ask-ai.ts). */
(()=>{
"use strict";
if(typeof CLOUD_ON==="undefined"||!CLOUD_ON) return;
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ls={get:(k,d)=>{try{const v=localStorage.getItem(k);return v==null?d:JSON.parse(v)}catch(e){return d}},
  set:(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}};
const signedIn=()=>typeof DB!=="undefined"&&!!DB.cloud;

/* ---------- database calls (own wrapper, so a missing chat can be told apart) ---------- */
async function call(fn,args){
  let tok; try{ tok=await validToken(); }catch(e){ tok=null; }
  if(!tok) throw Object.assign(new Error("Sign in again to continue."),{kind:"signin"});
  let r; try{ r=await fetch(SB+"/rest/v1/rpc/"+fn,{method:"POST",headers:{apikey:SBKEY,Authorization:"Bearer "+tok,"Content-Type":"application/json"},body:JSON.stringify(args||{})}); }
  catch(e){ throw Object.assign(new Error("You're offline. Messages will load when you're back online."),{kind:"offline"}); }
  let j=null; try{ j=await r.json(); }catch(e){}
  if(r.ok) return j;
  if(r.status===404||(j&&j.code==="PGRST202")) throw Object.assign(new Error("Chat isn't set up yet."),{kind:"missing"});
  if(r.status===401) throw Object.assign(new Error("Sign in again to continue."),{kind:"signin"});
  const m=j&&j.message||"Something went wrong. Try again.";
  throw Object.assign(new Error(m),{kind:/invited crew only/i.test(m)?"notcrew":/Sign in first/i.test(m)?"signin":"error"});
}

/* ---------- rooms ---------- */
const cityRoom=()=>{ try{ const k=String(destKey()).toLowerCase().replace(/[^a-z0-9_-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,50); return k.length>=2?"city:"+k:null; }catch(e){ return null; } };
const cityName=()=>{ try{ return state.dest.name||"This city"; }catch(e){ return "This city"; } };
const rooms=()=>{ const c=cityRoom(); return c?[{id:"lounge",name:"Crew lounge"},{id:c,name:cityName()}]:[{id:"lounge",name:"Crew lounge"}]; };

/* ---------- state ---------- */
const C={open:false,room:ls.get("lay.chatRoom","lounge"),msgs:{},last:{},me:null,status:"unknown",busy:false,photo:null,photoUrl:"",timer:0,unread:0,sel:null};
const seen=ls.get("lay.chatSeen",{});
const saveSeen=()=>ls.set("lay.chatSeen",seen);

/* ---------- markup ---------- */
const wrap=document.createElement("div");
wrap.className="chat-root"; wrap.hidden=true;
wrap.innerHTML=`
<button type="button" class="chat-fab" id="chatFab" aria-label="Open crew chat" aria-expanded="false" aria-controls="chatPanel">
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5v-3.5H4A1.5 1.5 0 0 1 2.5 16V7A1.5 1.5 0 0 1 4 5.5z"/><path d="M7 10h10M7 13h6"/></svg>
  <span class="chat-badge" id="chatBadge" hidden></span>
</button>
<section class="chat-panel" id="chatPanel" role="dialog" aria-modal="false" aria-labelledby="chatTitle" hidden>
  <header class="chat-head">
    <div class="chat-title"><span class="chat-dot" aria-hidden="true"></span><div><h2 id="chatTitle">Crew chat</h2><small id="chatSub">Crew only</small></div></div>
    <button type="button" class="chat-x" id="chatClose" aria-label="Close chat">×</button>
  </header>
  <div class="chat-rooms" id="chatRooms" role="tablist" aria-label="Chat rooms"></div>
  <div class="chat-body" id="chatBody" aria-live="polite"></div>
  <div class="chat-gate" id="chatGate" hidden></div>
  <form class="chat-form" id="chatForm" hidden>
    <div class="chat-prev" id="chatPrev" hidden><img id="chatPrevImg" alt="Photo to send"><button type="button" id="chatPrevX" aria-label="Remove photo">×</button></div>
    <div class="chat-row">
      <label class="chat-pic" for="chatFile" aria-label="Add a photo"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><circle cx="9" cy="10.5" r="1.8"/><path d="M20.5 15.5l-4.5-4.5-7 7.5"/></svg></label>
      <input type="file" id="chatFile" accept="image/*" hidden>
      <textarea id="chatText" rows="1" maxlength="500" placeholder="Message the crew…" aria-label="Message"></textarea>
      <button type="submit" class="chat-send" id="chatSend" aria-label="Send"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-8-6 16-2.5-6.5z"/></svg></button>
    </div>
    <p class="chat-err" id="chatErr" role="status"></p>
  </form>
</section>`;
document.body.appendChild(wrap);

/* ---------- helpers ---------- */
const hm=t=>{ const d=new Date(t); return d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}); };
const dayOf=t=>{ const d=new Date(t), n=new Date(), y=new Date(); y.setDate(n.getDate()-1);
  return d.toDateString()===n.toDateString()?"Today":d.toDateString()===y.toDateString()?"Yesterday":d.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"}); };
const linkify=t=>esc(t).replace(/\b(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g,'<a href="$1" target="_blank" rel="noopener nofollow">$1</a>');
const avatar=n=>typeof pav==="function"?pav(n):`<span class="pav" aria-hidden="true">${esc(String(n||"?")[0].toUpperCase())}</span>`;
const photoCache=new Map();
async function loadImg(img){
  const p=img.dataset.photo; if(!p||img.dataset.done) return; img.dataset.done="1";
  try{
    let u=photoCache.get(p);
    if(!u){ const r=await sbStore("GET","authenticated/crew-photos/"+p); if(!r.ok) throw 0; u=URL.createObjectURL(await r.blob()); photoCache.set(p,u); }
    img.onload=()=>{ img.classList.add("in"); stick(); }; img.src=u;
  }catch(e){ img.closest(".chat-photo")?.classList.add("gone"); }
}
let nearBottom=true;
const stick=()=>{ const b=$("chatBody"); if(nearBottom) b.scrollTop=b.scrollHeight; };
$("chatBody").addEventListener("scroll",()=>{ const b=$("chatBody"); nearBottom=b.scrollHeight-b.scrollTop-b.clientHeight<80; },{passive:true});

/* ---------- rendering ---------- */
function renderRooms(){
  const rs=rooms(); if(C.room!==AI&&!rs.some(r=>r.id===C.room)) C.room="lounge";
  $("chatRooms").innerHTML=`<button type="button" role="tab" class="chat-ai-tab" data-room="${AI}" aria-selected="${C.room===AI}">✦ Ask AI</button>`+rs.map(r=>{ const n=unreadIn(r.id);
    return `<button type="button" role="tab" data-room="${esc(r.id)}" aria-selected="${r.id===C.room}">${esc(r.name)}${n?` <b>${n>9?"9+":n}</b>`:""}</button>`; }).join("");
  const r=rs.find(x=>x.id===C.room);
  $("chatTitle").textContent=C.room===AI?"Ask AI":"Crew chat";
  $("chatSub").textContent=C.room===AI?"Questions about the app · AI can make mistakes":r&&r.id!=="lounge"?`Crew in ${r.name} right now`:"Crew of every airline · crew only";
  $("chatText").placeholder=C.room===AI?"Ask about the app…":"Message the crew…";
  const pic=wrap.querySelector(".chat-pic"); if(pic) pic.style.display=C.room===AI?"none":"";
}
function renderMsgs(){
  const list=C.msgs[C.room]||[], body=$("chatBody");
  if(!list.length){ body.innerHTML=`<div class="chat-empty"><b>Say hi to the crew ✈️</b><span>${C.room==="lounge"?"Ask for tips, find someone on your layover, share a photo.":"Anyone else in "+esc(cityName())+"? Plan a dinner, a run or a museum."}</span></div>`; return; }
  let h="", lastDay="", lastWho="";
  list.forEach(m=>{
    const d=dayOf(m.at); if(d!==lastDay){ h+=`<div class="chat-day">${d}</div>`; lastDay=d; lastWho=""; }
    const cont=lastWho===m.name+m.mine; lastWho=m.name+m.mine;
    h+=`<div class="chat-msg${m.mine?" mine":""}${cont?" cont":""}${C.sel===m.id?" sel":""}" data-id="${m.id}">
      ${m.mine||cont?"":avatar(m.name)}
      <div class="chat-bub">${m.mine||cont?"":`<b class="chat-name">${esc(m.name)}</b>`}
        ${m.photo?`<div class="chat-photo"><img data-photo="${esc(m.photo)}" alt="Photo from ${esc(m.name)}"></div>`:""}
        ${m.body?`<p>${linkify(m.body)}</p>`:""}
        <time>${hm(m.at)}</time></div>
      ${C.sel===m.id?`<div class="chat-acts">${m.mine?`<button type="button" data-del="${m.id}">Delete</button>`:`<button type="button" data-rep="${m.id}">Report</button>`}</div>`:""}
    </div>`;
  });
  body.innerHTML=h;
  body.querySelectorAll("img[data-photo]").forEach(loadImg);
  stick();
}
function gate(html){ $("chatGate").innerHTML=html; $("chatGate").hidden=!html; $("chatForm").hidden=!!html; $("chatBody").hidden=!!html; $("chatRooms").hidden=!!html&&!signedIn(); }
function renderGate(){
  if(!signedIn()) return gate(`<div class="chat-empty"><b>Crew chat</b><span>Talk with crew of every airline, share photos and meet up on layovers. Invite only.</span><button class="btn" type="button" data-go="signin">Sign in</button></div>`);
  if(C.status==="notcrew") return gate(`<div class="chat-empty"><b>Crew only</b><span>Join with an invite code from a colleague. Then the chat opens for you. Questions about the app? Tap Ask AI above.</span><button class="btn" type="button" data-go="join">Enter invite code</button></div>`);
  if(C.status==="offline") return gate(`<div class="chat-empty"><b>You're offline</b><span>Messages load when you're back online.</span></div>`);
  if(C.status==="ok"&&!C.me) return gate(`<form class="chat-empty" id="chatNameForm"><b>Pick your crew name</b><span>Shown next to your messages. A nickname is fine.</span><input id="chatName" maxlength="20" placeholder="e.g. SkyNomad" autocomplete="off" aria-label="Crew name"><button class="btn" type="submit">Save name</button><small class="chat-err" id="chatNameErr"></small></form>`);
  gate("");
}
function render(){
  renderRooms();
  if(C.room===AI){ if(!signedIn()) return gate(`<div class="chat-empty"><b>Ask AI</b><span>Get quick answers about Layover Logbook: roster check, Pro, the crew feed, money and more. Sign in to ask.</span><button class="btn" type="button" data-go="signin">Sign in</button></div>`);
    gate(""); return renderAi(); }
  renderGate(); if(C.status==="ok"&&C.me) renderMsgs();
}

/* ---------- Ask AI ---------- */
const AI="ai", AI_LOG="lay.aiChat";
const EXAMPLES=[
  "How do I read my roster from a screenshot?",
  "How do I get an invite code for the crew feed?",
  "What's included in Pro, and how much is it?",
  "How do I see which days I'm off with crew friends?",
  "How does the fatigue check work?",
  "How do I track my allowance and spending?",
  "How do I add the app to my home screen?",
  "How do I cancel my subscription?"
];
const A={log:ls.get(AI_LOG,[]),busy:false};
const aiSave=()=>ls.set(AI_LOG,A.log.slice(-30));
const aiText=t=>linkify(t);
function renderAi(){
  const body=$("chatBody");
  const chips=`<div class="chat-ai-ex">${EXAMPLES.map(q=>`<button type="button" data-ask="${esc(q)}">${esc(q)}</button>`).join("")}</div>`;
  if(!A.log.length&&!A.busy){
    body.innerHTML=`<div class="chat-ai-hi"><span class="chat-ai-av" aria-hidden="true">✦</span><b>Hi! I'm the Layover Logbook assistant.</b><span>Ask me how anything in the app works. Try one of these:</span></div>${chips}`;
    return;
  }
  let h="";
  A.log.forEach(m=>{
    h+=m.role==="user"
      ?`<div class="chat-msg mine"><div class="chat-bub"><p>${esc(m.content)}</p></div></div>`
      :`<div class="chat-msg chat-ai"><span class="chat-ai-av" aria-hidden="true">✦</span><div class="chat-bub"><p>${aiText(m.content)}</p></div></div>`;
  });
  if(A.busy) h+=`<div class="chat-msg chat-ai"><span class="chat-ai-av" aria-hidden="true">✦</span><div class="chat-bub"><p class="chat-ai-dots" aria-label="Thinking"><i></i><i></i><i></i></p></div></div>`;
  else h+=`<div class="chat-ai-foot"><button type="button" data-ainew>New chat</button><button type="button" data-aiex>Example questions</button></div>`;
  body.innerHTML=h; stick();
}
function aiCtx(){
  const c={}; try{ c.city=state.dest&&state.dest.name; }catch(e){}
  try{ const s=window.LAYOVER_STATE&&LAYOVER_STATE(); c.home=s&&s.home&&s.home.code; }catch(e){}
  try{ c.pro=!!Plan.pro; }catch(e){}
  try{ c.tab=document.querySelector(".tabbar [aria-current='page'],.tabbar .on")?.dataset.tab; }catch(e){}
  return c;
}
async function askAi(q){
  q=String(q||"").trim().slice(0,1000); if(!q||A.busy) return;
  A.log.push({role:"user",content:q}); A.busy=true; aiSave(); nearBottom=true; renderAi(); $("chatErr").textContent="";
  let reply="";
  try{
    let tok; try{ tok=await validToken(); }catch(e){ tok=null; }
    if(!tok){ reply="Please sign in again to ask a question."; return; }
    let r; try{ r=await fetch(SB+"/functions/v1/ask-ai",{method:"POST",headers:{apikey:SBKEY,Authorization:"Bearer "+tok,"Content-Type":"application/json"},
      body:JSON.stringify({messages:A.log.slice(-12),context:aiCtx()})}); }
    catch(e){ reply="You're offline. Ask again when you have a connection."; return; }
    let j=null; try{ j=await r.json(); }catch(e){}
    if(r.ok&&j&&j.answer){ reply=j.answer; return; }
    reply=r.status===401?"Please sign in again to ask a question."
      :r.status===429?`You've asked ${j&&j.limit||30} questions today. Ask AI will be back tomorrow.`
      :r.status===404?"Ask AI isn't switched on yet. Try again later."
      :"Ask AI is taking a break right now. Please try again in a little while.";
  }finally{
    A.busy=false;
    if(reply) A.log.push({role:"assistant",content:reply});
    aiSave(); if(C.open&&C.room===AI) renderAi();
  }
}
$("chatBody").addEventListener("click",e=>{
  const ask=e.target.closest("[data-ask]"); if(ask){ e.stopImmediatePropagation(); askAi(ask.dataset.ask); return; }
  if(e.target.closest("[data-ainew]")){ e.stopImmediatePropagation(); A.log=[]; aiSave(); renderAi(); return; }
  if(e.target.closest("[data-aiex]")){ e.stopImmediatePropagation(); const b=$("chatBody"); b.insertAdjacentHTML("beforeend",`<div class="chat-ai-ex">${EXAMPLES.map(q=>`<button type="button" data-ask="${esc(q)}">${esc(q)}</button>`).join("")}</div>`); b.querySelector("[data-aiex]")?.remove(); nearBottom=true; stick(); return; }
  if(C.room===AI) e.stopImmediatePropagation();   /* no delete/report on AI bubbles */
});
document.head.insertAdjacentHTML("beforeend",`<style>
.chat-rooms .chat-ai-tab{background:linear-gradient(150deg,#2A1E52,#B0136E);color:#fff;border-color:transparent}
.chat-rooms .chat-ai-tab[aria-selected="true"]{background:linear-gradient(150deg,#B0136E,#F0B429);color:#fff;border-color:transparent}
.chat-ai-av{width:28px;height:28px;flex:none;border-radius:50%;display:grid;place-items:center;font-size:.85rem;color:#fff;background:linear-gradient(150deg,#2A1E52,#B0136E)}
.chat-ai-hi{display:grid;justify-items:center;gap:6px;text-align:center;padding:14px 10px 6px;color:var(--muted)}
.chat-ai-hi .chat-ai-av{width:44px;height:44px;font-size:1.2rem}
.chat-ai-hi b{color:var(--ink);font-family:var(--display);font-size:1.25rem;font-weight:800}
.chat-ai-ex{display:flex;flex-direction:column;gap:6px;padding:6px 0 4px}
.chat-ai-ex button,.chat-ai-foot button{text-align:left;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:14px;padding:9px 12px;font:inherit;font-size:.875rem;line-height:1.3;cursor:pointer}
.chat-ai-ex button:active,.chat-ai-foot button:active{background:var(--sub)}
.chat-ai-foot{display:flex;gap:6px;justify-content:center;padding:8px 0 2px}
.chat-ai-foot button{border-radius:999px;padding:6px 12px;font-size:.75rem;font-weight:700;color:var(--muted)}
.chat-ai-dots{display:flex;gap:4px;padding:6px 2px}
.chat-ai-dots i{width:7px;height:7px;border-radius:50%;background:var(--muted);opacity:.4}
@media (prefers-reduced-motion:no-preference){.chat-ai-dots i{animation:aidot 1s infinite}.chat-ai-dots i:nth-child(2){animation-delay:.15s}.chat-ai-dots i:nth-child(3){animation-delay:.3s}}
@keyframes aidot{50%{opacity:1;transform:translateY(-2px)}}
</style>`);

/* ---------- unread ---------- */
const unreadIn=r=>(C.msgs[r]||[]).filter(m=>!m.mine&&m.id>(seen[r]||0)).length;
function markSeen(){ const l=C.msgs[C.room]; if(l&&l.length){ seen[C.room]=Math.max(seen[C.room]||0,l[l.length-1].id); saveSeen(); } badge(); }
function badge(){
  const n=rooms().reduce((s,r)=>s+unreadIn(r.id),0); C.unread=n;
  const b=$("chatBadge"); b.hidden=!n; b.textContent=n>9?"9+":String(n);
  $("chatFab").setAttribute("aria-label",n?`Open crew chat, ${n} new`:"Open crew chat");
}

/* ---------- loading ---------- */
async function load(room,full){
  const after=full||!C.last[room]?null:C.last[room];
  const d=await call("crew_chat_list",{p_room:room,p_after:after});
  C.me=d&&d.me||null;
  const got=(d&&d.messages)||[];
  const list=full||!C.msgs[room]?[]:C.msgs[room];
  got.forEach(m=>{ if(!list.some(x=>x.id===m.id)) list.push(m); });
  list.sort((a,b)=>a.id-b.id);
  C.msgs[room]=list.slice(-200);
  if(list.length) C.last[room]=list[list.length-1].id;
  if(seen[room]==null&&list.length){ seen[room]=list[list.length-1].id; saveSeen(); }   /* first visit: old messages aren't "new" */
  return got.length;
}
async function poll(){
  clearTimeout(C.timer);
  if(!signedIn()){
    /* signed out: show the bubble only once the chat exists (a missing function answers 404) */
    if(C.status!=="signedout"){ try{ const r=await fetch(SB+"/rest/v1/rpc/crew_chat_list",{method:"POST",headers:{apikey:SBKEY,Authorization:"Bearer "+SBKEY,"Content-Type":"application/json"},body:'{"p_room":"lounge"}'});
      if(r.status===404){ C.status="missing"; show(false); C.timer=setTimeout(poll,5*60e3); return; } }catch(e){} }
    C.status="signedout"; show(true); if(C.open) render(); C.timer=setTimeout(poll,8000); return; }
  try{
    const rs=C.open&&C.room!==AI?[C.room]:rooms().map(r=>r.id);
    let changed=0; for(const r of rs) changed+=await load(r,!C.msgs[r]);
    const was=C.status; C.status="ok"; show(true);
    if(C.open&&C.room!==AI){ if(changed||was!=="ok") render(); markSeen(); } else { if(!C.open||!A.busy) renderRooms(); badge(); }
  }catch(e){
    if(e.kind==="missing"){ C.status="missing"; show(false); C.timer=setTimeout(poll,5*60e3); return; }
    C.status=e.kind==="notcrew"?"notcrew":e.kind==="offline"?"offline":e.kind==="signin"?"signedout":C.status;
    show(true); if(C.open&&C.room!==AI) render();
  }
  C.timer=setTimeout(poll,C.open&&C.room!==AI&&!document.hidden?4000:document.hidden?120e3:45e3);
}
function show(on){ wrap.hidden=!on; }

/* ---------- open / close ---------- */
function openChat(){
  C.open=true; $("chatPanel").hidden=false; $("chatFab").setAttribute("aria-expanded","true"); wrap.classList.add("open");
  nearBottom=true; render(); markSeen(); poll();
  setTimeout(()=>{ if(!$("chatForm").hidden&&matchMedia("(pointer:fine)").matches) $("chatText").focus(); },150);
}
function closeChat(){ C.open=false; C.sel=null; $("chatPanel").hidden=true; $("chatFab").setAttribute("aria-expanded","false"); wrap.classList.remove("open"); poll(); }
$("chatFab").addEventListener("click",()=>C.open?closeChat():openChat());
$("chatClose").addEventListener("click",closeChat);
document.addEventListener("keydown",e=>{ if(e.key==="Escape"&&C.open) closeChat(); });
window.LayoverChat={open:openChat,close:closeChat};

$("chatRooms").addEventListener("click",async e=>{
  const b=e.target.closest("[data-room]"); if(!b||b.dataset.room===C.room) return;
  C.room=b.dataset.room; ls.set("lay.chatRoom",C.room); C.sel=null; nearBottom=true; render();
  if(C.room===AI) return;
  try{ await load(C.room,!C.msgs[C.room]); render(); markSeen(); }catch(err){}
});
$("chatGate").addEventListener("click",e=>{
  const g=e.target.closest("[data-go]"); if(!g) return;
  if(g.dataset.go==="signin"&&typeof openAccountScreen==="function"){ closeChat(); openAccountScreen("signin"); }
  if(g.dataset.go==="join"&&typeof showTab==="function"){ closeChat(); showTab("crew"); }
});
$("chatGate").addEventListener("submit",async e=>{
  if(e.target.id!=="chatNameForm") return; e.preventDefault();
  const nm=$("chatName").value.trim();
  try{ C.me=await rpc("crew_set_name",{p_name:nm}); if(typeof Crew!=="undefined") Crew.me=C.me; render(); }
  catch(err){ $("chatNameErr").textContent=err.message; }
});

/* bubble tap: show delete / report */
$("chatBody").addEventListener("click",async e=>{
  const del=e.target.closest("[data-del]"), rep=e.target.closest("[data-rep]");
  if(del){ const id=+del.dataset.del;
    if(!del.classList.contains("armed")){ del.classList.add("armed"); del.textContent="Delete for everyone?"; return; }
    try{ const ph=await call("crew_chat_delete",{p_id:id}); if(ph) sbStore("DELETE","crew-photos/"+ph).catch(()=>{});
      C.msgs[C.room]=(C.msgs[C.room]||[]).filter(m=>m.id!==id); C.sel=null; renderMsgs(); }catch(err){ toast(err.message); }
    return; }
  if(rep){ const id=+rep.dataset.rep;
    try{ await call("crew_chat_report",{p_id:id}); C.sel=null; renderMsgs(); toast("Thanks. Messages reported by 3 crew are hidden."); }catch(err){ toast(err.message); }
    return; }
  if(e.target.closest("a")) return;
  const m=e.target.closest(".chat-msg"); if(!m) return;
  const id=+m.dataset.id; C.sel=C.sel===id?null:id; const keep=$("chatBody").scrollTop; renderMsgs(); $("chatBody").scrollTop=keep;
});

/* ---------- composer ---------- */
const ta=$("chatText");
const grow=()=>{ ta.style.height="auto"; ta.style.height=Math.min(ta.scrollHeight,110)+"px"; };
ta.addEventListener("input",()=>{ grow(); $("chatErr").textContent=""; });
ta.addEventListener("keydown",e=>{ if(e.key==="Enter"&&!e.shiftKey&&matchMedia("(pointer:fine)").matches){ e.preventDefault(); $("chatForm").requestSubmit(); } });
function clearPhoto(){ if(C.photoUrl) URL.revokeObjectURL(C.photoUrl); C.photo=null; C.photoUrl=""; $("chatPrev").hidden=true; $("chatFile").value=""; }
$("chatFile").addEventListener("change",async e=>{
  const f=e.target.files&&e.target.files[0]; if(!f) return;
  try{ const b=await shrinkPhoto(f); clearPhoto(); C.photo=b; C.photoUrl=URL.createObjectURL(b); $("chatPrevImg").src=C.photoUrl; $("chatPrev").hidden=false; }
  catch(err){ $("chatErr").textContent=err.message||"Couldn't use that photo."; }
});
$("chatPrevX").addEventListener("click",clearPhoto);
$("chatForm").addEventListener("submit",async e=>{
  e.preventDefault(); if(C.busy) return;
  const t=ta.value.trim();
  if(C.room===AI){ if(t){ ta.value=""; grow(); askAi(t); } return; }
  if(!t&&!C.photo) return;
  if((t.match(/(https?:\/\/|www\.)/gi)||[]).length>1){ $("chatErr").textContent="Messages can contain at most one link."; return; }
  C.busy=true; $("chatSend").disabled=true; $("chatErr").textContent="";
  let path=null;
  try{
    if(C.photo){
      path=DB.cloud.uid+"/"+crypto.randomUUID()+".jpg";
      const r=await sbStore("POST","crew-photos/"+path,{headers:{"Content-Type":"image/jpeg"},body:C.photo});
      if(!r.ok) throw new Error("The photo didn't upload. Check your connection and try again.");
      photoCache.set(path,C.photoUrl); C.photoUrl="";
    }
    const m=await call("crew_chat_send",{p_room:C.room,p_body:t,p_photo:path});
    path=null; ta.value=""; grow(); clearPhoto();
    const l=C.msgs[C.room]=C.msgs[C.room]||[]; if(!l.some(x=>x.id===m.id)) l.push(m);
    C.last[C.room]=Math.max(C.last[C.room]||0,m.id); nearBottom=true; renderMsgs(); markSeen();
  }catch(err){
    $("chatErr").textContent=err.message;
    if(path) sbStore("DELETE","crew-photos/"+path).catch(()=>{});
  }finally{ C.busy=false; $("chatSend").disabled=false; }
});

/* keep the panel above the phone keyboard */
if(window.visualViewport){
  const fit=()=>{ const vv=visualViewport, gap=Math.max(0,innerHeight-vv.height-vv.offsetTop); wrap.style.setProperty("--kb",gap+"px"); };
  visualViewport.addEventListener("resize",fit); visualViewport.addEventListener("scroll",fit);
}
document.addEventListener("visibilitychange",()=>{ if(!document.hidden) poll(); });
/* the destination changed: the city room changes with it */
let lastCity=cityRoom();
setInterval(()=>{ const c=cityRoom(); if(c!==lastCity){ lastCity=c; if(C.room!=="lounge") C.room="lounge"; renderRooms(); } },3000);

/* start once the app (and any sign-in) is on screen */
const start=setInterval(()=>{ const l=$("login"); if(l&&!l.hidden) return; clearInterval(start); poll(); },700);
})();
