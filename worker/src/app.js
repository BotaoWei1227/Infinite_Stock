import {HttpError} from "./errors.js";
import * as L from "./logic.js";
import * as B from "../../public/board.js";
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
const DEFAULT_SETTINGS={loanRate:L.RATE,demRate:L.DEM_RATE,tdRate:L.TD_RATE,threshold:L.SIM_THRESHOLD};
const settingsOf=o=>({...DEFAULT_SETTINGS,...(o?.data?.settings||{})});
const NEWS_QUEUE="secret/newsSchedule",TAIPEI="Asia/Taipei";
const seed=now=>Object.fromEntries(SEED.map(([id,name,emoji,base])=>[id,{name,emoji,base,price:base,last:"",t:[now],p:[base]}]));
const taipeiParts=now=>Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:TAIPEI,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(now)).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
const taipeiDay=now=>{const p=taipeiParts(now);return `${p.year}-${p.month}-${p.day}`;};
const marketOpen=now=>{const p=taipeiParts(now),h=Number(p.hour);return h>=9&&h<24;};
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
  if(!marketOpen(d.now()))return {ok:true,closed:true};
  return retry(async()=>{
    const [m,o]=await Promise.all([d.db.get(MP),loadOdds(d)]),now=d.now(),stocks={},ev=L.activeEvents(o.data.events,now);
    for(const [id,s] of Object.entries(m.data.stocks))stocks[id]=L.step(s,d.rand(),d.rand(),now,L.effOdds(o.data.bias?.[id],now),L.eventShift(ev,id,now));
    const ops=[{path:MP,data:{stocks},ts:["updatedAt"],pre:m.version}];
    if(ev.length!==(o.data.events||[]).length)ops.push({path:PRIV,data:{events:ev},pre:o.version});   // 順便清掉過期活動
    await d.db.commit(ops);
    return {ok:true};
  });
}
// 每個台北日 08:00 起，每次排程只呼叫一次 Gemini，逐檔產生每日造物題目。
export async function generateDailyTask(d){
  if(!d.dailyTask)return {ok:true,skipped:true};
  const now=d.now(),parts=taipeiParts(now);
  if(parts.hour!=="08")return {ok:true,skipped:true};
  const date=taipeiDay(now),m=await d.db.get(MP);if(!m)return {ok:false};
  const tasks=m.data.dailyTasks?.date===date?{...m.data.dailyTasks.tasks}:{};
  const id=Object.keys(m.data.stocks).sort().find(k=>!tasks[k]);if(!id)return {ok:true,complete:true};
  const lockPath="secret/dailyTaskLock",oldLock=await d.db.get(lockPath);if((oldLock?.data.until||0)>now)return {ok:true,busy:true};
  const lockToken=crypto.randomUUID();
  try{await d.db.commit([{path:lockPath,data:{date,stockId:id,token:lockToken,until:now+300000},pre:oldLock?oldLock.version:null}]);}
  catch(e){if(e instanceof HttpError&&e.code==="conflict")return {ok:true,busy:true};throw e;}
  try{
    const task=await d.dailyTask(m.data.stocks[id].name,date);
    return await retry(async()=>{
      const current=await d.db.get(MP),today=current.data.dailyTasks?.date===date?{...current.data.dailyTasks.tasks}:{};
      if(today[id])return {ok:true,duplicate:true};
      await d.db.commit([{path:MP,data:{dailyTasks:{date,tasks:{...today,[id]:task}}},pre:current.version}]);
      return {ok:true,stockId:id};
    });
  }finally{
    try{const lock=await d.db.get(lockPath);if(lock?.data.token===lockToken)await d.db.commit([{path:lockPath,data:{until:0},pre:lock.version}]);}catch{}
  }
}

