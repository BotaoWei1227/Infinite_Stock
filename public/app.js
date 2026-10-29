import {CFG} from "./config.js";
import {initializeApp} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {getAuth,onAuthStateChanged,GoogleAuthProvider,signInWithPopup,signInWithRedirect,getRedirectResult,signOut} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {createMono} from "./mono.js";
import {getFirestore,collection,doc,onSnapshot,query,orderBy,limit} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const REDIRECT=location.origin+location.pathname; // 必須與 Developer Center 的 Redirect URI 完全一致
const $=id=>document.getElementById(id),S=sessionStorage;
const K=(()=>{   // Google API Key：存在這台裝置的瀏覽器（localStorage），下次不用重打；無痕模式等用不了時退回只存這個分頁
  let ls=null;try{localStorage.setItem("_t","1");localStorage.removeItem("_t");ls=localStorage;}catch{}
  try{if(ls){const old=S.getItem("gk");if(old&&!ls.getItem("gk")){ls.setItem("gk",old);S.removeItem("gk");}}}catch{}   // 舊版把 Key 放在分頁裡 → 自動搬到本機
  return {
    persistent:!!ls,
    getItem:k=>(ls&&ls.getItem(k))||S.getItem(k),
    setItem:(k,v)=>{(ls||S).setItem(k,v);if(ls)S.removeItem(k);},
    removeItem:k=>{if(ls)ls.removeItem(k);S.removeItem(k);}
  };
})();
const fmt=n=>(Math.round(n*100)/100).toFixed(2);
const prisonLeft=until=>hmLeft(until-Date.now());
let hinting=true;
const say=t=>{hinting=false;$("msg").textContent=t;};
let db,auth,user=null,me={cash:CFG.startCash,hold:{},name:"訪客"},stocks={},dailyTasks={date:"",tasks:{}},token=null,inv=[],item=null,profile=null,busy=false,offP=null,collapsed=new Set(),view="trade",bankBuilt=false,isDev=false,devText="",odds=null,skew=0,newsList=[],newsErr=false,nf=null,oddsTick=0,analystReport=null,analystStock="",tradeShares=1,marketOpenPrev=null,gameSettings={loanRate:.05,demRate:.004,tdRate:.012,threshold:70},settingsSyncedAt=0;

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
}
const okUrl=u=>{try{return new URL(u).protocol==="https:"?u:null}catch{return null}};
const icon=(e,url)=>{const s=document.createElement("span"),u=okUrl(url);s.textContent=e||"❔";
  if(u){const i=new Image();i.className="ic";i.alt="";i.loading="lazy";i.src=u;i.onload=()=>s.replaceChildren(i);}return s;};

const left=at=>{const m=Math.max(0,Math.floor((864e5-(Date.now()-at))/6e4));return m>=60?Math.floor(m/60)+" 小時":m+" 分";};
const usedBefore=name=>{const u=me.used||{};return Object.hasOwn(u,"n:"+String(name).normalize("NFKC").trim().toLowerCase())||Object.hasOwn(u,name);};   // 同一個造物只能投入一次
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
function logoutIA(){token=null;inv=[];item=null;profile=null;render();}

