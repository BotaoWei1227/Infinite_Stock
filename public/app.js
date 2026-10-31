import {CFG} from "./config.js";
import {initializeApp} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {getAuth,onAuthStateChanged,GoogleAuthProvider,signInWithPopup,signInWithRedirect,getRedirectResult,signOut} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {createMono} from "./mono.js";
import {normInv,BASE_ITEMS} from "./items.js";
import {zhBig,profileHead,statGrid,achievementList} from "./profile.js";
import {getFirestore,initializeFirestore,getDoc,collection,doc,onSnapshot,query,orderBy,limit} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const $=id=>document.getElementById(id),S=sessionStorage;
const fmt=n=>(Math.round(n*100)/100).toFixed(2);
const prisonLeft=until=>hmLeft(until-Date.now());
let hinting=true;
const say=t=>{hinting=false;$("msg").textContent=t;};
let db,auth,user=null,me={cash:CFG.startCash,hold:{},name:"訪客"},stocks={},dailyTasks={date:"",tasks:{}},busy=false,offP=null,collapsed=new Set(),view="trade",bankBuilt=false,isDev=false,odds=null,skew=0,newsList=[],newsErr=false,nf=null,oddsTick=0,analystReport=null,analystStock="",tradeShares=1,marketOpenPrev=null,gameSettings={loanRate:.05,demRate:.004,tdRate:.012,threshold:70},settingsSyncedAt=0;

const okUrl=u=>{try{return new URL(u).protocol==="https:"?u:null}catch{return null}};
const icon=(e,url)=>{const s=document.createElement("span"),u=okUrl(url);s.textContent=e||"❔";
  if(u){const i=new Image();i.className="ic";i.alt="";i.loading="lazy";i.src=u;i.onload=()=>s.replaceChildren(i);}return s;};

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

