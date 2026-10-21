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
const seed=now=>Object.fromEntries(SEED.map(([id,name,emoji,base])=>[id,{name,emoji,base,price:base,bias:0,last:"",t:[now],p:[base]}]));
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
async function inject(d,uid,{stockId,itemName,iaToken,geminiKey}={}){
  if(!/^[a-z]{2,20}$/.test(stockId||"")||typeof itemName!=="string"||!itemName||itemName.length>60)throw bad("參數錯誤");
  const me=await d.ia.me(iaToken);                          // 身分一律由 IA 回傳，不信任客戶端
  await retry(()=>ensureBind(d,uid,me.id));
  const pid=`players/${me.id}`;
  const cool=p=>p&&d.now()-(p.data.lastInjectAt||0)<COOLDOWN;
  const [p0,m0]=await Promise.all([d.db.get(pid),d.db.get(MP)]);
  const s0=m0?.data.stocks?.[stockId];
  if(!s0)throw new HttpError(404,"not-found","找不到這檔股票");
  if(cool(p0))throw new HttpError(429,"resource-exhausted","投入太頻繁，請稍候幾秒");
  if(L.usedRecent(p0?.data.used,itemName,d.now()))throw new HttpError(409,"failed-precondition","這個造物今天已經投入過了（每個造物每天限一次）");
  if(!L.recent(await d.ia.history(iaToken),d.now()).has(itemName))throw new HttpError(403,"permission-denied","只能投入 24 小時內做出的造物");
  const j=await d.judge(s0.name,itemName,geminiKey);
  return retry(async()=>{
    const [p,m]=await Promise.all([d.db.get(pid),d.db.get(MP)]);
    const stocks=m?.data.stocks,s=stocks?.[stockId];
    if(!s)throw new HttpError(404,"not-found","找不到這檔股票");
    if(cool(p))throw new HttpError(429,"resource-exhausted","投入太頻繁，請稍候幾秒");
    if(L.usedRecent(p?.data.used,itemName,d.now()))throw new HttpError(409,"failed-precondition","這個造物今天已經投入過了（每個造物每天限一次）");
    const bias=L.nudge(s.bias,j.score),up=Math.round(L.upProb(bias)*100);
    const next=L.step({...s,bias},d.rand(),d.rand(),d.now(),`${itemName}（${j.score}分）`); // 只改變機率，再隨機走一步
    const pct=Math.round((next.price/s.price-1)*1000)/10,who=me.workshopName||"無名工坊";
    await d.db.commit([
      {path:MP,data:{stocks:{...stocks,[stockId]:next}},ts:["updatedAt"],pre:m.version},
      {path:pid,data:{...(p?{}:{cash:START,hold:{}}),name:who,lastInjectAt:d.now(),used:L.markUsed(p?.data.used,itemName,d.now())},pre:p?p.version:null},
      {path:`feed/${crypto.randomUUID()}`,data:{who,stock:s.name,item:itemName,score:j.score,reason:j.reason,pct,up},ts:["at"],pre:null}]);
    return {...j,pct,price:next.price,up};
  });
}
async function trade(d,uid,{stockId,dir,iaToken}={}){
  if(!/^[a-z]{2,20}$/.test(stockId||"")||(dir!==1&&dir!==-1))throw bad("參數錯誤");
  const me=await d.ia.me(iaToken);
  await retry(()=>ensureBind(d,uid,me.id));
  const pid=`players/${me.id}`;
  return retry(async()=>{
    const [p,m]=await Promise.all([d.db.get(pid),d.db.get(MP)]);
    const s=m?.data.stocks?.[stockId];
    if(!s)throw new HttpError(404,"not-found","找不到這檔股票");
    let r;try{r=L.trade(p?p.data:{cash:START,hold:{}},stockId,s.price,dir);}
    catch(e){throw new HttpError(409,"failed-precondition",e.message);}
    await d.db.commit([{path:pid,data:{name:me.workshopName||"無名工坊",cash:r.cash,hold:r.hold},pre:p?p.version:null}]);
    return {ok:true};
  });
}
export async function route(req,env,d){
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors(env)});
  const path=new URL(req.url).pathname;
  try{
    if(req.method!=="POST")throw new HttpError(405,"invalid-argument","方法不允許");
    if(path==="/ensure-market")return out(env,200,await ensureMarket(d));
    if(path==="/inject"||path==="/trade"){
      const a=await d.verify(req);
      if(a.provider!=="google.com")throw new HttpError(401,"unauthenticated","請先以 Google 帳號登入");
      let body;try{body=await req.json();}catch{throw bad("請求格式錯誤");}
      return out(env,200,await (path==="/inject"?inject:trade)(d,a.uid,body));
    }
    throw new HttpError(404,"not-found","找不到");
  }catch(e){
    if(e instanceof HttpError)return out(env,e.status,{error:{code:e.code,message:e.message}});
    console.error("unhandled",e?.name); // 不記錄訊息與請求內容（可能含 token / API Key）
    return out(env,500,{error:{code:"internal",message:"伺服器錯誤"}});
  }
}
