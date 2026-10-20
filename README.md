# 煉金交易所（玩家製作的非官方小遊戲）

## 架構
- `public/`：靜態前端（GitHub Pages）。OAuth 為瀏覽器端 Authorization Code + PKCE S256，沒有 Server Secret。
- `functions/`：Cloud Functions（需 Firebase **Blaze** 方案）。`inject` / `trade` 以玩家的 IA access token 向官方 `/developer-api/v1/me` 驗證身分、確認造物在背包內，再於伺服器計算漲跌與買賣。玩家資料以 IA 的 app-scoped ID 為鍵。
- 規則：造物必須是 **24 小時內成功合成**（取自 IA 合成紀錄，官方最多提供最近 500 筆）；Function 只接受 Firebase Google 登入的使用者，並把 Google 帳號與 IA 工坊一對一綁定（`links` / `iaLinks`，客戶端不可讀寫）。
- `firestore.rules`：客戶端唯讀，所有寫入僅限 Functions。
- Google API Key 由玩家輸入，只放 sessionStorage，每次投入時隨請求傳給 Function 轉呼叫 Gemini；Function 不儲存、不記錄。

## 外部步驟（需由你本人操作）
1. Firebase：建立專案、升級 Blaze、啟用 **Google 登入**（Authentication → Sign-in method）與 Firestore。
2. `npm i -g firebase-tools && firebase login && firebase use <專案ID>`，然後 `cd functions && npm i && cd .. && firebase deploy --only functions,firestore`。
3. 把 Firebase Web 設定填入 `public/config.js`（Authentication 的授權網域加上 `<帳號>.github.io`）。
4. 推到 GitHub（Settings → Pages → Source 選 GitHub Actions），確定網址如 `https://<帳號>.github.io/<repo>/`。
5. 到 https://pillars-of-creation.funtuan.work/developer 申請應用（scopes：`profile`、`history.read`——用來驗證 24 小時內的合成紀錄；申請時不需 Redirect URI）。核准後手動設定 Redirect URI = 你的 Pages 網址（含結尾斜線），Client ID 填入 `public/config.js`。
6. 不使用 Server API，也沒有獎勵功能（獎勵需官方另行核准）。

## 測試
`cd functions && npm test`（漲跌機率、價格下限、買賣邏輯）。
手動驗證：OAuth 成功／拒絕／state 不符／1 小時過期、401 重新連結、429 退避、背包無此造物、Gemini Key 錯誤、手機版登入來回。