// ---------- 伺服器端行動（Worker 驗證 IA 身分並計算行情） ----------
async function act(name,data){
  if(busy)return null;if(!user){say("請先以 Google 帳號登入");return null;}if(name==="inject"&&!token&&!isDev){say("投入造物需要先連結《無限煉製》帳號");return null;}
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
const REL={direct:"直接相關",strong:"高度相關",weak:"勉強相關",none:"無關"};
async function inject(id){
  if(!token&&!isDev)return say("投入造物需要先連結《無限煉製》帳號（買賣與銀行不用）");
  const typed=isDev?devText.trim():"",itemName=typed||item?.name;
  if(!itemName)return say(isDev?"請選擇造物，或在上方輸入造物名稱":"請先選擇要投入的造物");
  if(!K.getItem("gk")){say("請先到右上角 ⚙ 設定 Google API Key");$("settings").showModal?.();return;}
  const r=await act("inject",{stockId:id,itemName,geminiKey:K.getItem("gk")});
  if(r){item=null;say(`相似度 ${r.score}${REL[r.relation]?"（"+REL[r.relation]+"）":""}：${r.reason}｜${r.pass?`超過門檻 ${r.threshold}，提高`:`沒超過門檻 ${r.threshold}，降低`}${stocks[id]?.name||""}的上漲機率${r.up!=null?`（現在 ${r.up}%・僅開發者可見）`:""}`);render();}
}
const trade=async(id,dir)=>{const shares=tradeShares,r=await act("trade",{stockId:id,dir,shares});if(r){me={...me,cash:r.cash,hold:r.hold};say(`已${dir>0?"買入":"賣出"} ${shares} 股${stocks[id]?.name||""}`);render();}};
// 上漲機率只有開發者看得到：資料放在伺服器的私密文件，開發者才能用 /odds 取得（一般玩家的瀏覽器裡根本沒有這些資料）
const DECAY_MS=3e5,DECAY=.9;   // 機率提升每 5 分鐘只剩 90%（須與伺服器 worker/src/logic.js 一致）
const nowS=()=>Date.now()+skew;
const effOddsC=rec=>{if(!rec||!rec.v)return 0;const e=rec.v*Math.pow(DECAY,Math.max(0,nowS()-rec.at)/DECAY_MS);return Math.abs(e)<.005?0:e;};
const shiftC=id=>{let x=0;for(const e of odds?.events||[])if(e.until>nowS())x+=(e.shift&&e.shift[id])||0;return x;};
const upPct=id=>Math.round(Math.min(.9,Math.max(.1,.5+effOddsC(odds?.bias?.[id])+shiftC(id)))*100);
function refreshGauges(){   // 兩次更新之間，機率條也會慢慢回到 50%
  if(!isDev||!odds)return;
  document.querySelectorAll(".gi").forEach(i=>{i.style.width=upPct(i.dataset.id)+"%";});
  document.querySelectorAll(".gp").forEach(b=>{b.textContent=upPct(b.dataset.id)+"%";});
}
async function fetchOdds(){
  if(!isDev||!user)return;
  try{
    const r=await fetch(CFG.api+"/odds",{method:"POST",headers:{Authorization:"Bearer "+await user.getIdToken()}});
    if(!r.ok)return;
    const j=await r.json();odds=j;skew=j.now-Date.now();render();
  }catch{}
}
const DAYMS=864e5,MOB_LIMIT=100,BAIL=80;
// 存款（須與伺服器 worker/src/logic.js 一致）：活存日利率 0.4%；定存日利率 1.2%、鎖 3 天，到期自動轉入活存
const TD_DAYS=3;
const grow=(r,ms)=>Math.pow(1+r,Math.max(0,ms)/DAYMS);
const demValueC=(dem,now)=>dem&&dem.a>0?dem.a*grow(gameSettings.demRate,now-dem.t):0;
const tdEndC=td=>td.t+TD_DAYS*DAYMS;
const tdValueC=(td,now)=>td.p*grow(gameSettings.tdRate,Math.min(now,tdEndC(td))-td.t);
function settleC(d,now){
  let dem=d.dem&&d.dem.a>0?{a:d.dem.a,t:d.dem.t}:{a:0,t:now};const live=[],done=[];
  for(const td of d.tds||[])(tdEndC(td)<=now?done:live).push(td);
  done.sort((x,y)=>tdEndC(x)-tdEndC(y));
  for(const td of done){const T=tdEndC(td);dem={a:demValueC(dem,T)+tdValueC(td,T),t:T};}
  return {dem:{a:demValueC(dem,now),t:now},tds:live};
}
const depositsNow=()=>{const n=Date.now(),s=settleC(me,n);return s.dem.a+s.tds.reduce((a,t)=>a+tdValueC(t,n),0);};
const overAtClient=()=>{const l=me.loan;if(!l||!(l.p>0))return null;if(owedNow()<=MOB_LIMIT)return null;if(l.over!=null)return l.over;if(l.p>=MOB_LIMIT)return l.t;return l.t+DAYMS*Math.log(MOB_LIMIT/l.p)/Math.log(1+gameSettings.loanRate);};
const mobDueClient=()=>{const o=overAtClient();return o!=null&&Date.now()-o>=DAYMS;};
const hmLeft=ms=>{const m=Math.max(0,Math.ceil(ms/6e4));return m>=60?Math.floor(m/60)+" 小時 "+(m%60)+" 分":m+" 分";};
let checking=false;
async function syncGameSettings(){if(!user||Date.now()-settingsSyncedAt<60000)return;settingsSyncedAt=Date.now();try{const r=await fetch(CFG.api+"/whoami",{method:"POST",headers:{Authorization:"Bearer "+await user.getIdToken()}});if(!r.ok)return;const j=await r.json(),next={...gameSettings,...j.settings};if(JSON.stringify(next)!==JSON.stringify(gameSettings)){isDev=!!j.dev;gameSettings=next;bankBuilt=false;render();}}catch{}}
function checkMob(){if(checking||!user||!mobDueClient())return;checking=true;act("bank",{action:"check"}).finally(()=>{checking=false;});}
const owedNow=()=>{const l=me.loan;return l&&l.p>0?l.p*Math.pow(1+gameSettings.loanRate,Math.max(0,Date.now()-l.t)/DAYMS):0;};
const net=()=>me.cash+(me.mprop||0)+Object.entries(me.hold||{}).reduce((a,[k,n])=>a+n*(stocks[k]?.price||0),0)-owedNow()+depositsNow();
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
  const pt=i=>X(i).toFixed(1)+","+Y(pts[i]).toFixed(1),runs=[];let run=null;
  for(let i=1;i<n;i++){ // 連續同方向的線段合成一條；持平沿用前一段的顏色
    const dir=pts[i]>pts[i-1]?1:pts[i]<pts[i-1]?-1:(run?run.dir:1);
    if(!run||run.dir!==dir){run={dir,p:[pt(i-1)]};runs.push(run);}
    run.p.push(pt(i));
  }
  runs.forEach(r=>{const ln=document.createElementNS(NS,"polyline");ln.setAttribute("points",r.p.join(" "));ln.setAttribute("class","ln "+(r.dir>0?"up":"dn"));svg.append(ln);});
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
    chip(!!token,token?"工坊："+(profile?.workshopName||"已連結"):"連結《無限煉製》帳號",()=>{if(token){if(confirm("中斷《無限煉製》連線？"))logoutIA();}else login();}),
    el("div",{class:"stat"},el("span",{class:"k",text:"現金 "}),el("b",{text:fmt(me.cash)}),el("span",{class:"k",text:"　淨資產 "}),el("b",{text:fmt(net())})),
    ...(me.jailUntil>Date.now()?[el("div",{class:"cell debt",text:"⛓ 服刑中・剩 "+prisonLeft(me.jailUntil)})]:[]));
}
let craftSig="";
function renderCraft(){
  const sig=JSON.stringify([!!token,isDev,inv.map(x=>x.name),Object.keys(me.used||{}),item&&item.name,busy]);
  if(sig===craftSig)return;craftSig=sig;
  const w=$("craft");w.replaceChildren(winBar("📦 CREATION.EXE",[el("span",{class:"wb dec","aria-hidden":"true",text:"_"}),el("span",{class:"wb dec","aria-hidden":"true",text:"×"})]));
  const b=el("div",{class:"body"});
  if(!token&&!isDev){b.append(el("p",{class:"mu",text:"先連結《無限煉製》帳號，才能挑選 24 小時內做出的造物來投入。"}));}
  if(token){
    const sel=el("select",{class:"px-sel","aria-label":"選擇要投入的造物"});
    sel.append(new Option(inv.length?"▼ 選擇 24 小時內做出的造物":"24 小時內沒有新做出的造物",""));
    inv.forEach((x,i)=>{const u=usedBefore(x.name),o=new Option(`${x.name}（${u?"已投入過":"剩 "+left(x.at)}）`,String(i));o.disabled=!!u;sel.append(o);});
    sel.value=item&&inv.includes(item)&&!usedBefore(item.name)?String(inv.indexOf(item)):"";
    sel.onchange=()=>{item=inv[sel.value]||null;};
    b.append(sel,el("p",{class:"mu",text:"每個造物只能投入一次，不能重複；選好後，到想影響的股票視窗按「投入造物」。"}));
  }
  if(isDev)b.append(el("label",{class:"lbl",for:"devitem",text:"🛠 開發者：自己打字輸入造物（有填就優先使用，不需要連結《無限煉製》）"}),
    el("input",{class:"px-in",id:"devitem",type:"text",maxlength:"60",autocomplete:"off",placeholder:"例如：蒸氣龍",value:devText,oninput:e=>{devText=e.target.value;}}));
  w.append(b);
}
function renderMarket(){
  const mk=$("market");mk.replaceChildren();
  // 自訂股數：直接輸入 1～100000 的整數，或點快速按鈕。輸入時只更新按鈕文字，不重畫整個市場（避免手機鍵盤收起）
  const qty=el("input",{class:"px-in qty-in",id:"qty",type:"number",inputmode:"numeric",min:"1",max:"100000",step:"1","aria-label":"每次交易股數",value:String(tradeShares)});
  const setQty=n=>{tradeShares=n;document.querySelectorAll(".buy-btn").forEach(b=>b.textContent=`買 ${n}`);document.querySelectorAll(".sell-btn").forEach(b=>b.textContent=`賣 ${n}`);};
  qty.oninput=()=>{const n=Math.floor(Number(qty.value));if(Number.isFinite(n)&&n>=1&&n<=100000)setQty(n);};
  qty.onblur=()=>{qty.value=String(tradeShares);};
  mk.append(el("div",{class:"trade-quantity"},el("label",{class:"lbl",for:"qty",text:"每次買賣股數"}),qty,
    ...[1,10,100,1000].map(n=>el("button",{class:"px-btn qty-q",type:"button",text:String(n),onclick:()=>{qty.value=String(n);setQty(n);}}))));
  const ids=Object.keys(stocks).sort();
  if(!ids.length){mk.append(el("p",{class:"mu",text:"行情載入中…"}));return;}
  for(const id of ids){
    const s=stocks[id],task=dailyTasks.date===taipeiDate()?dailyTasks.tasks?.[id]:null,open=!collapsed.has(id),first=(s.p&&s.p[0])||s.price,ch=(s.price/first-1)*100,chTxt=(ch>=0?"+":"")+ch.toFixed(2)+"%";
    const n=me.hold?.[id]||0;
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
      ...(task?[el("div",{class:"daily-task"},el("b",{text:"今日指定造物："+task.item}),el("span",{text:task.description}))]:[]),
      ...(isDev&&odds?[el("div",{class:"meter"},el("span",{class:"k",text:"上漲機率 🔒"}),el("div",{class:"gauge","aria-hidden":"true"},el("i",{class:"gi","data-id":id,style:`width:${upPct(id)}%`})),el("b",{class:"gp","data-id":id,text:upPct(id)+"%"}))]:[]),
      el("div",{class:"mu",text:`持有 ${n} 股${s.last?"｜上次投入："+s.last:""}`}),
      el("div",{class:"acts"},
        el("button",{class:"px-btn buy-btn",type:"button",disabled:busy,text:`買 ${tradeShares}`,onclick:()=>trade(id,1)}),
        el("button",{class:"px-btn sell-btn",type:"button",disabled:busy,text:`賣 ${tradeShares}`,onclick:()=>trade(id,-1)}),
        el("button",{class:"px-btn pri",type:"button",disabled:busy,text:"投入造物",onclick:()=>inject(id)})));
    w.append(b);mk.append(w);
  }
}

