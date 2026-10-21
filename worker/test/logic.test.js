import test from "node:test";import assert from "node:assert";
import {effBias,DECAY,DECAY_MS,SIM_THRESHOLD,passes,upProb,nudge,tradeNudge,INJECT_MAX,BIAS_CAP,TRADE_NUDGE,step,trade,recent,DAY,MAXH} from "../src/logic.js";
const near=(a,b,e=1e-9)=>Math.abs(a-b)<e;
const S=(o={})=>({price:12,base:12,bias:0,t:[0],p:[12],...o});
test("相似度門檻：要高過 70 才算相關；越高於/低於門檻影響越大；等於門檻沒有影響",()=>{
  assert.equal(SIM_THRESHOLD,70);assert.equal(passes(71),true);assert.equal(passes(70),false);assert.equal(passes(0),false);
  assert.ok(near(nudge(0,100),.05));assert.ok(near(nudge(0,0),-.05));assert.equal(nudge(0,70),0);
  assert.ok(near(nudge(0,85),.025));assert.ok(near(nudge(0,71),.05/30));                  // 剛高過門檻 → 只有一點點
  assert.ok(near(nudge(0,35),-.025));assert.ok(near(nudge(0,69),-.05/70));                // 剛低於門檻 → 只降一點點
  assert.equal(nudge(.14,100),.15);assert.equal(nudge(-.14,0),-.15);                      // 上限 ±15 個百分點
  assert.ok(near(tradeNudge(0,1),.01));assert.ok(near(tradeNudge(0,-1),-.01));assert.equal(tradeNudge(.15,1),.15);assert.equal(tradeNudge(-.15,-1),-.15);
  assert.ok(near(upProb(.3),.8));assert.equal(upProb(.4),.9);assert.equal(upProb(-.4),.1);
  assert.equal(INJECT_MAX,.05);assert.equal(BIAS_CAP,.15);assert.equal(TRADE_NUDGE,.01);
  let b=0;for(let i=0;i<100;i++)b=nudge(b,100);assert.equal(b,.15);                      // 100 個人狂投也只到 65%
});
test("走一步：機率決定方向，幅度 0.3–1.5%",()=>{
  assert.equal(step(S(),.4,.5,1).price,12.11);   // r1<0.5 → 漲
  assert.equal(step(S(),.6,.5,1).price,11.89);   // r1>0.5 → 跌
  assert.equal(step(S({bias:.3}),.7,.5,1).price,12.11); // 偏移 +0.3 → 上漲機率 80%，0.7 仍漲
  assert.equal(step(S({bias:-.3}),.4,.5,1).price,11.89); // 偏移 -0.3 → 上漲機率 20%，0.4 反而跌
  const lo=step(S(),.4,0,1).price/12-1,hi=step(S(),.4,1,1).price/12-1;
  assert.ok(lo>=.0029&&hi<=.0151);
});
test("價格下限 1；均值回歸；走一步時偏移會先衰減到現在",()=>{
  assert.ok(near(step(S({bias:.3,biasAt:0}),.5,.5,5*60*1000).bias,.27));
  assert.equal(step(S({bias:.004}),.5,.5,1).bias,0);
  assert.equal(step(S({price:1,base:1}),.9,.5,1).price,1);
  const r=step(S({price:24}),.1,.5,1).price;assert.ok(r>24&&r<24*1.009); // 價格偏高時，上漲被壓制
});
test("走勢點保留最近 MAXH 個，並可附上說明文字",()=>{
  const s=S({t:Array.from({length:MAXH},(_,i)=>i),p:Array.from({length:MAXH},()=>12)});
  const n=step(s,.4,.5,999,"火（90分）");
  assert.equal(n.t.length,MAXH);assert.equal(n.t.at(-1),999);assert.equal(n.p.length,MAXH);assert.equal(n.last,"火（90分）");
});
test("買賣",()=>{
  assert.deepEqual(trade({cash:50,hold:{}},"fire",12,1),{cash:38,hold:{fire:1}});
  assert.throws(()=>trade({cash:5,hold:{}},"fire",12,1),/現金不足/);
  assert.throws(()=>trade({cash:5,hold:{}},"fire",12,-1),/沒有持股/);
});
test("24 小時內的成功合成才算",()=>{
  const now=1e13,h=3600e3;
  const m=recent([{result:"火",createdAt:now-h},{result:"火",createdAt:now-2*h},{result:"水",createdAt:now-25*h},
    {result:null,failed:true,createdAt:now-h},{result:"土",failed:true,createdAt:now-h},{result:"風",createdAt:now+10*h}],now);
  assert.deepEqual([...m],[["火",now-h]]);
  assert.equal(recent([{result:"雷",createdAt:now-DAY}],now).has("雷"),true);
  assert.equal(recent([{result:"雷",createdAt:now-DAY-1}],now).has("雷"),false);
});
import {usedRecent,markUsed} from "../src/logic.js";
test("每個造物每 24 小時限一次，過期自動清掉",()=>{
  const now=1e13,h=3600e3;
  assert.equal(usedRecent({火:now-h},"火",now),true);assert.equal(usedRecent({火:now-DAY},"火",now),false);assert.equal(usedRecent({},"火",now),false);assert.equal(usedRecent(undefined,"火",now),false);
  assert.deepEqual(markUsed({水:now-25*h,雷:now-h},"火",now),{雷:now-h,火:now});
});

