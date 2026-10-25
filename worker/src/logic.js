// 純函式：隨機行情、機率偏移、買賣、24 小時資格
export const DAY=864e5,MAXH=180; // 走勢圖保留最近 180 個點（每 2 分鐘一點≈6 小時）
export const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const rd=n=>Math.round(n*100)/100;
export const upProb=bias=>clamp(.5+bias,.1,.9);
// 機率偏移（bias）＝上漲機率 − 50%。人多時每個人的影響都要小，所以單次很輕、總量有上限：
//   投入造物：相似度高過門檻 → 提高「漲」的機率，沒高過 → 提高「跌」的機率，一次最多 ±5 個百分點
//   買賣：每買 1 股 +1 個百分點、每賣 1 股 −1 個百分點（買賣壓力）
//   所有人加起來最多 ±15 個百分點（上漲機率 35%–65%）
//   衰減：每過 5 分鐘只剩 90%（高於 50% 的機率往下掉、低於 50% 的往上回升），小於 0.5 個百分點就直接歸零（回到 50%）。按真實時間計算，與排程間隔無關
export const INJECT_MAX=.05,BIAS_CAP=.15,TRADE_NUDGE=.01,DECAY=.9,DECAY_MS=5*60*1000;
export const effBias=(s,now)=>{const b=s.bias||0;if(!b)return 0;const e=b*Math.pow(DECAY,Math.max(0,now-(s.biasAt??now))/DECAY_MS);return Math.abs(e)<.005?0:e;};
// 相似度（0–100）必須「高過」門檻才算相關：相似度越高於門檻，提高上漲機率越多（100 時為滿額）；
// 沒高過就視為無關：越低於門檻，提高下跌機率越多（0 時為滿額）。剛好等於門檻 → 沒有影響
export const SIM_THRESHOLD=70;
export const passes=sim=>sim>SIM_THRESHOLD;
export const nudge=(bias,sim)=>clamp((bias||0)+(passes(sim)?(sim-SIM_THRESHOLD)/(100-SIM_THRESHOLD):-(SIM_THRESHOLD-sim)/SIM_THRESHOLD)*INJECT_MAX,-BIAS_CAP,BIAS_CAP);
export const tradeNudge=(bias,dir,shares=1)=>clamp((bias||0)+dir*TRADE_NUDGE*shares,-BIAS_CAP,BIAS_CAP);
// 私密機率紀錄 rec＝{v:偏移, at:時間}（存在只有伺服器讀得到的文件）；回傳「現在」衰減後的偏移
export const effOdds=(rec,now)=>rec?effBias({bias:rec.v,biasAt:rec.at},now):0;
// 行情走一步：方向隨機（上漲機率 = .5+衰減後的偏移 bias+活動基準偏移 shift），幅度 0.3–1.5%，加微弱均值回歸避免漂離基準價。
// 回傳的股票只含公開欄位（機率資訊絕不放進公開行情）
export function step(s,r1,r2,now,bias=0,shift=0,last){
  const {bias:_b,biasAt:_a,...pub}=s;
  const up=r1<upProb(bias+shift),mag=.003+r2*.012,pull=.01*Math.log(s.base/s.price);
  const price=clamp(rd(s.price*(1+(up?mag:-mag)+pull)),1,s.base*5);
  return {...pub,price,t:[...(s.t||[]),now].slice(-MAXH),p:[...(s.p||[]),price].slice(-MAXH),...(last!==undefined?{last}:{})};
}
export function trade(d,id,price,dir,shares=1){
  const n=d.hold?.[id]||0;
  if(!Number.isInteger(shares)||shares<1||shares>100)throw new Error("一次交易限 1、10 或 100 股");
  if(dir>0&&d.cash<price*shares)throw new Error("現金不足");
  if(dir<0&&n<shares)throw new Error(`持股不足（需要 ${shares} 股）`);
  return {cash:rd(d.cash-dir*price*shares),hold:{...d.hold,[id]:n+dir*shares}};
}
// 合成紀錄 → Map(造物名 → 最近一次成功合成時間)：24 小時內、非失敗、時間合理
export function recent(items,now){
  const m=new Map();
  for(const x of items||[]){
    if(x.failed||!x.result||typeof x.createdAt!=="number"||now-x.createdAt>DAY||x.createdAt>now+60000)continue;
    if(!(m.get(x.result)>=x.createdAt))m.set(x.result,x.createdAt);
  }
  return m;
}
// 每個造物，同一個玩家只能投入一次（玩家文件的 used：造物名 → 投入時間）。
// 名稱先做 NFKC＋小寫＋去頭尾空白（全形/大小寫不能鑽漏洞），並加 "n:" 前綴避開 Firestore 的保留字樣
export const usedKey=n=>"n:"+String(n).normalize("NFKC").trim().toLowerCase();
export const usedBefore=(u,name)=>!!u&&(Object.hasOwn(u,usedKey(name))||Object.hasOwn(u,name));   // 也相容舊資料（原樣的名稱）
const MAX_USED=2000;
export function markUsed(u,name,now){
  const m={...(u||{}),[usedKey(name)]:now},keys=Object.keys(m);
  if(keys.length>MAX_USED)keys.sort((a,b)=>m[a]-m[b]).slice(0,keys.length-MAX_USED).forEach(k=>delete m[k]);
  return m;
}

