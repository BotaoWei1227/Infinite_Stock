// 這些都是公開資訊（Firebase Web 設定、IA Client ID）。Server Secret 不需要，也絕不要放這裡。
export const CFG={
  firebase:{apiKey:"AIzaSyArp0iRKP4UXIwZzwPJYs0ZogqxKbAjr4c",authDomain:"infinite-stock-a7d4d.firebaseapp.com",projectId:"infinite-stock-a7d4d",appId:"1:504040010808:web:e04916c8159628393962cd"},
  api:"", // 網頁與 API 同一個 Worker（同網域），留空即可
  ia:{base:"https://pillars-of-creation.funtuan.work",clientId:"ia_UI5xpGRgXUQlzMctNbOPPNkF",scope:"profile history.read"},
  modelLabel:"gemini-3.5-flash-lite", // 僅供顯示；實際模型固定在伺服器（worker/src/ia.js 的 MODEL）
  startCash:50
};
