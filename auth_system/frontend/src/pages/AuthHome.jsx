import { useEffect, useState } from 'react'
import { authApi } from '../api'
import { go } from '../AuthApp'

export default function AuthHome() {
  const [user, setUser] = useState(null)
  useEffect(() => { authApi.me().then(({ user: value }) => {
    if (value.must_change_password) go('/change-password'); else setUser(value)
  }).catch(() => go('/login')) }, [])
  if (!user) return <main className="auth-shell">載入中…</main>
  return <main className="auth-shell"><section className="auth-card">
    <h1>登入成功</h1><p>username：{user.username}</p><p>display_name：{user.display_name || '—'}</p>
    {user.is_admin && <button className="secondary" onClick={() => go('/admin/users')}>管理使用者</button>}
    <button className="secondary" onClick={() => go('/change-password')}>修改密碼</button>
    <button onClick={async () => { await authApi.logout(); go('/login') }}>登出</button>
  </section></main>
}
