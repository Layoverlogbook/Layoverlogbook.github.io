/* Off together: each crew member uploads their own roster; the app reads it and publishes only the
   day types (off, part day, duty, away, standby, leave), never flights, routes or times.
   Crew connect privately with a code: connected crew see each other's days, nobody else.
   The app then finds the days everyone is off. Storage and access rules live in Supabase
   (roster_shares, roster_links and the roster_* functions). */
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
let me=ls.get("lay.tgMe",{name:""});
let friends=ls.get("lay.tgFriends",[]);       /* connected crew, cached from the cloud */
let mine=ls.get("lay.tgMine",null);           /* my share: {code, friends, updated} */
let example=ls.get("lay.tgExample",false);    /* demo friend, this device only */
let pick=ls.get("lay.tgPick",null);           /* ids of friends to match against; null = everyone */
let month=todayK().slice(0,7), pending=null, files=[], busy=false;
const save=()=>{ ls.set("lay.tgMe",me); ls.set("lay.tgFriends",friends); ls.set("lay.tgMine",mine); ls.set("lay.tgExample",example); ls.set("lay.tgPick",pick); };
ls.set("lay.tgBuddies",null);                 /* links from the first version are replaced by private connections */

const EXAMPLE=(()=>{ /* a believable friend: two trips, a standby, lots of days off */
  const t=todayK(), pat="DDAOOPOODDDAAOOOSOODOLLLOODDOOPOOOD", days={};
  [...pat].forEach((c,i)=>days[addD(t,i-2)]=c);
  return {id:"example",name:"Sara (example)",days,updated:t,color:COLORS[5]};
})();
const DEMO_ME=(()=>{ const t=todayK(), days={}; [..."OODDAOOODDAAAOOPOODDOOOLLOOODDDAOO"].forEach((c,i)=>days[addD(t,i-2)]=c); return days; })();

/* ---------- my days, worked out from the roster ---------- */
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
function myDays(){ const r=rosterDays(); return Object.keys(r).length||!example?r:DEMO_ME; }

/* ---------- cloud ---------- */
const cloudOn=()=>typeof CLOUD_ON!=="undefined"&&CLOUD_ON;
const signedIn=()=>cloudOn()&&typeof DB!=="undefined"&&!!DB.cloud;
const ERR={signin:"Sign in again to continue.",bad_code:"That code didn't work. Check it with your friend, or ask for a new one.",
  own_code:"That's your own code. Send it to a friend instead.",too_many:"Too many tries. Wait an hour and try again.",
  too_many_friends:"You're connected with 30 crew already. Disconnect someone first.",pro:"Seeing friends' days is part of Pro.",
  bad_days:"Couldn't share that roster. Read it again.",bad_start:"That roster is too old to share. Upload this month's roster."};
async function call(fn,args){
  try{ return await rpc(fn,args); }
  catch(e){ throw new Error(ERR[e.message]||e.message||"Something went wrong. Try again."); }
}
const toFriend=(f,i)=>{ const days={}; [...(f.days||"")].forEach((c,j)=>{ if(c!=="-") days[addD(f.start,j)]=c; });
  return {id:f.id,name:f.name,days,updated:String(f.updated||"").slice(0,10)||todayK(),color:COLORS[i%COLORS.length]}; };
function shareDays(){
  const days=rosterDays(), t=todayK(), ks=Object.keys(days).filter(k=>k>=addD(t,-3)).sort();
  if(!ks.length) return null;
  const start=ks[0], n=Math.min(MAXDAYS,diffD(start,ks[ks.length-1])+1);
  let d=""; for(let i=0;i<n;i++) d+=days[addD(start,i)]||"-";
  return {start,days:d.replace(/-+$/,"")};
}
/* publish my days whenever the roster or my name changed */
async function publish(force){
  if(!signedIn()) return;
  const sh=shareDays(); if(!sh) return;
  const name=(me.name||"").trim()||"Crew", sig=[name,sh.start,sh.days].join("|");
  if(!force&&sig===ls.get("lay.tgPubSig",null)&&mine&&mine.code) return;
  try{
    const code=await call("roster_publish",{p_name:name,p_start:sh.start,p_days:sh.days});
    ls.set("lay.tgPubSig",sig); mine={...(mine||{}),code,updated:todayK()}; save(); render();
  }catch(e){ msg(e.message); }
}
let pubTimer=0; const publishSoon=()=>{ clearTimeout(pubTimer); pubTimer=setTimeout(()=>publish(),900); };
async function refresh(){
  if(!signedIn()) return;
  el("tgSync").textContent="Updating…";
  try{
    mine=(await call("roster_mine",{}))||null;
    if(!locked()){ const fr=await call("roster_friends",{}); friends=(fr||[]).map(toFriend); }
    save(); await publish(); render();
  }catch(e){}
  el("tgSync").textContent=friends.length?`${friends.length} connected`:"";
}

