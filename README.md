# 多使用者標註工具

React + Flask 標註工具，包含獨立登入系統、管理員使用者管理、專案人員分配、圖片／影片標註、ReID 純修改模式及訓練資料下載。

支援 Windows 與 Linux。兩邊使用相同程式碼及 `network-config.json`，但虛擬環境、環境變數與啟動腳本不同。

## 功能與服務

- 建立專案時可指定專案群組，並以「父群組 / 子群組」建立任意層級。專案會收納在指定的群組路徑內，未指定群組的專案仍顯示於最外層；群組不會搬動專案資料，既有單層群組可直接沿用。
- 群組內所有後代專案都完成時，每一層父群組都會顯示「已完成」。管理員可在直接包含專案的最底層群組使用群組指派，一次將勾選的使用者套用到該群組目前的全部專案；外層父群組不提供此按鈕。群組指派會統一取代各專案原有指派，但不會建立永久繼承規則，之後新增的專案仍需重新指派。

| 服務 | 預設連接埠 | 對外開放 |
|---|---:|---|
| 標註工具前端 | 5173 | 是 |
| 登入系統前端 | 5174 | 是 |
| 標註工具後端 | 5001 | 否，只供本機代理使用 |
| 登入系統後端 | 5002 | 否，只供本機代理使用 |

### 語意分割／實例分割操作

- 既有多邊形頂點會持續顯示。繪製時游標接近既有頂點會直接共用該頂點；接近邊線則會投影到邊線並插入共用頂點。吸附容許距離預設為畫面上的 10px，不受縮放倍率影響。
- 若要從既有邊界開始繪製，按住 `Shift` 點擊起點。移到同一邊界的另一個頂點並按住 `Ctrl`（macOS 為 `Cmd`）可預覽沿用的邊界；按 `Space` 可切換另一條路徑，再以 `Ctrl/Cmd + 點擊` 套用。
- 草稿存在時，`Backspace`、`Delete` 或 `Ctrl/Cmd + Z` 只會復原最近一次草稿操作，不會刪除既有標註。沿用整段邊界會視為一次草稿操作。
- 按 `Enter` 或雙擊會先顯示完成確認；在確認視窗選擇取消或按 `Esc` 會保留草稿並繼續標註。直接在畫布按 `Esc` 則取消目前草稿。
- 移動共用頂點時，使用該頂點的相鄰多邊形會同步更新。儲存與匯出格式仍維持原有座標陣列。

### ReID 共用操作

- 一般 ReID 標註與 ReID 純修改模式的左側工具列都有「共同輸入」開關，預設為關閉。開啟後修改 LID 時，GID 會同步寫入相同值，且 GID 欄位暫時改為唯讀；關閉後恢復分開輸入。
- 開啟共同輸入不會回溯修改既有 bbox，只有之後新增或修改的 LID 會同步到 GID。切換圖片時會保留目前開關狀態，離開專案後恢復預設關閉。

### ReID 純修改模式

- 可載入圖片或影片。可直接選取最外層日期資料夾；工具會遞迴尋找所有 `<圖片資料夾名稱>_bbox.jsonl`，載入同名圖片資料夾中的圖片，並依圖片檔名或 `frame_index` 自動配對 bbox。JSONL 可放在圖片資料夾內，也可與同名圖片資料夾並列。
- 同目錄下的 `<相機名稱>_ais.jsonl` 會自動匯入；系統以 `ais_recorded_harbor_ts` 對照資料夾起始時間與 bbox 的 `video_pts_s`，並納入目前相機畫面燒錄時間固定晚 1 秒的偏移，將 MMSI 點位配到時間最接近的圖片，不需要另外手動選取 MMSI JSONL。

## 1. 系統需求

共同需求：

- Git
- Python 3.10 以上，建議 Python 3.12
- Node.js 20.19 以上，或 22.12 以上
- npm

Windows：

```powershell
git --version
py --list
node --version
npm --version
```

Linux：

```bash
git --version
python3 --version
node --version
npm --version
curl --version
```

Ubuntu／Debian 安裝必要工具：

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip curl util-linux openssh-client rsync
```

Linux 的 `start.sh` 另外需要 `curl` 與 `setsid`。若出現 `Missing required command: curl`：

```bash
sudo apt install -y curl
```

## 2. Clone 專案

Windows PowerShell：

```powershell
git clone https://github.com/weizone12/label_tool.git
cd label_tool
```

Linux：

```bash
git clone https://github.com/weizone12/label_tool.git
cd label_tool
```

## 3. 網路設定

所有網路位址集中在根目錄的 `network-config.json`。

Windows 查詢 IP：

```powershell
ipconfig
```

Linux 查詢 IP：

```bash
hostname -I
ip -br address
ip route get 1.1.1.1
```

若 Linux 顯示多個 IP，通常使用 `ip route get 1.1.1.1` 輸出中 `src` 後面的 IP。不要使用 `127.x.x.x` 或 Docker 常見的 `172.17.x.x` 作為區網公開位址。

設定範例：

```json
{
  "scheme": "http",
  "publicHost": "192.168.X.XXX",
  "frontendBindHost": "0.0.0.0",
  "backendBindHost": "127.0.0.1",
  "labelFrontendPort": 5173,
  "labelBackendPort": 5001,
  "authFrontendPort": 5174,
  "authBackendPort": 5002
}
```

一般只需修改 `publicHost`。請維持：

```json
"frontendBindHost": "0.0.0.0",
"backendBindHost": "127.0.0.1"
```

只在本機測試時可使用 `127.0.0.1`；若要讓區網其他電腦使用，請填入主機區網 IP。

## 4. 建立 Python 虛擬環境

專案使用兩套獨立環境：

- `backend/.venv`：標註後端
- `auth_system/backend/.venv`：登入後端

### Windows

查看已安裝版本：

```powershell
py --list
```

以下以 Python 3.12 為例：

```powershell
py -3.12 -m venv .\backend\.venv
& .\backend\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\backend\.venv\Scripts\python.exe -m pip install -r .\backend\requirements.txt

