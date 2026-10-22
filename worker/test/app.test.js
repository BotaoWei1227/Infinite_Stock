import test from "node:test";import assert from "node:assert";
import {route,tick} from "../src/app.js";import {HttpError} from "../src/errors.js";import {fakeDb} from "./helpers.js";
const env={ALLOWED_ORIGIN:"https://u.github.io"},H=3600e3,DAYMS=864e5;
function mk(o={}){
  const t={v:1.8e12},db=fakeDb(),state={me:{id:"iau_1",workshopName:"測試工坊"},provider:"google.com",uid:"g1",name:"Botao",email:"player@example.com",emailVerified:true,judges:0,iaDown:false};
  const d={db,now:()=>t.v,rand:()=>.5,
    verify:async()=>({uid:state.uid,provider:state.provider,name:state.name,email:state.email,emailVerified:state.emailVerified}),
    ia:{me:async()=>{if(state.iaDown)throw new HttpError(401,"unauthenticated","授權失效，請重新連結《無限煉製》");return state.me;},
        history:async()=>[{result:"火",failed:false,createdAt:t.v-H},{result:"雷",failed:false,createdAt:t.v-H},{result:"水",failed:false,createdAt:t.v-25*H},{result:"土",failed:true,createdAt:t.v-H}]},
    judge:async()=>{state.judges++;return {score:90,reason:"火本身"};},...o};
  const call=async(p,body)=>{const r=await route(new Request("https://w"+p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})}),env,d);return {status:r.status,body:await r.json(),h:r.headers};};
  return {d,db,t,state,call};
}
const inj=(x={})=>({stockId:"fire",itemName:"火",iaToken:"tok12345",geminiKey:"k".repeat(12),...x});
const TR=(x={})=>({stockId:"fire",dir:1,...x});
const BK=(x={})=>({...x});
const MS=db=>db.m.get("market/state").data.stocks;
const P=db=>db.m.get("players/g1").data;
const feeds=db=>[...db.m].filter(([k])=>k.startsWith("feed/")).map(([,v])=>v.data);