// ---------- 財經新聞 ----------
// 玩家只看得到：名稱、內容、時間、普發現金。活動對機率的影響只有開發者看得到。
// 跑馬燈：新聞發布後 TICKER_MS 內、活動還沒結束，就在頁面最上方滾動顯示標題；點一下進財經新聞
const TICKER_MS=3*36e5;let tickSig="";
function renderTicker(){
  const t=$("ticker");if(!t)return;
  const now=nowS(),items=newsList.filter(n=>{const at=n.at?.toMillis?.()??Number(n.at);return Number.isFinite(at)&&at<=now+6e4&&now-at<TICKER_MS&&n.endsAt>now;}).map(n=>n.title).filter(Boolean);
  const sig=items.join("\u0001");if(sig===tickSig)return;tickSig=sig;
  t.hidden=!items.length;if(!items.length){t.replaceChildren();return;}
  const text="📰 快訊　"+items.join("　★　")+"　　　";
  const track=el("div",{class:"tk-track"},el("span",{class:"tk-item",text}),el("span",{class:"tk-item","aria-hidden":"true",text}));
  track.style.animationDuration=Math.max(14,[...text].length*.45)+"s";
  t.replaceChildren(el("button",{type:"button",class:"tk-btn","aria-label":"財經快訊："+items.join("、")+"。點一下看財經新聞",onclick:()=>setView("news")},track));
}
function newsTime(n){const t=n.at?.toDate?.();return t?t.toLocaleString("zh-TW",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false}):"";}
const taipeiInputEpoch=v=>{const m=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/.exec(v||"");return m?Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5])-8*3600000:0;};
const taipeiTimeLabel=ms=>new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(ms));
const taipeiDate=()=>{const p=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;};
const marketOpenClient=()=>Number(new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Taipei",hour:"2-digit",hourCycle:"h23"}).format(new Date()))>=9;
const fxText=e=>Object.entries(e.shift||{}).map(([id,x])=>`${stocks[id]?.name||id} ${x>0?"+":"−"}${Math.round(Math.abs(x)*100)}`).join("、");
function updateNewsTimes(){document.querySelectorAll(".ntime").forEach(s=>{const left=Number(s.dataset.end)-nowS();s.textContent=left>0?"進行中・剩 "+hmLeft(left):"已結束";});}
function newsWin(n){
  const active=n.endsAt>nowS(),claimed=!!(me.claims&&Object.hasOwn(me.claims,n.id)),ev=(odds?.events||[]).find(e=>e.id===n.id);
  const w=el("section",{class:"win news"+(active?"":" ended"),"aria-label":n.title});
  w.append(winBar("📰 "+n.title,[el("span",{class:"wb dec","aria-hidden":"true",text:"_"}),el("span",{class:"wb dec","aria-hidden":"true",text:"×"})]));
  const b=el("div",{class:"body"});
  b.append(el("div",{class:"meta"},document.createTextNode(`${newsTime(n)}　`),el("span",{class:"ntime","data-end":String(n.endsAt),text:active?"進行中":"已結束"})));
  if(n.body)b.append(el("div",{class:"nbody",text:n.body}));
  if(n.cash>0)b.append(el("div",{class:"cash"},el("span",{text:`💰 普發現金：每人 ${fmt(n.cash)}`}),
    claimed?el("b",{class:"mu",text:"✓ 已領取"}):active?el("button",{class:"px-btn pri",type:"button",disabled:busy,text:"領取",onclick:()=>claimCash(n)}):el("span",{class:"mu",text:"已結束"})));
  if(isDev){
    if(ev)b.append(el("div",{class:"fxinfo",text:`🔒 活動影響（只有你看得到）：${fxText(ev)}`}));
    if(active)b.append(el("button",{class:"px-btn sm",type:"button",disabled:busy,text:"提前結束活動",onclick:()=>endNews(n)}));
  }
  w.append(b);return w;
}
async function claimCash(n){const r=await act("news",{action:"claim",id:n.id});if(r)say(`已領取普發現金 ${fmt(r.amount)}`);}
async function endNews(n){if(!confirm(`提前結束「${n.title}」？活動的機率影響會立刻消失。`))return;const r=await act("news",{action:"end",id:n.id});if(r){say("已提前結束活動");fetchOdds();}}
let newsSig="";
function renderNews(){
  const form=$("nform");
  if(isDev&&!form.firstChild){buildNewsForm(form);buildDeveloperGameSettings(form);}
  if(!isDev&&form.firstChild){form.replaceChildren();nf=null;}
  if(nf)syncEffRows();
  const sig=JSON.stringify([newsList.map(n=>[n.id,n.endsAt>nowS(),!!(me.claims&&Object.hasOwn(me.claims,n.id))]),isDev,(odds?.events||[]).map(e=>e.id),newsErr,busy,!!user]);
  const list=$("nlist");
  if(sig!==newsSig){
    newsSig=sig;list.replaceChildren();
    if(newsErr)list.append(el("p",{class:"warn",text:"新聞載入失敗。請確認 Firestore 規則已更新（需要允許讀取 news 集合）。"}));
    else if(!newsList.length)list.append(el("p",{class:"mu",text:"目前沒有任何新聞。"}));
    newsList.forEach(n=>list.append(newsWin(n)));
  }
  updateNewsTimes();
}
// 開發者發布表單：只建一次，不會因為行情更新而被清掉正在輸入的內容
function buildNewsForm(host){
  nf={title:el("input",{class:"px-in",id:"ntitle",maxlength:"40",placeholder:"活動名稱（最多 40 字）","aria-label":"活動名稱"}),
    body:el("textarea",{class:"px-in",id:"nbody",rows:"4",maxlength:"600",placeholder:"活動資料（可留空；只寫文字也行，例如前情公告）","aria-label":"活動資料"}),
    dur:el("input",{class:"px-in",id:"ndur",type:"number",inputmode:"decimal",min:"1",value:"1","aria-label":"活動持續時間"}),
    unit:el("select",{class:"px-sel","aria-label":"時間單位"},new Option("分鐘","1"),new Option("小時","60"),new Option("天","1440")),
    cash:el("input",{class:"px-in",id:"ncash",type:"number",inputmode:"decimal",min:"0",step:"0.01",placeholder:"0（不發就留空）","aria-label":"普發現金"}),
    when:el("input",{class:"px-in",id:"nwhen",type:"datetime-local","aria-label":"台北時間預定發布時間"}),
    box:el("div"),scheduledHost:el("div"),eff:{},sig:""};
  nf.unit.value="60";
  const w=el("section",{class:"win","aria-label":"發布活動"});
  w.append(winBar("🛠 PUBLISH.EXE",[el("span",{class:"wb dec","aria-hidden":"true",text:"_"}),el("span",{class:"wb dec","aria-hidden":"true",text:"×"})]));
  w.append(el("div",{class:"body"},
    el("p",{class:"mu",text:"只有開發者看得到這個表單。活動影響與機率只有你看得到，玩家只會看到名稱、內容、時間與現金。"}),
    el("label",{class:"lbl",for:"ntitle",text:"活動名稱"}),nf.title,
    el("label",{class:"lbl",for:"nbody",text:"活動資料"}),nf.body,
    el("label",{class:"lbl",for:"nwhen",text:"預定發布時間（台北時間；留空代表立即發布）"}),nf.when,
    el("label",{class:"lbl",for:"ndur",text:"活動持續時間"}),el("div",{class:"unit"},nf.dur,nf.unit),
    el("h2",{class:"h2",text:"活動影響（可個別選擇）"}),
    el("p",{class:"mu",text:"活動期間，把該股票「上漲的基準機率」改成 50+x（漲）或 50−x（跌）；x 是 1～40 的整數。不選＝不影響。"}),
    nf.box,
    el("label",{class:"lbl",for:"ncash",text:"普發現金（每位玩家領一次，活動期間內有效）"}),nf.cash,
    el("div",{class:"row"},el("button",{class:"px-btn pri",type:"button",text:"發布／排程活動",onclick:publishNews})),
    el("h2",{class:"h2",text:"待發布新聞"}),nf.scheduledHost));
  host.append(w);syncEffRows();loadScheduledNews();
}
function buildDeveloperGameSettings(host){
  const input=(id,label,value)=>{const field=el("input",{class:"px-in",type:"number",min:"0",max:"100",step:"0.1",value:String(value),id,"aria-label":label});return [el("label",{class:"lbl",for:id,text:label}),field];};
  const [loanLabel,loan]=input("cfg-loan","借款日利率（%）",gameSettings.loanRate*100),[demLabel,dem]=input("cfg-dem","活存日利率（%）",gameSettings.demRate*100),[tdLabel,td]=input("cfg-td","定存日利率（%）",gameSettings.tdRate*100);
  const [thLabel,th]=input("cfg-threshold","造物相似度門檻（%）",gameSettings.threshold);th.step="1";
  const section=el("section",{class:"win","aria-label":"開發者遊戲設定"});
  section.append(winBar("⚙ GAME SETTINGS.EXE"),el("div",{class:"body"},el("p",{class:"mu",text:"僅開發者可見。利率以日為單位連續複利；造物門檻為 1–99 的整數百分比。"}),loanLabel,loan,demLabel,dem,tdLabel,td,thLabel,th,
    el("button",{class:"px-btn pri",type:"button",text:"儲存遊戲設定",disabled:busy,onclick:async()=>{const r=await act("admin-settings",{action:"save",loanRate:Number(loan.value),demRate:Number(dem.value),tdRate:Number(td.value),threshold:Number(th.value)});if(r){gameSettings=r.settings;bankBuilt=false;say("遊戲設定已更新");}}})));
  host.append(section);
}
async function loadScheduledNews(){
  if(!isDev||!user||!nf?.scheduledHost)return;
  const host=nf.scheduledHost;host.replaceChildren(el("p",{class:"mu",text:"載入預定新聞…"}));
  try{const r=await fetch(CFG.api+"/news",{method:"POST",headers:{Authorization:"Bearer "+await user.getIdToken(),"Content-Type":"application/json"},body:JSON.stringify({action:"list-scheduled"})}),j=await r.json();if(!r.ok)throw Error(j.error?.message||"載入失敗");
    host.replaceChildren();if(!j.scheduled.length){host.append(el("p",{class:"mu",text:"沒有預定發布的新聞。"}));return;}
    const ul=el("ul",{class:"list"});j.scheduled.forEach(n=>ul.append(el("li",{},el("span",{text:taipeiTimeLabel(n.scheduledAt)+"　"+n.title}),el("button",{class:"px-btn sm",type:"button",text:"取消",onclick:async()=>{const z=await act("news",{action:"cancel-scheduled",id:n.id});if(z){say("已取消預定新聞");loadScheduledNews();}}}))));host.append(ul);
  }catch(e){host.replaceChildren(el("p",{class:"warn",text:"預定新聞載入失敗："+e.message}));}
}
function syncEffRows(){
  const ids=Object.keys(stocks).sort(),sig=ids.join(",");
  if(sig===nf.sig)return;nf.sig=sig;nf.box.replaceChildren();
  for(const id of ids){
    const sel=el("select",{class:"px-sel","aria-label":`${stocks[id].name} 的影響`},new Option("— 無","0"),new Option("▲ 漲 +x","1"),new Option("▼ 跌 −x","-1"));
    const num=el("input",{class:"px-in",type:"number",inputmode:"numeric",min:"1",max:"40",step:"1",value:"10",disabled:true,"aria-label":`${stocks[id].name} 的 x（百分點）`});
    sel.onchange=()=>{num.disabled=sel.value==="0";};
    nf.eff[id]={sel,num};nf.box.append(el("div",{class:"fx"},el("span",{text:`${stocks[id].emoji} ${stocks[id].name}`}),sel,num));
  }
}
async function publishNews(){
  const title=nf.title.value.trim(),mins=parseFloat(nf.dur.value)*parseFloat(nf.unit.value),cash=parseFloat(nf.cash.value)||0,effects={},scheduledAt=nf.when.value?taipeiInputEpoch(nf.when.value):undefined;
  if(!title)return say("請輸入活動名稱");
  if(!(mins>=1))return say("請輸入活動持續時間");
  for(const [id,c] of Object.entries(nf.eff)){const dir=Number(c.sel.value);if(!dir)continue;const x=parseInt(c.num.value);if(!(x>=1&&x<=40))return say("活動影響的 x 要是 1～40 的整數");effects[id]=dir*x;}
  const r=await act("news",{action:"publish",title,body:nf.body.value,durationMin:mins,effects,cash,scheduledAt});
  if(r){say(r.scheduled?`已排定「${title}」於 ${taipeiTimeLabel(r.scheduledAt)} 發布`:`已發布活動「${title}」`);nf.title.value="";nf.body.value="";nf.cash.value="";nf.when.value="";nf.dur.value="1";nf.unit.value="60";for(const c of Object.values(nf.eff)){c.sel.value="0";c.num.disabled=true;c.num.value="10";}fetchOdds();loadScheduledNews();}
}
// ---------- 銀行 ----------
const bk={},sv={};
function buildBank(){
  const v=$("v-bank");v.replaceChildren();
  const w=el("section",{class:"win","aria-label":"銀行"});
  w.append(winBar("🏦 BANK.EXE",[el("span",{class:"wb dec","aria-hidden":"true",text:"_"}),el("span",{class:"wb dec","aria-hidden":"true",text:"×"})]));
  const b=el("div",{class:"body"});
  const hr=((Math.pow(1+gameSettings.loanRate,1/24)-1)*100).toFixed(2);
  bk.owed=el("b");bk.cash=el("b");bk.mob=el("b");bk.next=el("b");bk.times=el("p",{class:"mu"});
  bk.amt=el("input",{class:"px-in",type:"number",inputmode:"decimal",min:"0.01",step:"0.01",placeholder:"金額",id:"bamt","aria-label":"金額"});
  bk.b1=el("button",{class:"px-btn pri",type:"button",text:"借款",onclick:()=>{const a=parseFloat(bk.amt.value);if(!(a>0))return say("請輸入金額");bankAct("borrow",a).then(r=>{if(r)bk.amt.value="";});}});
  bk.b2=el("button",{class:"px-btn",type:"button",text:"還款",onclick:()=>{const a=parseFloat(bk.amt.value);if(!(a>0))return say("請輸入金額");bankAct("repay",a).then(r=>{if(r)bk.amt.value="";});}});
  bk.b3=el("button",{class:"px-btn",type:"button",text:"全額還清",onclick:()=>bankAct("repay",0,true)});
  bk.bail=el("div",{class:"bailbox",hidden:true},
    el("p",{class:"hot",text:`⛓ 你正在服刑。可以借 ${fmt(BAIL)} 的保釋貸款立刻出獄：這筆錢不會進你的口袋，直接成為欠款（照一般貸款利率滾利，欠款超過 ${MOB_LIMIT} 並拖過 24 小時黑道還是會上門）。`}),
    el("button",{class:"px-btn pri",type:"button",text:"借貸保釋",onclick:async()=>{if(!confirm(`借 ${fmt(BAIL)} 保釋貸款並出獄？這筆錢會計入欠款。`))return;const r=await act("bank",{action:"bail"});if(r)say(`已保釋出獄，目前欠款 ${fmt(r.owed)}`);}}));
  b.append(
    el("p",{class:"mu",text:`高利貸：利率 ${(gameSettings.loanRate*100).toFixed(2)}%／24 小時（約每小時 ${hr}%，利息持續複利累計），想借多少都行。`}),
    el("div",{class:"grid"},
      el("div",{class:"cell debt"},el("span",{class:"k",text:"目前欠款"}),bk.owed),el("div",{class:"cell"},el("span",{class:"k",text:"現金"}),bk.cash),
      el("div",{class:"cell"},el("span",{class:"k",text:"黑道上門倒數"}),bk.mob),el("div",{class:"cell debt"},el("span",{class:"k",text:"24 小時後欠款"}),bk.next)),
    bk.bail,el("label",{class:"lbl",for:"bamt",text:"金額"}),bk.amt,el("div",{class:"row"},bk.b1,bk.b2,bk.b3),
    el("p",{class:"warn",text:`欠款會從淨值扣掉。欠款超過 ${MOB_LIMIT} 並連續超過 24 小時，黑道就會上門：資產清空，只能重新開始。借來的錢可以拿去買股票，但股價可能跌。`}),bk.times);
  w.append(b);v.append(w);buildSavings(v);bankBuilt=true;
}
async function depAct(action,{all=false,at}={}){
  const a=parseFloat(sv.amt.value),needs=["dem_in","dem_out","td_in"].includes(action)&&!all;
  if(needs&&!(a>0))return say("請輸入金額");
  if(action==="td_break"&&!confirm("提前解約只退回本金，利息會作廢，確定嗎？"))return;
  const r=await act("bank",{action,amount:needs?a:undefined,all,at});
  if(r){say({dem_in:`已存入活存 ${fmt(a)}`,dem_out:all?"已領出全部活存":`已領出活存 ${fmt(a)}`,td_in:`已存入定存 ${fmt(a)}（鎖 ${TD_DAYS} 天）`,td_break:"已提前解約，退回本金（利息作廢）"}[action]);
    if(action!=="td_break")sv.amt.value="";}
}
function buildSavings(v){
  const w=el("section",{class:"win","aria-label":"存款"});
  w.append(winBar("💰 SAVINGS.EXE",[el("span",{class:"wb dec","aria-hidden":"true",text:"_"}),el("span",{class:"wb dec","aria-hidden":"true",text:"×"})]));
  sv.dem=el("b");sv.td=el("b");sv.sum=el("b");sv.day=el("b");sv.list=el("ul",{class:"list"});sv.sig="";
  sv.amt=el("input",{class:"px-in",type:"number",inputmode:"decimal",min:"0.01",step:"0.01",placeholder:"金額",id:"samt","aria-label":"存款金額"});
  const btn=(label,action,extra,pri)=>el("button",{class:"px-btn"+(pri?" pri":""),type:"button",text:label,onclick:()=>depAct(action,extra)});
  sv.btns=[btn("存入活存","dem_in",{},true),btn("領出活存","dem_out"),btn("全部領出","dem_out",{all:true}),btn(`存入定存（${TD_DAYS} 天）`,"td_in")];
  w.append(el("div",{class:"body"},
    el("p",{class:"mu",text:`活存：日利率 ${gameSettings.demRate*100}%，隨時存取。定存：日利率 ${gameSettings.tdRate*100}%，鎖 ${TD_DAYS} 天，到期自動轉入活存；提前解約只退本金，利息作廢。`}),
    el("div",{class:"grid"},
      el("div",{class:"cell"},el("span",{class:"k",text:"活存餘額"}),sv.dem),el("div",{class:"cell"},el("span",{class:"k",text:"定存（含利息）"}),sv.td),
      el("div",{class:"cell"},el("span",{class:"k",text:"存款總額"}),sv.sum),el("div",{class:"cell"},el("span",{class:"k",text:"每日利息（估）"}),sv.day)),
    el("label",{class:"lbl",for:"samt",text:"金額"}),sv.amt,el("div",{class:"row"},...sv.btns),
    el("h2",{class:"h2",text:"定存明細"}),sv.list));
  v.append(w);
}
function updateSavings(){
  const now=Date.now(),s=settleC(me,now),tdv=s.tds.map(t=>tdValueC(t,now)),tdTotal=tdv.reduce((a,x)=>a+x,0);
  sv.dem.textContent=fmt(s.dem.a);sv.td.textContent=fmt(tdTotal);sv.sum.textContent=fmt(s.dem.a+tdTotal);sv.day.textContent=fmt(s.dem.a*gameSettings.demRate+tdTotal*gameSettings.tdRate);
  const sig=JSON.stringify(s.tds.map(t=>t.t));
  if(sig!==sv.sig){sv.sig=sig;sv.list.replaceChildren();sv.rows=s.tds.map(t=>{
    const span=el("span",{class:"mu"});
    sv.list.append(el("li",{},span,el("button",{class:"px-btn sm",type:"button",text:"提前解約","aria-label":"提前解約這筆定存，只退本金",onclick:()=>depAct("td_break",{at:t.t})})));
    return span;});
    if(!s.tds.length)sv.list.append(el("li",{},el("span",{class:"mu",text:"目前沒有定存"})));}
  s.tds.forEach((t,i)=>{sv.rows[i].textContent=`本金 ${fmt(t.p)}｜目前 ${fmt(tdv[i])}｜到期剩 ${hmLeft(tdEndC(t)-now)}`;});
  sv.btns.forEach(b=>{b.disabled=busy;});sv.list.querySelectorAll("button").forEach(b=>{b.disabled=busy;});
}
function updateBank(){
  if(!bankBuilt)buildBank();
  updateSavings();
  const o=owedNow();bk.owed.textContent=fmt(o);bk.cash.textContent=fmt(me.cash);
  bk.next.textContent=fmt(o*(1+gameSettings.loanRate));
  const ov=overAtClient(),left_=ov==null?0:ov+DAYMS-Date.now();
  bk.mob.textContent=ov==null?`安全（≤${MOB_LIMIT}）`:left_<=0?"⚠ 黑道已在門口":"⚠ "+hmLeft(left_);bk.mob.className=ov==null?"":"hot";
  bk.times.textContent=me.bankrupt>0?`你被黑道找上過 ${me.bankrupt} 次。`:"";
  bk.bail.hidden=!(me.jailUntil>Date.now());bk.b1.disabled=bk.b2.disabled=bk.b3.disabled=busy;bk.b2.disabled=busy||o<.005;bk.b3.disabled=busy||o<.005;
}
// ---------- 練金工坊 ----------
function renderWork(){
  const v=$("v-work");v.replaceChildren();
  const w=el("section",{class:"win","aria-label":"練金工坊"});
  w.append(winBar("⚗ WORKSHOP.EXE",[el("span",{class:"wb dec","aria-hidden":"true",text:"_"}),el("span",{class:"wb dec","aria-hidden":"true",text:"×"})]));
  const b=el("div",{class:"body"});
  b.append(el("p",{class:"warn",text:"這裡目前只讀取你在《無限煉製》的合成紀錄，列出 24 小時內做出的造物。代為合成需要官方提供的合成介面，尚未接上。"}));
  b.append(el("h2",{class:"h2",text:"你 24 小時內做出的造物"}));
  if(!token)b.append(el("p",{class:"mu",text:"連結《無限煉製》帳號後，這裡會列出你做出的造物，以及哪些還能投入股票。"}));
  else if(!inv.length)b.append(el("p",{class:"mu",text:"24 小時內沒有新做出的造物。到遊戲裡煉成新東西吧！"}));
  else{const ul=el("ul",{class:"list"});
    inv.forEach(x=>{const u=usedBefore(x.name);ul.append(el("li",{},el("span",{class:u?"off":"",text:x.name}),el("span",{class:"mu",text:u?"已投入過":"剩 "+left(x.at)+"・可投入"})));});
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
  const pname=el("input",{class:"px-in",maxlength:"20",placeholder:"輸入排行榜顯示名稱",value:me.customName||"",disabled:!user,"aria-label":"排行榜顯示名稱"});
  const saveName=el("button",{class:"px-btn pri",type:"button",text:"儲存名稱",disabled:!user,onclick:async()=>{const r=await act("profile",{name:pname.value});if(r){me.customName=r.name;say("排行榜名稱已更新");renderSet();}}});
  const body=el("div",{class:"body"},el("h2",{class:"h2",text:"玩家名稱"}),el("p",{class:"mu",text:user?"排行榜會顯示這個名稱；留空不允許。最多 20 字。":"登入後即可設定排行榜顯示名稱。"}),pname,saveName,
    el("h2",{class:"h2",text:"介面大小"}),seg,
    el("h2",{class:"h2",text:"Google API Key"}),el("p",{class:"mu",text:"AI 判定造物時使用你自己的 Key；也可以按右上角的 ⚙。"}),
    el("button",{class:"px-btn",type:"button",text:"開啟 API 設定",onclick:()=>$("settings").showModal()}));
  w.append(body);
  v.append(w);
}
// ---------- 分頁 ----------
const VIEWS={mono:"v-mono",trade:"v-trade",rank:"v-rank",black:"v-black",analyst:"v-analyst",news:"v-news",bank:"v-bank",work:"v-work",set:"v-set"},HASH={mono:"#mono",trade:"",rank:"#rank",black:"#black",analyst:"#analyst",news:"#news",bank:"#bank",work:"#work",set:"#settings"};
// 大富翁：只在進入大富翁畫面時才訂閱棋盤文件（省 Firestore 讀取額度）
let offMono=null;const mono=createMono({host:$("v-mono"),el,fmt,say,act,getMe:()=>me,getUser:()=>user,isBusy:()=>busy});
function monoSub(on){
  if(!on){offMono&&offMono();offMono=null;return;}
  if(offMono||!db)return;
  offMono=onSnapshot(doc(db,"monopoly","state"),snap=>{mono.update(snap.exists()?snap.data():{});if(!monoFocused&&user){monoFocused=true;setTimeout(()=>mono.focusMe(),50);}},()=>say("讀不到大富翁棋盤，請確認 Firestore 規則已開放 monopoly 集合"));
}
let monoFocused=false;
function setView(v){
  if(!VIEWS[v])v="trade";view=v;
  for(const [k,id] of Object.entries(VIEWS))$(id).hidden=k!==v;
  $("mode").textContent=v==="mono"?"📈":"🎲";$("mode").setAttribute("aria-label",v==="mono"?"回到股市":"切換到大富翁");monoSub(v==="mono");
  document.querySelectorAll(".nav-item").forEach(b=>{if(b.dataset.v===v)b.setAttribute("aria-current","page");else b.removeAttribute("aria-current");});
  try{history.replaceState(null,"",location.pathname+location.search+HASH[v]);}catch{}
  render();window.scrollTo(0,0);
}
function render(){
  renderTicker();
  const rule=document.querySelector(".rule");if(rule)rule.textContent=`股價會自己隨機漲跌。AI 會替造物評出與股票主題的相似度（0–100）：超過目前 ${gameSettings.threshold}% 門檻才算相關，會提高上漲機率；低於門檻會提高下跌機率（越接近門檻影響越小），效果會慢慢消退。每個造物只能投入一次，不能重複。買進會推升、賣出會壓低上漲機率，像真實市場的買賣壓力；每個人的影響都很小，人多才會明顯。`;
  if(hinting)$("msg").textContent=!user?"請先登入 Google 帳號，就能買賣股票與使用銀行":isDev&&view==="trade"?"開發者模式：可以在造物視窗直接打字輸入造物名稱":!token?"買賣與銀行可以直接玩；連結《無限煉製》帳號才能投入造物":view==="bank"?"借來的錢可以拿去買股票，但利息一直在滾，記得還款":view==="trade"?"選一個 24 小時內做出的造物，再到想影響的股票視窗按「投入造物」":"";
  if(me.jailUntil>Date.now())$("msg").textContent="你目前正在服刑，剩餘 "+prisonLeft(me.jailUntil)+"；服刑期間不能進行遊戲操作，但可以到銀行借貸保釋。";
  renderStrip();
  if(view==="trade"){
    const open=marketOpenClient();marketOpenPrev=open;$("shutter").hidden=open;$("craft").hidden=!open;$("market").hidden=!open;$("feed").closest(".win").hidden=!open;
    if(open){renderCraft();renderMarket();}
  }
  else if(view==="mono")mono.render();
  else if(view==="rank")renderRank();
  else if(view==="black")renderBlackmarket();
  else if(view==="analyst")renderAnalyst();
  else if(view==="news")renderNews();
  else if(view==="bank")updateBank();
  else if(view==="work")renderWork();
  else renderSet();
}
async function renderRank(){
  const host=$("ranklist");host.replaceChildren();
  if(!user){host.append(el("p",{class:"mu",text:"登入 Google 帳號後查看排行榜。"}));return;}
  host.append(el("p",{class:"mu",text:"富士比排行榜依淨資產排序（現金＋持股市值＋存款−欠款），顯示前 100 名。"}));
  try{const r=await fetch(CFG.api+"/leaderboard",{method:"POST",headers:{Authorization:"Bearer "+await user.getIdToken(),"Content-Type":"application/json"},body:"{}"}),j=await r.json();if(!r.ok)throw Error(j.error?.message||"載入失敗");
    const ol=el("ol",{class:"list"});j.rows.forEach((x,i)=>ol.append(el("li",{},el("span",{text:`${i+1}. ${x.name}${x.isMe?"（我）":""}`}),el("b",{text:fmt(x.value)}))));host.append(ol);
    if(!j.rows.length)host.append(el("p",{class:"mu",text:"目前還沒有玩家資料。"}));
  }catch(e){host.append(el("p",{class:"warn",text:"排行榜載入失敗："+e.message}));}
}
async function renderBlackmarket(){
  const host=$("blackmarket");host.replaceChildren();
  if(!user){host.append(el("p",{class:"mu",text:"登入 Google 帳號後使用黑市。"}));return;}
  host.append(el("p",{class:"warn",text:"搶玩家：黑市費 10,000 元，成功率 30%，搶走對方現金的 30%；被抓機率 70%，另罰 10,000 元並服刑 24 小時。被抓時搶款不會轉出，需備妥 20,000 元。"}),
    el("p",{class:"warn",text:"搶銀行：黑市費 5,000 元，成功率 10%；成功獲得 50,000 元。失敗被捕，罰 10,000 元並服刑 24 小時，需備妥 15,000 元。"}));
  if(me.jailUntil>Date.now()){host.append(el("p",{class:"hot",text:"你正在服刑，還要 "+prisonLeft(me.jailUntil)+"。"}));return;}
  const sel=el("select",{class:"px-sel","aria-label":"選擇搶劫目標"});sel.append(new Option("載入玩家名單…",""));
  const result=el("div",{class:"mu"});
  const playerBtn=el("button",{class:"px-btn pri",type:"button",disabled:true,text:"搶這位玩家",onclick:async()=>{
    if(!sel.value)return say("請選擇目標玩家");if(!confirm("確定花 10,000 元嘗試搶劫？被抓另罰 10,000 元並關押一天。"))return;
    const r=await act("blackmarket",{action:"rob-player",targetUid:sel.value});if(r){say(r.caught?"被捕！罰金 "+fmt(r.fine)+"，服刑 24 小時；搶款已歸還。":"得手！搶到 "+fmt(r.stolen)+"，已扣除黑市費 "+fmt(r.fee)+"。");renderStrip();}
  }});
  sel.onchange=()=>{playerBtn.disabled=busy||!sel.value;};
  const bankBtn=el("button",{class:"px-btn",type:"button",disabled:busy||Number(me.cash)<15000,text:"搶銀行",onclick:async()=>{
    if(!confirm("確定花 5,000 元搶銀行？成功可得 50,000 元，失敗會被捕、罰 10,000 元並關押一天。"))return;
    const r=await act("blackmarket",{action:"rob-bank"});if(r){say(r.caught?"銀行警鈴響了！罰金 "+fmt(r.fine)+"，服刑 24 小時。":"成功搶到 "+fmt(r.loot)+"！已扣除費用 "+fmt(r.fee)+"。");renderStrip();}
  }});
  host.append(el("label",{class:"lbl",text:"搶劫玩家目標"}),sel,el("div",{class:"row"},playerBtn,bankBtn),result);
  try{const r=await fetch(CFG.api+"/blackmarket",{method:"POST",headers:{Authorization:"Bearer "+await user.getIdToken(),"Content-Type":"application/json"},body:JSON.stringify({action:"targets"})}),j=await r.json();if(!r.ok)throw Error(j.error?.message||"載入失敗");
    sel.replaceChildren(new Option("▼ 選擇玩家",""));j.targets.forEach(t=>sel.append(new Option(t.name+"（現金 "+fmt(t.cash)+"）",t.uid)));playerBtn.disabled=busy||!sel.value;
  }catch(e){sel.replaceChildren(new Option("玩家名單載入失敗："+e.message,""));}
}
function renderAnalyst(){
  const host=$("analyst");host.replaceChildren();
  if(!user){host.append(el("p",{class:"mu",text:"登入 Google 帳號後才能委託分析。"}));return;}
  const ids=Object.keys(stocks).sort(),sel=el("select",{class:"px-sel",id:"analyst-stock","aria-label":"選擇分析股票"});
  sel.append(new Option(ids.length?"▼ 選擇股票":"行情載入中…",""));
  ids.forEach(id=>sel.append(new Option(`${stocks[id].emoji} ${stocks[id].name}`,id)));
  sel.value=stocks[analystStock]?analystStock:"";sel.onchange=()=>{analystStock=sel.value;};
  const fee=el("input",{class:"px-in",type:"number",inputmode:"numeric",min:"1000",max:"10000",step:"100",value:"1000",id:"analyst-fee","aria-label":"分析師費用"});
  const ask=el("button",{class:"px-btn pri",type:"button",text:"付費詢問",disabled:busy||!ids.length,onclick:async()=>{
    const amount=Number(fee.value);if(!sel.value)return say("請先選擇股票");if(!Number.isInteger(amount)||amount<1000||amount>10000)return say("費用需為 1,000～10,000 元整數");
    const r=await act("analyst",{stockId:sel.value,amount});if(r){analystStock=sel.value;me.cash=Number(me.cash)-r.fee;analystReport=r;renderAnalyst();}
  }});
  host.append(el("p",{class:"mu",text:"選股票並支付 1,000～10,000 元，請分析師估計目前上漲機率。最高價位的估計誤差不超過 ±10 個百分點；金額越低越不準。"}),
    el("label",{class:"lbl",for:"analyst-stock",text:"要分析的股票"}),sel,
    el("label",{class:"lbl",for:"analyst-fee",text:"分析費用（現金："+fmt(me.cash)+"）"}),fee,el("div",{class:"row"},ask));
  if(analystReport){
    const report=analystReport,words=report.rude?"就這點錢也想打聽行情？我隨口報一個，你自己看著辦。":"這是我根據盤面估的，別拿去當保證。";
    host.append(el("div",{class:"analyst-chat"},el("div",{class:"analyst-avatar",text:"🕵️"}),el("div",{class:"analyst-bubble"},
      el("b",{text:"股票分析師"}),el("p",{text:words}),el("p",{text:`${report.stock}：我估目前上漲機率約 ${report.estimate}%（誤差約 ±${report.radius} 個百分點）。`} ),el("small",{class:"mu",text:`已收取 ${fmt(report.fee)} 元`}))));
  }
}
function wireNav(){
  const dr=$("drawer");
  $("menu").onclick=()=>dr.showModal();$("dclose").onclick=()=>dr.close();
  dr.addEventListener("click",e=>{if(e.target===dr)dr.close();});
  dr.querySelectorAll(".nav-item").forEach(b=>b.onclick=()=>{dr.close();setView(b.dataset.v);});
  setInterval(()=>{renderTicker();refreshGauges();if(isDev&&++oddsTick%4===0)fetchOdds();syncGameSettings();if(view==="news")updateNewsTimes();checkMob();if(me.jailUntil&&me.jailUntil<=Date.now()){me.jailUntil=0;render();}const open=marketOpenClient();if(view==="trade"&&marketOpenPrev!==open){marketOpenPrev=open;render();}if(view==="bank"&&document.activeElement!==bk.amt&&document.activeElement!==sv.amt){renderStrip();updateBank();}},5000);
}
function renderFeed(rows){
  const f=$("feed");f.replaceChildren();
  if(!rows.length)f.append(el("div",{class:"mu",text:"還沒有人投入造物"}));
  rows.forEach(x=>{const t=x.at?.toDate?.();const hm=t?t.toLocaleTimeString("zh-TW",{hour:"2-digit",minute:"2-digit",hour12:false}):"";
    if(x.mob){f.append(el("div",{class:"mob"},document.createTextNode(`☠ ${x.who} 欠款 ${fmt(x.owed)} 拖過一天，被黑道抓走關押一天，資產重製`)));return;}
    if(x.robbery){f.append(el("div",{class:x.caught?"dn":"up"},el("span",{class:"tm",text:hm}),document.createTextNode(`🕶 ${x.who} ${x.caught?"在黑市行動中被捕並關押一天":"完成了一次黑市行動"}`)));return;}
    f.append(el("div",{class:(x.pass!=null?x.pass:x.pct!=null?x.pct>0:x.score>=50)?"up":"dn"},el("span",{class:"tm",text:hm}),
      document.createTextNode(`${x.who}${x.dev?" 🛠":""} 將「${x.item}」投入 ${x.stock}：相似度 ${x.score}${x.pass!=null?(x.pass?" ✓":" ✗"):""}${x.pct!=null?"，"+(x.pct>0?"+":"")+x.pct+"%":""}`)));});
}
function wireSettings(){
  const dlg=$("settings"),k=$("gkey"),upd=()=>{$("keystate").textContent=K.getItem("gk")?(K.persistent?"✓ 已設定（存在這台裝置，下次不用重打）":"✓ 已設定（只存在這個分頁；這個瀏覽器不允許長期儲存）"):"尚未設定";};
  k.value=K.getItem("gk")||"";$("model").textContent=CFG.modelLabel;upd();
  if(K.persistent)document.querySelectorAll("#settings .mu").forEach(p=>{if(p.textContent.includes("只存在這個分頁"))p.textContent="Key 存在這台裝置的瀏覽器裡（下次不用重打），按「清除 Key」可刪除；每次投入時隨請求送到伺服器轉呼叫 Gemini，伺服器不儲存、不記錄。共用的手機或電腦請記得清除。";});
  $("gear").onclick=()=>dlg.showModal();
  $("mode").onclick=()=>setView(view==="mono"?"trade":"mono");
  $("close").onclick=()=>dlg.close();
  dlg.addEventListener("click",e=>{if(e.target===dlg)dlg.close();});
  k.onchange=()=>{K.setItem("gk",k.value.trim());upd();};
  $("clearkey").onclick=()=>{K.removeItem("gk");k.value="";upd();};
}

// ---------- 啟動 ----------
async function main(){
  applyScale();wireSettings();wireNav();marketOpenPrev=marketOpenClient();
  setView({"#mono":"mono","#news":"news","#rank":"rank","#black":"black","#analyst":"analyst","#bank":"bank","#work":"work","#settings":"set"}[location.hash]||"trade");
  if([CFG.firebase.apiKey,CFG.ia.clientId,CFG.api].some(v=>/REPLACE_ME/.test(v))){say("請先在 config.js 填入 Firebase、Client ID 與 Worker 網址");return;}
  const app=initializeApp(CFG.firebase);db=getFirestore(app);if(view==="mono")monoSub(true);
  auth=getAuth(app);getRedirectResult(auth).catch(e=>say("Google 登入失敗："+e.code));
  onAuthStateChanged(auth,u=>{
    user=u;isDev=false;craftSig="";analystReport=null;analystStock="";offP&&offP();offP=null;
    if(u)u.getIdToken().then(t=>fetch(CFG.api+"/whoami",{method:"POST",headers:{Authorization:"Bearer "+t}})).then(r=>r.json()).then(j=>{isDev=!!j.dev;gameSettings={...gameSettings,...j.settings};craftSig="";bankBuilt=false;render();if(isDev)fetchOdds();}).catch(()=>{});
    if(u)offP=onSnapshot(doc(db,"players",u.uid),snap=>{me=snap.exists()?{...snap.data()}:{cash:CFG.startCash,hold:{},name:u.displayName||"玩家"};render();checkMob();});
    else me={cash:CFG.startCash,hold:{},name:"訪客"};
    render();
  });
  await handleCallback();
  onSnapshot(doc(db,"market","state"),snap=>{
    if(!snap.exists()){fetch(CFG.api+"/ensure-market",{method:"POST"}).catch(()=>{});return;}
    stocks=snap.data().stocks||{};dailyTasks=snap.data().dailyTasks||{date:"",tasks:{}};render();});
  onSnapshot(query(collection(db,"news"),orderBy("at","desc"),limit(30)),snap=>{newsList=[];snap.forEach(d=>newsList.push({id:d.id,...d.data()}));newsErr=false;render();},()=>{newsErr=true;render();});
  onSnapshot(query(collection(db,"feed"),orderBy("at","desc"),limit(15)),snap=>{const rows=[];snap.forEach(d=>rows.push(d.data()));renderFeed(rows);});
  if(token)loadIA().then(render).catch(e=>say(e.message));
}
main();
