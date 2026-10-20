import test from "node:test";import assert from "node:assert";
import {route} from "../src/app.js";import {HttpError} from "../src/errors.js";import {fakeDb} from "./helpers.js";
const env={ALLOWED_ORIGIN:"https://u.github.io"},H=3600e3;
function mk(o={}){
  const t={v:1.8e12},db=fakeDb(),state={me:{id:"iau_1",workshopName:"測試工坊"},provider:"google.com",uid:"g1",judges:0};
  const d={db,now:()=>t.v,rand:()=>.5,
    verify:async()=>({uid:state.uid,provider:state.provider}),
    ia:{me:async()=>state.me,history:async()=>[{result:"火",failed:false,createdAt:t.v-H},{result:"水",failed:false,createdAt:t.v-25*H},{result:"土",failed:true,createdAt:t.v-H}]},
    judge:async()=>{state.judges++;return {score:90,reason:"火本身"};},...o};
  const call=async(p,body)=>{const r=await route(new Request("https://w"+p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})}),env,d);return {status:r.status,body:await r.json(),h:r.headers};};
  return {d,db,t,state,call};
}
const inj=(x={})=>({stockId:"fire",itemName:"火",iaToken:"tok12345",geminiKey:"k".repeat(12),...x});
test("市場初始化（只做一次）",async()=>{const {call,db}=mk();await call("/ensure-market");await call("/ensure-market");assert.equal([...db.m.keys()].filter(k=>k.startsWith("stocks/")).length,6);});
test("投入成功：股價/玩家/動態/綁定一次寫好，且 CORS 標頭正確",async()=>{
  const {call,db,t}=mk();await call("/ensure-market");
  const r=await call("/inject",inj());
  assert.equal(r.status,200);assert.equal(r.body.score,90);assert.ok(r.body.pct>0);
  assert.equal(r.h.get("Access-Control-Allow-Origin"),"https://u.github.io");
  assert.ok(db.m.get("stocks/fire").data.price>12);
  assert.deepEqual(db.m.get("players/iau_1").data.hold,{});assert.equal(db.m.get("players/iau_1").data.cash,50);
  assert.ok([...db.m.keys()].some(k=>k.startsWith("feed/")));
  assert.equal(db.m.get("links/g1").data.iaId,"iau_1");assert.equal(db.m.get("iaLinks/iau_1").data.uid,"g1");
});
test("未登入 / 非 Google 提供者 → 401",async()=>{
  const a=mk();a.state.provider="anonymous";assert.equal((await a.call("/inject",inj())).status,401);
  const b=mk({verify:async()=>{throw new HttpError(401,"unauthenticated","x");}});assert.equal((await b.call("/trade",{})).status,401);
});
test("24 小時規則：過期與失敗的合成 → 403，且不呼叫 AI",async()=>{
  const {call,state,db}=mk();await call("/ensure-market");
  assert.equal((await call("/inject",inj({itemName:"水"}))).status,403);
  assert.equal((await call("/inject",inj({itemName:"土"}))).status,403);
  assert.equal(state.judges,0);assert.equal(db.m.get("stocks/fire").data.price,12);
});
test("冷卻 8 秒",async()=>{
  const {call,t}=mk();await call("/ensure-market");await call("/inject",inj());
  assert.equal((await call("/inject",inj())).status,429);
  t.v+=9000;assert.equal((await call("/inject",inj())).status,200);
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