/* ---------- reading a roster picture (same reader as Roster check, Pro) ---------- */
async function shrink(file){
  const bmp=await createImageBitmap(file); const k=Math.min(1,2000/Math.max(bmp.width,bmp.height));
  const c=document.createElement("canvas"); c.width=Math.round(bmp.width*k); c.height=Math.round(bmp.height*k);
  c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);
  const url=c.toDataURL("image/jpeg",.85); return {type:"image/jpeg",data:url.slice(url.indexOf(",")+1)};
}
function rules(){
  if(window.RosterCheck&&RosterCheck.rules) return RosterCheck.rules();
  const RC=window.RosterEngine, rid=ls.get("lay.rcRule","qatar");
  return {...(RC?RC.RULESETS[rid]:{}),...((ls.get("lay.rcCustom",{})||{})[rid]||{})};
}
function msg(t,spin){ el("tgMsg").innerHTML=(spin?'<span class="rc-spin"></span>':"")+esc(t||""); }
function signIn(){ if(typeof openAccountScreen==="function") openAccountScreen("signin"); }
async function readRoster(){
  if(locked()){ goPro(); return; }
  if(!signedIn()){ signIn(); return; }
  if(!files.length||busy) return;
  busy=true; const btn=el("tgRead"); btn.disabled=true; msg("Reading your roster… this can take up to a minute.",true);
  try{
    let tok; try{ tok=await validToken(); }catch(e){ tok=null; }
    if(!tok){ msg("Sign in again to continue."); return; }
    const R=rules(), images=await Promise.all(files.map(shrink));
    let r; try{ r=await fetch(SB+"/functions/v1/roster-read",{method:"POST",headers:{apikey:SBKEY,Authorization:"Bearer "+tok,"Content-Type":"application/json"},
      body:JSON.stringify({images,airline:R.name,homeBase:R.homeBase,homeOffset:R.homeOffset,month:el("tgMonth").value,timeBasis:"auto"})}); }
    catch(e){ msg("You're offline. Try again when you have a connection."); return; }
    let j=null; try{ j=await r.json(); }catch(e){}
    if(r.status===402){ msg("Reading rosters is part of Pro."); goPro(); return; }
    if(r.status===401){ msg("Sign in again to continue."); return; }
    if(r.status===503){ msg("Reading roster pictures isn't switched on yet. The app owner needs to add the reading key."); return; }
    if(!r.ok||!j||!Array.isArray(j.duties)){ msg("Couldn't read that roster. Try a clearer screenshot."); return; }
    if(!j.duties.length){ msg("No duties found in that picture. Check it's your roster and try again."); return; }
    ls.set("lay.roster",j.duties); if(window.RosterCheck) RosterCheck.reload();
    example=false; save(); files=[]; el("tgThumbs").innerHTML=""; el("tgDrop").classList.remove("has");
    const sh=shareDays(); if(sh) month=sh.start.slice(0,7);
    render(); await publish(true);
    msg(`Read ${j.duties.length} duties and shared your days with your crew friends.`);
  }catch(e){ msg("Couldn't read that roster. Try a clearer screenshot."); }
  finally{ busy=false; btn.disabled=!files.length; }
}