import {owed,borrow,repay,overAt,mobDue,MOB_LIMIT,RATE} from "../src/logic.js";
test("銀行：5%/24 小時複利、無借款上限、部分/全額還款",()=>{
  const t0=1e13;
  assert.equal(owed(undefined,t0),0);assert.equal(owed({p:0,t:t0},t0),0);
  assert.ok(near(owed({p:50,t:t0},t0+DAY),52.5));assert.ok(near(owed({p:100,t:t0},t0+2*DAY),110.25));
  assert.ok(near(owed({p:50,t:t0},t0+DAY/2),50*Math.sqrt(1.05)));assert.equal(RATE,.05);
  let r=borrow({cash:50},50,t0);assert.deepEqual(r,{cash:100,loan:{p:50,t:t0}});
  r=borrow({cash:50},5000,t0);assert.equal(r.cash,5050);assert.equal(r.loan.p,5000);          // 可以無限借
  assert.throws(()=>borrow({cash:0},2e9,t0),/過大/);
  const d={cash:100,loan:{p:50,t:t0}};
  r=repay(d,20,t0+DAY,false);assert.equal(r.cash,80);assert.ok(near(r.loan.p,32.5));
  r=repay(d,0,t0+DAY,true);assert.equal(r.cash,47.5);assert.deepEqual(r.loan,{p:0,t:t0+DAY});
  r=repay(d,999,t0+DAY,false);assert.equal(r.loan.p,0);
  assert.throws(()=>repay({cash:10,loan:{p:50,t:t0}},0,t0,true),/現金不足/);
  assert.throws(()=>repay({cash:10},5,t0,false),/沒有欠款/);
});
test("黑道：欠款連續超過上限滿 24 小時才會上門",()=>{
  const t0=1e13,h=3600e3;
  assert.equal(MOB_LIMIT,100);
  // 剛好在上限內 → 永遠安全（只要沒超過）
  assert.equal(overAt({p:90,t:t0},t0),null);assert.equal(mobDue({p:90,t:t0},t0+2*h),false);
  // 一次借到 150：從借款當下起算，24 小時後上門
  let r=borrow({cash:50},150,t0);assert.equal(r.loan.over,t0);
  assert.equal(mobDue(r.loan,t0+23*h),false);assert.equal(mobDue(r.loan,t0+24*h),true);
  // 還到上限以下 → 計時歸零；再超過才重新計時
  const full={cash:1000,loan:r.loan};
  let r2=repay(full,60,t0+10*h,false);assert.ok(r2.loan.p<=MOB_LIMIT&&r2.loan.over===undefined);
  assert.equal(mobDue(r2.loan,t0+60*h),false);assert.equal(mobDue(r2.loan,t0+100*h),true);   // 還款後利息又把欠款推過上限：越線約在 +45 小時，+69 小時上門
  // 仍高於上限的部分還款，不會重置計時
  let r3=repay(full,10,t0+10*h,false);assert.equal(r3.loan.over,t0);assert.equal(mobDue(r3.loan,t0+24*h),true);
  // 由利息把 99 推過 100：以公式反推越線時間，再滿 24 小時才上門
  const lo={p:99,t:t0},cross=t0+DAY*Math.log(100/99)/Math.log(1.05);
  assert.ok(near(overAt(lo,t0+30*h),cross,1));assert.equal(mobDue(lo,cross+23*h),false);assert.equal(mobDue(lo,cross+24*h+1),true);
  assert.equal(mobDue(undefined,t0),false);assert.equal(mobDue({p:0,t:t0},t0+99*DAY),false);
});

test("機率提升每 5 分鐘降 10%，直到回到 50%；低於 50% 的對稱回升",()=>{
  const M=5*60*1000,hi={bias:.1,biasAt:0},lo={bias:-.1,biasAt:0};
  assert.equal(DECAY,.9);assert.equal(DECAY_MS,M);
  assert.ok(near(effBias(hi,0),.1));assert.ok(near(effBias(hi,M),.09));assert.ok(near(effBias(hi,2*M),.081));assert.ok(near(effBias(hi,10*M),.1*Math.pow(.9,10)));
  assert.ok(near(effBias(lo,M),-.09));assert.ok(near(effBias(lo,2*M),-.081));                       // 低於 50%：每 5 分鐘回升 10%
  assert.ok(near(effBias(hi,2.5*60*1000),.1*Math.pow(.9,.5)));                                      // 按真實時間，不是一格一格跳
  assert.equal(effBias(hi,40*M),0);assert.equal(effBias(lo,40*M),0);                                // 久了就回到 50%（小於 0.5 個百分點歸零）
  assert.equal(effBias({bias:.1,biasAt:M},0),.1);                                                   // 時鐘倒退不會放大
  assert.equal(effBias({bias:.1},123),.1);assert.equal(effBias({},5),0);                            // 舊資料沒有 biasAt → 不衰減
  assert.ok(near(effBias({bias:effBias(hi,M),biasAt:M},2*M),effBias(hi,2*M)));                       // 分段衰減＝一次衰減（和排程間隔無關）
});
