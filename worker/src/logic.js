// 純函式：隨機行情、機率偏移、買賣、24 小時資格
export const DAY=864e5,MAXH=180; // 走勢圖保留最近 180 個點（每 2 分鐘一點≈6 小時）
export const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const rd=n=>Math.round(n*100)/100;
export const upProb=bias=>clamp(.5+bias,.1,.9);
// 機率偏移（bias）＝上漲機率 − 50%。人多時每個人的影響都要小，所以單次很輕、總量有上限：
//   投入造物：相關(≥50)提高「漲」的機率，無關(<50)提高「跌」的機率，滿分/零分一次最多 ±5 個百分點
//   買賣：每買 1 股 +1 個百分點、每賣 1 股 −1 個百分點（買賣壓力）
//   所有人加起來最多 ±15 個百分點（上漲機率 35%–65%），並隨時間衰減（每 2 分鐘 ×0.92）
export const INJECT_MAX=.05,BIAS_CAP=.15,TRADE_NUDGE=.01;
export const nudge=(bias,score)=>clamp((bias||0)+(score>=50?(score-50)/50:-(50-score)/50)*INJECT_MAX,-BIAS_CAP,BIAS_CAP);
export const tradeNudge=(bias,dir)=>clamp((bias||0)+dir*TRADE_NUDGE,-BIAS_CAP,BIAS_CAP);
// 行情走一步：方向隨機（上漲機率 = .5+bias），幅度 0.3–1.5%，加微弱均值回歸避免漂離基準價；偏移每步衰減 8%
export function step(s,r1,r2,now,last){
  const bias=s.bias||0,up=r1<upProb(bias),mag=.003+r2*.012,pull=.01*Math.log(s.base/s.price);
  const price=clamp(rd(s.price*(1+(up?mag:-mag)+pull)),1,s.base*5);
  const nb=bias*.92;
  return {...s,price,bias:Math.abs(nb)<.005?0:nb,
    t:[...(s.t||[]),now].slice(-MAXH),p:[...(s.p||[]),price].slice(-MAXH),...(last!==undefined?{last}:{})};
}
export function trade(d,id,price,dir){
  const n=d.hold?.[id]||0;
  if(dir>0&&d.cash<price)throw new Error("現金不足");
  if(dir<0&&n<1)throw new Error("沒有持股");
  return {cash:rd(d.cash-dir*price),hold:{...d.hold,[id]:n+dir}};
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
// 每個造物每 24 小時只能投入一次（玩家文件的 used：造物名 → 投入時間）
export const usedRecent=(u,name,now)=>{const t=(u||{})[name];return typeof t==="number"&&now-t<DAY&&t<=now+60000;};
export const markUsed=(u,name,now)=>({...Object.fromEntries(Object.entries(u||{}).filter(([,t])=>typeof t==="number"&&now-t<DAY)),[name]:now});

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