// 自動財經新聞：台北時間 10、14、18、22 點各發一則（開盤中）。每個時段只發一次（記在私密文件），失敗時下一分鐘再試。
export const AUTO_NEWS_HOURS=[10,14,18,22];
export async function generateAutoNews(d){
  if(!d.autoNews)return {ok:true,skipped:true};
  const now=d.now(),parts=taipeiParts(now),hour=Number(parts.hour);
  if(!AUTO_NEWS_HOURS.includes(hour))return {ok:true,skipped:true};
  const slotKey=`${taipeiDay(now)}-${parts.hour}`,path="secret/autoNews",st=await d.db.get(path);
  if(st?.data.done?.[slotKey]||(st?.data.until||0)>now)return {ok:true,skipped:true};
  const m=await d.db.get(MP);if(!m)return {ok:false};
  const token=crypto.randomUUID();
  try{await d.db.commit([{path,data:{until:now+50000,token},pre:st?st.version:null}]);}   // 鎖 50 秒，避免同時重複呼叫
  catch(e){if(e instanceof HttpError&&e.code==="conflict")return {ok:true,busy:true};throw e;}
  const stocks=Object.entries(m.data.stocks).map(([id,s])=>({id,name:s.name}));
  const n=await d.autoNews(stocks,hour,taipeiDay(now));
  const r=await newsPublish(d,{name:"練金村財經快報"},{title:n.title,body:n.body,durationMin:240,effects:n.effects,cash:0});
  await retry(async()=>{
    const cur=await d.db.get(path),done=Object.fromEntries(Object.entries(cur?.data.done||{}).sort().slice(-8));
    await d.db.commit([{path,data:{done:{...done,[slotKey]:r.id},until:0},pre:cur.version}]);
  });
  return {ok:true,published:true,id:r.id};
}

