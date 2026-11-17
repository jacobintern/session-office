# Session Office

[English](README.md)

給 Claude Code session 用的像素辦公室。每個在跑的 session 是辦公室裡的一位同事，坐在自己的桌子前；做完一輪就走到你桌前匯報。在頁面上可以回覆、按收到、`/clear`、`/compact`、切到它的終端機分頁、開除它，或開一個新 session。

## 運作方式

```
session ─(office mod)→ ~/.claude/office/desks/<id>.json
                                   │
              bridge session（只有一個，在自己的 iTerm2 分頁）
                                   │ ArtifactData
                                   ▼
                    Session Office 頁面（claude.ai artifact）
```

- **mod/**：Claude Code 的 mod。每個 session 把自己的桌卡寫成本機檔案；工作中的 session 不會呼叫任何工具，所以你用什麼權限模式都不受影響。
- **bridge**：用 `CLAUDE_OFFICE_BRIDGE=1` 啟動的一個 session，負責把桌卡同步進頁面的資料庫，再把頁面上下的指令寫回檔案給各 session。它以 `--dangerously-skip-permissions` 執行（寫入 artifact 資料的同意沒有其他方式能預先允許），所以**不要在 bridge 分頁裡交辦任何工作**。頁面右上角的燈號顯示它最後一次同步的時間，斷線時會轉紅。
- **page/**：artifact 頁面本身。
- **install/**：讓 bridge 保持運作的 watchdog，以及它的 LaunchAgent。

## 行前準備

| | 必要 | 怎麼確認 |
|---|---|---|
| macOS + [iTerm2](https://iterm2.com) | 是 | bridge 跑在 iTerm2 分頁裡，由 launchd 維持運作 |
| 支援 mod 的 Claude Code（2.1.311 測試過） | 是 | `claude --version` |
| 可以發佈 Artifact 的 claude.ai 帳號 | 是 | 能請 Claude 幫你發佈頁面就可以 |
| 這個 repository 的存取權 | 是 | 這是私人 repo：請擁有者把你加成協作者，並確認 `git clone git@github.com:jacobintern/session-office.git` 能成功 |
| Pipoya 人物素材包 + node | 是，只需一次 | 見〈人物圖〉 |
| Jira Cloud API token | 否 | Jira 欄位才需要 |
| Codex CLI | 否 | Codex 秘書顯示用量才需要 |

`install/install.sh --check` 會逐項檢查上面這些（以及 bridge），失敗的項目會附上修法。

## 安裝

1. 取得 repository 並安裝 mod：

   ```sh
   git clone git@github.com:jacobintern/session-office.git && cd session-office
   claude plugin marketplace add jacobintern/session-office
   claude plugin install office@session-office
   ```

2. 產生人物圖（見〈人物圖〉）：

   ```sh
   node install/build-sprites.mjs ~/Downloads/"PIPOYA FREE RPG Character Sprites 32x32.zip"
   ```

3. 發佈你自己的頁面。每個人都要有自己的一份，因為頁面的資料庫存的是你的 session。在這個資料夾開一個 Claude Code session，貼上：

   > Publish `page/session-office.html` as a new artifact with the `db` and
   > `user` capabilities, and publish every file in `page/chars/` alongside it
   > at `chars/<file name>`. Give me the artifact's URL.

4. 執行安裝程式，再把網址填進設定檔：

   ```sh
   ./install/install.sh          # --no-launchd 不裝 LaunchAgent，--uninstall 移除
   $EDITOR ~/.claude/office/config.json
   ```

5. 啟動 bridge。一分鐘內 watchdog 會開一個 iTerm2 分頁跑 bridge。第一次會有三個確認，全部按完 bridge 才會開始運作：
   - macOS：允許 watchdog 控制 iTerm2（自動化權限）；
   - Claude Code：接受 `--dangerously-skip-permissions`；
   - Claude Code：信任 bridge 的資料夾（`bridgeCwd`）。

6. 檢查：在終端機跑 `./install/install.sh --check`，或在任一個 session 打 `/office doctor`。接著開一個新的 `claude` session，它就會出現在頁面的桌子上。

## 指令

| | |
|---|---|
| `/office` | 頁面網址、這個 session 的桌卡，以及設定檢查是否全部通過 |
| `/office doctor` | 檢查設定、這個 session 的桌卡和 bridge |
| `/office name <文字>` | 設定桌牌（留空就清掉） |
| `/office status` | bridge 最近一輪的狀況 |
| `/office bridge` / `/office bridge off` | 讓這個 session 當 bridge，或取消 |

每個 session 啟動 15 秒後會跑一次同樣的檢查，只有失敗時才跳出一行提示。

## 設定：`~/.claude/office/config.json`

| 欄位 | 意義 |
|---|---|
| `officeUrl` | 你發佈的頁面網址 |
| `bridgeCwd` | bridge session 執行的資料夾 |
| `jira` | `null`，或 `{ "site", "email", "jql"?, "tokenFile"? }`。token 從 `tokenFile`（預設 `~/.jira_api_token`）讀取，透過 stdin 交給 curl，不會出現在指令參數裡；沒設 `jira` 時 Jira 欄位會隱藏 |
| `codex` | 設成 `false` 會隱藏 Codex 秘書 |
| `city` | `{ "lat", "lng" }`，用來計算窗外的日出日落 |
| `newSessionDirs` | 從頁面開新 session 時可選的資料夾 |
| `language` | `"zh-TW"`（預設）或 `"en"`：session 列出待決事項時用的標題（`## 要你決定` / `## Decisions for you`）。頁面本身跟隨瀏覽器語言，右上角可以切換中 / EN |

只有 `jira.site`、`codex`、`city`、`newSessionDirs` 會送到頁面（存在 `meta/config`）；Jira 的 email 和 token 只留在你的電腦上。

## 人物圖

角色來自 Pipoya 的免費素材包 **PIPOYA FREE RPG Character Sprites 32x32**（https://pipoya.itch.io/pipoya-free-rpg-character-sprites-32x32）。它的授權允許使用和修改，但不允許轉散布，所以圖片不放在這個 repository 裡。請從上面的連結下載素材包（免費），再用 `install/build-sprites.mjs` 產生頁面用的人物圖（〈安裝〉第 2 步）。產出會寫到 `page/chars/`（你、Codex 秘書和四組角色），要跟頁面一起發佈。

## 匯報格式

mod 會在每次送出的提問附上一行說明，要求模型需要你決定時，在回答最後加一段 `## 要你決定`；頁面會把這一段顯示成醒目的區塊。

## 授權

repository 裡的程式碼採 MIT 授權。人物圖屬於 Pipoya，依 Pipoya 自己的條款使用。
