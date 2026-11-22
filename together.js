/* Off together: crew share their rosters as day statuses and the app finds the days they are all free.
   Only day statuses travel (off, part day, duty, away, standby, leave), never flights, routes or times.
   Everything is kept on this device; a share is a link or a code sent through any chat app. */
(()=>{
"use strict";
const el=id=>document.getElementById(id);
if(!el("tgPanel")) return;
const ls={get:(k,d)=>{try{const v=localStorage.getItem(k);return v==null?d:JSON.parse(v)}catch(e){return d}},
  set:(k,v)=>{try{v==null?localStorage.removeItem(k):localStorage.setItem(k,JSON.stringify(v))}catch(e){}}};
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const locked=()=>document.body.classList.contains("locked");
const goPro=()=>{ if(typeof openPro==="function") openPro(); };
const say=t=>{ if(typeof toast==="function") toast(t); };

/* ---------- day codes ---------- */
const CODES={O:{l:"Off",s:"OFF"},L:{l:"Leave",s:"LEAVE"},P:{l:"Part day",s:"PART"},S:{l:"Standby",s:"SBY"},D:{l:"Duty",s:"DUTY"},A:{l:"Away",s:"AWAY"}};
const RANK={O:0,L:1,P:2,S:3,A:4,D:5};
const FREE=c=>c==="O"||c==="L";
const OK=c=>FREE(c)||c==="P";
const COLORS=["#2E7DD7","#13A36B","#E0662B","#8A4FD8","#C98A00","#0FA3B1"];
const MAXDAYS=150;

/* ---------- dates (plain calendar days, no time zone) ---------- */
const kOf=d=>d.toISOString().slice(0,10);
const dOf=k=>new Date(k+"T00:00:00Z");
const addD=(k,n)=>kOf(new Date(+dOf(k)+n*864e5));
const diffD=(a,b)=>Math.round((+dOf(b)-+dOf(a))/864e5);
const todayK=()=>{const n=new Date();return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`};
const fmt=(k,o)=>dOf(k).toLocaleDateString("en-GB",Object.assign({weekday:"short",day:"numeric",month:"short",timeZone:"UTC"},o||{}));

/* ---------- state ---------- */
let me=ls.get("lay.tgMe",{name:"",manual:{}}); me.manual=me.manual||{};
let buddies=ls.get("lay.tgBuddies",[]);
let pick=ls.get("lay.tgPick",null);           /* ids of friends to match against; null = everyone */
let brush="O", month=todayK().slice(0,7), painting=false, pending=null;
const save=()=>{ ls.set("lay.tgMe",me); ls.set("lay.tgBuddies",buddies); ls.set("lay.tgPick",pick); };

/* ---------- my days from Roster check ---------- */
function rosterDays(){
  const roster=ls.get("lay.roster",[]); if(!Array.isArray(roster)||!roster.length) return {};
  const RC=window.RosterEngine, rid=ls.get("lay.rcRule","qatar"), cu=(ls.get("lay.rcCustom",{})||{})[rid]||{};
  const off=cu.homeOffset??(RC&&RC.RULESETS[rid]?RC.RULESETS[rid].homeOffset:0);
  const loc=t=>new Date(t+off*36e5), key=t=>kOf(loc(t)), hr=t=>{const d=loc(t);return d.getUTCHours()+d.getUTCMinutes()/60};
  const out={}, put=(k,c)=>{ if(out[k]==null||RANK[c]>RANK[out[k]]) out[k]=c; };
  const ds=roster.map(d=>({...d,r:+new Date(d.reportUtc),e:+new Date(d.releaseUtc)})).filter(d=>d.r&&d.e).sort((a,b)=>a.r-b.r);
  if(!ds.length) return {};
  ds.forEach((d,i)=>{
    const kr=key(d.r), ke=key(Math.max(d.r,d.e-1));
    const span=c=>{ for(let k=kr;k<=ke;k=addD(k,1)) put(k,c); };
    if(d.kind==="OFF") return span("O");
    if(d.kind==="LEAVE") return span("L");
    const c=d.kind&&d.kind.startsWith("SBY")?"S":"D", home=d.kind!=="FLY"||d.endsAtHomeBase!==false;
    if(kr===ke&&home&&c==="D"&&(hr(d.e)<=16||hr(d.r)>=17)) put(kr,"P"); else span(c);
    if(d.kind==="FLY"&&d.endsAtHomeBase===false){
      const nx=ds[i+1]; if(nx){ for(let k=addD(ke,1);k<key(nx.r);k=addD(k,1)) put(k,"A"); }
    }
  });
  /* rosters come by the month: days with nothing on them are days off */
  const ks=Object.keys(out).sort(), first=ks[0].slice(0,7)+"-01";
  const lm=dOf(ks[ks.length-1].slice(0,7)+"-01"); lm.setUTCMonth(lm.getUTCMonth()+1);
  const last=addD(kOf(lm),-1);
  for(let k=first;k<=last;k=addD(k,1)) if(out[k]==null) out[k]="O";
  return out;
}
function myDays(){ return Object.assign(rosterDays(),me.manual||{}); }

/* ---------- share codes ---------- */
const b64e=s=>btoa(unescape(encodeURIComponent(s))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const b64d=s=>decodeURIComponent(escape(atob(s.replace(/-/g,"+").replace(/_/g,"/"))));
function encode(){
  const days=myDays(), t=todayK(), ks=Object.keys(days).filter(k=>k>=addD(t,-3)).sort();
  if(!ks.length) return null;
  const s=ks[0], n=Math.min(MAXDAYS,diffD(s,ks[ks.length-1])+1);
  let d=""; for(let i=0;i<n;i++) d+=days[addD(s,i)]||"-";
  d=d.replace(/-+$/,"");
  return b64e(JSON.stringify({v:1,n:(me.name||"Crew").slice(0,24),s,d,u:t}));
}
function decode(text){
  if(!text) return null;
  let t=String(text).trim(), m=t.match(/together=([A-Za-z0-9_\-]+)/);
  if(m) t=m[1]; else { const w=t.split(/\s+/).filter(x=>/^[A-Za-z0-9_\-]{20,}$/.test(x)); if(w.length) t=w[w.length-1]; }
  try{
    const o=JSON.parse(b64d(t));
    if(!o||o.v!==1||!/^\d{4}-\d{2}-\d{2}$/.test(o.s)||typeof o.d!=="string"||!/^[ODAPSL\-]*$/.test(o.d)||o.d.length>400) return null;
    const days={}; [...o.d].forEach((c,i)=>{ if(c!=="-") days[addD(o.s,i)]=c; });
    return {name:String(o.n||"Crew").replace(/[\u0000-\u001f<>]/g,"").slice(0,24).trim()||"Crew",days,updated:/^\d{4}-\d{2}-\d{2}$/.test(o.u||"")?o.u:todayK()};
  }catch(e){ return null; }
}
const linkFor=code=>location.origin+location.pathname+"#together="+code;

/* ---------- matching ---------- */
function people(){
  const sel=buddies.filter(b=>!pick||pick.includes(b.id));
  return [{id:"me",name:"You",color:"var(--accent)",days:myDays()},...sel];
}
function jointOn(k,ps){
  let full=true;
  for(const p of ps){ const c=p.days[k]; if(!c||!OK(c)) return null; if(!FREE(c)) full=false; }
  return full?"full":"part";
}
function upcoming(ps,limit){
  if(ps.length<2) return [];
  const t=todayK(), out=[]; let cur=null;
  const end=ps.reduce((m,p)=>{ const ks=Object.keys(p.days).sort(); return ks.length&&ks[ks.length-1]<m?ks[ks.length-1]:m; },addD(t,MAXDAYS));
  for(let k=t;k<=end;k=addD(k,1)){
    const j=jointOn(k,ps);
    if(j==="full"){ if(cur&&cur.type==="full"&&addD(cur.to,1)===k) cur.to=k; else { cur={type:"full",from:k,to:k}; out.push(cur); } }
    else { if(j==="part") out.push({type:"part",from:k,to:k}); cur=null; }
    if(out.length>(limit||40)) break;
  }
  return out;
}
function pairNext(b){ const u=upcoming([{days:myDays()},b],5); return u.find(x=>x.type==="full")||u[0]||null; }

/* ---------- 3D split-flap board ---------- */
function flap(target,text){
  const box=el(target); if(!box) return;
  const old=box.dataset.v||"";
  if(old===text) return;
  box.dataset.v=text; box.setAttribute("aria-label",text.trim());
  let h=""; for(let i=0;i<text.length;i++){
    const c=text[i]===" "?"&nbsp;":esc(text[i]), was=old[i]===" "||old[i]==null?"&nbsp;":esc(old[i]);
    h+=`<span class="fl${text[i]===" "?" sp":""}" style="--i:${i}"><b class="t">${c}</b><b class="b">${c}</b><i class="ft">${was}</i><i class="fb">${c}</i></span>`;
  }
  box.innerHTML=h;
  requestAnimationFrame(()=>box.classList.remove("go")); requestAnimationFrame(()=>requestAnimationFrame(()=>box.classList.add("go")));
}

/* ---------- rendering ---------- */
function monthDays(){
  const [y,m]=month.split("-").map(Number), n=new Date(Date.UTC(y,m,0)).getUTCDate(), lead=(new Date(Date.UTC(y,m-1,1)).getUTCDay()+6)%7;
  return {n,lead,label:new Date(Date.UTC(y,m-1,1)).toLocaleDateString("en-GB",{month:"long",year:"numeric",timeZone:"UTC"})};
}
const DOW=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d=>`<div class="tg-dow">${d}</div>`).join("");

function renderMe(){
  const days=myDays(), rd=rosterDays(), {n,lead,label}=monthDays(), t=todayK();
  document.querySelectorAll(".tgMonthLbl").forEach(x=>x.textContent=label);
  let h=DOW; for(let i=0;i<lead;i++) h+=`<div></div>`;
  for(let d=1;d<=n;d++){
    const k=`${month}-${String(d).padStart(2,"0")}`, c=days[k], man=me.manual&&me.manual[k]!=null&&me.manual[k]!==rd[k];
    h+=`<button type="button" class="tg-cell${c?" c-"+c:""}${k<t?" past":""}${k===t?" now":""}" data-k="${k}" aria-label="${fmt(k)}: ${c?CODES[c].l:"not set"}"><span class="n">${d}</span>${c?`<span class="st">${CODES[c].s}</span>`:""}${man?`<i class="man" title="Changed by hand"></i>`:""}</button>`;
  }
  el("tgMeCal").innerHTML=h;
  const rk=Object.keys(rd).length, mk=Object.keys(me.manual||{}).length, all=Object.keys(days).filter(k=>k>=t);
  el("tgMeSrc").textContent=rk?`From your roster${mk?` · ${mk} changed by hand`:""}`:mk?`${mk} days marked by hand`:"Tap days to mark them";
  el("tgMeOff").textContent=all.length?`${all.filter(k=>FREE(days[k])).length} days off ahead`:"";
  el("tgClearHand").hidden=!mk;
  el("tgShare").disabled=!all.length;
  el("tgName").value=me.name||"";
}

function renderCrew(){
  const ul=el("tgCrewList");
  ul.innerHTML=buddies.length?buddies.map((b,i)=>{
    const nx=pairNext(b), ks=Object.keys(b.days).sort();
    const range=ks.length?`${fmt(ks[0],{weekday:undefined})} – ${fmt(ks[ks.length-1],{weekday:undefined})}`:"No days";
    return `<li class="tg-friend" style="--pc:${b.color}"><span class="tg-av" aria-hidden="true">${esc((b.name[0]||"?").toUpperCase())}</span>
      <div class="tg-fi"><b>${esc(b.name)}</b><span class="hint">${range} · shared ${fmt(b.updated,{weekday:undefined})}</span>
      ${nx?`<span class="tg-next ${nx.type}">${nx.type==="full"?"Next day off together":"Next part day together"}: <b>${fmt(nx.from)}</b></span>`:`<span class="hint">No days off together yet</span>`}</div>
      <div class="tg-fa"><button class="btn ghost rc-sm" type="button" data-send="${i}">Send mine</button><button class="x" type="button" data-del="${i}" aria-label="Remove ${esc(b.name)}">×</button></div></li>`;
  }).join(""):`<li class="tg-emptyrow"><span class="hint">No crew friends yet. Paste a link or code a friend sent you, or see an example.</span></li>`;
  el("tgPicks").innerHTML=buddies.length>1?buddies.map(b=>`<button class="chip tg-pick" type="button" data-id="${esc(b.id)}" aria-pressed="${!pick||pick.includes(b.id)}" style="--pc:${b.color}">${esc(b.name)}</button>`).join(""):"";
  el("tgPicks").hidden=buddies.length<2;
}

function renderMatch(){
  const ps=people(), {n,lead}=monthDays(), t=todayK();
  let h=DOW; for(let i=0;i<lead;i++) h+=`<div></div>`;
  let fullN=0, partN=0;
  for(let d=1;d<=n;d++){
    const k=`${month}-${String(d).padStart(2,"0")}`, j=ps.length>1?jointOn(k,ps):null;
    if(j==="full"&&k>=t) fullN++; if(j==="part"&&k>=t) partN++;
    const bars=ps.map(p=>{const c=p.days[k];return `<i class="${!c?"u":FREE(c)?"f":c==="P"?"p":"b"}" style="--pc:${p.color}"></i>`}).join("");
    h+=`<div class="tg-cell m${j?" j-"+j:""}${k<t?" past":""}${k===t?" now":""}" role="gridcell" aria-label="${fmt(k)}${j==="full"?": everyone off":j==="part"?": everyone free part of the day":""}"><span class="n">${d}</span>${j==="full"?`<span class="spark" aria-hidden="true">✦</span>`:""}<span class="bars">${bars}</span></div>`;
  }
  el("tgMatchCal").innerHTML=h;
  el("tgLegend").innerHTML=ps.map(p=>`<span style="--c:${p.color}">${esc(p.name)}</span>`).join("");
  el("tgMonthSum").textContent=ps.length<2?"":`${fullN} full ${fullN===1?"day":"days"}${partN?` · ${partN} part ${partN===1?"day":"days"}`:""} still to come this month`;

  const up=upcoming(ps,12), list=el("tgList");
  if(ps.length<2) list.innerHTML=`<li class="tg-emptyrow"><span class="hint">Add a crew friend to see your days off together.</span></li>`;
  else if(!up.length) list.innerHTML=`<li class="tg-emptyrow"><span class="hint">No shared free days in the days you both shared. Ask for a newer roster, or swap a duty.</span></li>`;
  else list.innerHTML=up.slice(0,10).map((u,i)=>{
    const len=diffD(u.from,u.to)+1, d=dOf(u.from);
    const when=len>1?`${fmt(u.from)} – ${fmt(u.to)}`:fmt(u.from,{weekday:"long"});
    const why=u.type==="full"?(len>1?`${len} days off together${len>=3?" · trip idea!":""}`:"Day off together"):"Free part of the day · " + ps.filter(p=>p.days[u.from]==="P").map(p=>p.name).join(", ")+" working";
    return `<li class="tg-hit ${u.type}"><div class="tg-date" aria-hidden="true"><small>${d.toLocaleDateString("en-GB",{month:"short",timeZone:"UTC"})}</small><b>${d.getUTCDate()}</b></div>
      <div><b>${when}</b><span class="hint">${esc(why)}</span></div>
      <div class="tg-ha"><button class="btn ghost rc-sm" type="button" data-ics="${i}" aria-label="Add to calendar">＋ Cal</button><button class="btn rc-sm" type="button" data-inv="${i}">Invite</button></div></li>`;
  }).join("");
  list._up=up;
  renderHero(ps,up);
}

function renderHero(ps,up){
  const nx=up.find(u=>u.type==="full")||up[0];
  const who=ps.slice(1).map(p=>p.name);
  const whoTxt=who.length>2?`${who.slice(0,-1).join(", ")} and ${who[who.length-1]}`:who.join(" and ");
  const mine=Object.keys(ps[0].days).some(k=>k>=todayK());
  if(locked()){ flap("tgFlap","GO PRO"); el("tgHeroLine").textContent=buddies.length?`Unlock Pro to see your days off with ${whoTxt||"your crew"}.`:"Find every day you and your crew friends are off together."; }
  else if(!mine){ flap("tgFlap","YOUR DAYS"); el("tgHeroLine").textContent="Load your roster in Roster check, or mark your days off below."; }
  else if(ps.length<2){ flap("tgFlap","ADD CREW"); el("tgHeroLine").textContent="Share your days. Find the ones you're all off."; }
  else if(!nx){ flap("tgFlap","NO MATCH"); el("tgHeroLine").textContent=`Nothing yet with ${whoTxt}.`; }
  else {
    const d=dOf(nx.from), s=(d.toLocaleDateString("en-GB",{weekday:"short",timeZone:"UTC"})+" "+String(d.getUTCDate()).padStart(2,"0")+" "+d.toLocaleDateString("en-GB",{month:"short",timeZone:"UTC"})).toUpperCase();
    flap("tgFlap",s);
    const len=diffD(nx.from,nx.to)+1;
    el("tgHeroLine").textContent=`${nx.type==="full"?(len>1?`${len} days off`:"Day off"):"Part day free"} with ${whoTxt}`;
  }
  el("tgKick").textContent=locked()?"Off together · Pro":nx&&nx.from===todayK()?"Off together today":"Next day off together";
  /* Today teaser */
  const tc=el("tgToday"); if(!tc) return;
  if(locked()){ el("tgTodayT").textContent=buddies.length?"Days off together":"Off together"; el("tgTodayL").textContent=buddies.length?`See your days off with ${whoTxt}. Unlock with Pro.`:"Share rosters with crew friends and see which days you're all off."; }
  else if(!buddies.length){ el("tgTodayT").textContent="Off together"; el("tgTodayL").textContent="Share rosters with crew friends and see which days you're all off."; }
  else if(nx){ el("tgTodayT").textContent=fmt(nx.from,{weekday:"long"}); el("tgTodayL").textContent=`${nx.type==="full"?"Your next day off":"Part day free"} with ${whoTxt}`; }
  else { el("tgTodayT").textContent="No match yet"; el("tgTodayL").textContent=`Ask ${whoTxt} for a newer roster.`; }
}

function render(){ renderMe(); renderCrew(); renderMatch(); }

/* ---------- actions ---------- */
async function shareText(text,title){
  try{ if(navigator.share){ await navigator.share({title,text}); return "shared"; } }catch(e){ if(e&&e.name==="AbortError") return "cancel"; }
  try{ await navigator.clipboard.writeText(text); say("Copied. Paste it in your crew chat."); return "copied"; }
  catch(e){ window.prompt("Copy this and send it:",text); return "prompt"; }
}
async function shareMine(){
  if(locked()){ goPro(); return; }
  if(!me.name){ el("tgName").focus(); el("tgNameMsg").textContent="Add the name your friends know you by first."; return; }
  const code=encode(); if(!code){ say("Mark some days first."); return; }
  el("tgCode").value=linkFor(code); el("tgCodeBox").hidden=false;
  await shareText(`${me.name} shared their roster days off on Layover Logbook. Open to see our days off together: ${linkFor(code)}`,"My days off");
}
function addBuddy(b,quiet){
  const id=b.name.toLowerCase().replace(/\s+/g," ");
  const i=buddies.findIndex(x=>x.id===id);
  if(i>=0){ buddies[i]={...buddies[i],days:b.days,updated:b.updated}; if(!quiet) say(`Updated ${b.name}'s days.`); }
  else { buddies.push({id,name:b.name,days:b.days,updated:b.updated,color:COLORS[buddies.length%COLORS.length]}); if(pick) pick.push(id); if(!quiet) say(`Added ${b.name}.`); }
  save(); render();
}
function icsFor(u){
  const z=k=>k.replace(/-/g,""), who=people().slice(1).map(p=>p.name).join(", ");
  return ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Layover Logbook//Off together//EN","BEGIN:VEVENT",
    `UID:together-${u.from}-${Date.now()}@layoverlogbook`,`DTSTAMP:${new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d+/,"")}`,
    `DTSTART;VALUE=DATE:${z(u.from)}`,`DTEND;VALUE=DATE:${z(addD(u.to,1))}`,
    `SUMMARY:${u.type==="full"?"Off together":"Free part of the day"} with ${who.replace(/[,;\\]/g," ")}`,"END:VEVENT","END:VCALENDAR"].join("\r\n");
}
function download(name,text){
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([text],{type:"text/calendar"})); a.download=name;
  document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},2000);
}
const EXAMPLE=(()=>{ /* a believable friend: two trips, a standby, lots of days off */
  const t=todayK(), pat="DDAOOPOODDDAAOOOSOODOLLLOODDOOPOOOD", days={};
  [...pat].forEach((c,i)=>days[addD(t,i-2)]=c);
  return {name:"Sara (example)",days,updated:t};
})();

