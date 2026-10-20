import test from "node:test";import assert from "node:assert";
import {pUp,roll,applyPct,trade,recent,DAY} from "../src/logic.js";
const near=(a,b)=>Math.abs(a-b)<1e-9;
test("機率範圍",()=>{assert.ok(near(pUp(100),.85));assert.ok(near(pUp(50),.55));assert.ok(near(pUp(0),.15));});
test("相關→可能漲、無關→可能跌",()=>{assert.ok(roll(100,.5,.1)>0);assert.ok(roll(0,.5,.5)<0);assert.ok(roll(0,.5,.1)>0);});
test("幅度 2–8%",()=>{assert.ok(Math.abs(roll(80,0,0))>=.02-1e-9);assert.ok(Math.abs(roll(80,1,0))<=.08+1e-9);});
test("價格下限為 1",()=>{assert.equal(applyPct(1,-.08),1);assert.equal(applyPct(10,.05),10.5);});
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