// ---------- 伺服器端行動（Worker 驗證 Google 登入並計算行情） ----------
// 自己的 Gemini API Key（選用）：只存在這支手機的瀏覽器（localStorage，不行就退回分頁暫存），不會存到伺服器。
// 只有「合成」與「投入物品」的請求會帶上它，伺服器拿來呼叫 Gemini 後就丟掉；沒綁定就用伺服器的額度。
const GKEY_OK=/^[\x21-\x7E]{1,512}$/;   // 不限制 Key 的格式，只擋空白、中文、換行這些放進標頭會出錯的字元
const K=(()=>{
  let persist=true;try{localStorage.setItem("_t","1");localStorage.removeItem("_t");}catch{persist=false;}
  const st=()=>persist?localStorage:sessionStorage;
  return {get:()=>{try{return st().getItem("gkey")||"";}catch{return "";}},set:v=>{try{st().setItem("gkey",v);return true;}catch{return false;}},clear:()=>{try{localStorage.removeItem("gkey");sessionStorage.removeItem("gkey");}catch{}},persistent:persist};
})();
const KEY_URL="https://aistudio.google.com/apikey";   // 官方申請 Key 的頁面
const keyLink=text=>el("a",{class:"px-btn pri",href:KEY_URL,target:"_blank",rel:"noopener noreferrer",text,"aria-label":`${text}（會在新分頁開啟 Google AI Studio）`});
const maskKey=k=>k?`${k.slice(0,4)}…${k.slice(-4)}`:"";
// 動作做完後讓畫面立刻更新：①用伺服器回應裡的最新資料（現金、持股、背包、配方）直接更新；②稍後再向伺服器重抓一次玩家資料（以及大富翁棋盤）對帳，
// 不必等 Firestore 即時連線（手機上常常延遲或斷線）。即時連線仍然照常運作。
const ME_KEYS=["cash","hold","inv","recipes"];
function applyResult(j){if(j&&typeof j==="object")for(const k of ME_KEYS)if(Object.hasOwn(j,k)&&j[k]!=null)me={...me,[k]:j[k]};}
let recTimer=null;
function reconcile(name){
  clearTimeout(recTimer);
  recTimer=setTimeout(async()=>{
    if(!db||!user)return;
    try{const s=await getDoc(doc(db,"players",user.uid));if(s.exists()){me={...s.data()};render();}}catch{}
    if(name==="monopoly"&&view==="mono"){try{const s=await getDoc(doc(db,"monopoly","state"));mono.update(s.exists()?s.data():{});}catch{}}
  },900);
}
async function act(name,data,onOk){
  if(busy)return null;if(!user){say("請先以 Google 帳號登入");return null;}
  busy=true;say("處理中…");render();
  try{
    const r=await fetch(CFG.api+"/"+name,{method:"POST",headers:{Authorization:"Bearer "+await user.getIdToken(),"Content-Type":"application/json"},body:JSON.stringify((name==="craft"||name==="inject")&&K.get()?{...data,geminiKey:K.get()}:data)});
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j.error?.message||("HTTP "+r.status));
    applyResult(j);if(onOk)onOk(j);reconcile(name);
    return j;
  }
  catch(e){say(e.message);return null;}
  finally{busy=false;render();}
}
// 借貸保釋：被黑道抓走、搶劫被捕都一樣；銀行頁與黑市頁都有這個按鈕
function bailBlock(hidden=false){
  return el("div",{class:"bailbox",hidden},
    el("p",{class:"hot",text:`⛓ 你正在服刑。可以借 ${fmt(BAIL)} 的保釋貸款立刻出獄（被黑道抓走、搶劫或搶銀行被捕都適用）：這筆錢不會進你的口袋，直接成為欠款（照一般貸款利率滾利，欠款超過 ${MOB_LIMIT} 並拖過 24 小時黑道還是會上門）。`}),
    el("button",{class:"px-btn pri",type:"button",text:"借貸保釋",disabled:busy,onclick:async()=>{if(!confirm(`借 ${fmt(BAIL)} 保釋貸款並出獄？這筆錢會計入欠款。`))return;const r=await act("bank",{action:"bail"});if(r)say(`已保釋出獄，目前欠款 ${fmt(r.owed)}`);}}));
}
// 元素（＝股票）：名稱與圖示優先用行情資料，沒載入時用備用表
const ELEM_FALLBACK={fire:["火","🔥"],water:["水","💧"],earth:["土","🪨"],wind:["風","🌪️"],steam:["蒸氣","♨️"],thunder:["雷","⚡"]},ELEM_IDS=Object.keys(ELEM_FALLBACK),BASIC_IDS=["fire","water","earth","wind"],BASE_PRICE=10;
const elemName=id=>stocks[id]?.name||ELEM_FALLBACK[id]?.[0]||id,elemIcon=id=>stocks[id]?.emoji||ELEM_FALLBACK[id]?.[1]||"❔";
// 背包：{物品名稱:{n,e,lv}}（舊格式會自動轉換）。排序：品階高的在前，再依名稱
const REL={direct:"直接相關",strong:"高度相關",weak:"勉強相關",none:"無關"},stars=lv=>lv>0?" "+"★".repeat(lv):"";
const bagOf=()=>normInv(me.inv),bagList=()=>Object.entries(bagOf()).sort((a,b)=>b[1].lv-a[1].lv||a[0].localeCompare(b[0],"zh-Hant")),pickItem={};
async function inject(id){
  const mine=bagList();let name=mine.some(([n])=>n===pickItem[id])?pickItem[id]:mine[0]?.[0];
  if(!name){
    if(!isDev)return say("背包是空的：到「練金工坊」買基礎元素或三物合成，再回來投入");
    name=(prompt("開發者：輸入要投入的物品名稱（免材料）",elemName(id))||"").trim();if(!name)return;
  }
  const r=await act("inject",{stockId:id,item:name});
  if(r)say(`「${name}」和${elemName(id)}${REL[r.rel]||""}，${r.pass?"提高":"降低"}了${elemName(id)}的上漲機率${r.up!=null?`（現在 ${r.up}%・僅開發者可見）`:""}`);
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
  if(n<2){return el("div",{class:"chart mu",text:"走勢資料累積中…（每 1 分鐘一個點）",style:"display:grid;place-items:center"});}
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
    el("div",{class:"stat"},el("span",{class:"k",text:"現金 "}),el("b",{text:fmt(me.cash)}),el("span",{class:"k",text:"　淨資產 "}),el("b",{text:fmt(net())})),
    ...(me.jailUntil>Date.now()?[el("div",{class:"cell debt",text:"⛓ 服刑中・剩 "+prisonLeft(me.jailUntil)})]:[]));
}
let craftSig="";
function renderCraft(){
  const sig=JSON.stringify([isDev,bagOf(),Object.keys(stocks).length,busy]);
  if(sig===craftSig)return;craftSig=sig;
  const w=$("craft");w.replaceChildren(winBar("📦 BACKPACK.EXE",[el("span",{class:"wb dec","aria-hidden":"true",text:"_"}),el("span",{class:"wb dec","aria-hidden":"true",text:"×"})]));
  const b=el("div",{class:"body"}),have=bagList();
  b.append(have.length?el("div",{class:"chips"},...have.map(([n,x])=>el("span",{class:"echip",text:`${x.e} ${n}${stars(x.lv)} ×${x.n}`}))):el("p",{class:"mu",text:user?"背包是空的。到練金工坊買基礎元素（火、水、土、風），或把物品三物合成出新東西。":"登入後就能買元素、合成，再投入歸屬的股票。"}));
  if(isDev)b.append(el("p",{class:"mu",text:"🛠 開發者：投入元素不需要材料。"}));
  b.append(el("div",{class:"row"},el("button",{class:"px-btn pri",type:"button",text:"⚗ 前往練金工坊",onclick:()=>setView("work")}),el("span",{class:"mu",text:"到想影響的股票視窗選一個物品投入，AI 會判斷它和那檔股票有多相關。"})));
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
    const s=stocks[id],open=!collapsed.has(id),first=(s.p&&s.p[0])||s.price,ch=(s.price/first-1)*100,chTxt=(ch>=0?"+":"")+ch.toFixed(2)+"%";
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
      ...(isDev&&odds?[el("div",{class:"meter"},el("span",{class:"k",text:"上漲機率 🔒"}),el("div",{class:"gauge","aria-hidden":"true"},el("i",{class:"gi","data-id":id,style:`width:${upPct(id)}%`})),el("b",{class:"gp","data-id":id,text:upPct(id)+"%"}))]:[]),
      el("div",{class:"mu",text:`持有 ${n} 股${s.last?"｜上次投入："+s.last:""}｜背包${isDev?"（開發者免材料）":" "+bagList().reduce((a,[,x])=>a+x.n,0)+" 個"}`}),
      el("div",{class:"acts"},
        el("button",{class:"px-btn buy-btn",type:"button",disabled:busy,text:`買 ${tradeShares}`,onclick:()=>trade(id,1)}),
        el("button",{class:"px-btn sell-btn",type:"button",disabled:busy,text:`賣 ${tradeShares}`,onclick:()=>trade(id,-1)}),
        ...(()=>{
          const mine=bagList();
          if(!mine.length)return [el("button",{class:"px-btn pri",type:"button",disabled:busy||!isDev,text:isDev?"投入物品（開發者免材料）":"背包是空的",onclick:()=>inject(id)})];
          if(!mine.some(([n])=>n===pickItem[id]))pickItem[id]=mine[0][0];
          const sel=el("select",{class:"px-sel","aria-label":`選擇要投入${s.name}的物品`,onchange:()=>{pickItem[id]=sel.value;}});
          mine.forEach(([n,x])=>sel.append(new Option(`${x.e} ${n}${stars(x.lv)} ×${x.n}`,n)));sel.value=pickItem[id];
          return [sel,el("button",{class:"px-btn pri",type:"button",disabled:busy,text:"投入",onclick:()=>inject(id)})];})()));
    w.append(b);mk.append(w);
  }
}

