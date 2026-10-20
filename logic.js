// 純函式：漲跌機率與買賣計算（可單元測試）
const pUp=s=>s>=50?.55+(s-50)/50*.3:.45-(50-s)/50*.3; // 相關→漲 55–85%；無關→跌 55–85%
const roll=(score,r1,r2)=>(2+r1*6)/100*(r2<pUp(score)?1:-1); // 幅度 2–8%
const applyPct=(price,pct)=>Math.max(1,Math.round(price*(1+pct)*100)/100);
const r2=n=>Math.round(n*100)/100;
function trade(d,id,price,dir){
  const n=d.hold?.[id]||0;
  if(dir>0&&d.cash<price)throw new Error("現金不足");
  if(dir<0&&n<1)throw new Error("沒有持股");
  return {cash:r2(d.cash-dir*price),hold:{...d.hold,[id]:n+dir}};
}
const DAY=864e5;
// 合成紀錄 → Map(造物名 → 最近一次成功合成時間)，只保留 24 小時內、非失敗、時間合理的紀錄
function recent(items,now){
  const m=new Map();
  for(const x of items||[]){
    if(x.failed||!x.result||typeof x.createdAt!=="number"||now-x.createdAt>DAY||x.createdAt>now+60000)continue;
    if(!(m.get(x.result)>=x.createdAt))m.set(x.result,x.createdAt);
  }
  return m;
}
module.exports={pUp,roll,applyPct,trade,recent,DAY};