// ---- 銀行（高利貸）：利率 5% / 24 小時，按時間連續複利；可無限借款
// ---- 黑道：欠款超過 MOB_LIMIT 並「連續」超過 24 小時 → 黑道上門，資產清空重新開始
export const RATE=.05,MOB_LIMIT=100,MAX_DEBT=1e9;
const cents=n=>Math.round(n*100)/100;
export const owed=(loan,now)=>loan&&loan.p>0?loan.p*Math.pow(1+RATE,Math.max(0,now-loan.t)/DAY):0;
// 欠款「開始連續超過上限」的時間點；沒超過則 null（利息把欠款推過上限的時間點用公式反推）
export function overAt(loan,now){
  if(!loan||!(loan.p>0))return null;
  if(owed(loan,now)<=MOB_LIMIT)return null;
  if(loan.over!=null)return loan.over;
  if(loan.p>=MOB_LIMIT)return loan.t;
  return loan.t+DAY*Math.log(MOB_LIMIT/loan.p)/Math.log(1+RATE);
}
export const mobDue=(loan,now)=>{const o=overAt(loan,now);return o!=null&&now-o>=DAY;};
const nextLoan=(prev,p,now)=>p>MOB_LIMIT?{p,t:now,over:overAt(prev,now)??now}:{p,t:now};
export function borrow(d,amount,now){
  const o=owed(d.loan,now);
  if(o+amount>MAX_DEBT)throw new Error("借款總額過大");
  return {cash:cents(d.cash+amount),loan:nextLoan(d.loan,cents(o+amount),now)};
}
export function repay(d,amount,now,all){
  const o=owed(d.loan,now);
  if(o<.005)throw new Error("目前沒有欠款");
  const full=all||amount>=o,pay=full?Math.ceil(o*100-1e-9)/100:amount;
  if(d.cash+1e-9<pay)throw new Error("現金不足");
  return {cash:cents(d.cash-pay),loan:full?{p:0,t:now}:nextLoan(d.loan,cents(o-pay),now)};
}