/* ---------- incoming links ---------- */
function takeHash(){
  const m=location.hash.match(/together=([A-Za-z0-9_\-]+)/); if(!m) return;
  ls.set("lay.tgPending",m[1]);
  history.replaceState(null,"",location.pathname+location.search);
}
function offerPending(){
  const code=ls.get("lay.tgPending",null); if(!code) return;
  const b=decode(code); ls.set("lay.tgPending",null); if(!b) { say("That roster link didn't work. Ask for a new one."); return; }
  pending=b;
  const ks=Object.keys(b.days), off=ks.filter(k=>FREE(b.days[k])&&k>=todayK()).length;
  const tog=upcoming([{days:myDays()},b],60).filter(u=>u.type==="full").reduce((s,u)=>s+diffD(u.from,u.to)+1,0);
  el("tgInTitle").textContent=`${b.name} shared their days off`;
  el("tgInLine").textContent=`${ks.length} days · ${off} days off ahead`+(Object.keys(myDays()).length?` · ${tog} off together with you`:"");
  el("tgInAdd").textContent=locked()?"Unlock with Pro to compare":"Add and compare";
  el("tgIn").hidden=false; el("tgInBg").hidden=false;
}
function closeIn(){ el("tgIn").hidden=true; el("tgInBg").hidden=true; pending=null; }
takeHash();