/* ---------- matching ---------- */
const buddies=()=>example?[...friends,EXAMPLE]:friends;
function people(){
  const sel=buddies().filter(b=>!pick||pick.includes(b.id));
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
    const k=`${month}-${String(d).padStart(2,"0")}`, c=days[k];
    h+=`<div class="tg-cell${c?" c-"+c:""}${k<t?" past":""}${k===t?" now":""}" role="gridcell" aria-label="${fmt(k)}: ${c?CODES[c].l:"no roster"}"><span class="n">${d}</span>${c?`<span class="st">${CODES[c].s}</span>`:""}</div>`;
  }
  el("tgMeCal").innerHTML=h;
  const has=Object.keys(rd).length, ahead=Object.keys(days).filter(k=>k>=t);
  el("tgMeWrap").hidden=!Object.keys(days).length;            /* no roster yet: no empty calendar */
  el("tgPanel").classList.toggle("setup",!has&&!example);       /* setup card first until there is a roster */
  el("tgMeSrc").textContent=has?(mine&&mine.code?"Shared privately":"From your roster"):example?"Example days":"No roster yet";
  el("tgMeOff").textContent=ahead.length?`${ahead.filter(k=>FREE(days[k])).length} days off ahead`:"";
  if(document.activeElement!==el("tgName")) el("tgName").value=me.name||"";
  el("tgSignIn").hidden=signedIn();
  if(!cloudOn()){ el("tgSignIn").querySelector("p").textContent="Sharing rosters needs the online app at layoverlogbook.com."; el("tgSignBtn").hidden=true; }
  el("tgRead").disabled=!files.length||busy;
}
function renderShare(){
  const code=mine&&mine.code;
  el("tgCodeBox").hidden=!code||!signedIn();
  if(code) el("tgCode").textContent=code;
}
function renderCrew(){
  const bs=buddies();
  renderShare();
  el("tgCrewList").innerHTML=bs.length?bs.map(b=>{
    const nx=pairNext(b), ex=b.id==="example";
    return `<li class="tg-friend" style="--pc:${b.color}"><span class="tg-av" aria-hidden="true">${esc((b.name[0]||"?").toUpperCase())}</span>
      <div class="tg-fi"><b>${esc(b.name)}</b><span class="hint">${ex?"Example, only on this device":`Roster updated ${fmt(b.updated,{weekday:undefined})}`}</span>
      ${nx?`<span class="tg-next ${nx.type}">${nx.type==="full"?"Next day off together":"Next part day together"}: <b>${fmt(nx.from)}</b></span>`:`<span class="hint">No days off together yet</span>`}</div>
      <div class="tg-fa"><button class="btn ghost rc-sm" type="button" data-del="${esc(b.id)}" aria-label="${ex?"Remove":"Disconnect from"} ${esc(b.name)}">${ex?"Remove":"Disconnect"}</button></div></li>`;
  }).join(""):`<li class="tg-emptyrow"><span class="hint">${!signedIn()?"Sign in to connect with crew friends.":mine&&mine.code?"No crew connected yet. Send your code, or enter a friend's code below.":"Upload your roster to get your private code. Or enter a friend's code below."}</span></li>`;
  el("tgPicks").innerHTML=bs.length>1?bs.map(b=>`<button class="chip tg-pick" type="button" data-id="${esc(b.id)}" aria-pressed="${!pick||pick.includes(b.id)}" style="--pc:${b.color}">${esc(b.name)}</button>`).join(""):"";
  el("tgPicks").hidden=bs.length<2;
  el("tgExample").hidden=example;
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
  el("tgMatchWrap").hidden=ps.length<2||!Object.keys(ps[0].days).length;
  el("tgLegend").innerHTML=ps.map(p=>`<span style="--c:${p.color}">${esc(p.name)}</span>`).join("");
  el("tgMonthSum").textContent=ps.length<2?"":`${fullN} full ${fullN===1?"day":"days"}${partN?` · ${partN} part ${partN===1?"day":"days"}`:""} still to come this month`;

  const up=upcoming(ps,12), list=el("tgList");
  if(ps.length<2) list.innerHTML=`<li class="tg-emptyrow"><span class="hint">Connect with a crew friend to see your days off together.</span></li>`;
  else if(!up.length) list.innerHTML=`<li class="tg-emptyrow"><span class="hint">No free days together in the rosters you both shared. Next month's rosters may line up, or swap a duty.</span></li>`;
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
  const mineAhead=Object.keys(ps[0].days).some(k=>k>=todayK()), n=buddies().length;
  if(locked()){ flap("tgFlap","GO PRO"); el("tgHeroLine").textContent=n?`Unlock Pro to see your days off with ${whoTxt||"your crew"}.`:"Find every day you and your crew friends are off together."; }
  else if(!mineAhead){ flap("tgFlap","ROSTER"); el("tgHeroLine").textContent="Upload your roster. Your crew friends upload theirs. The app finds your days off together."; }
  else if(ps.length<2){ flap("tgFlap","ADD CREW"); el("tgHeroLine").textContent="Send your private code to a crew friend to compare rosters."; }
  else if(!nx){ flap("tgFlap","NO MATCH"); el("tgHeroLine").textContent=`Nothing yet with ${whoTxt}.`; }
  else {
    const d=dOf(nx.from), s=(d.toLocaleDateString("en-GB",{weekday:"short",timeZone:"UTC"})+" "+String(d.getUTCDate()).padStart(2,"0")+" "+d.toLocaleDateString("en-GB",{month:"short",timeZone:"UTC"})).toUpperCase();
    flap("tgFlap",s);
    const len=diffD(nx.from,nx.to)+1;
    el("tgHeroLine").textContent=`${nx.type==="full"?(len>1?`${len} days off`:"Day off"):"Part day free"} with ${whoTxt}`;
  }
  el("tgKick").textContent=locked()?"Off together · Pro":nx&&nx.from===todayK()?"Off together today":"Next day off together";
  /* Today teaser */
  if(!el("tgToday")) return;
  if(locked()){ el("tgTodayT").textContent=n?"Days off together":"Off together"; el("tgTodayL").textContent=n?`See your days off with ${whoTxt}. Unlock with Pro.`:"Upload rosters with crew friends and see which days you're all off."; }
  else if(!n){ el("tgTodayT").textContent="Off together"; el("tgTodayL").textContent="Upload rosters with crew friends and see which days you're all off."; }
  else if(nx){ el("tgTodayT").textContent=fmt(nx.from,{weekday:"long"}); el("tgTodayL").textContent=`${nx.type==="full"?"Your next day off":"Part day free"} with ${whoTxt}`; }
  else { el("tgTodayT").textContent="No match yet"; el("tgTodayL").textContent=`No days off together with ${whoTxt} in these rosters.`; }
}

