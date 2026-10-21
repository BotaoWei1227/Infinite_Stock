import {CFG} from "./config.js";
import {initializeApp} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {getAuth,onAuthStateChanged,GoogleAuthProvider,signInWithPopup,signInWithRedirect,getRedirectResult,signOut} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {getFirestore,collection,doc,onSnapshot,query,orderBy,limit} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const REDIRECT=location.origin+location.pathname; // 必須與 Developer Center 的 Redirect URI 完全一致
const $=id=>document.getElementById(id),S=sessionStorage;
const fmt=n=>(Math.round(n*100)/100).toFixed(2);
let hinting=true;
const say=t=>{hinting=false;$("msg").textContent=t;};
let db,auth,user=null,me={cash:CFG.startCash,hold:{},name:"訪客"},stocks={},token=null,inv=[],item=null,profile=null,busy=false,offP=null,collapsed=new Set(),view="trade",bankBuilt=false;

// ---------- OAuth：Authorization Code + PKCE S256（瀏覽器端） ----------
const b64u=b=>btoa(String.fromCharCode(...b)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const rnd=n=>{const v=new Uint8Array(n);crypto.getRandomValues(v);return b64u(v);};
async function login(){
  const verifier=rnd(32),state=rnd(24);
  const ch=b64u(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))));
  S.setItem("pk",JSON.stringify({verifier,state}));
  const u=new URL(CFG.ia.base+"/oauth/authorize");
  Object.entries({response_type:"code",client_id:CFG.ia.clientId,redirect_uri:REDIRECT,scope:CFG.ia.scope,state,code_challenge:ch,code_challenge_method:"S256"}).forEach(([k,v])=>u.searchParams.set(k,v));
  location.href=u.href;
}
async function handleCallback(){
  const q=new URLSearchParams(location.search);
  if(!q.has("code")&&!q.has("error"))return;
  const pk=JSON.parse(S.getItem("pk")||"{}");S.removeItem("pk");
  const code=q.get("code"),st=q.get("state"),err=q.get("error");
  history.replaceState(null,"",location.pathname);
  if(err)return say("你已取消授權");
  if(!pk.state||st!==pk.state)return say("授權驗證失敗（state 不符），請重新登入");
  try{
    const r=await fetch(CFG.ia.base+"/developer-api/oauth/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({grant_type:"authorization_code",client_id:CFG.ia.clientId,code,redirect_uri:REDIRECT,code_verifier:pk.verifier})});
    const j=await r.json();if(!r.ok)throw new Error(j.code||r.status);
    token=j.access_token;setTimeout(()=>{token=null;render();say("授權已過期，請重新連結");},(j.expires_in||3600)*1000-5000);
  }catch(e){say("取得授權失敗："+e.message);}
}
async function iaGet(path,tries=3){
  for(let i=0;i<tries;i++){
    const r=await fetch(CFG.ia.base+"/developer-api/v1/"+path,{headers:{Authorization:"Bearer "+token}});
    if(r.status===429){await new Promise(s=>setTimeout(s,(2**i)*800+Math.random()*400));continue;}
    if(r.status===401){token=null;render();throw new Error("授權失效，請重新連結");}
    if(!r.ok){const j=await r.json().catch(()=>({}));throw new Error(j.code||("HTTP "+r.status));}
    return r.json();
  }
  throw new Error("請求過於頻繁，請稍後再試");
}
async function loadIA(){
  profile=await iaGet("me");const all=[];let off=0;
  while(off!=null&&all.length<500){const p=await iaGet("history?limit=100&offset="+off);all.push(...p.items);off=p.nextOffset;}
  const now=Date.now(),m=new Map(); // 只列出 24 小時內成功合成的造物（伺服器會再驗證一次）
  for(const x of all){if(x.failed||!x.result||now-x.createdAt>864e5)continue;if(!(m.get(x.result)>=x.createdAt))m.set(x.result,x.createdAt);}
  inv=[...m].map(([name,at])=>({name,at})).sort((a,b)=>b.at-a.at);
  me.name=profile.workshopName||"訪客";
  offP&&offP(); // 玩家資料以 IA 的 app-scoped ID 為鍵，換裝置也能延續
  offP=onSnapshot(doc(db,"players",profile.id),d=>{me=d.exists()?{...d.data()}:{cash:CFG.startCash,hold:{},name:me.name};render();});
}
const okUrl=u=>{try{return new URL(u).protocol==="https:"?u:null}catch{return null}};
const icon=(e,url)=>{const s=document.createElement("span"),u=okUrl(url);s.textContent=e||"❔";
  if(u){const i=new Image();i.className="ic";i.alt="";i.loading="lazy";i.src=u;i.onload=()=>s.replaceChildren(i);}return s;};

const left=at=>{const m=Math.max(0,Math.floor((864e5-(Date.now()-at))/6e4));return m>=60?Math.floor(m/60)+" 小時":m+" 分";};
const usedAt=name=>{const t=(me.used||{})[name];return typeof t==="number"&&Date.now()-t<864e5?t:0;};
const el=(tag,p={},...kids)=>{const e=document.createElement(tag);
  for(const [k,v] of Object.entries(p)){if(k==="class")e.className=v;else if(k==="text")e.textContent=v;else if(k==="disabled"||k==="hidden")e[k]=!!v;else if(k.startsWith("on"))e[k]=v;else e.setAttribute(k,v);}
  e.append(...kids);return e;};
async function gLogin(){
  const p=new GoogleAuthProvider();
  try{await signInWithPopup(auth,p);}
  catch(e){
    if(e.code==="auth/popup-blocked"||e.code==="auth/operation-not-supported-in-this-environment")return signInWithRedirect(auth,p);
    if(e.code!=="auth/popup-closed-by-user"&&e.code!=="auth/cancelled-popup-request")say("Google 登入失敗："+e.code);
  }
}
function logoutIA(){token=null;inv=[];item=null;offP&&offP();offP=null;me={cash:CFG.startCash,hold:{},name:"訪客"};render();}

// ---------- 伺服器端行動（Worker 驗證 IA 身分並計算行情） ----------
async function act(name,data){
  if(busy)return null;if(!user){say("請先以 Google 帳號登入");return null;}if(!token){say("請先連結《無限煉製》帳號");return null;}
  busy=true;say("處理中…");render();
  try{
    const r=await fetch(CFG.api+"/"+name,{method:"POST",headers:{Authorization:"Bearer "+await user.getIdToken(),"Content-Type":"application/json"},body:JSON.stringify({...data,iaToken:token})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j.error?.message||("HTTP "+r.status));
    return j;
  }
  catch(e){if(/授權失效/.test(e.message)){token=null;}say(e.message);return null;}
  finally{busy=false;render();}
}
async function inject(id){
  if(!item)return say("請先選擇要投入的造物");
  if(!S.getItem("gk")){say("請先到右上角 ⚙ 設定 Google API Key");$("settings").showModal?.();return;}
  const r=await act("inject",{stockId:id,itemName:item.name,geminiKey:S.getItem("gk")});
  if(r){item=null;say(`${r.score}分：${r.reason}｜上漲機率 ${r.up}%，本次 ${r.pct>0?"+":""}${r.pct}%`);render();}
}
const trade=(id,dir)=>act("trade",{stockId:id,dir});
const DAYMS=864e5,RATE=.05,DEBT_CAP=100;
const owedNow=()=>{const l=me.loan;return l&&l.p>0?l.p*Math.pow(1+RATE,Math.max(0,Date.now()-l.t)/DAYMS):0;};
const net=()=>me.cash+Object.entries(me.hold||{}).reduce((a,[k,n])=>a+n*(stocks[k]?.price||0),0)-owedNow();
const bankAct=async(action,amount,all)=>{const r=await act("bank",{action,amount,all});
  if(r){say(action==="borrow"?`已借入 ${fmt(amount)}，目前欠款 ${fmt(r.owed)}`:(r.owed>0?`已還款，剩餘欠款 ${fmt(r.owed)}`:"已全額還清，沒有欠款了"));}return r;};

const winBar=(title,extra)=>el("div",{class:"bar"},el("span",{class:"tt",text:title}),...(extra||[]));
function chart(s){ // 像素折線圖：紅漲綠跌，標示最高/最低與涵蓋時間
  const pts=s.p||[s.price],n=pts.length;
  if(n<2){return el("div",{class:"chart mu",text:"走勢資料累積中…（每 2 分鐘一個點）",style:"display:grid;place-items:center"});}
  const W=300,H=84,P=8,lo=Math.min(...pts),hi=Math.max(...pts),rg=(hi-lo)||1;
  const X=i=>P+i*(W-2*P)/(n-1),Y=v=>H-P-6-(v-lo)/rg*(H-2*P-10),NS="http://www.w3.org/2000/svg";
  const svg=document.createElementNS(NS,"svg");svg.setAttribute("viewBox",`0 0 ${W} ${H}`);svg.setAttribute("class","chart");svg.setAttribute("role","img");
  svg.setAttribute("aria-label",`${s.name}股價走勢，最高 ${fmt(hi)}，最低 ${fmt(lo)}`);
  [.25,.5,.75].forEach(f=>{const g=document.createElementNS(NS,"line");g.setAttribute("x1",P);g.setAttribute("x2",W-P);g.setAttribute("y1",H*f);g.setAttribute("y2",H*f);g.setAttribute("class","gd");svg.append(g);});
  const ln=document.createElementNS(NS,"polyline");ln.setAttribute("points",pts.map((v,i)=>X(i).toFixed(1)+","+Y(v).toFixed(1)).join(" "));
  ln.setAttribute("class","ln "+(pts[n-1]>=pts[0]?"up":"dn"));svg.append(ln);
  const mins=Math.round((s.t[s.t.length-1]-s.t[0])/6e4),span=mins>=60?Math.round(mins/60)+" 小時":mins+" 分鐘";
  [[fmt(hi),W-P,9,"end"],[fmt(lo),W-P,H-2,"end"],["近 "+span,P,H-2,"start"]].forEach(([t,x,y,a])=>{
    const e=document.createElementNS(NS,"text");e.setAttribute("x",x);e.setAttribute("y",y);e.setAttribute("text-anchor",a);e.setAttribute("class","lb");e.textContent=t;svg.append(e);});
  return svg;
}
function renderStrip(){
  const s=$("strip");s.replaceChildren();
  const chip=(ok,label,on)=>el("button",{class:"chip "+(ok?"ok":"todo"),type:"button",onclick:on},el("i",{class:"dot","aria-hidden":"true"}),el("span",{text:label}));
  s.append(
    chip(!!user,user?"Google："+(user.displayName||user.email||"已登入"):"以 Google 帳號登入",()=>{if(user){if(confirm("登出 Google？"))signOut(auth);}else gLogin();}),
    chip(!!token,token?"工坊："+me.name:"連結《無限煉製》帳號",()=>{if(token){if(confirm("中斷《無限煉製》連線？"))logoutIA();}else login();}),
    el("div",{class:"stat"},el("span",{class:"k",text:"現金 "}),el("b",{text:fmt(me.cash)}),el("span",{class:"k",text:"　淨值 "}),el("b",{text:fmt(net())})));
}
let craftSig="";
function renderCraft(){
  const sig=JSON.stringify([!!token,inv.map(x=>x.name),Object.keys(me.used||{}),item&&item.name,busy]);
  if(sig===craftSig)return;craftSig=sig;
  const w=$("craft");w.replaceChildren(winBar("📦 CREATION.EXE",[el("span",{class:"wb dec","aria-hidden":"true",text:"_"}),el("span",{class:"wb dec","aria-hidden":"true",text:"×"})]));
  const b=el("div",{class:"body"});
  if(!token){b.append(el("p",{class:"mu",text:"先連結《無限煉製》帳號，才能挑選 24 小時內做出的造物來投入。"}));}
  else{
    const sel=el("select",{class:"px-sel","aria-label":"選擇要投入的造物"});
    sel.append(new Option(inv.length?"▼ 選擇 24 小時內做出的造物":"24 小時內沒有新做出的造物",""));
    inv.forEach((x,i)=>{const u=usedAt(x.name),o=new Option(`${x.name}（${u?"今日已投入":"剩 "+left(x.at)}）`,String(i));o.disabled=!!u;sel.append(o);});
    sel.value=item&&inv.includes(item)&&!usedAt(item.name)?String(inv.indexOf(item)):"";
    sel.onchange=()=>{item=inv[sel.value]||null;};
    b.append(sel,el("p",{class:"mu",text:"每個造物每天只能投入一次；選好後，到想影響的股票視窗按「投入造物」。"}));
  }
  w.append(b);
}
function renderMarket(){
  const mk=$("market");mk.replaceChildren();
  const ids=Object.keys(stocks).sort();
  if(!ids.length){mk.append(el("p",{class:"mu",text:"行情載入中…"}));return;}
  for(const id of ids){
    const s=stocks[id],open=!collapsed.has(id),first=(s.p&&s.p[0])||s.price,ch=(s.price/first-1)*100,chTxt=(ch>=0?"+":"")+ch.toFixed(2)+"%";
    const upP=Math.round(Math.min(.9,Math.max(.1,.5+(s.bias||0)))*100),n=me.hold?.[id]||0;
    const w=el("section",{class:"win stock"+(open?"":" shut"),"aria-label":s.name});
    w.append(winBar(`${s.emoji} ${id.toUpperCase()}.EXE`,[
      ...(open?[]:[el("span",{class:"bt "+(ch>=0?"up":"dn"),text:`${fmt(s.price)} ${chTxt}`})]),
      el("button",{class:"wb",type:"button","aria-label":(open?"收合 ":"展開 ")+s.name,"aria-expanded":String(open),text:open?"_":"▢",
        onclick:()=>{open?collapsed.add(id):collapsed.delete(id);renderMarket();}}),
      el("span",{class:"wb dec","aria-hidden":"true",text:"×"})]));
    const b=el("div",{class:"body"});
    b.append(
      el("div",{class:"hd"},el("span",{class:"nm",text:s.name}),el("span",{class:"px big",text:fmt(s.price)}),el("span",{class:"chg "+(ch>=0?"up":"dn"),text:chTxt})),
      chart(s),
      el("div",{class:"meter"},el("span",{class:"k",text:"上漲機率"}),el("div",{class:"gauge","aria-hidden":"true"},el("i",{style:`width:${upP}%`})),el("b",{text:upP+"%"})),
      el("div",{class:"mu",text:`持有 ${n} 股${s.last?"｜上次投入："+s.last:""}`}),
      el("div",{class:"acts"},
        el("button",{class:"px-btn",type:"button",disabled:busy,text:"買 1",onclick:()=>trade(id,1)}),
        el("button",{class:"px-btn",type:"button",disabled:busy,text:"賣 1",onclick:()=>trade(id,-1)}),
        el("button",{class:"px-btn pri",type:"button",disabled:busy,text:"投入造物",onclick:()=>inject(id)})));
    w.append(b);mk.append(w);
  }
}

// ---------- 銀行 ----------
const bk={};
function buildBank(){
  const v=$("v-bank");v.replaceChildren();
  const w=el("section",{class:"win","aria-label":"銀行"});
  w.append(winBar("🏦 BANK.EXE",[el("span",{class:"wb dec","aria-hidden":"true",text:"_"}),el("span",{class:"wb dec","aria-hidden":"true",text:"×"})]));
  const b=el("div",{class:"body"});
  const hr=((Math.pow(1+RATE,1/24)-1)*100).toFixed(2);
  bk.owed=el("b");bk.cash=el("b");bk.room=el("b");bk.next=el("b");
  bk.amt=el("input",{class:"px-in",type:"number",inputmode:"decimal",min:"0.01",step:"0.01",placeholder:"金額",id:"bamt","aria-label":"金額"});
  bk.b1=el("button",{class:"px-btn pri",type:"button",text:"借款",onclick:()=>{const a=parseFloat(bk.amt.value);if(!(a>0))return say("請輸入金額");bankAct("borrow",a).then(r=>{if(r)bk.amt.value="";});}});
  bk.b2=el("button",{class:"px-btn",type:"button",text:"還款",onclick:()=>{const a=parseFloat(bk.amt.value);if(!(a>0))return say("請輸入金額");bankAct("repay",a).then(r=>{if(r)bk.amt.value="";});}});
  bk.b3=el("button",{class:"px-btn",type:"button",text:"全額還清",onclick:()=>bankAct("repay",0,true)});
  b.append(
    el("p",{class:"mu",text:`高利貸：利率 5%／24 小時（約每小時 ${hr}%，利息持續複利累計）。欠款上限 ${DEBT_CAP}。`}),
    el("div",{class:"grid"},
      el("div",{class:"cell debt"},el("span",{class:"k",text:"目前欠款"}),bk.owed),el("div",{class:"cell"},el("span",{class:"k",text:"現金"}),bk.cash),
      el("div",{class:"cell"},el("span",{class:"k",text:"還能再借"}),bk.room),el("div",{class:"cell debt"},el("span",{class:"k",text:"24 小時後欠款"}),bk.next)),
    el("label",{class:"lbl",for:"bamt",text:"金額"}),bk.amt,el("div",{class:"row"},bk.b1,bk.b2,bk.b3),
    el("p",{class:"warn",text:"欠款會從淨值扣掉，不還的話利息會一直滾。借來的錢可以拿去買股票，但股價可能跌。"}));
  w.append(b);v.append(w);bankBuilt=true;
}
function updateBank(){
  if(!bankBuilt)buildBank();
  const o=owedNow();bk.owed.textContent=fmt(o);bk.cash.textContent=fmt(me.cash);
  bk.room.textContent=fmt(Math.max(0,DEBT_CAP-o));bk.next.textContent=fmt(o*(1+RATE));
  bk.b1.disabled=bk.b2.disabled=bk.b3.disabled=busy;bk.b2.disabled=busy||o<.005;bk.b3.disabled=busy||o<.005;
}
// ---------- 練金工坊 ----------
function renderWork(){
  const v=$("v-work");v.replaceChildren();
  const w=el("section",{class:"win","aria-label":"練金工坊"});
  w.append(winBar("⚗ WORKSHOP.EXE",[el("span",{class:"wb dec","aria-hidden":"true",text:"_"}),el("span",{class:"wb dec","aria-hidden":"true",text:"×"})]));
  const b=el("div",{class:"body"});
  b.append(el("p",{class:"warn",text:"《無限煉製》的公開 API 目前只開放讀取（個人資料、背包、合成紀錄），沒有「代為合成」的功能，所以這裡還不能替你在遊戲裡煉成。代煉功能的做法待定。"}));
  b.append(el("h2",{class:"h2",text:"你 24 小時內做出的造物"}));
  if(!token)b.append(el("p",{class:"mu",text:"連結《無限煉製》帳號後，這裡會列出你做出的造物，以及哪些還能投入股票。"}));
  else if(!inv.length)b.append(el("p",{class:"mu",text:"24 小時內沒有新做出的造物。到遊戲裡煉成新東西吧！"}));
  else{const ul=el("ul",{class:"list"});
    inv.forEach(x=>{const u=usedAt(x.name);ul.append(el("li",{},el("span",{class:u?"off":"",text:x.name}),el("span",{class:"mu",text:u?"今日已投入":"剩 "+left(x.at)+"・可投入"})));});
    b.append(ul);}
  w.append(b);v.append(w);
}
// ---------- 設定（介面大小） ----------
const SCALES={s:["小",.9],m:["中",1],l:["大",1.2]};
let scaleKey="m";
try{const k=localStorage.getItem("ui");if(SCALES[k])scaleKey=k;}catch{}
const applyScale=()=>document.documentElement.style.setProperty("--zoom",String(SCALES[scaleKey][1]));
function renderSet(){
  const v=$("v-set");v.replaceChildren();
  const w=el("section",{class:"win","aria-label":"設定"});
  w.append(winBar("⚙ SETTINGS.EXE",[el("span",{class:"wb dec","aria-hidden":"true",text:"_"}),el("span",{class:"wb dec","aria-hidden":"true",text:"×"})]));
  const seg=el("div",{class:"seg",role:"group","aria-label":"介面大小"});
  Object.entries(SCALES).forEach(([k,[name]])=>seg.append(el("button",{class:"px-btn",type:"button","aria-pressed":String(k===scaleKey),text:name,
    onclick:()=>{scaleKey=k;try{localStorage.setItem("ui",k);}catch{}applyScale();renderSet();}})));
  w.append(el("div",{class:"body"},el("h2",{class:"h2",text:"介面大小"}),seg,
    el("h2",{class:"h2",text:"Google API Key"}),el("p",{class:"mu",text:"AI 判定造物時使用你自己的 Key；也可以按右上角的 ⚙。"}),
    el("button",{class:"px-btn",type:"button",text:"開啟 API 設定",onclick:()=>$("settings").showModal()})));
  v.append(w);
}
// ---------- 分頁 ----------
const VIEWS={trade:"v-trade",bank:"v-bank",work:"v-work",set:"v-set"},HASH={trade:"",bank:"#bank",work:"#work",set:"#settings"};
function setView(v){
  if(!VIEWS[v])v="trade";view=v;
  for(const [k,id] of Object.entries(VIEWS))$(id).hidden=k!==v;
  document.querySelectorAll(".nav-item").forEach(b=>{if(b.dataset.v===v)b.setAttribute("aria-current","page");else b.removeAttribute("aria-current");});
  try{history.replaceState(null,"",location.pathname+location.search+HASH[v]);}catch{}
  render();window.scrollTo(0,0);
}
function render(){
  if(hinting)$("msg").textContent=!user?"請先登入 Google，並連結《無限煉製》帳號":!token?"再連結《無限煉製》帳號，就能投入造物與使用銀行":view==="bank"?"借來的錢可以拿去買股票，但利息一直在滾，記得還款":view==="trade"?"選一個 24 小時內做出的造物，再到想影響的股票視窗按「投入造物」":"";
  renderStrip();
  if(view==="trade"){renderCraft();renderMarket();}
  else if(view==="bank")updateBank();
  else if(view==="work")renderWork();
  else renderSet();
}
function wireNav(){
  const dr=$("drawer");
  $("menu").onclick=()=>dr.showModal();$("dclose").onclick=()=>dr.close();
  dr.addEventListener("click",e=>{if(e.target===dr)dr.close();});
  dr.querySelectorAll(".nav-item").forEach(b=>b.onclick=()=>{dr.close();setView(b.dataset.v);});
  setInterval(()=>{if(view==="bank"&&document.activeElement!==bk.amt){renderStrip();updateBank();}},5000);
}
function renderFeed(rows){
  const f=$("feed");f.replaceChildren();
  if(!rows.length)f.append(el("div",{class:"mu",text:"還沒有人投入造物"}));
  rows.forEach(x=>{const t=x.at?.toDate?.();const hm=t?t.toLocaleTimeString("zh-TW",{hour:"2-digit",minute:"2-digit",hour12:false}):"";
    f.append(el("div",{class:x.pct>0?"up":"dn"},el("span",{class:"tm",text:hm}),
      document.createTextNode(`${x.who} 將「${x.item}」投入 ${x.stock}：${x.score}分，${x.pct>0?"+":""}${x.pct}%${x.up!=null?"（上漲機率 "+x.up+"%）":""}`)));});
}
function wireSettings(){
  const dlg=$("settings"),k=$("gkey"),upd=()=>{$("keystate").textContent=S.getItem("gk")?"✓ 已設定（只存在這個分頁）":"尚未設定";};
  k.value=S.getItem("gk")||"";$("model").textContent=CFG.modelLabel;upd();
  $("gear").onclick=()=>dlg.showModal();
  $("close").onclick=()=>dlg.close();
  dlg.addEventListener("click",e=>{if(e.target===dlg)dlg.close();});
  k.onchange=()=>{S.setItem("gk",k.value.trim());upd();};
  $("clearkey").onclick=()=>{S.removeItem("gk");k.value="";upd();};
}

// ---------- 啟動 ----------
async function main(){
  applyScale();wireSettings();wireNav();
  setView({"#bank":"bank","#work":"work","#settings":"set"}[location.hash]||"trade");
  if([CFG.firebase.apiKey,CFG.ia.clientId,CFG.api].some(v=>/REPLACE_ME/.test(v))){say("請先在 config.js 填入 Firebase、Client ID 與 Worker 網址");return;}
  const app=initializeApp(CFG.firebase);db=getFirestore(app);
  auth=getAuth(app);getRedirectResult(auth).catch(e=>say("Google 登入失敗："+e.code));
  onAuthStateChanged(auth,u=>{user=u;render();});
  await handleCallback();
  onSnapshot(doc(db,"market","state"),snap=>{
    if(!snap.exists()){fetch(CFG.api+"/ensure-market",{method:"POST"}).catch(()=>{});return;}
    stocks=snap.data().stocks||{};render();});
  onSnapshot(query(collection(db,"feed"),orderBy("at","desc"),limit(15)),snap=>{const rows=[];snap.forEach(d=>rows.push(d.data()));renderFeed(rows);});
  if(token)loadIA().then(render).catch(e=>say(e.message));
}
main();