// ---- 存款：活存日利率 0.4%（隨時存取）；定存日利率 1.2%，鎖 3 天，到期自動轉入活存（之後以活存利率計息）
// 提前解約只退本金、利息作廢。利息按真實時間連續複利。
export const DEM_RATE=.004,TD_RATE=.012,TD_DAYS=3,MAX_TDS=20;
const grow=(r,ms)=>Math.pow(1+r,Math.max(0,ms)/DAY);
const r4=n=>Math.round(n*1e4)/1e4;
export const tdEnd=td=>td.t+TD_DAYS*DAY;
export const demValue=(dem,now)=>dem&&dem.a>0?dem.a*grow(DEM_RATE,now-dem.t):0;
export const tdValue=(td,now)=>td.p*grow(TD_RATE,Math.min(now,tdEnd(td))-td.t);
// 把已到期的定存，依到期先後轉入活存，並把活存結算到 now；回傳 {dem:{a,t:now}, tds:尚未到期的定存}
export function settle(d,now){
  let dem=d.dem&&d.dem.a>0?{a:d.dem.a,t:d.dem.t}:{a:0,t:now};
  const live=[],done=[];
  for(const td of d.tds||[])(tdEnd(td)<=now?done:live).push(td);
  done.sort((x,y)=>tdEnd(x)-tdEnd(y));
  for(const td of done){const T=tdEnd(td);dem={a:demValue(dem,T)+tdValue(td,T),t:T};}
  return {dem:{a:r4(demValue(dem,now)),t:now},tds:live};
}
export const depositsValue=(d,now)=>{const s=settle(d,now);return s.dem.a+s.tds.reduce((a,t)=>a+tdValue(t,now),0);};
export function demIn(d,amt,now){
  const s=settle(d,now);
  if(d.cash+1e-9<amt)throw new Error("現金不足");
  return {cash:cents(d.cash-amt),dem:{a:r4(s.dem.a+amt),t:now},tds:s.tds};
}
export function demOut(d,amt,now,all){
  const s=settle(d,now),v=s.dem.a;
  if(v<.005)throw new Error("活存沒有餘額");
  if(!all&&amt>v+.005)throw new Error("活存餘額不足");     // 要領的比餘額多 → 報錯，不會默默當成全領
  const everything=all||amt>=v-.005;                      // 差不到半分錢視為全領
  const take=everything?cents(v):amt;
  return {cash:cents(d.cash+take),dem:{a:everything?0:r4(v-take),t:now},tds:s.tds};
}
export function tdIn(d,amt,now){
  const s=settle(d,now);
  if(amt<1)throw new Error("定存最少 1");
  if(s.tds.length>=MAX_TDS)throw new Error(`定存最多 ${MAX_TDS} 筆`);
  if(d.cash+1e-9<amt)throw new Error("現金不足");
  return {cash:cents(d.cash-amt),dem:s.dem,tds:[...s.tds,{p:r4(amt),t:now}]};
}
// 以「存入時間」辨識是哪一筆（比序號穩，不會因為別筆剛好到期而錯位）
export function tdBreak(d,at,now){
  const s=settle(d,now),td=s.tds.find(x=>x.t===at);
  if(!td)throw new Error("找不到這筆定存（可能已到期，轉入活存了）");
  return {cash:cents(d.cash+td.p),dem:s.dem,tds:s.tds.filter(x=>x!==td)};
}

// ---- 財經新聞活動：活動期間，把指定股票的「上漲基準機率」從 50% 改成 50±x%（玩家的投入/買賣偏移再疊加其上）
// 市場文件的 events：[{id, until, shift:{股票:±0.x}}]，行情排程只讀這份，不必另外查活動
export const MAX_SHIFT=40,MAX_EVENTS=20;
export const activeEvents=(events,now)=>(events||[]).filter(e=>e&&e.until>now);
export const eventShift=(events,id,now)=>{let x=0;for(const e of events||[])if(e&&e.until>now)x+=(e.shift&&e.shift[id])||0;return x;};
// 普發現金的領取紀錄（玩家文件的 claims：活動 id → 領取時間），只留最近 100 筆
export function markClaim(c,id,now){
  const m={...(c||{}),[id]:now},keys=Object.keys(m);
  if(keys.length>100)keys.sort((a,b)=>m[a]-m[b]).slice(0,keys.length-100).forEach(k=>delete m[k]);
  return m;
}
