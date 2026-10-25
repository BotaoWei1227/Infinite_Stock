import {HttpError} from "./errors.js";
import * as L from "./logic.js";
const START=50,COOLDOWN=8000,MP="market/state";
const SEED=[["fire","火","🔥",12],["water","水","💧",10],["earth","土","🪨",8],["wind","風","🌪️",9],["steam","蒸氣","♨️",18],["thunder","雷","⚡",15]];
const bad=m=>new HttpError(400,"invalid-argument",m);
const cors=env=>({"Access-Control-Allow-Origin":env.ALLOWED_ORIGIN||"*","Access-Control-Allow-Headers":"Authorization, Content-Type","Access-Control-Allow-Methods":"POST, OPTIONS","Vary":"Origin"});
const out=(env,status,body)=>new Response(JSON.stringify(body),{status,headers:{...cors(env),"Content-Type":"application/json"}});

async function retry(fn){ // 樂觀鎖衝突時重讀重算
  for(let i=0;;i++){try{return await fn();}catch(e){if(!(e instanceof HttpError&&e.code==="conflict"&&i<3))throw e;}}
}
// Google 帳號 ↔ IA 工坊一對一綁定（首次動作時建立，之後不得更換）
async function ensureBind(d,uid,iaId){
  const l=await d.db.get(`links/${uid}`);
  if(l){if(l.data.iaId!==iaId)throw new HttpError(409,"failed-precondition","此 Google 帳號已綁定另一個工坊");return;}
  const b=await d.db.get(`iaLinks/${iaId}`);
  if(b&&b.data.uid!==uid)throw new HttpError(409,"failed-precondition","此工坊已綁定另一個 Google 帳號");
  await d.db.commit([{path:`links/${uid}`,data:{iaId},ts:["at"],pre:null},{path:`iaLinks/${iaId}`,data:{uid},ts:["at"],pre:b?b.version:null}]);
}
const PRIV="secret/odds";   // 私密文件：玩家的機率偏移 + 財經活動影響。Firestore 規則不開放任何客戶端讀取，只有 Worker（服務帳戶）讀得到
const seed=now=>Object.fromEntries(SEED.map(([id,name,emoji,base])=>[id,{name,emoji,base,price:base,last:"",t:[now],p:[base]}]));
async function ensureMarket(d){
  if(!(await d.db.get(MP))){
    try{await d.db.commit([{path:MP,data:{stocks:seed(d.now())},ts:["updatedAt"],pre:null},{path:PRIV,data:{bias:{},events:[]},pre:null}]);}
    catch(e){if(!(e instanceof HttpError&&e.code==="conflict"))throw e;}
  }
  return {ok:true};
}
// 讀私密機率文件；舊版把偏移/活動放在公開行情裡 → 第一次使用時搬進私密文件，並把公開文件裡的機率欄位清掉
async function loadOdds(d){
  const o=await d.db.get(PRIV);if(o)return o;
  const m=await d.db.get(MP);if(!m)throw new HttpError(404,"not-found","行情尚未建立");
  const bias={},stocks={};
  for(const [id,{bias:b,biasAt:at,...pub}] of Object.entries(m.data.stocks)){stocks[id]=pub;if(b)bias[id]={v:b,at:at??d.now()};}
  try{await d.db.commit([{path:PRIV,data:{bias,events:m.data.events||[]},pre:null},{path:MP,data:{stocks,events:undefined},pre:m.version}]);}
  catch(e){if(!(e instanceof HttpError&&e.code==="conflict"))throw e;}
  return d.db.get(PRIV);
}
// 排程：每 2 分鐘讓每檔股票隨機走一步（機率只讀私密文件，公開行情只寫價格與走勢）
export async function tick(d){
  if(!(await d.db.get(MP)))return ensureMarket(d);
  return retry(async()=>{
    const [m,o]=await Promise.all([d.db.get(MP),loadOdds(d)]),now=d.now(),stocks={},ev=L.activeEvents(o.data.events,now);
    for(const [id,s] of Object.entries(m.data.stocks))stocks[id]=L.step(s,d.rand(),d.rand(),now,L.effOdds(o.data.bias?.[id],now),L.eventShift(ev,id,now));
    const ops=[{path:MP,data:{stocks},ts:["updatedAt"],pre:m.version}];
    if(ev.length!==(o.data.events||[]).length)ops.push({path:PRIV,data:{events:ev},pre:o.version});   // 順便清掉過期活動
    await d.db.commit(ops);
    return {ok:true};
  });
}

