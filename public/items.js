// 練金物品（前端與 Worker 共用，沒有任何機密）。
// 物品 = {n 數量, e 圖示, lv 品階 0～3}。物品沒有固定歸屬：可以投入任何一檔股票，由 AI 判斷它和那檔股票的相關程度。
// 玩家背包 inv 以「物品名稱」為鍵；AI 合成出來的物品可以是任何名稱（溫泉、彩虹…）。
export const ELEMENTS=["fire","water","earth","wind","steam","thunder"],BASICS=["fire","water","earth","wind"];   // 六檔股票的代號；火水土風可以用現金買
export const BASE_ITEMS={
  fire:{name:"火",e:"🔥",lv:0},water:{name:"水",e:"💧",lv:0},earth:{name:"土",e:"🪨",lv:0},wind:{name:"風",e:"🌪️",lv:0},
  steam:{name:"蒸氣",e:"♨️",lv:1},thunder:{name:"雷",e:"⚡",lv:1}};
export const TIER={fire:0,water:0,earth:0,wind:0,steam:1,thunder:1};            // 基礎元素的位階（沒有 AI 時的固定配方用）
export const MAX_LV=3,LV_POWER=[.5,1,1.25,1.5];                                  // 品階越高，投入時的力道越大（乘上相關度算出的機率提升）
export const MAX_NAME=10;
// 名稱正規化：NFKC、去頭尾空白、連續空白合成一個
export const normName=s=>String(s??"").normalize("NFKC").replace(/\s+/g," ").trim();
// 名稱是否可用：1～10 個字、不含 + / 與控制字元（+ 用來串配方鍵）
export const validName=s=>{const n=normName(s),len=[...n].length;return n===s&&len>=1&&len<=MAX_NAME&&!/[+\/\u0000-\u001f\u007f]/.test(n)&&!/^__.*__$/.test(n);};   // __x__ 是 Firestore 保留的欄位名
// 配方鍵：三個物品名稱依字碼排序後用 + 串起來（與放入順序無關）
export const itemKey=names=>[...names].sort().join("+");
// 舊版背包：{fire:2}（元素代號 → 數量）或 {火:{n,e,el}}；轉成 {火:{n:2,e:"🔥",lv:0}}
export function normInv(inv){
  const out={};
  for(const [k,v] of Object.entries(inv||{})){
    if(typeof v==="number"){const b=BASE_ITEMS[k];if(b&&v>0)out[b.name]={n:(out[b.name]?.n||0)+v,e:b.e,lv:b.lv};}
    else if(v&&Number(v.n)>0){const lv=Number.isInteger(v.lv)?Math.min(MAX_LV,Math.max(0,v.lv)):(TIER[v.el]||0);out[k]={n:Number(v.n),e:String(v.e||"❔"),lv};}
  }
  return out;
}
