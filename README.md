# 多模式標註工具

單機單使用者的 React + Flask 標註工具。目前第一階段支援圖片分類、矩形、多邊形、OCR 四邊形與三點式旋轉矩形標註。

## 快速啟動與結束
在專案根目錄開啟 PowerShell 並執行：
```powershell
.\start.ps1
```
啟動後開啟 `http://127.0.0.1:5173/`。

結束前後端服務：
```powershell
.\stop.ps1
```

如果 PowerShell 阻擋本機腳本，可使用：
```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

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