py -3.12 -m venv .\auth_system\backend\.venv
& .\auth_system\backend\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\auth_system\backend\.venv\Scripts\python.exe -m pip install -r .\auth_system\backend\requirements.txt
```

將 `-3.12` 改成你的版本。出現 `No suitable Python runtime found` 代表指定版本未安裝，請改用 `py --list` 中實際存在的相容版本。

### Linux

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install --upgrade pip
backend/.venv/bin/pip install -r backend/requirements.txt

python3 -m venv auth_system/backend/.venv
auth_system/backend/.venv/bin/pip install --upgrade pip
auth_system/backend/.venv/bin/pip install -r auth_system/backend/requirements.txt
```

若出現 `No module named venv`：

```bash
sudo apt install -y python3-venv
```

兩邊都不需要手動啟用 `.venv`，啟動腳本會直接使用專案環境內的 Python。Windows 與 Linux 建立的 `.venv` 不能互相複製使用。

## 5. 安裝前端套件

### Windows

```powershell
Push-Location .\frontend
npm ci
Pop-Location

Push-Location .\auth_system\frontend
npm ci
Pop-Location
```

### Linux

```bash
npm ci --prefix frontend
npm ci --prefix auth_system/frontend
```

`node_modules` 含作業系統相關套件，Windows 與 Linux 應各自執行 `npm ci`，不要直接複製。若 Vite 無法啟動，請確認 Node.js 為 20.19 以上或 22.12 以上。

## 6. 第一次建立管理員

密碼至少需要 12 個字元。以下 Bootstrap 變數只需在第一次建立管理員時設定。

### Windows PowerShell

```powershell
$env:AUTH_BOOTSTRAP_ADMIN_USERNAME = 'admin'
$env:AUTH_BOOTSTRAP_ADMIN_PASSWORD = '至少12字元的臨時密碼'
```

### Linux

```bash
export AUTH_BOOTSTRAP_ADMIN_USERNAME='admin'
export AUTH_BOOTSTRAP_ADMIN_PASSWORD='至少12字元的臨時密碼'
```

管理員第一次登入後必須修改密碼。建立成功後，後續啟動不需再設定 Bootstrap 帳號與密碼。

## 7. AUTH_SECRET_KEY

`AUTH_SECRET_KEY` 用來保護登入 Session，不是使用者密碼。若每次啟動值不同，只會讓既有使用者重新登入，不會刪除帳號、專案或標註資料。

### Windows PowerShell

```powershell
$env:AUTH_SECRET_KEY = & .\auth_system\backend\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_hex(32))"
```

PowerShell 關閉後環境變數會消失。若不保存，日後重啟可能要求使用者重新登入。

### Linux

產生並設定：

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
export AUTH_SECRET_KEY='產生的長隨機密鑰'
```

若要保存：

```bash
mkdir -p ~/.config/label-tool
nano ~/.config/label-tool/auth.env
chmod 600 ~/.config/label-tool/auth.env
```

`auth.env` 內容：

```bash
export AUTH_SECRET_KEY='固定且隨機的長密鑰'
```

日後啟動前：

```bash
source ~/.config/label-tool/auth.env
```

請勿將 Secret Key 提交到 GitHub。

## 8. 啟動系統

### Windows

Windows 使用 PowerShell 腳本，登入與標註系統分開啟動。

若 PowerShell 阻擋腳本：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

先啟動登入系統：

```powershell
.\auth_system\start-auth.ps1
```

再啟動標註工具：

```powershell
.\start.ps1
```

### Linux

首次設定執行權限：

```bash
chmod +x start.sh stop.sh
```

一次啟動四個服務：

```bash
./start.sh
```

成功時會顯示：

```text
Authentication: http://主機IP:5174/login
Label tool:     http://主機IP:5173/
```

請先開啟 `http://主機IP:5174/login`。

## 9. 停止系統

### Windows

```powershell
.\stop.ps1
.\auth_system\stop-auth.ps1
```

### Linux

```bash
./stop.sh
```

正常關機前建議先停止服務。若未停止就正常關機，已儲存資料通常不受影響，但正在上傳、儲存或壓縮的操作可能中斷。重新開機後需再次執行啟動腳本。

