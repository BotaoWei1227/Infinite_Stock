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
const seed=now=>Object.fromEntries(SEED.map(([id,name,emoji,base])=>[id,{name,emoji,base,price:base,bias:0,biasAt:now,last:"",t:[now],p:[base]}]));
async function ensureMarket(d){
  if(!(await d.db.get(MP))){
    try{await d.db.commit([{path:MP,data:{stocks:seed(d.now())},ts:["updatedAt"],pre:null}]);}
    catch(e){if(!(e instanceof HttpError&&e.code==="conflict"))throw e;}
  }
  return {ok:true};
}
// 排程：每 2 分鐘讓每檔股票隨機走一步（整個行情在單一文件，一次寫入）
export async function tick(d){
  if(!(await d.db.get(MP)))return ensureMarket(d);
  return retry(async()=>{
    const m=await d.db.get(MP),now=d.now(),stocks={};
    for(const [id,s] of Object.entries(m.data.stocks))stocks[id]=L.step(s,d.rand(),d.rand(),now);
    await d.db.commit([{path:MP,data:{stocks},ts:["updatedAt"],pre:m.version}]);
    return {ok:true};
  });
}
const STRIKE_MSG="欠款太多又拖過一天，黑道找上門了！資產被清空，只能重新開始。";
// 黑道：欠款連續超過上限滿 24 小時 → 清空資產（保留已投入紀錄），並在全服動態留下一筆
async function strikeIfDue(d,pid,p){
  const now=d.now();
  if(!p||!L.mobDue(p.data.loan,now))return;
  const owed=Math.round(L.owed(p.data.loan,now)*100)/100;
  await d.db.commit([
    {path:pid,data:{cash:START,hold:{},loan:{p:0,t:now},bankrupt:(p.data.bankrupt||0)+1},pre:p.version},
    {path:`feed/${crypto.randomUUID()}`,data:{who:p.data.name||"玩家",mob:true,owed},ts:["at"],pre:null}]);
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
  if(!dev&&L.usedRecent(p0?.data.used,itemName,d.now()))throw new HttpError(409,"failed-precondition","這個造物今天已經投入過了（每個造物每天限一次）");
  if(!dev&&!L.recent(await d.ia.history(iaToken),d.now()).has(itemName))throw new HttpError(403,"permission-denied","只能投入 24 小時內做出的造物");
  const j=await d.judge(s0.name,itemName,geminiKey);
  return retry(async()=>{
    const [p,m]=await Promise.all([d.db.get(pid),d.db.get(MP)]);
    await strikeIfDue(d,pid,p);
    const stocks=m?.data.stocks,s=stocks?.[stockId];
    if(!s)throw new HttpError(404,"not-found","找不到這檔股票");
    if(cool(p))throw new HttpError(429,"resource-exhausted","投入太頻繁，請稍候幾秒");
    if(!dev&&L.usedRecent(p?.data.used,itemName,d.now()))throw new HttpError(409,"failed-precondition","這個造物今天已經投入過了（每個造物每天限一次）");
    const now=d.now(),bias=L.nudge(L.effBias(s,now),j.score),up=Math.round(L.upProb(bias)*100);
    const next={...s,bias,biasAt:now,last:`${itemName}（${j.score}分）`};   // 只改變上漲機率；價格由排程隨機走，投入當下不會跳動
    const who=dev?(a.name||"開發者"):(me.workshopName||a.name||"無名工坊");
    await d.db.commit([
      {path:MP,data:{stocks:{...stocks,[stockId]:next}},ts:["updatedAt"],pre:m.version},
      {path:pid,data:{...(p?{}:{cash:START,hold:{}}),name:who,lastInjectAt:d.now(),...(dev?{}:{used:L.markUsed(p?.data.used,itemName,d.now())})},pre:p?p.version:null},
      {path:`feed/${crypto.randomUUID()}`,data:{who,stock:s.name,item:itemName,score:j.score,rel:j.relation,pass:L.passes(j.score),reason:j.reason,up,...(dev?{dev:true}:{})},ts:["at"],pre:null}]);
    return {...j,price:s.price,up,pass:L.passes(j.score),threshold:L.SIM_THRESHOLD};
  });
}
// 買賣：只需要 Google 登入，不需要連結 IA
async function trade(d,a,{stockId,dir}={}){
  if(!/^[a-z]{2,20}$/.test(stockId||"")||(dir!==1&&dir!==-1))throw bad("參數錯誤");
  const pid=`players/${a.uid}`;
  return retry(async()=>{
    const [p,m]=await Promise.all([d.db.get(pid),d.db.get(MP)]);
    await strikeIfDue(d,pid,p);
    const s=m?.data.stocks?.[stockId];
    if(!s)throw new HttpError(404,"not-found","找不到這檔股票");
    let r;try{r=L.trade(p?p.data:{cash:START,hold:{}},stockId,s.price,dir);}
    catch(e){throw new HttpError(409,"failed-precondition",e.message);}
    const stocks={...m.data.stocks,[stockId]:{...s,bias:L.tradeNudge(L.effBias(s,d.now()),dir),biasAt:d.now()}};   // 買進推升、賣出壓低上漲機率（買賣壓力）；不直接改價格，避免買賣套利
    await d.db.commit([
      {path:MP,data:{stocks},ts:["updatedAt"],pre:m.version},
      {path:pid,data:{...(p?{}:{name:a.name||"玩家"}),cash:r.cash,hold:r.hold},pre:p?p.version:null}]);
    return {ok:true};
  });
}
// 銀行：借款 / 還款 / 全額還清 / check（只檢查黑道）。同樣不需要 IA
async function bank(d,a,{action,amount,all}={}){
  if(!["borrow","repay","check"].includes(action))throw bad("參數錯誤");
  const amt=Math.round(Number(amount)*100)/100,full=action==="repay"&&all===true;
  if(action!=="check"&&!full&&!(Number.isFinite(amt)&&amt>=.01&&amt<=1e6))throw bad("金額不正確（0.01–1,000,000）");
  const pid=`players/${a.uid}`;
  return retry(async()=>{
    const p=await d.db.get(pid),now=d.now();
    await strikeIfDue(d,pid,p);
    if(action==="check")return {ok:true};
    let r;try{r=action==="borrow"?L.borrow(p?p.data:{cash:START},amt,now):L.repay(p?p.data:{cash:START},amt,now,full);}
    catch(e){throw new HttpError(409,"failed-precondition",e.message);}
    await d.db.commit([{path:pid,data:{...(p?{}:{hold:{},name:a.name||"玩家"}),cash:r.cash,loan:r.loan},pre:p?p.version:null}]);
    return {ok:true,cash:r.cash,owed:Math.round(L.owed(r.loan,now)*100)/100};
  });
}
export async function route(req,env,d){
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors(env)});
  const path=new URL(req.url).pathname;
  try{
    if(req.method!=="POST")throw new HttpError(405,"invalid-argument","方法不允許");
    if(path==="/ensure-market")return out(env,200,await ensureMarket(d));
    if(path==="/inject"||path==="/trade"||path==="/bank"||path==="/whoami"){
      const a=await d.verify(req);
      if(a.provider!=="google.com")throw new HttpError(401,"unauthenticated","請先以 Google 帳號登入");
      if(path==="/whoami")return out(env,200,{dev:isDev(d,a)});
      let body;try{body=await req.json();}catch{throw bad("請求格式錯誤");}
      return out(env,200,await (path==="/inject"?inject:path==="/bank"?bank:trade)(d,a,body));
    }
    throw new HttpError(404,"not-found","找不到");
  }catch(e){
    if(e instanceof HttpError)return out(env,e.status,{error:{code:e.code,message:e.message}});
    console.error("unhandled",e?.name); // 不記錄訊息與請求內容（可能含 token / API Key）
    return out(env,500,{error:{code:"internal",message:"伺服器錯誤"}});
  }
}
