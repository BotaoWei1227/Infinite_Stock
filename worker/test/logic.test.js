import test from "node:test";import assert from "node:assert";
import {effOdds,activeEvents,eventShift,markClaim,MAX_SHIFT,MAX_EVENTS,demValue,tdValue,tdEnd,settle,depositsValue,demIn,demOut,tdIn,tdBreak,DEM_RATE,TD_RATE,TD_DAYS,MAX_TDS,effBias,DECAY,DECAY_MS,SIM_THRESHOLD,passes,upProb,nudge,tradeNudge,INJECT_MAX,BIAS_CAP,FLOAT_FLOOR,TRADE_PRESSURE,step,trade,recent,DAY,MAXH} from "../src/logic.js";
const near=(a,b,e=1e-9)=>Math.abs(a-b)<e;
const S=(o={})=>({price:12,base:12,bias:0,t:[0],p:[12],...o});
test("相似度門檻：要高過 70 才算相關；越高於/低於門檻影響越大；等於門檻沒有影響",()=>{
  assert.equal(SIM_THRESHOLD,70);assert.equal(passes(71),true);assert.equal(passes(70),false);assert.equal(passes(0),false);
  assert.ok(near(nudge(0,100),.05));assert.ok(near(nudge(0,0),-.05));assert.equal(nudge(0,70),0);
  assert.ok(near(nudge(0,85),.025));assert.ok(near(nudge(0,71),.05/30));                  // 剛高過門檻 → 只有一點點
  assert.ok(near(nudge(0,35),-.025));assert.ok(near(nudge(0,69),-.05/70));                // 剛低於門檻 → 只降一點點
  assert.equal(nudge(.14,100),.15);assert.equal(nudge(-.14,0),-.15);                      // 上限 ±15 個百分點
  assert.equal(FLOAT_FLOOR,100);assert.equal(TRADE_PRESSURE,.3);
  // 買賣壓力＝交易股數占全服持股的比例 × 30 個百分點（全服持股至少當成 100 股）
  assert.ok(near(tradeNudge(0,1,1,1000),.0003));assert.ok(near(tradeNudge(0,-1,1,1000),-.0003));    // 1 股 / 1000 股：幾乎沒影響
  assert.ok(near(tradeNudge(0,-1,50,1000),-.015));                                                 // 賣掉 5%：-1.5 個百分點
  assert.equal(tradeNudge(0,-1,900,1000),-.15);assert.equal(tradeNudge(0,1,900,1000),.15);          // 賣掉 90%：重創（碰到上限）
  assert.ok(near(tradeNudge(0,1,1,0),.003));assert.ok(near(tradeNudge(0,1,5,20),.015));            // 全服持股很少時，用 100 股當分母
  assert.ok(near(tradeNudge(0,1,500,50),.3>.15?.15:.3));                                           // 一次買超過全服持股：比例最多當 100%
  assert.equal(tradeNudge(.15,1,1,1000)>.15,false);assert.equal(tradeNudge(-.15,-1,1,1000),-.15);
  assert.ok(near(upProb(.3),.8));assert.equal(upProb(.4),.9);assert.equal(upProb(-.4),.1);
  assert.equal(INJECT_MAX,.05);assert.equal(BIAS_CAP,.15);
  let b=0;for(let i=0;i<100;i++)b=nudge(b,100);assert.equal(b,.15);                      // 100 個人狂投也只到 65%
});
test("走一步（每分鐘一步）：機率決定方向，幅度 0.15–0.75%",()=>{
  assert.equal(step(S(),.4,.5,1).price,12.05);   // r1<0.5 → 漲
  assert.equal(step(S(),.6,.5,1).price,11.95);   // r1>0.5 → 跌
  assert.equal(step(S(),.7,.5,1,.3).price,12.05); // 偏移 +0.3 → 上漲機率 80%，0.7 仍漲
  assert.equal(step(S(),.4,.5,1,-.3).price,11.95); // 偏移 -0.3 → 上漲機率 20%，0.4 反而跌
  const lo=step(S(),.4,0,1).price/12-1,hi=step(S(),.4,1,1).price/12-1;
  assert.ok(lo>=.00145&&hi<=.00755);
});
test("價格下限 1；均值回歸；公開行情不含機率欄位；私密偏移按時間衰減",()=>{
  assert.equal(step(S({price:1,base:1}),.9,.5,1).price,1);
  const r=step(S({price:24}),.1,.5,1).price;assert.ok(r>24&&r<24*1.009);
  const n=step(S({bias:.3,biasAt:0}),.4,.5,1);assert.equal("bias" in n,false);assert.equal("biasAt" in n,false);   // 舊欄位也會被清掉
  assert.ok(near(effOdds({v:.1,at:0},5*60*1000),.09));assert.equal(effOdds(undefined,5),0);
});
test("走勢點保留最近 MAXH 個，並可附上說明文字",()=>{
  const s=S({t:Array.from({length:MAXH},(_,i)=>i),p:Array.from({length:MAXH},()=>12)});
  const n=step(s,.4,.5,999,0,0,"火（90分）");
  assert.equal(n.t.length,MAXH);assert.equal(n.t.at(-1),999);assert.equal(n.p.length,MAXH);assert.equal(n.last,"火（90分）");
});
test("買賣",()=>{
  assert.deepEqual(trade({cash:50,hold:{}},"fire",12,1),{cash:38,hold:{fire:1}});
  assert.throws(()=>trade({cash:5,hold:{}},"fire",12,1),/現金不足/);
  assert.throws(()=>trade({cash:5,hold:{}},"fire",12,-1),/持股不足/);
  assert.deepEqual(trade({cash:1000,hold:{fire:2}},"fire",12,1,37),{cash:556,hold:{fire:39}});          // 自訂股數
  assert.deepEqual(trade({cash:0,hold:{fire:50}},"fire",12,-1,41),{cash:492,hold:{fire:9}});
  assert.throws(()=>trade({cash:1e9,hold:{}},"fire",12,1,0),/整數/);assert.throws(()=>trade({cash:1e9,hold:{}},"fire",12,1,2.5),/整數/);
  assert.throws(()=>trade({cash:1e9,hold:{}},"fire",12,1,100001),/整數/);
});
test("24 小時內的成功合成才算",()=>{
  const now=1e13,h=3600e3;
  const m=recent([{result:"火",createdAt:now-h},{result:"火",createdAt:now-2*h},{result:"水",createdAt:now-25*h},
    {result:null,failed:true,createdAt:now-h},{result:"土",failed:true,createdAt:now-h},{result:"風",createdAt:now+10*h}],now);
  assert.deepEqual([...m],[["火",now-h]]);
  assert.equal(recent([{result:"雷",createdAt:now-DAY}],now).has("雷"),true);
  assert.equal(recent([{result:"雷",createdAt:now-DAY-1}],now).has("雷"),false);
});
import {usedKey,usedBefore,markUsed} from "../src/logic.js";
test("同一個造物只能投入一次：名稱正規化、舊資料相容、有數量上限",()=>{
  const now=1e13;
  let u=markUsed({},"火焰",now);assert.deepEqual(Object.keys(u),["n:火焰"]);
  assert.equal(usedBefore(u,"火焰"),true);assert.equal(usedBefore(u,"水"),false);assert.equal(usedBefore(undefined,"火焰"),false);
  assert.equal(usedBefore(markUsed({},"ＡＢ c",now),"ab C"),true);assert.equal(usedKey("  Ｆｉｒｅ "),"n:fire");   // 全形、大小寫、空白都擋
  assert.equal(usedBefore({火:1},"火"),true);                                                                    // 舊資料（沒有前綴的名稱）也算
  assert.equal(usedBefore(markUsed({},"__x__",now),"__x__"),true);assert.ok(Object.keys(markUsed({},"__x__",now))[0].startsWith("n:"));
  let big={};for(let i=0;i<2100;i++)big=markUsed(big,"造物"+i,now+i);
  assert.equal(Object.keys(big).length,2000);assert.equal(usedBefore(big,"造物0"),false);assert.equal(usedBefore(big,"造物2099"),true);   // 超過上限丟最舊的
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

test("存款：活存日利率 0.4%、定存日利率 1.2% 鎖 3 天，按時間連續複利",()=>{
  const t0=1e13,D=DAY;
  assert.equal(DEM_RATE,.004);assert.equal(TD_RATE,.012);assert.equal(TD_DAYS,3);
  assert.ok(near(demValue({a:100,t:t0},t0+D),100.4));assert.ok(near(demValue({a:100,t:t0},t0+2*D),100.8016));assert.equal(demValue(undefined,t0),0);
  const td={p:100,t:t0};
  assert.ok(near(tdValue(td,t0+D),101.2));assert.ok(near(tdValue(td,t0+3*D),100*1.012**3));
  assert.ok(near(tdValue(td,t0+10*D),100*1.012**3));                                  // 到期後不再以定存利率累計
  assert.equal(tdEnd(td),t0+3*D);
});
test("存款：到期的定存自動轉入活存（之後以活存利率計息），結算按到期先後",()=>{
  const t0=1e13,D=DAY,td=100*1.012**3;
  let s=settle({dem:{a:50,t:t0},tds:[{p:100,t:t0}]},t0+2*D);                          // 還沒到期
  assert.equal(s.tds.length,1);assert.ok(near(s.dem.a,50*1.004**2,1e-3));
  s=settle({tds:[{p:100,t:t0}]},t0+4*D);                                              // 第 3 天到期 → 活存再算 1 天
  assert.equal(s.tds.length,0);assert.ok(near(s.dem.a,td*1.004,1e-3));assert.equal(s.dem.t,t0+4*D);
  s=settle({dem:{a:50,t:t0},tds:[{p:100,t:t0}]},t0+4*D);                              // 原本就有活存
  assert.ok(near(s.dem.a,(50*1.004**3+td)*1.004,1e-3));
  s=settle({tds:[{p:100,t:t0},{p:200,t:t0+D}]},t0+5*D);                               // 兩筆先後到期
  const mid=100*1.012**3,at4=mid*1.004**1+200*1.012**3;                                // 第 3 天到期 100；第 4 天又到期 200
  assert.ok(near(s.dem.a,at4*1.004,1e-3));
  assert.ok(near(depositsValue({dem:{a:50,t:t0},tds:[{p:100,t:t0}]},t0+D),50*1.004+101.2,1e-3));   // 總額＝活存＋定存（含利息）
});
test("存款：存入/領出/定存/提前解約（只退本金）與各種錯誤",()=>{
  const t0=1e13,D=DAY;
  let r=demIn({cash:100},40,t0);assert.deepEqual([r.cash,r.dem.a],[60,40]);
  assert.throws(()=>demIn({cash:10},40,t0),/現金不足/);
  const d={cash:60,dem:{a:40,t:t0}};
  r=demOut(d,10,t0+D,false);assert.equal(r.cash,70);assert.ok(near(r.dem.a,40*1.004-10,1e-3));
  r=demOut(d,0,t0+D,true);assert.equal(r.cash,100.16);assert.equal(r.dem.a,0);
  r=demOut(d,40.16,t0+D,false);assert.equal(r.dem.a,0);                              // 剛好等於餘額（差不到半分錢）→ 全領
  assert.throws(()=>demOut(d,40.17,t0+D,false),/不足/);                                // 多領 1 分錢就報錯
  assert.throws(()=>demOut(d,50,t0+D,false),/不足/);assert.throws(()=>demOut({cash:1},5,t0,false),/沒有餘額/);
  r=tdIn({cash:100},30,t0);assert.deepEqual([r.cash,r.tds],[70,[{p:30,t:t0}]]);
  assert.throws(()=>tdIn({cash:100},0.5,t0),/最少/);assert.throws(()=>tdIn({cash:10},30,t0),/現金不足/);
  const many=Array.from({length:MAX_TDS},(_,i)=>({p:1,t:t0+i}));assert.throws(()=>tdIn({cash:100,tds:many},5,t0+1000),/最多/);
  const withTd={cash:0,tds:[{p:100,t:t0}]};
  r=tdBreak(withTd,t0,t0+D);assert.equal(r.cash,100);assert.deepEqual(r.tds,[]);        // 提前解約：只退本金，1 天的利息作廢
  assert.throws(()=>tdBreak(withTd,t0+1,t0+D),/找不到/);
  assert.throws(()=>tdBreak(withTd,t0,t0+4*D),/找不到/);                                // 已到期轉入活存，不能再「解約」
});

test("財經新聞活動：期間內才有效；多個活動相加；走一步時套用基準機率偏移",()=>{
  const now=1e13,ev=[{id:"a",until:now+1000,shift:{fire:.1,water:-.2}},{id:"b",until:now+5000,shift:{fire:.05}},{id:"c",until:now-1,shift:{fire:.4}}];
  assert.ok(near(eventShift(ev,"fire",now),.15));assert.ok(near(eventShift(ev,"water",now),-.2));assert.equal(eventShift(ev,"wind",now),0);
  assert.ok(near(eventShift(ev,"fire",now+2000),.05));assert.equal(eventShift(ev,"fire",now+9999),0);                 // 活動結束後自動失效
  assert.deepEqual(activeEvents(ev,now).map(e=>e.id),["a","b"]);assert.deepEqual(activeEvents(undefined,now),[]);assert.equal(eventShift(undefined,"fire",now),0);
  assert.equal(MAX_SHIFT,40);assert.equal(MAX_EVENTS,20);
  const S0={price:12,base:12,bias:0,t:[0],p:[12]};
  assert.ok(step(S0,.45,.5,1,0,0).price>12);                                  // 沒活動：r1 小於上漲機率(50%) 才會漲
  assert.ok(step(S0,.55,.5,1,0,0).price<12);assert.ok(step(S0,.55,.5,1,0,.1).price>12);               // 活動 +10：上漲機率 60%，0.55 就會漲
  assert.ok(step(S0,.45,.5,1,0,-.1).price<12);                                                              // 活動 −10：上漲機率 40%，0.45 就會跌
  assert.ok(step(S0,.65,.5,1,.1,.1).price>12);assert.ok(step(S0,.75,.5,1,.1,.1).price<12);   // 與玩家偏移疊加（70%）
  assert.ok(step(S0,.89,.5,1,0,.9).price>12);assert.ok(step(S0,.91,.5,1,0,.9).price<12);              // 總機率仍被限制在 10%–90%
  let c=markClaim({},"x",5);assert.deepEqual(c,{x:5});
  for(let i=0;i<150;i++)c=markClaim(c,"e"+i,10+i);assert.equal(Object.keys(c).length,100);assert.ok("e149" in c&&!("x" in c));
});
