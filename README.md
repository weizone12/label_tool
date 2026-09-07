# 多模式標註工具

單機單使用者的 React + Flask 標註工具。目前第一階段支援圖片分類、矩形、多邊形、OCR 四邊形與三點式旋轉矩形標註。

## 快速啟動與結束
網路位址統一設定在根目錄的 `network-config.json`。更換伺服器 IP 時只需修改
`publicHost`；一般情況不需修改程式內的網址。`frontendBindHost` 保持 `0.0.0.0`，
`backendBindHost` 保持 `127.0.0.1`，讓區網使用者經由前端代理存取後端。

整合版本需先啟動獨立登入系統，再啟動標註工具：
```powershell
cd auth_system
.\start-auth.ps1
cd ..
.\start.ps1
```
未登入時，`http://<publicHost>:<labelFrontendPort>/` 會導向登入頁；登入完成後會返回標註工具。

若登入系統已在執行，可只在專案根目錄執行：
```powershell
.\start.ps1
```
啟動後終端會顯示依 `network-config.json` 組成的網址。

結束前後端服務：
```powershell
.\stop.ps1
cd auth_system
.\stop-auth.ps1
```

如果 PowerShell 阻擋本機腳本，可使用：
```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

## Linux 啟動與停止

首次 clone 後建立專案內的虛擬環境並安裝相依套件：

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
python3 -m venv auth_system/backend/.venv
auth_system/backend/.venv/bin/pip install -r auth_system/backend/requirements.txt
npm ci --prefix frontend
npm ci --prefix auth_system/frontend
chmod +x start.sh stop.sh
```

設定首次管理員與固定 Session 密鑰後，一次啟動登入及標註服務：

```bash
export AUTH_BOOTSTRAP_ADMIN_USERNAME='admin'
export AUTH_BOOTSTRAP_ADMIN_PASSWORD='請使用至少 12 字元的臨時密碼'
export AUTH_SECRET_KEY='請設定長且隨機的固定密鑰'
./start.sh
```

停止全部服務：

```bash
./stop.sh
```

Linux 腳本與 Windows 腳本共用 `network-config.json`。部署前請將 `publicHost`
改成 Linux 主機可供使用者連線的 IP。Linux 不支援伺服器端 Windows 原生檔案選擇視窗，
但瀏覽器的檔案上傳功能可正常使用。

## 分別啟動
後端：
```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

前端：
```powershell
cd frontend
npm install
npm run dev
```

瀏覽器開啟 `http://127.0.0.1:5173`。標註資料預設儲存在 `backend/data/projects`。