const STRIKE_MSG="欠款太多又拖過一天，黑道找上門了！資產已重製，並被關押 24 小時。";
const SENTENCE=864e5,PLAYER_ROBBERY_FEE=10000,ROBBERY_FINE=10000,BANK_ROBBERY_FEE=5000,BANK_LOOT=50000;
const ANALYST_MIN=1000,ANALYST_MAX=10000;
function assertFree(p,now){if((p?.data.jailUntil||0)>now)throw new HttpError(403,"imprisoned",`你仍在服刑，${new Date(p.data.jailUntil).toISOString()} 後才能行動`);}
// 黑道：欠款連續超過上限滿 24 小時 → 資產重製，並關押 24 小時
async function strikeIfDue(d,pid,p){
  const now=d.now();
  if(!p||!L.mobDue(p.data.loan,now))return;
  const owed=Math.round(L.owed(p.data.loan,now)*100)/100;
  await d.db.commit([
    {path:pid,data:{cash:START,hold:{},loan:{p:0,t:now},dem:{a:0,t:now},tds:[],bankrupt:(p.data.bankrupt||0)+1,jailUntil:now+SENTENCE},pre:p.version},
    {path:`feed/${crypto.randomUUID()}`,data:{who:p.data.customName||p.data.name||"玩家",mob:true,owed},ts:["at"],pre:null}]);
  throw new HttpError(409,"mob",STRIKE_MSG);
}
// 開發者：以 Google 驗證過的信箱比對（名單在機密 DEV_EMAILS），可免 IA、自行輸入造物
const isDev=(d,a)=>a.emailVerified===true&&!!a.email&&(d.devEmails||[]).includes(a.email);
async function inject(d,a,{stockId,itemName,iaToken,geminiKey}={}){
  if(typeof itemName==="string")itemName=itemName.trim();
  if(!/^[a-z]{2,20}$/.test(stockId||"")||typeof itemName!=="string"||!itemName||itemName.length>60||/[\u0000-\u001f]/.test(itemName))throw bad("參數錯誤");
  const dev=isDev(d,a);
  let me=null;
  if(!dev){                                                  // 一般玩家：投入需要 IA，身分與合成紀錄都由 IA 回傳，不信任客戶端
    me=await d.ia.me(iaToken);
    await retry(()=>ensureBind(d,a.uid,me.id));
  }
  const pid=`players/${a.uid}`;
  const cool=p=>p&&d.now()-(p.data.lastInjectAt||0)<COOLDOWN;
  const [p0,m0]=await Promise.all([d.db.get(pid),d.db.get(MP)]);
  await strikeIfDue(d,pid,p0);
  const s0=m0?.data.stocks?.[stockId];
  if(!s0)throw new HttpError(404,"not-found","找不到這檔股票");
  if(cool(p0))throw new HttpError(429,"resource-exhausted","投入太頻繁，請稍候幾秒");
  if(!dev&&L.usedBefore(p0?.data.used,itemName))throw new HttpError(409,"failed-precondition","這個造物你已經投入過了（同一個造物只能投入一次，不能重複）");
  if(!dev&&!L.recent(await d.ia.history(iaToken),d.now()).has(itemName))throw new HttpError(403,"permission-denied","只能投入 24 小時內做出的造物");
  const j=await d.judge(s0.name,itemName,geminiKey);
  return retry(async()=>{
    const [p,m,o]=await Promise.all([d.db.get(pid),d.db.get(MP),loadOdds(d)]);
    await strikeIfDue(d,pid,p);
    const stocks=m?.data.stocks,s=stocks?.[stockId];
    if(!s)throw new HttpError(404,"not-found","找不到這檔股票");
    if(cool(p))throw new HttpError(429,"resource-exhausted","投入太頻繁，請稍候幾秒");
    if(!dev&&L.usedBefore(p?.data.used,itemName))throw new HttpError(409,"failed-precondition","這個造物你已經投入過了（同一個造物只能投入一次，不能重複）");
    const now=d.now(),bias=L.nudge(L.effOdds(o.data.bias?.[stockId],now),j.score);   // 只改變上漲機率；價格由排程隨機走，投入當下不會跳動
    const up=Math.round(L.upProb(bias+L.eventShift(o.data.events,stockId,now))*100);
    const who=p?.data.customName|| (dev?(a.name||"開發者"):(me.workshopName||a.name||"無名工坊"));
    await d.db.commit([
      {path:MP,data:{stocks:{...stocks,[stockId]:{...s,last:`${itemName}（${j.score}分）`}}},ts:["updatedAt"],pre:m.version},
      {path:PRIV,data:{bias:{...o.data.bias,[stockId]:{v:bias,at:now}}},pre:o.version},
      {path:pid,data:{...(p?{}:{cash:START,hold:{}}),name:who,lastInjectAt:d.now(),...(dev?{}:{used:L.markUsed(p?.data.used,itemName,d.now())})},pre:p?p.version:null},
      {path:`feed/${crypto.randomUUID()}`,data:{who,stock:s.name,item:itemName,score:j.score,rel:j.relation,pass:L.passes(j.score),reason:j.reason,...(dev?{dev:true}:{})},ts:["at"],pre:null}]);
    // 機率只有開發者看得到：一般玩家的回應不含 up
    return {...j,price:s.price,pass:L.passes(j.score),threshold:L.SIM_THRESHOLD,...(dev?{up}:{})};
  });
}
// 買賣：只需要 Google 登入，不需要連結 IA
async function trade(d,a,{stockId,dir,shares=1}={}){
  if(!/^[a-z]{2,20}$/.test(stockId||"")||(dir!==1&&dir!==-1)||![1,10,100].includes(shares))throw bad("參數錯誤");
  const pid=`players/${a.uid}`;
  return retry(async()=>{
    const [p,m,o]=await Promise.all([d.db.get(pid),d.db.get(MP),loadOdds(d)]);
    await strikeIfDue(d,pid,p);
    const s=m?.data.stocks?.[stockId];
    if(!s)throw new HttpError(404,"not-found","找不到這檔股票");
    let r;try{r=L.trade(p?p.data:{cash:START,hold:{}},stockId,s.price,dir,shares);}
    catch(e){throw new HttpError(409,"failed-precondition",e.message);}
    const now=d.now();   // 買進推升、賣出壓低上漲機率（買賣壓力）；不直接改價格，避免買賣套利
    await d.db.commit([
      {path:PRIV,data:{bias:{...o.data.bias,[stockId]:{v:L.tradeNudge(L.effOdds(o.data.bias?.[stockId],now),dir,shares),at:now}}},pre:o.version},
      {path:pid,data:{...(p?{}:{name:a.name||"玩家"}),cash:r.cash,hold:r.hold},pre:p?p.version:null}]);
    return {ok:true};
  });
}
// 銀行：借款 / 還款 / 全額還清 / 活存存提 / 定存存入與提前解約 / check（只檢查黑道）。都不需要 IA
const DEP=["dem_in","dem_out","td_in","td_break"];
async function bank(d,a,{action,amount,all,at}={}){
  if(!["borrow","repay","check",...DEP].includes(action))throw bad("參數錯誤");
  const amt=Math.round(Number(amount)*100)/100,everything=all===true&&(action==="repay"||action==="dem_out");
  if(["borrow","repay","dem_in","dem_out","td_in"].includes(action)&&!everything&&!(Number.isFinite(amt)&&amt>=.01&&amt<=1e6))throw bad("金額不正確（0.01–1,000,000）");
  if(action==="td_break"&&!Number.isFinite(Number(at)))throw bad("參數錯誤");
  const pid=`players/${a.uid}`;
  return retry(async()=>{
    const p=await d.db.get(pid),now=d.now();
    await strikeIfDue(d,pid,p);
    if(action==="check")return {ok:true};
    const data=p?p.data:{cash:START};
    let upd;
    try{
      upd=action==="borrow"?L.borrow(data,amt,now):action==="repay"?L.repay(data,amt,now,everything)
        :action==="dem_in"?L.demIn(data,amt,now):action==="dem_out"?L.demOut(data,amt,now,everything)
        :action==="td_in"?L.tdIn(data,amt,now):L.tdBreak(data,Number(at),now);
    }catch(e){throw new HttpError(409,"failed-precondition",e.message);}
    await d.db.commit([{path:pid,data:{...(p?{}:{hold:{},name:a.name||"玩家"}),...upd},pre:p?p.version:null}]);
    const after={...data,...upd},r2=n=>Math.round(n*100)/100;
    return {ok:true,cash:upd.cash,owed:r2(L.owed(after.loan,now)),deposits:r2(L.depositsValue(after,now))};
  });
}
// ---- 財經新聞：開發者發布活動（名稱、資料、持續時間、各股票上漲基準機率 ±x、普發現金）；玩家在活動期間領一次現金
const NEWS_ID=/^[0-9a-f-]{36}$/,noCtl=t=>!/[\u0000-\u0008\u000b-\u001f]/.test(t);    // 活動資料允許換行
async function newsPublish(d,a,{title,body:text,durationMin,effects,cash}){
  title=typeof title==="string"?title.trim():"";text=typeof text==="string"?text.trim():"";
  if(!title||title.length>40||!noCtl(title)||/\n/.test(title))throw bad("活動名稱要 1–40 字（不能換行）");
  if(text.length>600||!noCtl(text))throw bad("活動資料最多 600 字");
  const mins=Number(durationMin);if(!(mins>=1&&mins<=43200))throw bad("活動持續時間要在 1 分鐘～30 天之間");
  const money=Math.round(Number(cash||0)*100)/100;if(!(money>=0&&money<=1e6))throw bad("普發現金要在 0～1,000,000 之間");
  if(effects!=null&&(typeof effects!=="object"||Array.isArray(effects)))throw bad("活動影響格式不正確");
  const eff={},src=effects||{};
  if(Object.keys(src).length>12)throw bad("活動影響的股票太多");
  for(const [id,x] of Object.entries(src)){
    if(!/^[a-z]{2,20}$/.test(id)||!Number.isInteger(x)||x===0||Math.abs(x)>L.MAX_SHIFT)throw bad(`活動影響要是 ±1～±${L.MAX_SHIFT} 的整數`);
    eff[id]=x;
  }
  const id=crypto.randomUUID();
  return retry(async()=>{
    const [m,o]=await Promise.all([d.db.get(MP),loadOdds(d)]);
    for(const sid of Object.keys(eff))if(!m.data.stocks[sid])throw bad(`找不到股票 ${sid}`);
    const now=d.now(),until=now+Math.round(mins*60000),ev=L.activeEvents(o.data.events,now);
    if(Object.keys(eff).length){   // 純資訊活動（沒有影響）不佔用名額
      if(ev.length>=L.MAX_EVENTS)throw bad("同時進行的活動太多了，請先結束幾個");
      ev.push({id,until,shift:Object.fromEntries(Object.entries(eff).map(([k,x])=>[k,x/100]))});
    }
    // 公開的新聞文件「不含」活動影響（機率只有開發者看得到）；影響只存在私密文件
    await d.db.commit([
      {path:PRIV,data:{events:ev},pre:o.version},
      {path:`news/${id}`,data:{title,body:text,by:a.name||"開發者",endsAt:until,durationMin:mins,cash:money},ts:["at"],pre:null}]);
    return {ok:true,id,endsAt:until};
  });
}
async function newsEnd(d,{id}){
  if(!NEWS_ID.test(id||""))throw bad("參數錯誤");
  return retry(async()=>{
    const [n,o]=await Promise.all([d.db.get(`news/${id}`),loadOdds(d)]);
    if(!n)throw new HttpError(404,"not-found","找不到這個活動");
    const now=d.now();
    await d.db.commit([
      {path:`news/${id}`,data:{endsAt:Math.min(n.data.endsAt,now)},pre:n.version},
      {path:PRIV,data:{events:L.activeEvents(o.data.events,now).filter(e=>e.id!==id)},pre:o.version}]);
    return {ok:true};
  });
}
async function newsClaim(d,a,{id}){
  if(!NEWS_ID.test(id||""))throw bad("參數錯誤");
  const pid=`players/${a.uid}`;
  return retry(async()=>{
    const [p,n]=await Promise.all([d.db.get(pid),d.db.get(`news/${id}`)]),now=d.now();
    await strikeIfDue(d,pid,p);
    if(!n||n.data.endsAt<=now||!(n.data.cash>0))throw new HttpError(409,"failed-precondition","這個活動已經結束，或沒有現金可以領");
    if(p?.data.claims&&Object.hasOwn(p.data.claims,id))throw new HttpError(409,"failed-precondition","你已經領過這次的普發現金了");
    const data=p?p.data:{cash:START},amount=n.data.cash;
    await d.db.commit([{path:pid,data:{...(p?{}:{hold:{},name:a.name||"玩家"}),cash:Math.round((data.cash+amount)*100)/100,claims:L.markClaim(data.claims,id,now)},pre:p?p.version:null}]);
    return {ok:true,amount};
  });
}
async function news(d,a,body={}){
  if(body.action==="claim")return newsClaim(d,a,body);
  if(body.action!=="publish"&&body.action!=="end")throw bad("參數錯誤");
  if(!isDev(d,a))throw new HttpError(403,"permission-denied","只有開發者可以發布或結束活動");
  return body.action==="publish"?newsPublish(d,a,body):newsEnd(d,body);
}
async function setPlayerName(d,a,{name}={}){
  if(typeof name!=="string")throw bad("名稱格式不正確");name=name.trim();
  if(!name||name.length>20||/[\u0000-\u001f]/.test(name))throw bad("名稱需為 1–20 字，且不能包含控制字元");
  const path=`players/${a.uid}`;
  return retry(async()=>{const p=await d.db.get(path);await d.db.commit([{path,data:{...(p?{}:{cash:START,hold:{},name:a.name||"玩家"}),customName:name},pre:p?p.version:null}]);return {ok:true,name};});
}
async function leaderboard(d,a){
  const [players,m]=await Promise.all([d.db.list("players"),d.db.get(MP)]),stocks=m?.data.stocks||{},now=d.now();
  return {rows:players.map(({id,data:p})=>({isMe:id===a.uid,name:p.customName||p.name||"玩家",value:Math.round((Number(p.cash||0)+Object.entries(p.hold||{}).reduce((n,[id,q])=>n+Number(q||0)*Number(stocks[id]?.price||0),0)-L.owed(p.loan,now)+L.depositsValue(p,now))*100)/100})).sort((a,b)=>b.value-a.value||a.name.localeCompare(b.name,"zh-Hant")).slice(0,100)};
}
async function analyst(d,a,{stockId,amount}={}){
  const fee=Number(amount);
  if(!/^[a-z]{2,20}$/.test(stockId||"")||!Number.isInteger(fee)||fee<ANALYST_MIN||fee>ANALYST_MAX)throw bad("請選擇股票並支付 1,000～10,000 元整數費用");
  const path=`players/${a.uid}`;
  return retry(async()=>{
    const [p,m,o]=await Promise.all([d.db.get(path),d.db.get(MP),loadOdds(d)]),now=d.now(),s=m?.data.stocks?.[stockId];
    if(!s)throw new HttpError(404,"not-found","找不到這檔股票");
    const data=p?p.data:{cash:START,hold:{},name:a.name||"玩家"};
    if(Number(data.cash||0)<fee)throw new HttpError(409,"failed-precondition","現金不足，付不起分析費");
    const actual=L.upProb(L.effOdds(o.data.bias?.[stockId],now)+L.eventShift(L.activeEvents(o.data.events,now),stockId,now))*100;
    const radius=50-(fee-ANALYST_MIN)*40/(ANALYST_MAX-ANALYST_MIN),rand=d.secureRand?d.secureRand():d.rand();
    const estimate=Math.min(90,Math.max(10,actual+(rand*2-1)*radius));
    await d.db.commit([{path,data:{...(p?{}:{hold:{},name:a.name||"玩家"}),cash:Math.round((Number(data.cash)-fee)*100)/100},pre:p?p.version:null}]);
    return {ok:true,fee,stock:s.name,estimate:Math.round(estimate*10)/10,radius:Math.round(radius*10)/10,rude:fee<5000};
  });
}
async function blackmarket(d,a,{action,targetUid}={}){
  if(action==="targets"){
    const players=await d.db.list("players");
    return {targets:players.filter(x=>x.id!==a.uid).map(({id,data:p})=>({uid:id,name:p.customName||p.name||"玩家",cash:Math.round(Number(p.cash||0)*100)/100})).sort((x,y)=>x.name.localeCompare(y.name,"zh-Hant"))};
  }
  if(!["rob-player","rob-bank"].includes(action))throw bad("黑市行動不正確");
  if(action==="rob-player"&&(!/^[^/]{1,128}$/.test(targetUid||"")||targetUid===a.uid))throw bad("請選擇其他玩家");
  return retry(async()=>{
    const now=d.now(),pid=`players/${a.uid}`,p=await d.db.get(pid);await strikeIfDue(d,pid,p);assertFree(p,now);
    const fee=action==="rob-player"?PLAYER_ROBBERY_FEE:BANK_ROBBERY_FEE;
    const fine=ROBBERY_FINE,minimum=fee+fine;
    if(Number(p?.data.cash??START)<minimum)throw new HttpError(409,"failed-precondition",`現金至少需要 ${minimum} 元（含可能的罰金準備金）`);
    const caught=(d.secureRand?d.secureRand():d.rand())>=(action==="rob-player" ? 0.3 : 0.1);
    if(caught){
      const jailUntil=now+SENTENCE,cash=Math.round((Number(p?.data.cash??START)-fee-fine)*100)/100;
      await d.db.commit([{path:pid,data:{...(p?{}:{hold:{},name:a.name||"玩家"}),cash,jailUntil,robberies:(p?.data.robberies||0)+1},pre:p?p.version:null},
        {path:`feed/${crypto.randomUUID()}`,data:{who:p?.data.customName||p?.data.name||a.name||"玩家",robbery:true,caught:true,kind:action},ts:["at"],pre:null}]);
      return {ok:true,caught:true,fine,jailUntil,fee};
    }
    if(action==="rob-bank"){
      const cash=Math.round((Number(p?.data.cash??START)-fee+BANK_LOOT)*100)/100;
      await d.db.commit([{path:pid,data:{...(p?{}:{hold:{},name:a.name||"玩家"}),cash,robberies:(p?.data.robberies||0)+1},pre:p?p.version:null},
        {path:`feed/${crypto.randomUUID()}`,data:{who:p?.data.customName||p?.data.name||a.name||"玩家",robbery:true,caught:false,kind:action},ts:["at"],pre:null}]);
      return {ok:true,caught:false,loot:BANK_LOOT,fee};
    }
    const victimPath=`players/${targetUid}`,victim=await d.db.get(victimPath);
    if(!victim)throw new HttpError(404,"not-found","找不到這位玩家");
    const stolen=Math.round(Number(victim.data.cash||0)*.3*100)/100;
    await d.db.commit([
      {path:pid,data:{...(p?{}:{hold:{},name:a.name||"玩家"}),cash:Math.round((Number(p?.data.cash??START)-fee+stolen)*100)/100,robberies:(p?.data.robberies||0)+1},pre:p?p.version:null},
      {path:victimPath,data:{cash:Math.round((Number(victim.data.cash||0)-stolen)*100)/100},pre:victim.version},
      {path:`feed/${crypto.randomUUID()}`,data:{who:p?.data.customName||p?.data.name||a.name||"玩家",robbery:true,caught:false,kind:action},ts:["at"],pre:null}]);
    return {ok:true,caught:false,stolen,fee};
  });
}
export async function route(req,env,d){
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors(env)});
  const path=new URL(req.url).pathname;
  try{
    if(req.method!=="POST")throw new HttpError(405,"invalid-argument","方法不允許");
    if(path==="/ensure-market")return out(env,200,await ensureMarket(d));
    if(path==="/inject"||path==="/trade"||path==="/bank"||path==="/news"||path==="/whoami"||path==="/odds"||path==="/profile"||path==="/leaderboard"||path==="/blackmarket"||path==="/analyst"){
      const a=await d.verify(req);
      if(a.provider!=="google.com")throw new HttpError(401,"unauthenticated","請先以 Google 帳號登入");
      if(path==="/whoami")return out(env,200,{dev:isDev(d,a)});
      if(path==="/leaderboard")return out(env,200,await leaderboard(d,a));
      if(path==="/blackmarket"&&req.method==="POST"){
        const preBody=await req.clone().json().catch(()=>({}));
        if(preBody.action==="targets")return out(env,200,await blackmarket(d,a,preBody));
      }
      if(path==="/odds"){   // 只有開發者看得到各股票的上漲機率（偏移與活動影響）；一般玩家一律 403
        if(!isDev(d,a))throw new HttpError(403,"permission-denied","只有開發者可以查看");
        const o=await loadOdds(d),now=d.now();
        return out(env,200,{now,bias:o.data.bias||{},events:L.activeEvents(o.data.events,now)});
      }
      let body;try{body=await req.json();}catch{throw bad("請求格式錯誤");}
      if(path!=="/leaderboard"&&path!=="/blackmarket")assertFree(await d.db.get(`players/${a.uid}`),d.now());
      return out(env,200,await (path==="/inject"?inject:path==="/bank"?bank:path==="/news"?news:path==="/profile"?setPlayerName:path==="/blackmarket"?blackmarket:path==="/analyst"?analyst:trade)(d,a,body));
    }
    throw new HttpError(404,"not-found","找不到");
  }catch(e){
    if(e instanceof HttpError)return out(env,e.status,{error:{code:e.code,message:e.message}});
    console.error("unhandled",e?.name); // 不記錄訊息與請求內容（可能含 token / API Key）
    return out(env,500,{error:{code:"internal",message:"伺服器錯誤"}});
  }
}