test("市場初始化（只做一次）",async()=>{
  const {call,db}=mk();await call("/ensure-market");await call("/ensure-market");
  assert.equal(Object.keys(MS(db)).length,6);assert.equal(MS(db).fire.t.length,1);
});
test("投入：只改變機率、價格不跳動；玩家(以 Google uid 為鍵)/動態/綁定一次寫好，CORS 正確",async()=>{
  const {call,db}=mk();await call("/ensure-market");
  const r=await call("/inject",inj());
  assert.equal(r.status,200);assert.equal(r.body.score,90);assert.equal(r.body.up,53);assert.equal(r.body.price,12);assert.equal(r.body.pass,true);assert.equal(r.body.threshold,70);
  assert.equal(r.h.get("Access-Control-Allow-Origin"),"https://u.github.io");
  const f=MS(db).fire;assert.ok(Math.abs(f.bias-.05*20/30)<1e-9);assert.deepEqual(f.p,[12]);assert.equal(f.t.length,1);assert.equal(f.last,"火（90分）");   // 沒有新的價格點
  assert.equal(MS(db).water.price,10);
  assert.equal(P(db).name,"測試工坊");assert.equal(P(db).cash,50);assert.deepEqual(P(db).hold,{});assert.ok(typeof P(db).used["n:火"]==="number");
  assert.equal(feeds(db)[0].up,53);assert.equal(feeds(db)[0].pass,true);assert.equal("pct" in feeds(db)[0],false);assert.equal(feeds(db)[0].stock,"火");
  assert.equal(db.m.get("links/g1").data.iaId,"iau_1");assert.equal(db.m.get("iaLinks/iau_1").data.uid,"g1");
});
test("無關造物提高下跌機率",async()=>{
  const {call,db}=mk({judge:async()=>({score:10,reason:"無關"})});await call("/ensure-market");
  const r=await call("/inject",inj());assert.equal(r.body.up,46);assert.equal(r.body.pass,false);assert.ok(MS(db).fire.bias<0);
});
test("排程：每檔隨機走一步，偏移衰減；衝突會重試；缺市場時會建立",async()=>{
  const {call,db,d,t}=mk();await call("/ensure-market");await call("/inject",inj());
  t.v+=5*60*1000;await tick(d);
  const f=MS(db).fire;assert.equal(f.t.length,2);assert.ok(Math.abs(f.bias-(.05*20/30)*.9)<1e-9);assert.equal(f.biasAt,t.v);assert.equal(MS(db).water.t.length,2);
  db.failNext=2;await tick(d);assert.equal(MS(db).water.t.length,3);
  const e=mk();await tick(e.d);assert.equal(Object.keys(MS(e.db)).length,6);
});
test("未登入 / 非 Google 提供者 → 401",async()=>{
  const a=mk();a.state.provider="anonymous";
  for(const [p,b] of [["/inject",inj()],["/trade",TR()],["/bank",BK({action:"borrow",amount:5})]])assert.equal((await a.call(p,b)).status,401);
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
test("Google ↔ 工坊 一對一綁定（投入時檢查）",async()=>{
  const m=mk();await m.call("/ensure-market");await m.call("/inject",inj());m.t.v+=9000;
  m.state.uid="g2";assert.equal((await m.call("/inject",inj({itemName:"雷"}))).status,409);
  m.state.uid="g1";m.state.me={id:"iau_2"};assert.equal((await m.call("/inject",inj({itemName:"雷"}))).status,409);
});
test("買賣不需要 IA：IA 失效也能買賣、借款",async()=>{
  const {call,db,state}=mk();await call("/ensure-market");state.iaDown=true;
  for(let i=0;i<4;i++)assert.equal((await call("/trade",TR())).status,200);
  assert.deepEqual(P(db),{name:"Botao",cash:2,hold:{fire:4}});
  assert.equal((await call("/trade",TR())).status,409);
  assert.equal((await call("/trade",TR({stockId:"water",dir:-1}))).status,409);
  assert.equal((await call("/bank",BK({action:"borrow",amount:10}))).status,200);
  assert.equal((await call("/inject",inj())).status,401);                // 只有投入需要 IA
});
test("樂觀鎖衝突會自動重試",async()=>{
  const {call,db}=mk();await call("/ensure-market");db.failNext=2;
  assert.equal((await call("/trade",TR())).status,200);
});
test("參數檢查與 OPTIONS",async()=>{
  const {call,d}=mk();await call("/ensure-market");
  assert.equal((await call("/inject",inj({stockId:"../x"}))).status,400);
  assert.equal((await call("/trade",TR({dir:5}))).status,400);
  assert.equal((await route(new Request("https://w/inject",{method:"OPTIONS"}),env,d)).status,204);
});
test("同一個造物只能投入一次：隔多久都不能再投，其他造物不受影響",async()=>{
  const {call,db,t}=mk();await call("/ensure-market");
  assert.equal((await call("/inject",inj())).status,200);
  assert.ok(typeof P(db).used["n:火"]==="number");
  t.v+=9000;let r=await call("/inject",inj());assert.equal(r.status,409);assert.match(r.body.error.message,/已經投入過/);
  r=await call("/inject",inj({itemName:" 火 "}));assert.equal(r.status,409);                       // 加空白也一樣
  assert.equal((await call("/inject",inj({itemName:"雷"}))).status,200);
  assert.deepEqual(Object.keys(P(db).used).sort(),["n:火","n:雷"]);
  t.v+=25*H;assert.equal((await call("/inject",inj())).status,409);                               // 24 小時後（又合成了一次）也不行
});

test("銀行：無限借款→利息累計→還款；欠款不被其他操作覆蓋",async()=>{
  const {call,db,t}=mk();await call("/ensure-market");
  let r=await call("/bank",BK({action:"borrow",amount:50}));assert.equal(r.status,200);assert.equal(r.body.cash,100);assert.equal(r.body.owed,50);
  assert.deepEqual(P(db).loan,{p:50,t:t.v});assert.deepEqual(P(db).hold,{});
  await call("/trade",TR());assert.equal(P(db).loan.p,50);
  t.v+=DAYMS;r=await call("/bank",BK({action:"repay",amount:10}));assert.equal(r.status,200);assert.equal(r.body.owed,42.5);assert.equal(r.body.cash,78);
  r=await call("/bank",BK({action:"repay",all:true}));assert.equal(r.body.owed,0);assert.equal(r.body.cash,35.5);
  assert.equal((await call("/bank",BK({action:"repay",all:true}))).status,409);
  r=await call("/bank",BK({action:"borrow",amount:5000}));assert.equal(r.status,200);assert.equal(r.body.cash,5035.5);   // 想借多少都行
});
test("銀行：金額檢查、現金不足不能還款",async()=>{
  const {call,t}=mk();await call("/ensure-market");
  for(const bad of [0,-5,"abc",2e6,null])assert.equal((await call("/bank",BK({action:"borrow",amount:bad}))).status,400);
  assert.equal((await call("/bank",BK({action:"steal",amount:5}))).status,400);
  await call("/bank",BK({action:"borrow",amount:90}));
  for(let i=0;i<8;i++)await call("/trade",TR({stockId:"steam"}));
  t.v+=3*DAYMS;const r=await call("/bank",BK({action:"repay",all:true}));assert.equal(r.status,409);assert.match(r.body.error.message,/現金不足/);
});

test("黑道：欠款超過 100 並拖過 24 小時 → 資產清空重新開始，全服動態留下紀錄",async()=>{
  const {call,db,t}=mk();await call("/ensure-market");
  await call("/bank",BK({action:"borrow",amount:150}));await call("/trade",TR());                 // 現金 200 → 買 1 股
  t.v+=23*H;assert.equal((await call("/trade",TR())).status,200);                              // 23 小時：還安全
  t.v+=2*H;const r=await call("/trade",TR());                                                  // 25 小時：黑道上門
  assert.equal(r.status,409);assert.equal(r.body.error.code,"mob");assert.match(r.body.error.message,/黑道/);
  assert.deepEqual([P(db).cash,P(db).hold,P(db).loan.p,P(db).bankrupt],[50,{},0,1]);
  const mob=feeds(db).find(x=>x.mob);assert.equal(mob.who,"Botao");assert.ok(mob.owed>150);
  assert.equal((await call("/trade",TR())).status,200);                                        // 重新開始後可以正常玩
  assert.equal(P(db).cash,38);assert.equal(P(db).bankrupt,1);
});
test("黑道：還到 100 以下就解除；之後超過才重新計時；check 與投入也會觸發",async()=>{
  const {call,db,t,state}=mk();await call("/ensure-market");
  await call("/bank",BK({action:"borrow",amount:150}));
  t.v+=20*H;assert.equal((await call("/bank",BK({action:"repay",amount:60}))).status,200);        // 還到約 100 以下
  t.v+=200*H;assert.equal((await call("/bank",BK({action:"check"}))).status,409);                 // 利息把欠款又推過 100，隔很久才發現 → 當然要上門
  const a=mk();await a.call("/ensure-market");await a.call("/bank",BK({action:"borrow",amount:99}));
  a.t.v+=28*H;assert.equal((await a.call("/bank",BK({action:"check"}))).status,200);              // 利息約 5 小時後越線，28 小時時才過 23 小時
  a.t.v+=2*H;const r=await a.call("/bank",BK({action:"check"}));assert.equal(r.status,409);assert.equal(r.body.error.code,"mob");
  const b=mk();await b.call("/ensure-market");await b.call("/bank",BK({action:"borrow",amount:150}));b.t.v+=25*H;
  const j=await b.call("/inject",inj());assert.equal(j.status,409);assert.equal(j.body.error.code,"mob");assert.equal(b.state.judges,0);   // 不會白花 AI 額度
});
test("黑道：安全範圍內（≤100）不會被找上，再久也不會",async()=>{
  const {call,t}=mk();await call("/ensure-market");await call("/bank",BK({action:"borrow",amount:100}));
  t.v+=DAYMS/100;assert.equal((await call("/bank",BK({action:"check"}))).status,200);    // 剛借時 = 100，利息一跑就超過；這裡只驗證極短時間內不誤殺
  const s=mk();await s.call("/ensure-market");await s.call("/bank",BK({action:"borrow",amount:60}));s.t.v+=10*DAYMS;
  assert.equal((await s.call("/bank",BK({action:"check"}))).status,200);                  // 60×1.05^10≈97.7，仍在 100 內
});

const DEV="dev@example.com";
const asDev=(o={})=>{const m=mk({devEmails:[DEV],...o});m.state.email=DEV;m.state.emailVerified=true;return m;};
test("開發者：不需要 IA，可自己打字輸入任何造物；不計入每日限制；動態會標示",async()=>{
  const {call,db,state,t}=asDev();await call("/ensure-market");state.iaDown=true;
  const r=await call("/inject",{stockId:"fire",itemName:"  我亂打的東西  ",geminiKey:"k".repeat(12)});
  assert.equal(r.status,200);assert.equal(state.judges,1);
  const f=feeds(db).find(x=>x.item==="我亂打的東西");assert.equal(f.dev,true);assert.equal(f.who,"Botao");
  assert.equal(P(db).used,undefined);assert.equal(db.m.has("links/g1"),false);                    // 不綁 IA、不記每日使用
  assert.equal((await call("/inject",{stockId:"fire",itemName:"我亂打的東西",geminiKey:"k".repeat(12)})).status,429);   // 冷卻仍有效
  t.v+=9000;assert.equal((await call("/inject",{stockId:"fire",itemName:"我亂打的東西",geminiKey:"k".repeat(12)})).status,200); // 同名可重複
  assert.equal((await call("/inject",{stockId:"fire",itemName:"x".repeat(61),geminiKey:"k".repeat(12)})).status,400);
});
test("開發者判斷：信箱未驗證、不在名單、名單為空、大小寫",async()=>{
  const a=asDev();a.state.emailVerified=false;await a.call("/ensure-market");a.state.iaDown=true;
  assert.equal((await a.call("/inject",{stockId:"fire",itemName:"亂打",geminiKey:"k".repeat(12)})).status,401);   // 未驗證 → 當一般玩家，需要 IA
  const b=mk({devEmails:[DEV]});b.state.email="someone@x.com";b.state.emailVerified=true;await b.call("/ensure-market");b.state.iaDown=true;
  assert.equal((await b.call("/inject",{stockId:"fire",itemName:"亂打",geminiKey:"k".repeat(12)})).status,401);
  const c=mk();c.state.email=DEV;c.state.emailVerified=true;await c.call("/ensure-market");c.state.iaDown=true;                      // 沒設定 DEV_EMAILS
  assert.equal((await c.call("/inject",{stockId:"fire",itemName:"亂打",geminiKey:"k".repeat(12)})).status,401);
  const d2=mk({devEmails:[DEV]});d2.state.email=DEV;d2.state.emailVerified=true;
  assert.equal((await d2.call("/whoami")).body.dev,true);assert.equal((await b.call("/whoami")).body.dev,false);assert.equal((await a.call("/whoami")).body.dev,false);
  a.state.provider="anonymous";assert.equal((await a.call("/whoami")).status,401);
});

test("買賣會推動走勢：買進推升、賣出壓低上漲機率；有上限；失敗的交易不影響；不直接改價格",async()=>{
  const {call,db}=mk();await call("/ensure-market");
  await call("/trade",TR());assert.ok(Math.abs(MS(db).fire.bias-.01)<1e-9);assert.equal(MS(db).fire.price,12);assert.equal(MS(db).fire.p.length,1);
  await call("/trade",TR({dir:-1}));assert.ok(Math.abs(MS(db).fire.bias)<1e-9);
  assert.equal((await call("/trade",TR({dir:-1}))).status,409);assert.ok(Math.abs(MS(db).fire.bias)<1e-9);          // 沒持股賣不出去，不算
  await call("/trade",TR({stockId:"water"}));assert.ok(Math.abs(MS(db).water.bias-.01)<1e-9);assert.ok(Math.abs(MS(db).fire.bias)<1e-9);   // 只影響該檔
  await call("/bank",BK({action:"borrow",amount:1000}));
  for(let i=0;i<20;i++)await call("/trade",TR());assert.equal(MS(db).fire.bias,.15);                           // 買再多也只到 65%
  // 買賣沒有套利：連續買進再賣出，現金只會因為價格不變而回到原點（沒有憑空賺到的價差）
  const {call:c2,db:d2}=mk();await c2("/ensure-market");const cash0=50;await c2("/trade",TR());await c2("/trade",TR({dir:-1}));assert.equal(d2.m.get("players/g1").data.cash,cash0);
});
test("多人同時買賣會疊加但被上限擋住，且彼此不互相覆蓋",async()=>{
  const A=mk(),db=A.db;await A.call("/ensure-market");
  for(const [uid,name] of [["g1","甲"],["g2","乙"],["g3","丙"]]){A.state.uid=uid;A.state.name=name;await A.call("/trade",TR());}
  assert.ok(Math.abs(MS(db).fire.bias-.03)<1e-9);assert.equal(["g1","g2","g3"].every(u=>db.m.get("players/"+u).data.hold.fire===1),true);
});

test("門檻：剛好等於 70 不算通過（沒有影響）；71 才通過",async()=>{
  for(const [sim,pass,bias] of [[70,false,0],[71,true,.05/30],[69,false,-.05/70]]){
    const {call,db}=mk({judge:async()=>({score:sim,reason:"x",relation:"strong"})});await call("/ensure-market");
    const r=await call("/inject",inj());assert.equal(r.body.pass,pass,String(sim));assert.ok(Math.abs(MS(db).fire.bias-bias)<1e-9,String(sim));
  }
});

test("投入的機率提升每 5 分鐘降 10%（兩個方向都回到 50%），且與排程間隔無關",async()=>{
  const M=300000;
  const up=mk({judge:async()=>({score:100,reason:"x",relation:"direct"})}),dn=mk({judge:async()=>({score:0,reason:"x",relation:"none"})});
  for(const x of [up,dn]){await x.call("/ensure-market");await x.call("/inject",inj());}
  assert.ok(Math.abs(MS(up.db).fire.bias-.05)<1e-9);assert.ok(Math.abs(MS(dn.db).fire.bias+.05)<1e-9);
  const seen=[];
  for(let i=1;i<=40;i++){for(const x of [up,dn]){x.t.v+=M;await tick(x.d);}seen.push([MS(up.db).fire.bias,MS(dn.db).fire.bias]);}
  assert.ok(Math.abs(seen[0][0]-.045)<1e-9&&Math.abs(seen[0][1]+.045)<1e-9);                           // 5 分鐘後剩 90%
  assert.ok(Math.abs(seen[9][0]-.05*Math.pow(.9,10))<1e-9);                                           // 50 分鐘後
  assert.deepEqual(seen[39],[0,0]);                                                                   // 久了回到 50%
  // 每 2 分鐘一次與每 10 分鐘一次，結果相同
  const a=mk({judge:async()=>({score:100,reason:"x",relation:"direct"})}),b=mk({judge:async()=>({score:100,reason:"x",relation:"direct"})});
  for(const x of [a,b]){await x.call("/ensure-market");await x.call("/inject",inj());}
  for(let i=0;i<5;i++){a.t.v+=120000;await tick(a.d);}b.t.v+=600000;await tick(b.d);
  assert.ok(Math.abs(MS(a.db).fire.bias-MS(b.db).fire.bias)<1e-9);assert.ok(Math.abs(MS(a.db).fire.bias-.05*.81)<1e-9);
  // 買賣疊加在「已衰減」的值上
  b.t.v+=M;await b.call("/trade",TR());assert.ok(Math.abs(MS(b.db).fire.bias-(.05*.81*.9+.01))<1e-9);
});

test("存款：活存/定存的存入、領出、利息、到期轉換、提前解約；不被其他操作覆蓋",async()=>{
  const {call,db,t}=mk();await call("/ensure-market");
  let r=await call("/bank",BK({action:"dem_in",amount:30}));assert.equal(r.status,200);assert.equal(r.body.cash,20);assert.equal(r.body.deposits,30);
  r=await call("/bank",BK({action:"td_in",amount:20}));assert.equal(r.status,200);assert.equal(r.body.cash,0);assert.equal(r.body.deposits,50);
  const at=P(db).tds[0].t;assert.deepEqual(P(db).dem.a,30);assert.equal(P(db).tds.length,1);
  await call("/trade",TR({dir:1}));                                                                   // 現金 0 買不起 → 失敗，但不影響存款
  assert.equal(P(db).tds.length,1);
  t.v+=DAYMS;r=await call("/bank",BK({action:"dem_out",amount:10}));assert.equal(r.status,200);
  assert.ok(Math.abs(r.body.cash-10)<1e-9);assert.ok(Math.abs(P(db).dem.a-(30*1.004-10))<1e-3);
  assert.equal((await call("/bank",BK({action:"td_break",at:at+1}))).status,409);                    // 找不到
  r=await call("/bank",BK({action:"td_break",at}));assert.equal(r.status,200);assert.equal(r.body.cash,30);assert.equal(P(db).tds.length,0);   // 只退本金 20
  await call("/bank",BK({action:"td_in",amount:30}));const at2=P(db).tds[0].t;
  t.v+=4*DAYMS;r=await call("/bank",BK({action:"check"}));assert.equal(r.status,200);                 // check 不結算
  r=await call("/bank",BK({action:"dem_out",all:true}));assert.equal(r.status,200);
  assert.ok(Math.abs(r.body.cash-((30*1.004-10)*1.004**4+30*1.012**3*1.004))<0.02,String(r.body.cash));   // 活存餘額＋到期的定存（再算 1 天活存）
  assert.equal(P(db).tds.length,0);assert.equal(P(db).dem.a,0);
  assert.equal((await call("/bank",BK({action:"td_break",at:at2}))).status,409);                      // 已到期轉入活存，不能再解約
});
test("存款：錯誤處理與限制",async()=>{
  const {call}=mk();await call("/ensure-market");
  assert.equal((await call("/bank",BK({action:"dem_in",amount:60}))).status,409);                    // 現金只有 50
  assert.equal((await call("/bank",BK({action:"dem_out",amount:5}))).status,409);                    // 沒有餘額
  assert.equal((await call("/bank",BK({action:"td_in",amount:0.001}))).status,400);                  // 金額檢查（四捨五入後 <0.01 不合法）
  assert.equal((await call("/bank",BK({action:"td_in",amount:0.5}))).status,409);                    // 定存最少 1
  assert.equal((await call("/bank",BK({action:"td_break"}))).status,400);
  for(let i=0;i<20;i++)assert.equal((await call("/bank",BK({action:"td_in",amount:1}))).status,200,String(i));
  assert.equal((await call("/bank",BK({action:"td_in",amount:1}))).status,409);                      // 定存最多 20 筆（這裡現金只剩 30）
});
test("黑道：連存款也一併被搶光",async()=>{
  const {call,db,t}=mk();await call("/ensure-market");
  await call("/bank",BK({action:"borrow",amount:300}));await call("/bank",BK({action:"dem_in",amount:100}));await call("/bank",BK({action:"td_in",amount:100}));
  assert.equal(P(db).tds.length,1);
  t.v+=25*H;const r=await call("/bank",BK({action:"dem_out",all:true}));assert.equal(r.status,409);assert.equal(r.body.error.code,"mob");
  assert.deepEqual([P(db).cash,P(db).dem.a,P(db).tds.length,P(db).loan.p],[50,0,0,0]);
});
