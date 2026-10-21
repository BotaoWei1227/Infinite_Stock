import test from "node:test";import assert from "node:assert";
import {upProb,nudge,step,trade,recent,DAY,MAXH} from "../src/logic.js";
const near=(a,b,e=1e-9)=>Math.abs(a-b)<e;
const S=(o={})=>({price:12,base:12,bias:0,t:[0],p:[12],...o});
test("偏移：相關→漲機率提高、無關→跌機率提高、上限 ±0.4",()=>{
  assert.ok(near(nudge(0,100),.3));assert.ok(near(nudge(0,0),-.3));assert.equal(nudge(0,50),0);
  assert.equal(nudge(.3,100),.4);assert.equal(nudge(-.3,0),-.4);
  assert.ok(near(upProb(.3),.8));assert.equal(upProb(.4),.9);assert.equal(upProb(-.4),.1);
});
test("走一步：機率決定方向，幅度 0.3–1.5%",()=>{
  assert.equal(step(S(),.4,.5,1).price,12.11);   // r1<0.5 → 漲
  assert.equal(step(S(),.6,.5,1).price,11.89);   // r1>0.5 → 跌
  assert.equal(step(S({bias:.3}),.7,.5,1).price,12.11); // 偏移 +0.3 → 上漲機率 80%，0.7 仍漲
  assert.equal(step(S({bias:-.3}),.4,.5,1).price,11.89); // 偏移 -0.3 → 上漲機率 20%，0.4 反而跌
  const lo=step(S(),.4,0,1).price/12-1,hi=step(S(),.4,1,1).price/12-1;
  assert.ok(lo>=.0029&&hi<=.0151);
});
test("偏移每步衰減，過小歸零；價格下限 1；均值回歸",()=>{
  assert.ok(near(step(S({bias:.3}),.5,.5,1).bias,.276));
  assert.equal(step(S({bias:.005}),.5,.5,1).bias,0);
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

import {owed,borrow,repay,DEBT_CAP,RATE} from "../src/logic.js";
test("銀行：5%/24 小時複利、借款上限、部分/全額還款",()=>{
  const t0=1e13;
  assert.equal(owed(undefined,t0),0);assert.equal(owed({p:0,t:t0},t0),0);
  assert.ok(near(owed({p:50,t:t0},t0+DAY),52.5));assert.ok(near(owed({p:100,t:t0},t0+2*DAY),110.25));
  assert.ok(near(owed({p:50,t:t0},t0+DAY/2),50*Math.sqrt(1.05)));
  let r=borrow({cash:50},50,t0);assert.deepEqual(r,{cash:100,loan:{p:50,t:t0}});
  assert.throws(()=>borrow({cash:50,loan:{p:60,t:t0}},50,t0),/上限/);
  assert.equal(DEBT_CAP,100);assert.equal(RATE,.05);
  const d={cash:100,loan:{p:50,t:t0}};
  r=repay(d,20,t0+DAY,false);assert.equal(r.cash,80);assert.ok(near(r.loan.p,32.5));
  r=repay(d,0,t0+DAY,true);assert.equal(r.cash,47.5);assert.equal(r.loan.p,0);
  r=repay(d,999,t0+DAY,false);assert.equal(r.loan.p,0);              // 超額還款視為全額
  assert.throws(()=>repay({cash:10,loan:{p:50,t:t0}},0,t0,true),/現金不足/);
  assert.throws(()=>repay({cash:10},5,t0,false),/沒有欠款/);
});
