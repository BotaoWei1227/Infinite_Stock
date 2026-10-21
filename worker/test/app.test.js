import test from "node:test";import assert from "node:assert";
import {route,tick} from "../src/app.js";import {HttpError} from "../src/errors.js";import {fakeDb} from "./helpers.js";
const env={ALLOWED_ORIGIN:"https://u.github.io"},H=3600e3;
function mk(o={}){
  const t={v:1.8e12},db=fakeDb(),state={me:{id:"iau_1",workshopName:"測試工坊"},provider:"google.com",uid:"g1",judges:0};
  const d={db,now:()=>t.v,rand:()=>.5,
    verify:async()=>({uid:state.uid,provider:state.provider}),
    ia:{me:async()=>state.me,history:async()=>[{result:"火",failed:false,createdAt:t.v-H},{result:"雷",failed:false,createdAt:t.v-H},{result:"水",failed:false,createdAt:t.v-25*H},{result:"土",failed:true,createdAt:t.v-H}]},
    judge:async()=>{state.judges++;return {score:90,reason:"火本身"};},...o};
  const call=async(p,body)=>{const r=await route(new Request("https://w"+p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})}),env,d);return {status:r.status,body:await r.json(),h:r.headers};};
  return {d,db,t,state,call};
}
const inj=(x={})=>({stockId:"fire",itemName:"火",iaToken:"tok12345",geminiKey:"k".repeat(12),...x});
const H2=3600e3;
const MS=db=>db.m.get("market/state").data.stocks;
test("市場初始化（只做一次）",async()=>{
  const {call,db}=mk();await call("/ensure-market");await call("/ensure-market");
  assert.equal(Object.keys(MS(db)).length,6);assert.equal(MS(db).fire.t.length,1);
});
test("投入：只改變機率並走一步；玩家/動態/綁定一次寫好，CORS 正確",async()=>{
  const {call,db}=mk();await call("/ensure-market");
  const r=await call("/inject",inj());
  assert.equal(r.status,200);assert.equal(r.body.score,90);assert.equal(r.body.up,74);assert.equal(r.body.price,12.11);assert.ok(r.body.pct>0);
  assert.equal(r.h.get("Access-Control-Allow-Origin"),"https://u.github.io");
  const f=MS(db).fire;assert.ok(Math.abs(f.bias-.2208)<1e-9);assert.deepEqual(f.p,[12,12.11]);assert.equal(f.t.length,2);assert.equal(f.last,"火（90分）");
  assert.equal(MS(db).water.price,10);                    // 其他股票不受影響
  assert.deepEqual(db.m.get("players/iau_1").data.hold,{});assert.equal(db.m.get("players/iau_1").data.cash,50);
  const fd=[...db.m].find(([k])=>k.startsWith("feed/"))[1].data;assert.equal(fd.up,74);assert.equal(fd.stock,"火");
  assert.equal(db.m.get("links/g1").data.iaId,"iau_1");assert.equal(db.m.get("iaLinks/iau_1").data.uid,"g1");
});
test("無關造物提高下跌機率",async()=>{
  const {call,db}=mk({judge:async()=>({score:10,reason:"無關"})});await call("/ensure-market");
  const r=await call("/inject",inj());assert.equal(r.body.up,26);assert.ok(MS(db).fire.bias<0);
});
test("排程：每檔隨機走一步，偏移衰減；衝突會重試；缺市場時會建立",async()=>{
  const {call,db,d}=mk();await call("/ensure-market");await call("/inject",inj());
  await tick(d);
  const f=MS(db).fire;assert.equal(f.t.length,3);assert.ok(Math.abs(f.bias-.2208*.92)<1e-9);
  assert.equal(MS(db).water.t.length,2);
  db.failNext=2;await tick(d);assert.equal(MS(db).water.t.length,3);
  const e=mk();await tick(e.d);assert.equal(Object.keys(MS(e.db)).length,6);
});
test("未登入 / 非 Google 提供者 → 401",async()=>{
  const a=mk();a.state.provider="anonymous";assert.equal((await a.call("/inject",inj())).status,401);
  const b=mk({verify:async()=>{throw new HttpError(401,"unauthenticated","x");}});assert.equal((await b.call("/trade",{})).status,401);
});
test("24 小時規則：過期與失敗的合成 → 403，且不呼叫 AI",async()=>{
  const {call,state,db}=mk();await call("/ensure-market");
  assert.equal((await call("/inject",inj({itemName:"水"}))).status,403);
  assert.equal((await call("/inject",inj({itemName:"土"}))).status,403);
  assert.equal(state.judges,0);assert.equal(MS(db).fire.price,12);
});
test("冷卻 8 秒",async()=>{
  const {call,t}=mk();await call("/ensure-market");await call("/inject",inj());
  assert.equal((await call("/inject",inj())).status,429);
  t.v+=9000;assert.equal((await call("/inject",inj({itemName:"雷"}))).status,200);
});
test("Google ↔ 工坊 一對一綁定",async()=>{
  const m=mk();await m.call("/ensure-market");await m.call("/trade",{stockId:"fire",dir:1,iaToken:"tok12345"});
  m.state.uid="g2";assert.equal((await m.call("/trade",{stockId:"fire",dir:1,iaToken:"tok12345"})).status,409);
  m.state.uid="g1";m.state.me={id:"iau_2"};assert.equal((await m.call("/trade",{stockId:"fire",dir:1,iaToken:"tok12345"})).status,409);
});
test("買賣：扣款、持股、現金不足",async()=>{
  const {call,db}=mk();await call("/ensure-market");
  for(let i=0;i<4;i++)assert.equal((await call("/trade",{stockId:"fire",dir:1,iaToken:"tok12345"})).status,200);
  assert.deepEqual(db.m.get("players/iau_1").data,{name:"測試工坊",cash:2,hold:{fire:4}});
  assert.equal((await call("/trade",{stockId:"fire",dir:1,iaToken:"tok12345"})).status,409);
  assert.equal((await call("/trade",{stockId:"water",dir:-1,iaToken:"tok12345"})).status,409);
});
test("樂觀鎖衝突會自動重試",async()=>{
  const {call,db}=mk();await call("/ensure-market");db.failNext=2;
  assert.equal((await call("/trade",{stockId:"fire",dir:1,iaToken:"tok12345"})).status,200);
});
test("參數檢查與 OPTIONS",async()=>{
  const {call,d}=mk();await call("/ensure-market");
  assert.equal((await call("/inject",inj({stockId:"../x"}))).status,400);
  assert.equal((await call("/trade",{stockId:"fire",dir:5,iaToken:"tok12345"})).status,400);
  const r=await route(new Request("https://w/inject",{method:"OPTIONS"}),env,d);assert.equal(r.status,204);
});

