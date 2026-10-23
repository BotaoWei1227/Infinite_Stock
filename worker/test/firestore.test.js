import test from "node:test";import assert from "node:assert";
import {encode,decode,makeDb,_resetToken} from "../src/firestore.js";
test("編碼/解碼來回一致",()=>{
  const o={name:"工坊",cash:37.74,n:3,ok:true,z:null,hold:{fire:1,water:0}};
  assert.deepEqual(decode(encode(o)),o);
  assert.deepEqual(encode(3),{integerValue:"3"});assert.deepEqual(encode(1.5),{doubleValue:1.5});
});
test("commit 請求格式：mask / 前置條件 / 伺服器時間；服務帳戶 JWT 可簽發",async()=>{
  _resetToken();
  const kp=await crypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"]);
  const der=new Uint8Array(await crypto.subtle.exportKey("pkcs8",kp.privateKey));
  const pem="-----BEGIN PRIVATE KEY-----\n"+btoa(String.fromCharCode(...der)).replace(/(.{64})/g,"$1\n")+"\n-----END PRIVATE KEY-----\n";
  const env={FIREBASE_PROJECT_ID:"proj",FIREBASE_SA:JSON.stringify({client_email:"sa@proj.iam",private_key:pem})};
  const calls=[];
  const f=async(u,o)=>{calls.push([String(u),o]);
    if(String(u).includes("oauth2"))return {ok:true,json:async()=>({access_token:"T",expires_in:3600})};
    return {ok:true,status:200,json:async()=>({})};};
  const db=makeDb(env,f);
  await db.commit([{path:"stocks/fire",data:{price:12.5},ts:["updatedAt"],pre:"2026-01-01T00:00:00Z"},{path:"feed/x",data:{who:"a"},ts:["at"],pre:null}]);
  const tokenCall=calls.find(c=>c[0].includes("oauth2"));assert.match(tokenCall[1].body.toString(),/assertion=.+\..+\..+/);
  const c=calls.find(c=>c[0].endsWith(":commit"));assert.equal(c[1].headers.Authorization,"Bearer T");
  const w=JSON.parse(c[1].body).writes;
  assert.deepEqual(w[0].updateMask.fieldPaths,["price"]);assert.deepEqual(w[0].currentDocument,{updateTime:"2026-01-01T00:00:00Z"});
  assert.equal(w[0].updateTransforms[0].setToServerValue,"REQUEST_TIME");assert.deepEqual(w[1].currentDocument,{exists:false});
  assert.equal(w[0].update.name,"projects/proj/databases/(default)/documents/stocks/fire");
});
test("前置條件衝突 → conflict",async()=>{
  const env={FIREBASE_PROJECT_ID:"p",FIREBASE_SA:"{}"};_resetToken();
  // 直接測錯誤對應：用已快取 token 的情境模擬
  const kp=await crypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign"]);
  const der=new Uint8Array(await crypto.subtle.exportKey("pkcs8",kp.privateKey));
  env.FIREBASE_SA=JSON.stringify({client_email:"a@b",private_key:"-----BEGIN PRIVATE KEY-----\n"+btoa(String.fromCharCode(...der))+"\n-----END PRIVATE KEY-----"});
  const f=async u=>String(u).includes("oauth2")?{ok:true,json:async()=>({access_token:"T",expires_in:3600})}:{ok:false,status:400,json:async()=>({error:{status:"FAILED_PRECONDITION"}})};
  await assert.rejects(makeDb(env,f).commit([{path:"a/b",data:{x:1},pre:"t"}]),e=>e.code==="conflict"&&e.status===409);
});
test("陣列（走勢點）編碼/解碼來回一致",()=>{
  const o={stocks:{fire:{name:"火",t:[1792466764845,1792466884845],p:[12,12.11],bias:0.2208}}};
  assert.deepEqual(decode(encode(o)),o);
  assert.deepEqual(encode([1,2.5]),{arrayValue:{values:[{integerValue:"1"},{doubleValue:2.5}]}});
});

test("欄位值為 undefined → 刪除該欄位（在 updateMask 中但不送出值）",async()=>{
  _resetToken();
  const kp=await crypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign"]);
  const der=new Uint8Array(await crypto.subtle.exportKey("pkcs8",kp.privateKey));
  const env={FIREBASE_PROJECT_ID:"p",FIREBASE_SA:JSON.stringify({client_email:"a@b",private_key:"-----BEGIN PRIVATE KEY-----\n"+btoa(String.fromCharCode(...der))+"\n-----END PRIVATE KEY-----"})};
  let body;const f=async(u,o)=>{if(String(u).includes("oauth2"))return {ok:true,json:async()=>({access_token:"T",expires_in:3600})};body=JSON.parse(o.body);return {ok:true,status:200,json:async()=>({})};};
  await makeDb(env,f).commit([{path:"market/state",data:{stocks:{a:1},events:undefined},pre:"t"}]);
  const w=body.writes[0];assert.deepEqual(w.updateMask.fieldPaths,["stocks","events"]);assert.deepEqual(Object.keys(w.update.fields),["stocks"]);
});