function render(){ renderMe(); renderCrew(); renderMatch(); }

/* ---------- actions ---------- */
async function shareText(text,title){
  try{ if(navigator.share){ await navigator.share({title,text}); return "shared"; } }catch(e){ if(e&&e.name==="AbortError") return "cancel"; }
  try{ await navigator.clipboard.writeText(text); say("Copied. Paste it in your crew chat."); return "copied"; }
  catch(e){ window.prompt("Copy this and send it:",text); return "prompt"; }
}
async function sendCode(){
  if(!mine||!mine.code) return;
  await shareText(`Let's find our days off together on Layover Logbook ✈️ Connect with my private code ${mine.code}: ${location.origin+location.pathname}#together=${mine.code}`,"Off together");
}
async function connect(code){
  if(!signedIn()){ ls.set("lay.tgPending",code); signIn(); return false; }
  const r=await call("roster_connect",{p_code:code});
  say(`Connected with ${r&&r.name?r.name:"your crew friend"}. You can both see each other's days now.`);
  await refresh(); return true;
}
const codeIn=t=>{ const v=String(t||"").toUpperCase(), m=v.match(/TOGETHER=([A-Z2-9]{10})\b/)||v.match(/\b([A-Z2-9]{10})\b/); return m?m[1]:null; };
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

/* ---------- incoming links: #together=CODE ---------- */
function takeHash(){
  const m=location.hash.match(/together=([A-Za-z0-9_\-]+)/); if(!m) return;
  history.replaceState(null,"",location.pathname+location.search);
  const c=codeIn("together="+m[1]); if(c) ls.set("lay.tgPending",c); else setTimeout(()=>say("That link is from an older version of the app. Ask your friend for their private code."),1500);
}
function offerPending(){
  const code=ls.get("lay.tgPending",null); if(!code||!el("tgIn").hidden) return;
  pending=code; ls.set("lay.tgPending",null);
  el("tgInTitle").textContent="Connect rosters?";
  el("tgInLine").textContent=`A crew friend sent you their private code ${code}.`;
  el("tgInMsg").textContent=""; el("tgInAdd").disabled=false;
  el("tgInAdd").textContent=signedIn()?"Connect":"Sign in to connect";
  el("tgIn").hidden=false; el("tgInBg").hidden=false;
}
function closeIn(){ el("tgIn").hidden=true; el("tgInBg").hidden=true; pending=null; }
takeHash();

/* ---------- wiring ---------- */
function shift(n){ const [y,m]=month.split("-").map(Number); month=new Date(Date.UTC(y,m-1+n,1)).toISOString().slice(0,7); render(); }
const arm=(b,ask,label,ms)=>{ if(b.classList.contains("armed")){ b.classList.remove("armed"); b.textContent=label; return true; }
  b.classList.add("armed"); b.textContent=ask; setTimeout(()=>{ if(b.classList.contains("armed")){ b.classList.remove("armed"); b.textContent=label; } },ms||3500); return false; };
