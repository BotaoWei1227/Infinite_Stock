import {HttpError} from "./errors.js";
import * as L from "./logic.js";
const START=50,COOLDOWN=8000;
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
async function ensureMarket(d){
  if(await d.db.empty("stocks")){
    try{await d.db.commit(SEED.map(([id,name,emoji,price])=>({path:`stocks/${id}`,data:{name,emoji,price,last:""},ts:["updatedAt"],pre:null})));}
    catch(e){if(!(e instanceof HttpError&&e.code==="conflict"))throw e;}
  }
  return {ok:true};
}
async function inject(d,uid,{stockId,itemName,iaToken,geminiKey,model}={}){
  if(!/^[a-z]{2,20}$/.test(stockId||"")||typeof itemName!=="string"||!itemName||itemName.length>60)throw bad("參數錯誤");
  const me=await d.ia.me(iaToken);                          // 身分一律由 IA 回傳，不信任客戶端
  await retry(()=>ensureBind(d,uid,me.id));
  const pid=`players/${me.id}`,sid=`stocks/${stockId}`;
  const cool=p=>p&&d.now()-(p.data.lastInjectAt||0)<COOLDOWN;
  const [p0,s0]=await Promise.all([d.db.get(pid),d.db.get(sid)]);
  if(!s0)throw new HttpError(404,"not-found","找不到這檔股票");
  if(cool(p0))throw new HttpError(429,"resource-exhausted","投入太頻繁，請稍候幾秒");
  if(!L.recent(await d.ia.history(iaToken),d.now()).has(itemName))throw new HttpError(403,"permission-denied","只能投入 24 小時內做出的造物");
  const j=await d.judge(s0.data.name,itemName,geminiKey,model);
  const pct=L.roll(j.score,d.rand(),d.rand()),pr=Math.round(pct*1000)/10;
  return retry(async()=>{
    const [p,s]=await Promise.all([d.db.get(pid),d.db.get(sid)]);
    if(!s)throw new HttpError(404,"not-found","找不到這檔股票");
    if(cool(p))throw new HttpError(429,"resource-exhausted","投入太頻繁，請稍候幾秒");
    const price=L.applyPct(s.data.price,pct),who=me.workshopName||"無名工坊";
    await d.db.commit([ // 股價、玩家冷卻、全服動態在同一個原子提交
      {path:sid,data:{price,last:`${itemName}（${j.score}分）`},ts:["updatedAt"],pre:s.version},
      {path:pid,data:{...(p?{}:{cash:START,hold:{}}),name:who,lastInjectAt:d.now()},pre:p?p.version:null},
      {path:`feed/${crypto.randomUUID()}`,data:{who,stock:s.data.name,item:itemName,score:j.score,reason:j.reason,pct:pr},ts:["at"],pre:null}]);
    return {...j,pct:pr,price};
  });
}
async function trade(d,uid,{stockId,dir,iaToken}={}){
  if(!/^[a-z]{2,20}$/.test(stockId||"")||(dir!==1&&dir!==-1))throw bad("參數錯誤");
  const me=await d.ia.me(iaToken);
  await retry(()=>ensureBind(d,uid,me.id));
  const pid=`players/${me.id}`,sid=`stocks/${stockId}`;
  return retry(async()=>{
    const [p,s]=await Promise.all([d.db.get(pid),d.db.get(sid)]);
    if(!s)throw new HttpError(404,"not-found","找不到這檔股票");
    let r;try{r=L.trade(p?p.data:{cash:START,hold:{}},stockId,s.data.price,dir);}
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
