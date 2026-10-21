import test from "node:test";import assert from "node:assert";
import {judge,MODEL,iaClient} from "../src/ia.js";
const ok=b=>({ok:true,status:200,json:async()=>b});
test("固定模型、不送已停用的 temperature、Key 走標頭",async()=>{
  assert.equal(MODEL,"gemini-3.5-flash-lite");
  let seen;const f=async(u,o)=>{seen=[String(u),o];return ok({candidates:[{content:{parts:[{text:'```json\n{"score":150,"reason":"火就是火"}\n```'}]}}]});};
  const r=await judge(f,"火","火焰","k".repeat(12));
  assert.ok(seen[0].endsWith("/models/gemini-3.5-flash-lite:generateContent"));
  assert.equal(seen[1].headers["x-goog-api-key"],"k".repeat(12));
  const b=JSON.parse(seen[1].body);assert.equal(b.generationConfig.responseMimeType,"application/json");assert.equal("temperature" in b.generationConfig,false);
  assert.deepEqual(r,{score:100,reason:"火就是火"});
});
test("錯誤：缺 Key / 額度 / 格式錯誤",async()=>{
  await assert.rejects(judge(async()=>ok({}),"火","x","短"),e=>e.status===400);
  await assert.rejects(judge(async()=>({ok:false,status:429}),"火","x","k".repeat(12)),e=>e.status===412&&/額度/.test(e.message));
  await assert.rejects(judge(async()=>ok({candidates:[{content:{parts:[{text:"不是 JSON"}]}}]}),"火","x","k".repeat(12)),e=>e.status===502);
});
test("IA 用戶端：429 退避重試、換頁讀完紀錄、401 轉為重新授權",async()=>{
  let n=0,slept=0;const f=async u=>{
    if(String(u).includes("/me")){n++;return n===1?{ok:false,status:429}:ok({id:"iau_1"});}
    if(String(u).includes("offset=0"))return ok({items:[{result:"火"}],nextOffset:100});
    if(String(u).includes("offset=100"))return ok({items:[{result:"水"}],nextOffset:null});
    return {ok:false,status:401};};
  const c=iaClient({},f,async()=>{slept++;});
  assert.equal((await c.me("tok12345")).id,"iau_1");assert.equal(slept,1);
  assert.equal((await c.history("tok12345")).length,2);
  await assert.rejects(iaClient({},async()=>({ok:false,status:401}),async()=>{}).me("tok12345"),e=>e.status===401);
});