document.querySelectorAll(".tgPrev").forEach(b=>b.addEventListener("click",()=>shift(-1)));
document.querySelectorAll(".tgNext").forEach(b=>b.addEventListener("click",()=>shift(1)));
(()=>{ const n=new Date(); el("tgMonth").value=`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}`; })();
el("tgName").addEventListener("input",e=>{ me.name=e.target.value.trim().slice(0,24); save(); publishSoon(); });
el("tgDrop").addEventListener("click",()=>{ if(locked()) goPro(); else if(!signedIn()) signIn(); else el("tgFile").click(); });
el("tgFile").addEventListener("change",e=>{
  files=[...e.target.files].slice(0,4);
  el("tgThumbs").innerHTML=files.map(f=>`<img src="${URL.createObjectURL(f)}" alt="Roster page">`).join("");
  el("tgDrop").classList.toggle("has",files.length>0); el("tgRead").disabled=!files.length; e.target.value="";
});
el("tgRead").addEventListener("click",readRoster);
el("tgSignBtn").addEventListener("click",signIn);
el("tgSend").addEventListener("click",sendCode);
el("tgNewCode").addEventListener("click",async e=>{
  if(!arm(e.currentTarget,"Change code?","New code")) return;
  try{ const c=await call("roster_new_code",{}); mine={...(mine||{}),code:c}; save(); renderShare(); say("New code ready. Crew already connected stay connected."); }catch(err){ say(err.message); }
});
el("tgStop").addEventListener("click",async e=>{
  if(!arm(e.currentTarget,"Stop and disconnect all?","Stop sharing")) return;
  try{ await call("roster_unpublish",{}); mine=null; friends=[]; ls.set("lay.tgPubSig",null); save(); render(); say("Your roster is no longer shared."); }catch(err){ say(err.message); }
});
el("tgAddForm").addEventListener("submit",async e=>{
  e.preventDefault(); const c=codeIn(el("tgPaste").value);
  if(!c){ el("tgAddMsg").textContent="A code has 10 letters and numbers, like K7QM2XPD4A."; return; }
  el("tgAddMsg").textContent="Connecting…";
  try{ const ok=await connect(c); el("tgAddMsg").textContent=""; if(ok) el("tgPaste").value=""; }
  catch(err){ el("tgAddMsg").textContent=err.message; }
});
el("tgExample").addEventListener("click",()=>{
  example=true; save(); render();
  if(!Object.keys(rosterDays()).length) say("Showing example days for you too, until you upload your roster.");
  el("tgMatchCard").scrollIntoView({behavior:"smooth",block:"start"});
});
el("tgCrewList").addEventListener("click",async e=>{
  const d=e.target.closest("[data-del]"); if(!d) return;
  const id=d.dataset.del;
  if(id==="example"){ example=false; if(pick) pick=pick.filter(x=>x!==id); save(); render(); return; }
  if(!arm(d,"Sure?","Disconnect")) return;
  try{ await call("roster_disconnect",{p_friend:id}); friends=friends.filter(f=>f.id!==id); if(pick) pick=pick.filter(x=>x!==id); save(); render(); say("Disconnected. You no longer see each other's days."); }
  catch(err){ say(err.message); }
});
el("tgPicks").addEventListener("click",e=>{
  const b=e.target.closest("[data-id]"); if(!b) return;
  const all=buddies().map(x=>x.id); let p=pick?[...pick]:[...all];
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
el("tgInAdd").addEventListener("click",async()=>{
  const c=pending; if(!c) return;
  if(!signedIn()){ ls.set("lay.tgPending",c); closeIn(); signIn(); return; }
  el("tgInAdd").disabled=true; el("tgInMsg").textContent="Connecting…";
  try{ await connect(c); closeIn(); if(typeof showTab==="function") showTab("pro","together"); if(locked()) goPro(); }
  catch(err){ el("tgInMsg").textContent=err.message; el("tgInAdd").disabled=false; }
});
el("tgInNo").addEventListener("click",closeIn); el("tgInBg").addEventListener("click",closeIn);
const tt=el("tgToday"); if(tt) tt.addEventListener("click",()=>{ if(typeof showTab==="function") showTab("pro","together"); });

/* my roster changed in Roster check: redraw and share the new days */
window.addEventListener("lay-roster",()=>{ render(); publishSoon(); });
window.addEventListener("storage",e=>{ if(e.key&&e.key.startsWith("lay.")) render(); });
document.querySelector('#tab-pro .seg [data-sub="together"]').addEventListener("click",()=>{ render(); refresh(); });
window.LayoverTogether={render,refresh,upcoming,shareDays,rosterDays};
let wasLocked=locked(), wasIn=null;
new MutationObserver(()=>{ if(locked()!==wasLocked){ wasLocked=locked(); render(); refresh(); } }).observe(document.body,{attributes:true,attributeFilter:["class"]});

render();
/* once the app (and any sign-in) is on screen: load connections, then offer a pending code */
setInterval(()=>{
  const login=el("login"), home=el("homeForm");
  if((login&&!login.hidden)||(home&&!home.hidden)) return;
  if(signedIn()!==wasIn){ wasIn=signedIn(); render(); refresh(); }
  if(ls.get("lay.tgPending",null)) offerPending();
},800);
window.addEventListener("hashchange",()=>{ takeHash(); offerPending(); });
})();