/* ---------- wiring ---------- */
function paint(btn){
  const k=btn.dataset.k; if(!k) return;
  me.manual=me.manual||{};
  const rd=rosterDays();
  if(brush==="clear") delete me.manual[k]; else if(rd[k]===brush) delete me.manual[k]; else me.manual[k]=brush;
  save(); renderMe(); renderCrew(); renderMatch();
}
function shift(n){ const [y,m]=month.split("-").map(Number); month=new Date(Date.UTC(y,m-1+n,1)).toISOString().slice(0,7); render(); }

el("tgBrush").addEventListener("click",e=>{ const b=e.target.closest("[data-b]"); if(!b) return; brush=b.dataset.b;
  el("tgBrush").querySelectorAll("[data-b]").forEach(x=>x.setAttribute("aria-pressed",x===b)); });
const cal=el("tgMeCal");
cal.addEventListener("pointerdown",e=>{ const b=e.target.closest("[data-k]"); if(!b) return; painting=e.pointerType==="mouse"; paint(b); e.preventDefault(); });
cal.addEventListener("pointerover",e=>{ if(!painting) return; const b=e.target.closest("[data-k]"); if(b) paint(b); });
window.addEventListener("pointerup",()=>painting=false);
cal.addEventListener("keydown",e=>{ if(e.key==="Enter"||e.key===" "){ const b=e.target.closest("[data-k]"); if(b){ e.preventDefault(); paint(b); } } });
document.querySelectorAll(".tgPrev").forEach(b=>b.addEventListener("click",()=>shift(-1)));
document.querySelectorAll(".tgNext").forEach(b=>b.addEventListener("click",()=>shift(1)));
el("tgName").addEventListener("input",e=>{ me.name=e.target.value.trim().slice(0,24); el("tgNameMsg").textContent=""; save(); });
el("tgShare").addEventListener("click",shareMine);
el("tgCopy").addEventListener("click",async()=>{ try{ await navigator.clipboard.writeText(el("tgCode").value); say("Link copied."); }catch(e){ el("tgCode").select(); } });
el("tgClearHand").addEventListener("click",()=>{ me.manual={}; save(); render(); });
el("tgAddForm").addEventListener("submit",e=>{
  e.preventDefault(); const v=el("tgPaste").value, b=decode(v);
  if(!b){ el("tgAddMsg").textContent="That doesn't look like a roster link or code. Ask your friend to send it again."; return; }
  el("tgAddMsg").textContent=""; el("tgPaste").value=""; addBuddy(b);
});
el("tgExample").addEventListener("click",()=>{
  if(!Object.keys(myDays()).some(k=>k>=todayK())){ /* nothing of mine yet: give me example days too, so the match shows */
    const t=todayK(); [..."OODDAOOODDAAAOOPOODDOOOLLOOODDDAOO"].forEach((c,i)=>me.manual[addD(t,i-2)]=c); save();
    say("Added example days for you too. Change them in Your days.");
  }
  addBuddy(EXAMPLE,true); el("tgMatchCard").scrollIntoView({behavior:"smooth",block:"start"}); });