## 10. 防火牆

### Windows

第一次啟動 Node.js 時，Windows 防火牆可能詢問是否允許網路存取。區網使用時請允許「私人網路」，或手動開放 TCP `5173`、`5174`。

### Linux

```bash
sudo ufw allow 5173/tcp
sudo ufw allow 5174/tcp
sudo ufw reload
sudo ufw status
```

雲端主機還需要在雲端防火牆或 Security Group 開放 TCP `5173`、`5174`。不要將 `5001`、`5002` 直接開放到 Internet。

## 11. Log 與錯誤排除

Windows 標註工具 Log：

```text
.runtime/backend.log
.runtime/backend-error.log
.runtime/frontend.log
.runtime/frontend-error.log
```

Windows 登入系統 Log：

```text
auth_system/.runtime/backend.log
auth_system/.runtime/backend-error.log
auth_system/.runtime/frontend.log
auth_system/.runtime/frontend-error.log
```

Linux Log：

```text
.runtime/auth-backend.log
.runtime/auth-backend-error.log
.runtime/auth-frontend.log
.runtime/auth-frontend-error.log
.runtime/label-backend.log
.runtime/label-backend-error.log
.runtime/label-frontend.log
.runtime/label-frontend-error.log
```

Linux 查看錯誤：

```bash
tail -n 100 .runtime/auth-backend-error.log
tail -n 100 .runtime/auth-frontend-error.log
tail -n 100 .runtime/label-backend-error.log
tail -n 100 .runtime/label-frontend-error.log
```

若 Linux 出現 `Startup check failed: http://127.0.0.1:5174/login`，最常見原因是 Node.js 太舊。

Linux 啟動成功但其他電腦無法載入時：

```bash
ss -ltnp | grep -E '5173|5174|5001|5002'
curl -I http://127.0.0.1:5173/
curl -I http://127.0.0.1:5174/login
```

正常監聽：

```text
0.0.0.0:5173
0.0.0.0:5174
127.0.0.1:5001
127.0.0.1:5002
```

## 12. 資料位置與跨系統注意事項

使用者與標註資料不會儲存在 Git：

```text
auth_system/backend/auth_data/users.db
auth_system/backend/auth_data/sessions/
backend/data/
```

從 GitHub clone 會取得完整程式碼，但會建立全新的空白使用者資料庫與專案資料。

Windows 與 Linux 不能直接共用：

- `.venv`
- `node_modules`
- 執行中的 Session

Linux 不支援伺服器端 Windows 原生檔案選擇視窗，但瀏覽器檔案上傳、圖片與影片標註、bbox JSONL、MMSI JSONL、登入管理、專案分配及一鍵下載皆可正常使用。

標註資料預設位於：

```text
backend/data/projects/
```

## 13. 每日備份至 Synology NAS

Linux 主機可將專案、使用者帳號與專案權限備份至同區網 NAS。目前預設設定為：

```text
NAS：192.168.1.3:22
帳號：admin
根目錄：/volume1/label_tool_backup
排程：每天 02:00（Asia/Taipei）
```

先在 Synology DSM 的「控制台 → 終端機和 SNMP」啟用 SSH，確認 `admin` 對 `/volume1/label_tool_backup` 有寫入權限，然後在 Linux 專案根目錄執行：

```bash
sudo apt install -y openssh-client rsync
bash scripts/install_nas_backup.sh
```

安裝時會建立獨立 SSH 金鑰；第一次需要輸入一次 NAS 密碼，密碼不會寫入程式或排程。若電腦在使用者登出後仍須於凌晨 2:00 準時執行，再執行：

```bash
sudo loginctl enable-linger "$USER"
```

手動掃描並備份：

```bash
bash scripts/backup_to_nas.sh
```

只預覽專案會被放到哪些 NAS 路徑，不連線也不傳送：

```bash
bash scripts/backup_to_nas.sh --dry-run
```

查看排程與最近備份紀錄：

```bash
systemctl --user list-timers label-tool-nas-backup.timer
journalctl --user -u label-tool-nas-backup.service -n 100 --no-pager
```

NAS 端會依各專案 `project.json` 的 `group` 建立資料夾，例如：

```text
/volume1/label_tool_backup/
├── projects/
│   ├── 父群組/子群組/專案名稱/
│   └── 未分群/專案名稱/
└── system/
    ├── access_control.db
    └── users.db
```

本機 `backend/data/projects/` 不會被移動或重新分群。備份使用不含刪除參數的 `rsync`：新增及修改會同步到 NAS，但本機刪除專案或檔案時，NAS 上的既有副本會保留。專案改名或移動群組後會建立新路徑，舊路徑也會保留。每次完成後會顯示有更新與無更新的專案數量，並列出實際更新的專案名稱及 NAS 路徑；成功更新的專案、所屬群組與最外層 `projects` 資料夾會改為本次備份時間，沒有更新的資料夾則維持原日期。資料庫會先建立 SQLite 一致性快照，再傳送至 NAS。長時間傳輸會使用 SSH keepalive；若遇到 rsync 連線中斷（包含結束碼 12），同一項目最多自動嘗試三次。