// ---- 練金大富翁：50 格一圈，沒有回合制，想擲骰就花 100 元。棋盤資料在 public/board.js（前後端共用）。
// 公開文件 monopoly/state：{ owners:{格子:{u,n,lv}}, pos:{uid:{p,n,at}}, log:[…] }；玩家的現金與免費擲骰次數在 players/{uid}。
const MS="monopoly/state",MONO_ACTIONS=["roll","buy","upgrade","list","bid","accept","cancel"],OFFER_TTL=48*36e5,MAX_OFFERS=100,MAX_MY_OFFERS=10,MAX_PRICE=1e6;
const monoName=(p,a)=>p?.data.customName||p?.data.name||a.name||"玩家";
const pushLog=(log,who,text,now)=>[...(log||[]),{at:now,who,text}].slice(-B.LOG_MAX);
async function monopoly(d,a,body={}){
  if(!MONO_ACTIONS.includes(body.action))throw bad("參數錯誤");
  const pid=`players/${a.uid}`;
  for(let attempt=0;;attempt++){   // 全服共用一份棋盤文件，擲骰很頻繁時衝突多一些，多試幾次
    try{return await monoOnce(d,a,pid,body);}
    catch(e){if(!(e instanceof HttpError&&e.code==="conflict"&&attempt<6))throw e;}
  }
}
async function monoOnce(d,a,pid,body){
  const action=body.action,tile=body.tile;
  const [p,st]=await Promise.all([d.db.get(pid),d.db.get(MS)]),now=d.now();
  await strikeIfDue(d,pid,p);
  const pd=p?p.data:{cash:START,hold:{}},cash0=Math.round(Number(pd.cash??START)*100)/100;
  const S=st?st.data:{owners:{},pos:{},log:[]},owners={...(S.owners||{})},posMap={...(S.pos||{})},who=monoName(p,a);
  const offers=Object.fromEntries(Object.entries(S.offers||{}).filter(([,o])=>now-o.at<OFFER_TTL));   // 過期（48 小時）的掛牌與出價自動清掉
  const playerBase=p?{}:{hold:{},name:a.name||"玩家"};
  const stateOp=data=>({path:MS,data,pre:st?st.version:null});
  const cur=Number(posMap[a.uid]?.p??0);
  if(action==="buy"){
    const t=B.BOARD[cur];
    if(!t||(t.type!=="prop"&&t.type!=="rail"))throw new HttpError(409,"failed-precondition","這一格不能購買");
    if(owners[cur])throw new HttpError(409,"failed-precondition","這塊地已經有主人了");
    if(cash0<t.price)throw new HttpError(409,"failed-precondition",`現金不足，${t.name} 要 ${t.price} 元`);
    owners[cur]={u:a.uid,n:who,lv:0};
    await d.db.commit([{path:pid,data:{...playerBase,cash:Math.round((cash0-t.price)*100)/100,mprop:B.propertyValue(owners,a.uid)},pre:p?p.version:null},
      stateOp({owners,log:pushLog(S.log,who,`買下了「${t.name}」（${t.price} 元）`,now)})]);
    return {ok:true,bought:cur,name:t.name,price:t.price};
  }
  if(action==="upgrade"){
    const i=Number(tile),t=B.BOARD[i],o=owners[i];
    if(!Number.isInteger(i)||!t||t.type!=="prop")throw bad("只有一般地產可以升級");
    if(!o||o.u!==a.uid)throw new HttpError(409,"failed-precondition","這不是你的地產");
    if((o.lv||0)>=B.MAX_LV)throw new HttpError(409,"failed-precondition","已經是最高等級了");
    if(cash0<t.up)throw new HttpError(409,"failed-precondition",`現金不足，升級要 ${t.up} 元`);
    owners[i]={...o,lv:(o.lv||0)+1};
    await d.db.commit([{path:pid,data:{...playerBase,cash:Math.round((cash0-t.up)*100)/100,mprop:B.propertyValue(owners,a.uid)},pre:p?p.version:null},
      stateOp({owners,log:pushLog(S.log,who,`把「${t.name}」升到 ${owners[i].lv} 級`,now)})]);
    return {ok:true,tile:i,lv:owners[i].lv,cost:t.up};
  }
  // ---- 玩家之間交易權狀：賣家掛牌（list）、買家出價（bid），對方同意（accept）才成交；現金在成交當下才檢查與轉移
  if(action==="list"||action==="bid"){
    const i=Number(tile),t=B.BOARD[i],price=Math.round(Number(body.price)),o=owners[i];
    if(!Number.isInteger(i)||!t||(t.type!=="prop"&&t.type!=="rail"))throw bad("只有地產與煉爐可以交易");
    if(!Number.isFinite(price)||price<1||price>MAX_PRICE)throw bad(`價格需為 1～${MAX_PRICE} 的整數`);
    if(!o)throw new HttpError(409,"failed-precondition","這塊地還沒有人持有，直接買就好");
    const kind=action==="list"?"sell":"buy";
    if(kind==="sell"&&o.u!==a.uid)throw new HttpError(409,"failed-precondition","這不是你的地產");
    if(kind==="buy"){if(o.u===a.uid)throw new HttpError(409,"failed-precondition","這是你自己的地產");if(cash0<price)throw new HttpError(409,"failed-precondition","現金不夠出這個價");}
    for(const [id,x] of Object.entries(offers))if(x.u===a.uid&&x.tile===i&&x.k===kind)delete offers[id];   // 同一格同一種只留最新一張
    if(Object.values(offers).filter(x=>x.u===a.uid).length>=MAX_MY_OFFERS)throw new HttpError(409,"failed-precondition",`你同時最多只能有 ${MAX_MY_OFFERS} 張掛牌／出價`);
    if(Object.keys(offers).length>=MAX_OFFERS)throw new HttpError(409,"failed-precondition","交易市場已滿，晚點再試");
    const id=crypto.randomUUID().slice(0,8);offers[id]={k:kind,u:a.uid,n:who,tile:i,price,to:kind==="buy"?o.u:null,at:now};
    await d.db.commit([stateOp({offers,log:pushLog(S.log,who,kind==="sell"?`把「${t.name}」掛牌出售（${price} 元）`:`出價 ${price} 元想買「${t.name}」（持有人：${o.n}）`,now)})]);
    return {ok:true,offerId:id,kind,tile:i,price};
  }
  if(action==="cancel"){
    const x=offers[body.offerId];if(!x)throw new HttpError(404,"not-found","找不到這張掛牌／出價（可能已成交或過期）");
    if(x.u!==a.uid&&!(x.k==="buy"&&x.to===a.uid))throw new HttpError(403,"permission-denied","你不能取消別人的掛牌");
    delete offers[body.offerId];await d.db.commit([stateOp({offers})]);return {ok:true};
  }
  if(action==="accept"){
    const x=offers[body.offerId];if(!x)throw new HttpError(404,"not-found","找不到這張掛牌／出價（可能已成交或過期）");
    const i=x.tile,t=B.BOARD[i],o=owners[i],seller=x.k==="sell"?x.u:a.uid,buyer=x.k==="sell"?a.uid:x.u;
    if(seller===buyer||x.u===a.uid)throw new HttpError(409,"failed-precondition","不能和自己交易");
    if(!o||o.u!==seller){delete offers[body.offerId];await d.db.commit([stateOp({offers})]);throw new HttpError(409,"failed-precondition","這張權狀已經易主，這筆交易作廢");}
    const otherId=x.u,od=await d.db.get(`players/${otherId}`);
    if(!od)throw new HttpError(409,"failed-precondition","對方的玩家資料不存在");
    const buyerCash=Math.round(Number(buyer===a.uid?cash0:od.data.cash||0)*100)/100;
    if(buyerCash<x.price)throw new HttpError(409,"failed-precondition",buyer===a.uid?`現金不足，要 ${x.price} 元`:`${x.n} 的現金不夠了，這筆出價暫時無法成交`);
    const buyerName=buyer===a.uid?who:x.n;
    owners[i]={u:buyer,n:buyerName,lv:o.lv||0};                                       // 等級跟著權狀走
    for(const [id,y] of Object.entries(offers))if(y.tile===i)delete offers[id];
    const upd=(uid,cash)=>({cash:Math.round(cash*100)/100,mprop:B.propertyValue(owners,uid)});
    const meData=a.uid===buyer?upd(a.uid,cash0-x.price):upd(a.uid,cash0+x.price),otherData=a.uid===buyer?upd(otherId,Number(od.data.cash||0)+x.price):upd(otherId,Number(od.data.cash||0)-x.price);
    await d.db.commit([{path:pid,data:{...playerBase,...meData},pre:p?p.version:null},{path:`players/${otherId}`,data:otherData,pre:od.version},
      stateOp({owners,offers,log:pushLog(S.log,who,`「${t.name}」以 ${x.price} 元易主：${seller===a.uid?who:x.n} → ${buyerName}`,now)})]);
    return {ok:true,tile:i,name:t.name,price:x.price,role:buyer===a.uid?"buyer":"seller"};
  }
  // ---- 擲骰
  if(now-(pd.mlast||0)<B.COOLDOWN_MS)throw new HttpError(429,"resource-exhausted","擲骰太快了，等一下再擲");
  const free=Number(pd.mfree||0)>0,cost=free?0:B.ROLL_COST;
  if(cash0<cost)throw new HttpError(409,"failed-precondition",`現金不足，擲骰一次要 ${B.ROLL_COST} 元`);
  const rnd=()=>d.secureRand?d.secureRand():d.rand(),die=()=>1+Math.floor(rnd()*6);
  let cash=cash0-cost,freeLeft=Number(pd.mfree||0)-(free?1:0),pos=cur,card=null,transfer=null;
  const events=[],r1=die(),r2=die();
  const pay=(n,label)=>{const x=Math.min(cash,n);cash-=x;events.push(x<n?`${label} ${n} 元，現金不夠，只付了 ${Math.round(x*100)/100} 元`:`${label} ${n} 元`);return x;};
  const advance=n=>{const raw=pos+n;if(n>0&&raw>=B.SIZE){cash+=B.START_BONUS;events.push(`經過起點，領薪水 ${B.START_BONUS} 元`);}pos=((raw%B.SIZE)+B.SIZE)%B.SIZE;};
  const land=depth=>{
    const t=B.BOARD[pos],o=owners[pos];
    if(t.type==="prop"||t.type==="rail"){
      if(!o)events.push(`來到「${t.name}」，無人持有，可以買下（${t.price} 元）`);
      else if(o.u===a.uid)events.push(`來到自己的「${t.name}」`);
      else{const rent=B.rentOf(pos,owners),x=Math.min(cash,rent);cash-=x;transfer={uid:o.u,name:o.n,amount:x};
        events.push(x<rent?`來到「${t.name}」，要付 ${o.n} 過路費 ${rent} 元，現金不夠，只付了 ${Math.round(x*100)/100} 元`:`來到「${t.name}」，付給 ${o.n} 過路費 ${rent} 元`);}
    }
    else if(t.type==="tax")pay(B.TAX,"稅務所課稅");
    else if(t.type==="gojail"){pos=B.JAIL_IDX;pay(B.JAIL_FINE,"被押送入獄，罰款");}
    else if(t.type==="chance"||t.type==="fate"){
      if(depth>0)return;
      const deck=t.type==="chance"?B.CHANCE_CARDS:B.FATE_CARDS,c=deck[Math.floor(rnd()*deck.length)],e=c.e;
      card={kind:t.type==="chance"?"機會":"命運",text:c.text};events.push(`抽到${card.kind}：${c.text}`);
      if(e.k==="cash"){if(e.v>=0)cash+=e.v;else pay(-e.v,"損失");}
      else if(e.k==="free")freeLeft+=e.v;
      else if(e.k==="jail"){pos=B.JAIL_IDX;pay(B.JAIL_FINE,"押送入獄，罰款");}
      else if(e.k==="move"){advance(e.v);events.push(`移動到「${B.BOARD[pos].name}」`);land(1);}
      else if(e.k==="goto"){const from=pos;pos=e.v;if(e.bonus&&(pos<=from)){cash+=B.START_BONUS;events.push(`經過起點，領薪水 ${B.START_BONUS} 元`);}events.push(`移動到「${B.BOARD[pos].name}」`);land(1);}
    }
  };
  const from=pos;advance(r1+r2);
  land(0);
  cash=Math.round(cash*100)/100;
  const ops=[{path:pid,data:{...playerBase,cash,mfree:freeLeft,mlast:now,mrolls:(pd.mrolls||0)+1},pre:p?p.version:null}];
  let paidTo=null;
  if(transfer&&transfer.amount>0){
    const od=await d.db.get(`players/${transfer.uid}`);
    if(od){const oc=Math.round((Number(od.data.cash||0)+transfer.amount)*100)/100;ops.push({path:`players/${transfer.uid}`,data:{cash:oc},pre:od.version});paidTo=transfer.name;}
    else{cash=Math.round((cash+transfer.amount)*100)/100;ops[0].data.cash=cash;events.push("（持有人資料不存在，過路費退回）");}
  }
  posMap[a.uid]={p:pos,n:who,at:now};
  const line=`擲出 ${r1}+${r2}，${events.join("；")}`;
  ops.push(stateOp({pos:posMap,owners,log:pushLog(S.log,who,line,now)}));
  await d.db.commit(ops);
  return {ok:true,dice:[r1,r2],from,to:pos,cost,free,events,card,cash,freeLeft,paidTo,canBuy:["prop","rail"].includes(B.BOARD[pos].type)&&!owners[pos]};
}