el("tgCrewList").addEventListener("click",e=>{
  const d=e.target.closest("[data-del]"), s=e.target.closest("[data-send]");
  if(d){ const i=+d.dataset.del;
    if(!d.classList.contains("armed")){ d.classList.add("armed"); d.textContent="Remove"; setTimeout(()=>{ if(d.isConnected){ d.classList.remove("armed"); d.textContent="×"; } },3000); return; }
    const id=buddies[i].id; buddies.splice(i,1); if(pick) pick=pick.filter(x=>x!==id); save(); render(); }
  if(s) shareMine();
});
el("tgPicks").addEventListener("click",e=>{
  const b=e.target.closest("[data-id]"); if(!b) return;
  const all=buddies.map(x=>x.id); let p=pick?[...pick]:[...all];
  p=p.includes(b.dataset.id)?p.filter(x=>x!==b.dataset.id):[...p,b.dataset.id];
  if(!p.length) p=[b.dataset.id];
  pick=p.length===all.length?null:p; save(); renderCrew(); renderMatch();
});
el("tgList").addEventListener("click",async e=>{
  const up=el("tgList")._up||[], c=e.target.closest("[data-ics]"), v=e.target.closest("[data-inv]");
  if(c&&window.LayoverAndroid&&LayoverAndroid.addEvent){ const u=up[+c.dataset.ics];
    LayoverAndroid.addEvent((u.type==="full"?"Off together with ":"Free part of the day with ")+people().slice(1).map(p=>p.name).join(", "),+dOf(u.from),+dOf(addD(u.to,1)),true); return; }
  if(c){ const u=up[+c.dataset.ics]; download(`off-together-${u.from}.ics`,icsFor(u)); say("Open the file to add it to your calendar."); }
  if(v){ const u=up[+v.dataset.inv], len=diffD(u.from,u.to)+1;
    const when=len>1?`${fmt(u.from)} to ${fmt(u.to)}`:fmt(u.from,{weekday:"long"});
    await shareText(u.type==="full"?`We're all off ${when}! ✈️ Plans? Brunch, beach or a quick trip?`:`We're all free for part of ${when}. ✈️ Dinner or a coffee?`,"Off together"); }
});
el("tgInAdd").addEventListener("click",()=>{ const b=pending; closeIn();
  if(b&&locked()){ addBuddy(b,true); if(typeof showTab==="function") showTab("rest","together"); goPro(); return; } /* kept, ready once Pro is on */
  if(b){ addBuddy(b); if(typeof showTab==="function") showTab("rest","together"); } });
