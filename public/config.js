// 這些都是公開資訊（Firebase Web 設定、IA Client ID）。Server Secret 不需要，也絕不要放這裡。
export const CFG={
  firebase:{apiKey:"AIzaSyArp0iRKP4UXIwZzwPJYs0ZogqxKbAjr4c",authDomain:"infinite-stock-a7d4d.firebaseapp.com",projectId:"infinite-stock-a7d4d",appId:"1:504040010808:web:e04916c8159628393962cd"},
  api:"", // 網頁與 API 同一個 Worker（同網域），留空即可
  ia:{base:"https://pillars-of-creation.funtuan.work",clientId:"pending",scope:"profile history.read"},
  defaultModel:"gemini-3.5-flash-lite",
  startCash:50
};