const STRIKE_MSG="欠款太多又拖過一天，黑道找上門了！資產已重製，並被關押 24 小時。";
const SENTENCE=864e5,BAIL=80,PLAYER_ROBBERY_FEE=10000,ROBBERY_FINE=10000,BANK_ROBBERY_FEE=5000,BANK_LOOT=50000;
const ANALYST_MIN=1000,ANALYST_MAX=10000;
function assertFree(p,now){if((p?.data.jailUntil||0)>now)throw new HttpError(403,"imprisoned",`你仍在服刑，${new Date(p.data.jailUntil).toISOString()} 後才能行動`);}
// 黑道：欠款連續超過上限滿 24 小時 → 資產重製，並關押 24 小時
async function strikeIfDue(d,pid,p){
  const now=d.now();
  const cfg=settingsOf(await loadOdds(d));
  if(!p||!L.mobDue(p.data.loan,now,cfg.loanRate))return;
  const owed=Math.round(L.owed(p.data.loan,now,cfg.loanRate)*100)/100;
  await d.db.commit([
    {path:pid,data:{cash:START,hold:{},loan:{p:0,t:now},dem:{a:0,t:now},tds:[],bankrupt:(p.data.bankrupt||0)+1,jailUntil:now+SENTENCE},pre:p.version},
    {path:`feed/${crypto.randomUUID()}`,data:{who:p.data.customName||p.data.name||"玩家",mob:true,owed},ts:["at"],pre:null}]);
  throw new HttpError(409,"mob",STRIKE_MSG);
}
// 開發者：以 Google 驗證過的信箱比對（名單在機密 DEV_EMAILS），可免 IA、自行輸入造物
const isDev=(d,a)=>a.emailVerified===true&&typeof a.email==="string"&&(d.devEmails||[]).includes(a.email.toLowerCase());
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
  const daily=m0?.data.dailyTasks,task=daily?.date===taipeiDay(d.now())?daily.tasks?.[stockId]:null;
  const theme=task?`${s0.name}；今日指定造物：${task.item}（${task.description}）`:s0.name;
  const j=await d.judge(theme,itemName,geminiKey);
  return retry(async()=>{
    const [p,m,o]=await Promise.all([d.db.get(pid),d.db.get(MP),loadOdds(d)]);
    await strikeIfDue(d,pid,p);
    const stocks=m?.data.stocks,s=stocks?.[stockId];
    if(!s)throw new HttpError(404,"not-found","找不到這檔股票");
    if(cool(p))throw new HttpError(429,"resource-exhausted","投入太頻繁，請稍候幾秒");
    if(!dev&&L.usedBefore(p?.data.used,itemName))throw new HttpError(409,"failed-precondition","這個造物你已經投入過了（同一個造物只能投入一次，不能重複）");
    const cfg=settingsOf(o),now=d.now(),bias=L.nudge(L.effOdds(o.data.bias?.[stockId],now),j.score,cfg.threshold);   // 只改變上漲機率；價格由排程隨機走，投入當下不會跳動
    const up=Math.round(L.upProb(bias+L.eventShift(o.data.events,stockId,now))*100);
    const who=p?.data.customName|| (dev?(a.name||"開發者"):(me.workshopName||a.name||"無名工坊"));
    await d.db.commit([
      {path:MP,data:{stocks:{...stocks,[stockId]:{...s,last:`${itemName}（${j.score}分）`}}},ts:["updatedAt"],pre:m.version},
      {path:PRIV,data:{bias:{...o.data.bias,[stockId]:{v:bias,at:now}}},pre:o.version},
      {path:pid,data:{...(p?{}:{cash:START,hold:{}}),name:who,lastInjectAt:d.now(),...(dev?{}:{used:L.markUsed(p?.data.used,itemName,d.now())})},pre:p?p.version:null},
      {path:`feed/${crypto.randomUUID()}`,data:{who,stock:s.name,item:itemName,score:j.score,rel:j.relation,pass:L.passes(j.score,cfg.threshold),reason:j.reason,...(dev?{dev:true}:{})},ts:["at"],pre:null}]);
    // 機率只有開發者看得到：一般玩家的回應不含 up
    return {...j,price:s.price,pass:L.passes(j.score,cfg.threshold),threshold:cfg.threshold,...(dev?{up}:{})};
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
    return {ok:true,cash:r.cash,hold:r.hold};
  });
}
// 銀行：借款 / 還款 / 全額還清 / 活存存提 / 定存存入與提前解約 / check（只檢查黑道）。都不需要 IA
const DEP=["dem_in","dem_out","td_in","td_break"];
async function bank(d,a,{action,amount,all,at}={}){
  if(!["borrow","repay","check","bail",...DEP].includes(action))throw bad("參數錯誤");
  const amt=Math.round(Number(amount)*100)/100,everything=all===true&&(action==="repay"||action==="dem_out");
  if(["borrow","repay","dem_in","dem_out","td_in"].includes(action)&&!everything&&!(Number.isFinite(amt)&&amt>=.01&&amt<=1e6))throw bad("金額不正確（0.01–1,000,000）");
  if(action==="td_break"&&!Number.isFinite(Number(at)))throw bad("參數錯誤");
  const pid=`players/${a.uid}`;
  return retry(async()=>{
    const p=await d.db.get(pid),now=d.now();
    await strikeIfDue(d,pid,p);
    if(action==="check")return {ok:true};
    if(action==="bail"){   // 服刑中可借「保釋貸款」（計入一般貸款，照利率滾利）：立刻出獄，現金不變
      if(!p||(p.data.jailUntil||0)<=now)throw new HttpError(409,"failed-precondition","你目前沒有在服刑，不需要保釋");
      const cfgB=settingsOf(await loadOdds(d)),upd=L.borrow(p.data,BAIL,now,cfgB.loanRate);
      await d.db.commit([{path:pid,data:{loan:upd.loan,jailUntil:0,bails:(p.data.bails||0)+1},pre:p.version}]);
      return {ok:true,bail:BAIL,jailUntil:0,owed:Math.round(L.owed(upd.loan,now,cfgB.loanRate)*100)/100};
    }
    const data=p?p.data:{cash:START},cfg=settingsOf(await loadOdds(d));
    let upd;
    try{
      upd=action==="borrow"?L.borrow(data,amt,now,cfg.loanRate):action==="repay"?L.repay(data,amt,now,everything,cfg.loanRate)
        :action==="dem_in"?L.demIn(data,amt,now,cfg.demRate,cfg.tdRate):action==="dem_out"?L.demOut(data,amt,now,everything,cfg.demRate,cfg.tdRate)
        :action==="td_in"?L.tdIn(data,amt,now,cfg.demRate,cfg.tdRate):L.tdBreak(data,Number(at),now,cfg.demRate,cfg.tdRate);
    }catch(e){throw new HttpError(409,"failed-precondition",e.message);}
    await d.db.commit([{path:pid,data:{...(p?{}:{hold:{},name:a.name||"玩家"}),...upd},pre:p?p.version:null}]);
    const after={...data,...upd},r2=n=>Math.round(n*100)/100;
    return {ok:true,cash:upd.cash,owed:r2(L.owed(after.loan,now,cfg.loanRate)),deposits:r2(L.depositsValue(after,now,cfg.demRate,cfg.tdRate))};
  });
}
// ---- 財經新聞：開發者發布活動（名稱、資料、持續時間、各股票上漲基準機率 ±x、普發現金）；玩家在活動期間領一次現金
const NEWS_ID=/^[0-9a-f-]{36}$/,noCtl=t=>!/[\u0000-\u0008\u000b-\u001f]/.test(t);    // 活動資料允許換行
async function newsPublish(d,a,{title,body:text,durationMin,effects,cash,scheduledAt}){
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
  const now0=d.now(),publishAt=scheduledAt==null||scheduledAt===""?0:Number(scheduledAt);
  if(publishAt&&(!Number.isSafeInteger(publishAt)||publishAt<=now0||publishAt>now0+30*864e5))throw bad("預定發布時間需在現在之後的 30 天內");
  const id=crypto.randomUUID();
  const newsData={title,body:text,by:a.name||"開發者",endsAt:(publishAt||now0)+Math.round(mins*60000),durationMin:mins,cash:money};
  if(publishAt){
    const m=await d.db.get(MP);if(!m)throw new HttpError(404,"not-found","行情尚未建立");
    for(const sid of Object.keys(eff))if(!m.data.stocks[sid])throw bad(`找不到股票 ${sid}`);
    return retry(async()=>{
      const q=await d.db.get(NEWS_QUEUE),items=q?.data.items||{};
      await d.db.commit([{path:NEWS_QUEUE,data:{items:{...items,[id]:{...newsData,scheduledAt:publishAt,effects:eff}}},pre:q?q.version:null}]);
      return {ok:true,id,scheduled:true,scheduledAt:publishAt,endsAt:newsData.endsAt};
    });
  }
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
      {path:`news/${id}`,data:{...newsData,endsAt:until},ts:["at"],pre:null}]);
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
async function scheduledNewsList(d){
  const q=await d.db.get(NEWS_QUEUE);
  return {scheduled:Object.entries(q?.data.items||{}).map(([id,x])=>({id,title:x.title,scheduledAt:x.scheduledAt,endsAt:x.endsAt})).sort((a,b)=>a.scheduledAt-b.scheduledAt)};
}
async function scheduledNewsCancel(d,{id}){
  if(!NEWS_ID.test(id||""))throw bad("參數錯誤");
  return retry(async()=>{const q=await d.db.get(NEWS_QUEUE),items={...(q?.data.items||{})};if(!items[id])throw new HttpError(404,"not-found","找不到這則預定新聞");delete items[id];
    await d.db.commit([{path:NEWS_QUEUE,data:{items},pre:q.version}]);return {ok:true};});
}
export async function publishScheduledNews(d){
  const q=await d.db.get(NEWS_QUEUE),now=d.now(),due=Object.entries(q?.data.items||{}).filter(([,x])=>x.scheduledAt<=now);
  let published=0;
  for(const [id] of due){
    const result=await retry(async()=>{
      const [queue,m,o]=await Promise.all([d.db.get(NEWS_QUEUE),d.db.get(MP),loadOdds(d)]),items={...(queue?.data.items||{})},item=items[id];
      if(!item||item.scheduledAt>d.now())return false;
      const publishedAt=d.now(),endsAt=publishedAt+Math.round(item.durationMin*60000),events=L.activeEvents(o.data.events,publishedAt);
      if(Object.keys(item.effects||{}).length){if(events.length>=L.MAX_EVENTS)return false;events.push({id,until:endsAt,shift:Object.fromEntries(Object.entries(item.effects).map(([k,x])=>[k,x/100]))});}
      delete items[id];
      await d.db.commit([
        {path:NEWS_QUEUE,data:{items},pre:queue.version},
        ...(Object.keys(item.effects||{}).length?[{path:PRIV,data:{events},pre:o.version}]:[]),
        {path:`news/${id}`,data:{title:item.title,body:item.body,by:item.by,endsAt,durationMin:item.durationMin,cash:item.cash},ts:["at"],pre:null}
      ]);
      return true;
    });
    if(result)published++;
  }
  return {ok:true,published};
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
  if(body.action==="list-scheduled"||body.action==="cancel-scheduled"){
    if(!isDev(d,a))throw new HttpError(403,"permission-denied","只有開發者可以管理預定新聞");
    return body.action==="list-scheduled"?scheduledNewsList(d):scheduledNewsCancel(d,body);
  }
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
  const [players,m,o,ms]=await Promise.all([d.db.list("players"),d.db.get(MP),loadOdds(d),d.db.get(MS)]),stocks=m?.data.stocks||{},now=d.now(),cfg=settingsOf(o),mo=ms?.data.owners||{};
  return {rows:players.map(({id,data:p})=>({isMe:id===a.uid,name:p.customName||p.name||"玩家",value:Math.round((Number(p.cash||0)+Object.entries(p.hold||{}).reduce((n,[id,q])=>n+Number(q||0)*Number(stocks[id]?.price||0),0)-L.owed(p.loan,now,cfg.loanRate)+L.depositsValue(p,now,cfg.demRate,cfg.tdRate)+B.propertyValue(mo,id))*100)/100})).sort((a,b)=>b.value-a.value||a.name.localeCompare(b.name,"zh-Hant")).slice(0,100)};
}
async function developerSettings(d,a,body={}){
  if(!isDev(d,a))throw new HttpError(403,"permission-denied","只有開發者可以調整設定");
  return retry(async()=>{
    const o=await loadOdds(d),cfg=settingsOf(o);
    if(body.action==="save"){
      const values={loanRate:Number(body.loanRate),demRate:Number(body.demRate),tdRate:Number(body.tdRate),threshold:Number(body.threshold)};
      if(!Number.isFinite(values.loanRate)||values.loanRate<0||values.loanRate>100||!Number.isFinite(values.demRate)||values.demRate<0||values.demRate>100||!Number.isFinite(values.tdRate)||values.tdRate<0||values.tdRate>100||!Number.isInteger(values.threshold)||values.threshold<1||values.threshold>99)throw bad("利率需為 0–100%，門檻需為 1–99% 整數");
      const next={loanRate:values.loanRate/100,demRate:values.demRate/100,tdRate:values.tdRate/100,threshold:values.threshold};
      await d.db.commit([{path:PRIV,data:{...o.data,settings:next},pre:o.version}]);return {ok:true,settings:next};
    }
    return {settings:cfg};
  });
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
    if(path==="/inject"||path==="/trade"||path==="/bank"||path==="/news"||path==="/whoami"||path==="/odds"||path==="/profile"||path==="/leaderboard"||path==="/blackmarket"||path==="/analyst"||path==="/admin-settings"||path==="/monopoly"){
      const a=await d.verify(req);
      if(a.provider!=="google.com")throw new HttpError(401,"unauthenticated","請先以 Google 帳號登入");
      if(path==="/whoami"){await ensureMarket(d);const o=await loadOdds(d);return out(env,200,{dev:isDev(d,a),settings:settingsOf(o)});}
      if(path==="/admin-settings"){let b={};try{b=await req.json();}catch{}return out(env,200,await developerSettings(d,a,b));}
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
      if((path==="/trade"||path==="/inject")&&!marketOpen(d.now()))throw new HttpError(409,"market-closed","休市中，交易時間為台北時間 09:00–24:00");
      let body;try{body=await req.json();}catch{throw bad("請求格式錯誤");}
      if(path!=="/leaderboard"&&path!=="/blackmarket"&&!(path==="/bank"&&body.action==="bail"))assertFree(await d.db.get(`players/${a.uid}`),d.now());
      return out(env,200,await (path==="/inject"?inject:path==="/bank"?bank:path==="/news"?news:path==="/profile"?setPlayerName:path==="/blackmarket"?blackmarket:path==="/analyst"?analyst:path==="/monopoly"?monopoly:trade)(d,a,body));
    }
    throw new HttpError(404,"not-found","找不到");
  }catch(e){
    if(e instanceof HttpError)return out(env,e.status,{error:{code:e.code,message:e.message}});
    console.error("unhandled",e?.name); // 不記錄訊息與請求內容（可能含 token / API Key）
    return out(env,500,{error:{code:"internal",message:"伺服器錯誤"}});
  }
}