el("tgInNo").addEventListener("click",closeIn); el("tgInBg").addEventListener("click",closeIn);
const tt=el("tgToday"); if(tt) tt.addEventListener("click",()=>{ if(typeof showTab==="function") showTab("rest","together"); });

/* Roster check changes my days: refresh when it saves, or when this page is shown */
window.addEventListener("storage",e=>{ if(e.key&&e.key.startsWith("lay.")) render(); });
document.querySelector('#tab-rest .seg [data-sub="together"]').addEventListener("click",render);
window.LayoverTogether={render,decode,encode,upcoming};
/* Pro turned on or off: redraw */
let wasLocked=locked();
new MutationObserver(()=>{ if(locked()!==wasLocked){ wasLocked=locked(); render(); } }).observe(document.body,{attributes:true,attributeFilter:["class"]});

render();
/* show an incoming friend's roster once the app (and any sign-in) is on screen */
const wait=setInterval(()=>{
  const login=el("login"), home=el("homeForm");
  if((!login||login.hidden)&&(!home||home.hidden)&&ls.get("lay.tgPending",null)){ clearInterval(wait); setTimeout(offerPending,300); }
  else if(!ls.get("lay.tgPending",null)) clearInterval(wait);
},700);
window.addEventListener("hashchange",()=>{ takeHash(); offerPending(); });
})();