// ---------- 財經新聞 ----------
// 玩家只看得到：名稱、內容、時間、普發現金。活動對機率的影響只有開發者看得到。
// 跑馬燈：新聞發布後 TICKER_MS 內、活動還沒結束，就在頁面最上方滾動顯示標題；點一下進財經新聞
const TICKER_MS=3*36e5;let tickSig="",tickerOff=false;
try{tickerOff=localStorage.getItem("tickerOff")==="1";}catch{}
function setTicker(on){tickerOff=!on;try{localStorage.setItem("tickerOff",on?"0":"1");}catch{}tickSig="";renderTicker();if(view==="set")renderSet();}
function renderTicker(){
  const t=$("ticker");if(!t)return;
  if(tickerOff){t.hidden=true;tickSig="";return;}
  const now=nowS(),items=newsList.filter(n=>{const at=n.at?.toMillis?.()??Number(n.at);return Number.isFinite(at)&&at<=now+6e4&&now-at<TICKER_MS&&n.endsAt>now;}).map(n=>n.title).filter(Boolean);
  const sig=items.join("\u0001");if(sig===tickSig)return;tickSig=sig;
  t.hidden=!items.length;if(!items.length){t.replaceChildren();return;}
  const text="📰 快訊　"+items.join("　★　")+"　　　";
  const track=el("div",{class:"tk-track"},el("span",{class:"tk-item",text}),el("span",{class:"tk-item","aria-hidden":"true",text}));
  track.style.animationDuration=Math.max(14,[...text].length*.45)+"s";
  t.replaceChildren(el("div",{class:"tk-wrap"},
    el("button",{type:"button",class:"tk-btn","aria-label":"財經快訊："+items.join("、")+"。點一下看財經新聞",onclick:()=>setView("news")},track),
    el("button",{type:"button",class:"tk-close","aria-label":"關閉新聞跑馬燈（可以到設定重新開啟）",title:"關閉跑馬燈",onclick:()=>{setTicker(false);say("已關閉新聞跑馬燈，可以到「設定」重新開啟");},text:"✕"})));
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
  const section=el("section",{class:"win","aria-label":"開發者遊戲設定"});
  section.append(winBar("⚙ GAME SETTINGS.EXE"),el("div",{class:"body"},el("p",{class:"mu",text:"僅開發者可見。利率以日為單位連續複利。"}),loanLabel,loan,demLabel,dem,tdLabel,td,
    el("button",{class:"px-btn pri",type:"button",text:"儲存遊戲設定",disabled:busy,onclick:async()=>{const r=await act("admin-settings",{action:"save",loanRate:Number(loan.value),demRate:Number(dem.value),tdRate:Number(td.value),threshold:gameSettings.threshold});if(r){gameSettings=r.settings;bankBuilt=false;say("遊戲設定已更新");}}})));
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
  bk.bail=bailBlock(true);
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
// ---------- 練金工坊：買基礎元素、三物合成（AI 自由聯想） ----------
let slots=[null,null,null],buyQty=1,craftMsg=null,shareText="";
const SHARE_PREFIX="https://pillars-of-creation.funtuan.work/s/",SHARE_OK=/^https:\/\/pillars-of-creation\.funtuan\.work\/s\/[A-Z0-9]{16,40}\/?(?:[?#].*)?$/;
function renderWork(){
  const v=$("v-work");v.replaceChildren();
  const bag=bagOf(),used=n=>slots.filter(x=>x===n).length,left=n=>(bag[n]?.n||0)-used(n);
  const chip=(n,onclick,extra="")=>el("button",{type:"button",class:"echip btn",disabled:busy||!onclick,"aria-label":`${n}${extra}`,onclick,text:`${bag[n]?.e||""} ${n}${stars(bag[n]?.lv)}${extra}`});
  if(!K.get())v.append(el("p",{class:"mu"},document.createTextNode("💡 合成靠 AI（Gemini）。想用自己的額度，可以先去拿一把 Gemini API Key，再到「設定」綁定。 "),keyLink("🔑 取得 Key"),el("button",{class:"px-btn",type:"button",text:"前往設定",onclick:()=>setView("set")})));
  // 1. 背包
  const bagWin=el("section",{class:"win","aria-label":"背包"});bagWin.append(winBar("📦 BACKPACK.EXE"));
  const have=bagList().map(([n])=>n),bb=el("div",{class:"body"});
  bb.append(el("p",{class:"mu",text:"點背包裡的物品，放進下面的合成格；每個物品只能用一次（合成或投入股票都會消耗）。物品可以投入任何一檔股票，品階（★）越高力道越大。"}));
  bb.append(have.length?el("div",{class:"chips"},...have.map(n=>chip(n,left(n)>0?()=>{const i=slots.indexOf(null);if(i<0)return say("三個格子都放滿了，先拿掉一個或按「合成」");slots[i]=n;renderWork();}:null,` ×${left(n)}`))):el("p",{class:"mu",text:user?"背包是空的，先到下面的材料店買基礎元素。":"請先登入 Google 帳號。"}));
  bagWin.append(bb);v.append(bagWin);
  // 1.5 領取《無限煉製》傳授連結：貼上網址，造物（名稱與圖示）會放進背包
  const gift=el("section",{class:"win","aria-label":"領取傳授連結"});gift.append(winBar("🎁 GIFT.EXE"));
  const link=el("input",{class:"px-in link-in",type:"url",inputmode:"url",autocomplete:"off",placeholder:SHARE_PREFIX+"XXXXXXXX","aria-label":"《無限煉製》傳授連結",value:shareText,oninput:e=>{shareText=e.target.value;ok.disabled=busy||!user||!SHARE_OK.test(shareText.trim());hint.textContent=shareText&&!SHARE_OK.test(shareText.trim())?"連結格式不符，必須是 "+SHARE_PREFIX+"代碼":"";}});
  const hint=el("p",{class:"hot",role:"status",text:shareText&&!SHARE_OK.test(shareText.trim())?"連結格式不符，必須是 "+SHARE_PREFIX+"代碼":""});
  const ok=el("button",{type:"button",class:"px-btn pri",disabled:busy||!user||!SHARE_OK.test(shareText.trim()),text:"🎁 領取造物",onclick:async()=>{const r=await act("craft",{action:"import",url:shareText.trim()},()=>{shareText="";});if(r)say(`領到「${r.item.e} ${r.item.name}」（${r.sender} 傳授）`);}});
  gift.append(el("div",{class:"body"},el("p",{class:"mu",text:"在《無限煉製》把造物「傳授」給別人會產生連結，貼在這裡就能把那個造物領進背包（名稱和圖示照原本的）。每個連結每人只能領一次，連結過期就不能領；每天最多領 20 個。"}),link,hint,el("div",{class:"row"},ok)));
  v.append(gift);
  // 2. 材料店
  const shop=el("section",{class:"win","aria-label":"材料店"});shop.append(winBar("🛒 SHOP.EXE"));
  const qty=el("input",{class:"px-in qty-in",type:"number",inputmode:"numeric",min:"1",max:"100",step:"1",value:String(buyQty),"aria-label":"購買數量",oninput:e=>{const n=Math.floor(Number(e.target.value));if(n>=1&&n<=100){buyQty=n;shop.querySelector(".cost").textContent=`${n*BASE_PRICE} 元`;}}});
  shop.append(el("div",{class:"body"},el("p",{class:"mu",text:`基礎元素：火、水、土、風，一個 ${BASE_PRICE} 元。蒸氣與雷不能買，只能合成。`}),
    el("div",{class:"row mono-row"},el("label",{class:"lbl",text:"數量"}),qty,el("span",{class:"mu"},document.createTextNode("花費 "),el("b",{class:"cost",text:`${buyQty*BASE_PRICE} 元`}))),
    el("div",{class:"chips"},...BASIC_IDS.map(id=>el("button",{type:"button",class:"px-btn buy-el",disabled:busy||!user,text:`買 ${BASE_ITEMS[id].e} ${BASE_ITEMS[id].name}`,onclick:async()=>{const n=buyQty,r=await act("craft",{action:"buy",element:id,qty:n});if(r)say(`買了 ${n} 個${BASE_ITEMS[id].name}，花 ${r.cost} 元`);}})))));
  v.append(shop);
  // 3. 三物合成
  const lab=el("section",{class:"win","aria-label":"三物合成"});lab.append(winBar("⚗ ALCHEMY.EXE"));
  const filled=slots.every(Boolean),lb=el("div",{class:"body"});
  lb.append(el("p",{class:"mu",text:"放入 3 個物品，由 AI 煉金師憑聯想創造出一個新物品（可能是溫泉、彩虹、火山…什麼都有可能），新物品也能再拿來合成。同一個組合永遠得到一樣的結果，品階不會比材料低。"}));
  lb.append(el("div",{class:"slots"},...slots.map((n,i)=>el("button",{type:"button",class:"slot"+(n?" on":""),"aria-label":n?`第 ${i+1} 格：${n}，點一下拿掉`:`第 ${i+1} 格：空的`,onclick:()=>{if(n){slots[i]=null;renderWork();}},text:n?`${bag[n]?.e||""}\n${n}`:"＋"})),
    el("span",{class:"arrow","aria-hidden":"true",text:"→"}),el("div",{class:"slot out","aria-live":"polite",text:craftMsg?`${craftMsg.e}\n${craftMsg.name}${stars(craftMsg.lv)}`:"？"})));
  lb.append(el("div",{class:"row"},
    el("button",{type:"button",class:"px-btn pri",disabled:busy||!filled||!user,text:"⚗ 合成",onclick:async()=>{const items=[...slots],r=await act("craft",{action:"craft",items},j=>{slots=[null,null,null];craftMsg={...j.result,reason:j.reason||""};});if(r)say(`合成成功：得到 1 個「${r.result.name}」${r.isNew?"（新發現的配方！）":""}`);}}),
    el("button",{type:"button",class:"px-btn",disabled:busy||slots.every(x=>!x),text:"清空",onclick:()=>{slots=[null,null,null];craftMsg=null;renderWork();}})));
  if(craftMsg?.reason)lb.append(el("p",{class:"sage",text:`🧙 煉金師：${craftMsg.reason}`}));
  if(craftMsg)lb.append(el("p",{class:"mu",text:`上一次合成得到：${craftMsg.e} ${craftMsg.name}${stars(craftMsg.lv)}。到交易區任一檔股票的視窗選它、按「投入」，AI 會判斷它和那檔股票有多相關：越相關漲機率越高，不相關反而會壓低。`}));
  lab.append(lb);v.append(lab);
  // 4. 配方簿
  const book=el("section",{class:"win","aria-label":"配方簿"});book.append(winBar("📖 RECIPES.EXE"));
  const recs=Object.entries(me.recipes||{}).filter(([,r])=>r&&typeof r==="object").sort(),rb=el("div",{class:"body"});
  rb.append(recs.length?el("ul",{class:"list"},...recs.map(([k,r])=>el("li",{},el("span",{text:k.split("+").map((n,i)=>`${r.i?.[i]||""}${n}`).join(" ＋ ")}),el("b",{text:`→ ${r.e||""} ${r.n}${stars(r.lv)}`})))):el("p",{class:"mu",text:"還沒有發現任何配方。"}));
  rb.append(el("p",{class:"mu",text:`投入股票的效果：看物品和股票的相關度（AI 判定），再乘上品階的力道（品階 0 是一半，1 是滿額）。每次投入都有幾秒冷卻，總偏移有上限，而且會慢慢消退。`}));
  book.append(rb);v.append(book);
}
// ---------- 個人資料與成就（自己的）／公開分享頁 ----------
let meProfile=null,meLoading=false,meErr="",pubId="",pubData=null,pubErr="",pubLoading=false,bioDraft=null;
async function loadMe(force=false){
  if(!user||meLoading||(meProfile&&!force))return;
  meLoading=true;meErr="";
  try{await act("achievements",{action:"get"},j=>{meProfile=j;});if(!meProfile)meErr="讀取失敗，請稍後再試";}catch{meErr="讀取失敗，請稍後再試";}
  meLoading=false;render();
}
const profileUrl=id=>`${location.origin}${location.pathname}#u=${id}`;
async function copyText(t){try{await navigator.clipboard.writeText(t);say("已複製連結");}catch{prompt("複製這個連結：",t);}}
function renderMe(){
  const v=$("v-me");v.replaceChildren();
  if(!user){v.append(el("p",{class:"mu",text:"請先以 Google 帳號登入，就能看到自己的個人資料與成就。"}));return;}
  if(!meProfile){v.append(el("p",{class:"mu",text:meErr||"讀取中…"}));if(!meLoading&&!meErr)loadMe();return;}
  const d=meProfile,card=el("section",{class:"win","aria-label":"我的個人資料"});card.append(winBar("👤 PROFILE.EXE"));
  const b=el("div",{class:"body"});b.append(profileHead(el,d,d.stats.peak),statGrid(el,d.stats));card.append(b);v.append(card);
  // 分享
  const sh=el("section",{class:"win","aria-label":"分享個人資料"});sh.append(winBar("🔗 SHARE.EXE"));
  const sb=el("div",{class:"body"}),bio=el("textarea",{class:"px-in",rows:"2",maxlength:"60",placeholder:"個人簡介（最多 60 字，選填）","aria-label":"個人簡介",oninput:e=>{bioDraft=e.target.value;}});bio.value=bioDraft??d.share.bio??"";
  sb.append(el("p",{class:"mu",text:"開啟後會產生一個連結，任何人（不用登入）都能看到你的稱號、名稱、簡介、歷史最高淨資產、成就與統計。看不到你的現金、持股、信箱等私人資料。可以隨時關閉。"}),bio);
  const save=on=>async()=>{const r=await act("achievements",{action:"share",on,bio:bio.value.trim()},j=>{meProfile=j;});if(r){bioDraft=null;say(on?"已開啟公開頁面":"已關閉公開頁面");}};
  sb.append(el("div",{class:"row"},d.share.on?el("button",{class:"px-btn pri",type:"button",disabled:busy,text:"儲存簡介",onclick:save(true)}):el("button",{class:"px-btn pri",type:"button",disabled:busy,text:"🔗 開啟公開頁面",onclick:save(true)}),d.share.on?el("button",{class:"px-btn",type:"button",disabled:busy,text:"關閉公開",onclick:save(false)}):null));
  if(d.share.on&&d.share.id){
    const url=profileUrl(d.share.id);
    sb.append(el("input",{class:"px-in link-in",readonly:"",value:url,"aria-label":"公開連結",onfocus:e=>e.target.select()}),
      el("div",{class:"row"},el("button",{class:"px-btn pri",type:"button",text:"📋 複製連結",onclick:()=>copyText(url)}),
        navigator.share?el("button",{class:"px-btn",type:"button",text:"📤 分享",onclick:()=>navigator.share({title:`${d.name} 的練金交易所個人資料`,text:`${d.title||"平民"}・${d.name}`,url}).catch(()=>{})}):null,
        el("a",{class:"px-btn",href:url,target:"_blank",rel:"noopener noreferrer",text:"預覽"})));
  }
  sh.append(sb);v.append(sh);
  // 成就
  const ac=el("section",{class:"win","aria-label":"成就"});ac.append(winBar("🏅 ACHIEVEMENTS.EXE"));
  ac.append(el("div",{class:"body"},...achievementList(el,d.achievements,{locked:true})));v.append(ac);
  v.append(el("div",{class:"row"},el("button",{class:"px-btn",type:"button",disabled:busy,text:"🔄 重新整理",onclick:()=>{meProfile=null;loadMe(true);}})));
}
async function loadPub(){
  if(pubLoading||!pubId)return;pubLoading=true;pubErr="";pubData=null;render();
  try{
    const r=await fetch(CFG.api+"/public",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:pubId})});
    const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error?.message||"找不到這個個人資料頁");pubData=j;
  }catch(e){pubErr=e.message||"讀取失敗";}
  pubLoading=false;render();
}
function renderPub(){
  const v=$("v-pub");v.replaceChildren();
  const home=el("div",{class:"row"},el("button",{class:"px-btn pri",type:"button",text:"🎮 進入練金交易所",onclick:()=>{pubId="";pubData=null;setView("trade");}}));
  if(pubErr){v.append(el("p",{class:"hot",text:pubErr}),home);return;}
  if(!pubData){v.append(el("p",{class:"mu",text:"讀取中…"}));return;}
  const d=pubData,card=el("section",{class:"win","aria-label":`${d.name} 的個人資料`});card.append(winBar("👤 PROFILE.EXE"));
  card.append(el("div",{class:"body"},profileHead(el,d,d.peak),statGrid(el,d.stats)));v.append(card);
  const ac=el("section",{class:"win","aria-label":"成就"});ac.append(winBar("🏅 ACHIEVEMENTS.EXE"));
  ac.append(el("div",{class:"body"},...achievementList(el,d.achievements.map(a=>({...a,unlocked:true})))));v.append(ac);
  v.append(el("div",{class:"row"},el("button",{class:"px-btn",type:"button",text:"📋 複製這個連結",onclick:()=>copyText(profileUrl(pubId))})),home);
}
// 設定頁之前的小工具：從網址 #u=代碼 判斷是不是公開個人資料頁
const pubFromHash=()=>{const m=/^#u=([a-z0-9]{8,20})$/.exec(location.hash);return m?m[1]:"";};
// ---------- 設定（介面大小） ----------
const RULE_TEXT="股價會自己隨機漲跌。到「練金工坊」買基礎元素（火、水、土、風，各 10 元），再把三個物品合成：AI 煉金師會憑聯想創造出新物品（溫泉、彩虹、火山…）。回到這裡選一個物品投入任何一檔股票：AI 會判斷它和這檔股票有多相關，越相關上漲機率提高越多，不相關反而會壓低；品階越高力道越大，效果會慢慢消退，每個物品只能用一次。買進會推升、賣出會壓低上漲機率，像真實市場的買賣壓力：影響大小看你買賣的股數占全服持股的比例，賣掉大部分持股會重創，買賣 1 股幾乎沒有影響。";
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
    el("h2",{class:"h2",text:"Gemini API Key 綁定（選用）"}),
    el("p",{class:"mu",text:"合成新物品和判斷投入的相關度都是 AI（Gemini）做的。綁定你自己的 Key，就會用你的免費額度；沒綁定就用伺服器的額度，額度用完時會暫時不能用。"}),
    el("p",{class:"mu",text:"Key 只存在這支手機的瀏覽器裡，不會存到伺服器；只有合成與投入物品時會隨請求送出，伺服器用完就丟，也不寫進任何紀錄。按下面的按鈕會在新分頁開啟 Google 的申請頁面，登入後建立 Key、複製，再回來貼在這裡。"}),
    el("div",{class:"row"},keyLink("🔑 前往取得 API Key")),
    ...(()=>{
      const cur=K.get(),inp=el("input",{class:"px-in",type:"password",autocomplete:"off",autocapitalize:"off",spellcheck:"false",placeholder:"AIza…","aria-label":"Gemini API Key"});
      const msg=el("p",{class:"mu",role:"status",text:cur?`✅ 已綁定：${maskKey(cur)}${K.persistent?"":"（這個瀏覽器無法長期儲存，關掉分頁就會消失）"}`:"目前沒有綁定，使用伺服器的額度。"});
      const save=el("button",{class:"px-btn pri",type:"button",text:"綁定",onclick:()=>{const v=inp.value.trim();if(!GKEY_OK.test(v)){msg.textContent="⚠ Key 不能是空的，也不能有空白、中文或換行（請確認有完整複製、前後沒有多餘的字）。";return;}if(!K.set(v)){msg.textContent="⚠ 這個瀏覽器不允許儲存，無法綁定。";return;}inp.value="";say("已綁定 Gemini API Key");renderSet();}});
      const clr=el("button",{class:"px-btn",type:"button",text:"解除綁定",disabled:!cur,onclick:()=>{K.clear();say("已解除綁定，改用伺服器的額度");renderSet();}});
      return [inp,el("div",{class:"row"},save,clr),msg];
    })(),
    el("h2",{class:"h2",text:"新聞跑馬燈"}),el("p",{class:"mu",text:"有新聞發布時，頁面最上方會滾動顯示標題。"}),
    el("div",{class:"seg",role:"group","aria-label":"新聞跑馬燈"},...[[true,"開啟"],[false,"關閉"]].map(([on,name])=>el("button",{class:"px-btn",type:"button","aria-pressed":String(on===!tickerOff),text:name,onclick:()=>setTicker(on)}))));
  w.append(body);
  v.append(w);
}
// ---------- 分頁 ----------
const VIEWS={mono:"v-mono",trade:"v-trade",rank:"v-rank",black:"v-black",analyst:"v-analyst",news:"v-news",bank:"v-bank",work:"v-work",me:"v-me",pub:"v-pub",set:"v-set"},HASH={mono:"#mono",trade:"",rank:"#rank",black:"#black",analyst:"#analyst",news:"#news",bank:"#bank",work:"#work",me:"#me",set:"#settings"};
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
  try{history.replaceState(null,"",location.pathname+location.search+(v==="pub"?`#u=${pubId}`:HASH[v]));}catch{}
  render();window.scrollTo(0,0);
}
function render(){
  renderTicker();
  const rule=document.querySelector(".rule");if(rule)rule.textContent=RULE_TEXT;
  if(hinting)$("msg").textContent=!user?"請先登入 Google 帳號，就能買賣股票與使用銀行":isDev&&view==="trade"?"開發者模式：投入元素不需要材料":view==="bank"?"借來的錢可以拿去買股票，但利息一直在滾，記得還款":view==="trade"?"先到「練金工坊」做出物品，再到想影響的股票視窗選物品按「投入」":"";
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
  else if(view==="me")renderMe();
  else if(view==="pub")renderPub();
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
  if(me.jailUntil>Date.now()){host.append(el("p",{class:"hot",text:"你正在服刑，還要 "+prisonLeft(me.jailUntil)+"。"}),bailBlock());return;}
  const sel=el("select",{class:"px-sel","aria-label":"選擇搶劫目標"});sel.append(new Option("載入玩家名單…",""));
  const result=el("div",{class:"mu"});
  const playerBtn=el("button",{class:"px-btn pri",type:"button",disabled:true,text:"搶這位玩家",onclick:async()=>{
    if(!sel.value)return say("請選擇目標玩家");if(!confirm("確定花 10,000 元嘗試搶劫？被抓另罰 10,000 元並關押一天。"))return;
    const r=await act("blackmarket",{action:"rob-player",targetUid:sel.value});if(r){say(r.caught?"被捕！罰金 "+fmt(r.fine)+"，服刑 24 小時；搶款已歸還。可以借貸保釋提前出獄。":"得手！搶到 "+fmt(r.stolen)+"，已扣除黑市費 "+fmt(r.fee)+"。");renderStrip();}
  }});
  sel.onchange=()=>{playerBtn.disabled=busy||!sel.value;};
  const bankBtn=el("button",{class:"px-btn",type:"button",disabled:busy||Number(me.cash)<15000,text:"搶銀行",onclick:async()=>{
    if(!confirm("確定花 5,000 元搶銀行？成功可得 50,000 元，失敗會被捕、罰 10,000 元並關押一天。"))return;
    const r=await act("blackmarket",{action:"rob-bank"});if(r){say(r.caught?"銀行警鈴響了！罰金 "+fmt(r.fine)+"，服刑 24 小時。可以借貸保釋提前出獄。":"成功搶到 "+fmt(r.loot)+"！已扣除費用 "+fmt(r.fee)+"。");renderStrip();}
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
  if(!rows.length)f.append(el("div",{class:"mu",text:"還沒有人投入元素"}));
  rows.forEach(x=>{const t=x.at?.toDate?.();const hm=t?t.toLocaleTimeString("zh-TW",{hour:"2-digit",minute:"2-digit",hour12:false}):"";
    if(x.mob){f.append(el("div",{class:"mob"},document.createTextNode(`☠ ${x.who} 欠款 ${fmt(x.owed)} 拖過一天，被黑道抓走關押一天，資產重製`)));return;}
    if(x.robbery){f.append(el("div",{class:x.caught?"dn":"up"},el("span",{class:"tm",text:hm}),document.createTextNode(`🕶 ${x.who} ${x.caught?"在黑市行動中被捕並關押一天":"完成了一次黑市行動"}`)));return;}
    if(x.element){f.append(el("div",{class:"up"},el("span",{class:"tm",text:hm}),document.createTextNode(`${x.who}${x.dev?" 🛠":""} 將「${x.item}」投入 ${x.stock}：${REL[x.rel]||""}${x.pass?" ✓":" ✗"}`)));return;}
    f.append(el("div",{class:(x.pass!=null?x.pass:x.pct!=null?x.pct>0:x.score>=50)?"up":"dn"},el("span",{class:"tm",text:hm}),
      document.createTextNode(`${x.who}${x.dev?" 🛠":""} 將「${x.item}」投入 ${x.stock}：相似度 ${x.score}${x.pass!=null?(x.pass?" ✓":" ✗"):""}${x.pct!=null?"，"+(x.pct>0?"+":"")+x.pct+"%":""}`)));});
}
function wireSettings(){
  $("gear").onclick=()=>setView("set");
  $("mode").onclick=()=>setView(view==="mono"?"trade":"mono");
}

// ---------- 啟動 ----------
async function main(){
  applyScale();wireSettings();wireNav();marketOpenPrev=marketOpenClient();
  pubId=pubFromHash();
  addEventListener("hashchange",()=>{const id=pubFromHash();if(id&&id!==pubId){pubId=id;pubData=null;setView("pub");loadPub();}});
  setView(pubId?"pub":{"#me":"me","#mono":"mono","#news":"news","#rank":"rank","#black":"black","#analyst":"analyst","#bank":"bank","#work":"work","#settings":"set"}[location.hash]||"trade");
  if(pubId)loadPub();
  if([CFG.firebase.apiKey,CFG.api].some(v=>/REPLACE_ME/.test(v))){say("請先在 config.js 填入 Firebase 與 Worker 網址");return;}
  const app=initializeApp(CFG.firebase);
  // 手機網路常讓 Firestore 的即時連線卡住；自動偵測並改用長輪詢，更新才不會漏掉
  try{db=initializeFirestore(app,{experimentalAutoDetectLongPolling:true});}catch{db=getFirestore(app);}if(view==="mono")monoSub(true);
  auth=getAuth(app);getRedirectResult(auth).catch(e=>say("Google 登入失敗："+e.code));
  onAuthStateChanged(auth,u=>{
    user=u;isDev=false;craftSig="";analystReport=null;analystStock="";meProfile=null;meErr="";bioDraft=null;offP&&offP();offP=null;
    if(u)u.getIdToken().then(t=>fetch(CFG.api+"/whoami",{method:"POST",headers:{Authorization:"Bearer "+t}})).then(r=>r.json()).then(j=>{isDev=!!j.dev;gameSettings={...gameSettings,...j.settings};craftSig="";bankBuilt=false;render();if(isDev)fetchOdds();}).catch(()=>{});
    if(u)offP=onSnapshot(doc(db,"players",u.uid),snap=>{me=snap.exists()?{...snap.data()}:{cash:CFG.startCash,hold:{},name:u.displayName||"玩家"};render();checkMob();});
    else me={cash:CFG.startCash,hold:{},name:"訪客"};
    render();
  });
  onSnapshot(doc(db,"market","state"),snap=>{
    if(!snap.exists()){fetch(CFG.api+"/ensure-market",{method:"POST"}).catch(()=>{});return;}
    stocks=snap.data().stocks||{};dailyTasks=snap.data().dailyTasks||{date:"",tasks:{}};render();});
  onSnapshot(query(collection(db,"news"),orderBy("at","desc"),limit(30)),snap=>{newsList=[];snap.forEach(d=>newsList.push({id:d.id,...d.data()}));newsErr=false;render();},()=>{newsErr=true;render();});
  onSnapshot(query(collection(db,"feed"),orderBy("at","desc"),limit(15)),snap=>{const rows=[];snap.forEach(d=>rows.push(d.data()));renderFeed(rows);});
}
main();
