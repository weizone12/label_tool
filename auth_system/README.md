# 完全獨立的登入與使用者管理系統

此系統在自己的 process、連接埠與目錄中運作，完全不匯入或修改標註工具。

- 登入前端：`http://127.0.0.1:5174/login`
- Auth API：`http://127.0.0.1:5002`
- 啟動：在此目錄執行 `.\start-auth.ps1`
- 停止：在此目錄執行 `.\stop-auth.ps1`

首次啟動可透過環境變數建立第一位管理員：

```powershell
$env:AUTH_BOOTSTRAP_ADMIN_USERNAME = 'admin'
$env:AUTH_BOOTSTRAP_ADMIN_PASSWORD = '請使用至少 12 字元的臨時密碼'
$env:AUTH_SECRET_KEY = '請設定長且隨機的 session secret'
.\start-auth.ps1
```

可選設定：

- `AUTH_DATA_DIR`：預設為 `backend/auth_data`。
- `AUTH_DATABASE_URL`：預設為上述目錄內的 SQLite `users.db`。
- `AUTH_COOKIE_SECURE=1`：正式 HTTPS 環境必須啟用。

瀏覽器 cookie 僅保存隨機、不透明的 session ID；session 內容由 Flask-Session
保存在 `AUTH_DATA_DIR/sessions`，cookie 設為 `HttpOnly`、`SameSite=Lax`，正式環境以
`AUTH_COOKIE_SECURE=1` 啟用 `Secure`。

Bootstrap 管理員也必須在第一次登入後修改密碼。環境變數不會覆寫既有帳號或密碼。
