import {route,tick,generateAutoNews,publishScheduledNews} from "./app.js";
import {makeDb} from "./firestore.js";
import {verifyFirebaseToken} from "./auth.js";
import {autoNews as generateNews} from "./ia.js";
const API=new Set(["/inject","/trade","/bank","/news","/odds","/whoami","/ensure-market","/profile","/leaderboard","/blackmarket","/analyst","/admin-settings","/monopoly","/craft"]);
const deps=env=>({
  db:makeDb(env),
  verify:r=>verifyFirebaseToken(r,env),
  now:()=>Date.now(),rand:Math.random,secureRand:()=>crypto.getRandomValues(new Uint32Array(1))[0]/4294967296,
  autoNews:env.GEMINI_API_KEY?(stocks,slot,date)=>generateNews(fetch,env.GEMINI_API_KEY,stocks,slot,date):null,
  devEmails:(env.DEV_EMAILS||"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean)   // 機密，不放在倉庫裡
});
export default {
  fetch(req,env){
    // 非 API 路徑交給靜態網頁（public/）
    if(env.ASSETS&&!API.has(new URL(req.url).pathname))return env.ASSETS.fetch(req);
    return route(req,env,deps(env));
  },
  // 排程觸發：讓行情自己隨機漲跌
  async scheduled(event,env,ctx){
    const d=deps(env);
    ctx.waitUntil(tick(d).catch(e=>console.error("tick failed",e?.name)));
    ctx.waitUntil(publishScheduledNews(d).catch(e=>console.error("scheduled news failed",e?.name)));
    ctx.waitUntil(generateAutoNews(d).catch(e=>console.error("auto news failed",e?.name)));
  }
};
