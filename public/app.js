import {CFG} from "./config.js";
import {initializeApp} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {getAuth,onAuthStateChanged,GoogleAuthProvider,signInWithPopup,signInWithRedirect,getRedirectResult,signOut} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {getFirestore,collection,doc,onSnapshot,query,orderBy,limit} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const REDIRECT=location.origin+location.pathname; // 必須與 Developer Center 的 Redirect URI 完全一致
const $=id=>document.getElementById(id),S=sessionStorage;
const fmt=n=>(Math.round(n*100)/100).toFixed(2);
const say=t=>{$("msg").textContent=t;};
let db,auth,user=null,me={cash:CFG.startCash,hold:{},name:"訪客"},stocks={},token=null,inv=[],item=null,profile=null,busy=false,offP=null;

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
async function gLogin(){
  const p=new GoogleAuthProvider();
  try{await signInWithPopup(auth,p);}
  catch(e){
    if(e.code==="auth/popup-blocked"||e.code==="auth/operation-not-supported-in-this-environment")return signInWithRedirect(auth,p);
    if(e.code!=="auth/popup-closed-by-user"&&e.code!=="auth/cancelled-popup-request")say("Google 登入失敗："+e.code);
  }
}
// ---------- 伺服器端行動（Cloud Functions 驗證 IA 身分並計算漲跌） ----------
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
  const r=await act("inject",{stockId:id,itemName:item.name,geminiKey:S.getItem("gk")||"",model:S.getItem("gm")||CFG.defaultModel});
  if(r)say(`${r.score}分：${r.reason}（${r.pct>0?"+":""}${r.pct}%）`);
}
const trade=(id,dir)=>act("trade",{stockId:id,dir});
const net=()=>me.cash+Object.entries(me.hold||{}).reduce((a,[k,n])=>a+n*(stocks[k]?.price||0),0);

// ---------- 畫面 ----------
function render(){
  const a=$("acct");a.replaceChildren();
  const rg=document.createElement("div");rg.className="row";rg.style.marginBottom="8px";
  if(user){const t=document.createElement("span");t.textContent="Google："+(user.email||user.displayName||"已登入");
    const o=document.createElement("button");o.className="g";o.textContent="登出 Google";o.onclick=()=>signOut(auth);rg.append(t,o);}
  else{const b=document.createElement("button");b.textContent="以 Google 帳號登入";b.onclick=gLogin;rg.append(b);
    const m=document.createElement("span");m.className="mu";m.textContent="登入後帳號會與你的工坊綁定，進度跨裝置保留";rg.append(m);}
  const r1=document.createElement("div");r1.className="row";
  if(token){const b=document.createElement("span");b.textContent="工坊："+me.name+"　";r1.append(b);
    const sel=document.createElement("select");sel.setAttribute("aria-label","投入造物");
    sel.append(new Option(inv.length?"選擇 24 小時內做出的造物":"24 小時內沒有做出新造物",""));inv.forEach((x,i)=>sel.append(new Option(x.name+"（剩 "+left(x.at)+"）",i)));
    sel.value=item?inv.indexOf(item):"";sel.onchange=()=>{item=inv[sel.value]||null;};r1.append(sel);
    const o=document.createElement("button");o.className="g";o.textContent="登出";o.onclick=()=>{token=null;inv=[];item=null;offP&&offP();me={cash:CFG.startCash,hold:{},name:"訪客"};render();};r1.append(o);
  }else{const b=document.createElement("button");b.textContent="連結《無限煉製》帳號";b.onclick=login;r1.append(b);
    const m=document.createElement("span");m.className="mu";m.textContent="用來驗證工坊身分與 24 小時內的合成紀錄（唯讀）";r1.append(m);}
  const r2=document.createElement("div");r2.className="row";r2.style.marginTop="8px";
  const k=document.createElement("input");k.type="password";k.placeholder="Google API Key（只存在本分頁，每次投入時傳給伺服器判定）";k.className="grow";k.value=S.getItem("gk")||"";k.onchange=()=>S.setItem("gk",k.value.trim());
  const m=document.createElement("input");m.placeholder="模型";m.value=S.getItem("gm")||CFG.defaultModel;m.size=16;m.onchange=()=>S.setItem("gm",m.value.trim());
  r2.append(k,m);a.append(rg,r1,r2);
  $("cash").textContent=fmt(me.cash);$("net").textContent=fmt(net());
  const mk=$("market");mk.replaceChildren();
  Object.entries(stocks).sort().forEach(([id,s])=>{
    const c=document.createElement("div");c.className="card";
    const top=document.createElement("div");top.className="row";
    const nm=document.createElement("b");nm.append(icon(s.emoji),document.createElement("span"));nm.lastChild.textContent=" "+s.name;
    const pr=document.createElement("span");pr.className="p grow";pr.style.textAlign="right";pr.textContent=fmt(s.price);top.append(nm,pr);
    const lp=document.createElement("div");lp.className="mu";lp.textContent=(s.last?"上次投入："+s.last+"　":"")+"持有 "+(me.hold?.[id]||0);
    const act2=document.createElement("div");act2.className="row";act2.style.marginTop="6px";
    [["買 1",()=>trade(id,1)],["賣 1",()=>trade(id,-1)]].forEach(([t,f])=>{const b=document.createElement("button");b.className="g";b.textContent=t;b.disabled=busy||!token||!user;b.onclick=f;act2.append(b);});
    const ij=document.createElement("button");ij.textContent="投入造物";ij.disabled=busy||!token||!user;ij.onclick=()=>inject(id);act2.append(ij);
    c.append(top,lp,act2);mk.append(c);});
}

// ---------- 啟動 ----------
async function main(){
  render();
  if([CFG.firebase.apiKey,CFG.ia.clientId,CFG.api].some(v=>/REPLACE_ME/.test(v))){say("請先在 config.js 填入 Firebase、Client ID 與 Worker 網址");return;}
  const app=initializeApp(CFG.firebase);db=getFirestore(app);
  auth=getAuth(app);getRedirectResult(auth).catch(e=>say("Google 登入失敗："+e.code));
  onAuthStateChanged(auth,u=>{user=u;render();});
  await handleCallback();
  onSnapshot(collection(db,"stocks"),async snap=>{
    if(snap.empty){fetch(CFG.api+"/ensure-market",{method:"POST"}).catch(()=>{});return;}
    stocks={};snap.forEach(d=>stocks[d.id]=d.data());render();});
  onSnapshot(query(collection(db,"feed"),orderBy("at","desc"),limit(15)),snap=>{
    const f=$("feed");f.replaceChildren();snap.forEach(d=>{const x=d.data(),e=document.createElement("div");
      e.textContent=`${x.who} 將「${x.item}」投入 ${x.stock}：${x.score}分，${x.pct>0?"+":""}${x.pct}%（${x.reason}）`;
      e.className=x.pct>0?"up":"dn";f.append(e);});});
  if(token)loadIA().then(render).catch(e=>say(e.message));
}
main();
