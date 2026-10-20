# 煉金交易所（玩家製作的非官方小遊戲）

## 架構（全部放在一個 Cloudflare Worker）
- `public/`：靜態網頁，由 Worker 的 Static Assets 提供。Google 登入用 Firebase Auth；《無限煉製》OAuth 是瀏覽器端 Authorization Code + PKCE S256，沒有 Server Secret。
- `worker/src/`：API（`/inject`、`/trade`、`/ensure-market`）。先驗證 Firebase ID Token（必須是 Google 登入），再用玩家的 IA access token 向官方 Developer API 驗證工坊身分，確認造物是 **24 小時內成功合成**，在伺服器計算漲跌與買賣，用服務帳戶透過 Firestore REST 原子寫入（樂觀鎖，衝突自動重試）。
- Firestore：客戶端唯讀（`firestore.rules`），行情與動態用 onSnapshot 即時更新；所有寫入只由 Worker 完成。`links` / `iaLinks` 是 Google ↔ 工坊一對一綁定，客戶端不可讀寫。
- Google API Key 由玩家輸入，只放 sessionStorage，每次投入時隨請求送到 Worker 轉呼叫 Gemini；Worker 不儲存、不記錄請求內容。

## 部署（全程可在手機網頁完成）
1. Firebase：啟用 Google 登入、建立 Firestore、發布 `firestore.rules`，授權網域加入 Worker 網址（`alchemy-exchange.<你的子網域>.workers.dev`）。
2. Google Cloud：建立只有「Cloud Datastore User」角色的服務帳戶，下載 JSON 金鑰（不要放進 Git）。
3. Cloudflare：Workers & Pages → Create → Import a repository → 選此倉庫，專案名稱 `alchemy-exchange`（須與 `wrangler.toml` 的 name 相同），Deploy。再到 Settings → Variables and Secrets 新增 Secret `FIREBASE_SA`，內容貼整份 JSON。
4. IA 應用核准後：把 Client ID 填入 `public/config.js`，在 Developer Center 設定 Redirect URI = `https://alchemy-exchange.<子網域>.workers.dev/`（結尾斜線不可省）。
5. 不使用 Server API，也沒有獎勵功能。

## 測試
`cd worker && npm test`
