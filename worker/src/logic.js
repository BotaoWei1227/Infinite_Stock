// 純函式：隨機行情、機率偏移、買賣、24 小時資格
export const DAY=864e5,MAXH=180; // 走勢圖保留最近 180 個點（每 2 分鐘一點≈6 小時）
export const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const rd=n=>Math.round(n*100)/100;
export const upProb=bias=>clamp(.5+bias,.1,.9);
// 投入造物：相關(≥50)提高「漲」的機率，無關(<50)提高「跌」的機率；偏移上限 ±0.4（漲跌機率最多 90%/10%）
export const nudge=(bias,score)=>clamp((bias||0)+(score>=50?(score-50)/50*.3:-(50-score)/50*.3),-.4,.4);
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

// ---- 銀行（高利貸）：利率 5% / 24 小時，按時間連續複利；借款上限 100
export const RATE=.05,DEBT_CAP=100;
const cents=n=>Math.round(n*100)/100;
export const owed=(loan,now)=>loan&&loan.p>0?loan.p*Math.pow(1+RATE,Math.max(0,now-loan.t)/DAY):0;
export function borrow(d,amount,now){
  const o=owed(d.loan,now);
  if(o+amount>DEBT_CAP+1e-9)throw new Error(`超過借款上限（欠款加新借款不能超過 ${DEBT_CAP}）`);
  return {cash:cents(d.cash+amount),loan:{p:cents(o+amount),t:now}};
}
export function repay(d,amount,now,all){
  const o=owed(d.loan,now);
  if(o<.005)throw new Error("目前沒有欠款");
  const full=all||amount>=o,pay=full?Math.ceil(o*100-1e-9)/100:amount;
  if(d.cash+1e-9<pay)throw new Error("現金不足");
  return {cash:cents(d.cash-pay),loan:{p:full?0:cents(o-pay),t:now}};
}
