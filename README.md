# 煉金交易所（玩家製作的非官方小遊戲）

## 架構（全部放在一個 Cloudflare Worker）
- `public/`：靜態網頁，由 Worker 的 Static Assets 提供。Google 登入用 Firebase Auth；《無限煉製》OAuth 是瀏覽器端 Authorization Code + PKCE S256，沒有 Server Secret。
- `worker/src/`：API（`/inject`、`/trade`、`/ensure-market`）。先驗證 Firebase ID Token（必須是 Google 登入），再用玩家的 IA access token 向官方 Developer API 驗證工坊身分，確認造物是 **24 小時內成功合成**，在伺服器計算漲跌與買賣，用服務帳戶透過 Firestore REST 原子寫入（樂觀鎖，衝突自動重試）。
- Firestore：客戶端唯讀（`firestore.rules`），行情與動態用 onSnapshot 即時更新；所有寫入只由 Worker 完成。`links` / `iaLinks` 是 Google ↔ 工坊一對一綁定，客戶端不可讀寫。
- Google API Key 由玩家輸入，只放 sessionStorage，每次投入時隨請求送到 Worker 轉呼叫 Gemini；Worker 不儲存、不記錄請求內容。

## 行情機制
- 全部行情放在 Firestore 單一文件 `market/state`（價格、偏移、最近 180 個走勢點），客戶端只需監聽 1 個文件。
- Cloudflare Cron Trigger 每 2 分鐘讓每檔股票隨機走一步（幅度 0.3–1.5%，含微弱均值回歸）。
- 機率偏移（bias）＝上漲機率 − 50%，由所有玩家共同推動，單次都很輕、總量有上限（`worker/src/logic.js`）：
  - 投入造物：AI 回傳「相似度」（0–100），**要高過門檻 `SIM_THRESHOLD`（70）才算相關**：相似度越高於門檻，提高上漲機率越多（100 時 +5 個百分點）；沒高過就視為無關，越低於門檻，提高下跌機率越多（0 時 −5 個百分點）；剛好等於門檻沒有影響（`INJECT_MAX`）。投入當下價格**不會**跳動。前端說明文字裡的「70」要和 `SIM_THRESHOLD` 保持一致。
  - 判定嚴格：模型必須先選分級（direct 85–100｜strong 65–84｜weak 20–45｜none 0–15），伺服器再把相似度壓進該級範圍，勉強相關最高只有 45；造物名稱被當成資料而非指令，無法在名稱裡藏「請給高分」。
  - 買賣：每買 1 股 +1 個百分點、每賣 1 股 −1 個百分點（`TRADE_NUDGE`），像買賣壓力。只影響機率、不直接改價格，所以沒有「買進再賣出」的套利。
  - 全部加總最多 ±15 個百分點（上漲機率 35%–65%，`BIAS_CAP`）。
  - **衰減**：高於 50% 的機率每過 5 分鐘只剩 90%（往 50% 掉），低於 50% 的對稱地每 5 分鐘回升 10%；小於 0.5 個百分點就歸零（回到 50%）。按真實時間連續計算（`DECAY`、`DECAY_MS`），與排程間隔無關；機率條在兩次行情更新之間也會持續更新。

## 選單與頁面（左上角 ☰）
- 📈 交易區：股票視窗、投入造物、全服動態。
- 🏦 銀行：高利貸，利率 5%／24 小時（連續複利），欠款上限 100；欠款從淨值扣除。伺服器端 `/bank`（借款／還款／全額還清）。
- ⚗ 練金工坊：《無限煉製》公開 API 只有讀取（`/me`、`/inventory`、`/inventions`、`/history`），沒有代為合成的端點；目前僅列出 24 小時內做出的造物與可投入狀態。
- ⚙ 設定：介面大小（小／中／大，存在瀏覽器），以及 Google API Key 設定入口。

## 開發者帳號
- 在 Cloudflare 新增 **Secret** `DEV_EMAILS`（開發者的 Google 信箱，多個用逗號分隔）。**不要寫進 `wrangler.toml`**：倉庫是公開的，而且 `[vars]` 會在每次部署時覆蓋網頁上的設定。
- 伺服器用 Firebase 驗證過的信箱（`email_verified` 必須為 true）比對；符合者可跳過 IA、自行輸入造物名稱投入，不計入「每個造物每天一次」，冷卻 8 秒仍有效。全服動態會標上 🛠。

## 規則與介面
- 判定模型固定為 `gemini-3.5-flash-lite`（`worker/src/ia.js` 的 `MODEL`，玩家無法更改；要換成 `gemini-3.6-flash` 只需改那一行）。這兩個模型已停用 `temperature` 參數，請求中不要再帶。
- 買賣與銀行只需要 Google 登入（玩家資料以 Google 帳號為鍵）；投入造物才需要連結《無限煉製》。
- 銀行可無限借款；欠款超過 100 並連續超過 24 小時，黑道上門：現金、持股、欠款全部歸零（現金回到 50），並在全服動態留下紀錄。
- 每個造物每 24 小時只能投入一次（玩家文件的 `used`），且必須是 24 小時內成功合成的。
- 介面：每檔股票是一個像素風「電腦視窗」（可收合）；Google API Key 與判定模型收在右上角 ⚙ 設定內，並有按鈕連到 Google AI Studio 的 API Key 頁面。

## 部署（全程可在手機網頁完成）
1. Firebase：啟用 Google 登入、建立 Firestore、發布 `firestore.rules`，授權網域加入 Worker 網址（`alchemy-exchange.<你的子網域>.workers.dev`）。
2. Google Cloud：建立只有「Cloud Datastore User」角色的服務帳戶，下載 JSON 金鑰（不要放進 Git）。
3. Cloudflare：Workers & Pages → Create → Import a repository → 選此倉庫，專案名稱 `alchemy-exchange`（須與 `wrangler.toml` 的 name 相同），Deploy。再到 Settings → Variables and Secrets 新增 Secret `FIREBASE_SA`，內容貼整份 JSON。
4. IA 應用核准後：把 Client ID 填入 `public/config.js`，在 Developer Center 設定 Redirect URI = `https://alchemy-exchange.<子網域>.workers.dev/`（結尾斜線不可省）。
5. 不使用 Server API，也沒有獎勵功能。

## 測試
`cd worker && npm test`
