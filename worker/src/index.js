import {route,tick} from "./app.js";
import {makeDb} from "./firestore.js";
import {verifyFirebaseToken} from "./auth.js";
import {iaClient,judge} from "./ia.js";
const API=new Set(["/inject","/trade","/bank","/whoami","/ensure-market"]);
const deps=env=>({
  db:makeDb(env),
  verify:r=>verifyFirebaseToken(r,env),
  ia:iaClient(env),
  judge:(...a)=>judge(fetch,...a),
  now:()=>Date.now(),rand:Math.random,
  devEmails:(env.DEV_EMAILS||"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean)   // 機密，不放在倉庫裡
});
export default {
  fetch(req,env){
    // 非 API 路徑交給靜態網頁（public/）
    if(env.ASSETS&&!API.has(new URL(req.url).pathname))return env.ASSETS.fetch(req);
    return route(req,env,deps(env));
  },
  // 排程觸發：讓行情自己隨機漲跌
  async scheduled(event,env,ctx){ctx.waitUntil(tick(deps(env)).catch(e=>console.error("tick failed",e?.name)));}
};