test("每個造物每天限一次；24 小時後可再投入，過期紀錄會被清掉",async()=>{
  const {call,db,t}=mk();await call("/ensure-market");
  assert.equal((await call("/inject",inj())).status,200);
  assert.ok(typeof db.m.get("players/iau_1").data.used["火"]==="number");
  t.v+=9000;let r=await call("/inject",inj());assert.equal(r.status,409);assert.match(r.body.error.message,/今天已經投入/);
  r=await call("/inject",inj({itemName:"雷"}));assert.equal(r.status,200);
  assert.deepEqual(Object.keys(db.m.get("players/iau_1").data.used).sort(),["火","雷"].sort());
  t.v+=25*H2;r=await call("/inject",inj());assert.equal(r.status,200);
  assert.deepEqual(Object.keys(db.m.get("players/iau_1").data.used),["火"]);
});

const BK=(x={})=>({iaToken:"tok12345",...x});
test("銀行：借款→利息累計→還款；欠款不被其他操作覆蓋",async()=>{
  const {call,db,t}=mk();await call("/ensure-market");
  let r=await call("/bank",BK({action:"borrow",amount:50}));assert.equal(r.status,200);assert.equal(r.body.cash,100);assert.equal(r.body.owed,50);
  assert.deepEqual(db.m.get("players/iau_1").data.loan,{p:50,t:t.v});assert.deepEqual(db.m.get("players/iau_1").data.hold,{});
  await call("/trade",{stockId:"fire",dir:1,iaToken:"tok12345"});assert.equal(db.m.get("players/iau_1").data.loan.p,50);   // 買股票不影響欠款
  t.v+=DAYMS;r=await call("/bank",BK({action:"repay",amount:10}));assert.equal(r.status,200);assert.equal(r.body.owed,42.5);assert.equal(r.body.cash,78);
  r=await call("/bank",BK({action:"repay",all:true}));assert.equal(r.status,200);assert.equal(r.body.owed,0);assert.equal(r.body.cash,35.5);
  assert.equal((await call("/bank",BK({action:"repay",all:true}))).status,409);
});
test("銀行：上限、現金不足、金額檢查、需要登入",async()=>{
  const {call,t,state}=mk();await call("/ensure-market");
  assert.equal((await call("/bank",BK({action:"borrow",amount:60}))).status,200);
  assert.equal((await call("/bank",BK({action:"borrow",amount:60}))).status,409);
  t.v+=10*DAYMS;                                                    // 利息滾到 ≈97.7，現金 110 夠；再借會超過上限
  assert.equal((await call("/bank",BK({action:"borrow",amount:10}))).status,409);
  for(const bad of [0,-5,"abc",101,null])assert.equal((await call("/bank",BK({action:"borrow",amount:bad}))).status,400);
  assert.equal((await call("/bank",BK({action:"steal",amount:5}))).status,400);
  state.provider="anonymous";assert.equal((await call("/bank",BK({action:"borrow",amount:5}))).status,401);
});
test("銀行：現金不足時不能還款",async()=>{
  const {call,t}=mk();await call("/ensure-market");
  await call("/bank",BK({action:"borrow",amount:100}));
  for(let i=0;i<12;i++)await call("/trade",{stockId:"steam",dir:1,iaToken:"tok12345"});   // 18×… 把現金花光
  t.v+=3*DAYMS;const r=await call("/bank",BK({action:"repay",all:true}));assert.equal(r.status,409);assert.match(r.body.error.message,/現金不足/);
});
const DAYMS=864e5;
