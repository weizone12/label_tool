import { useEffect, useState } from 'react'
import { authApi } from '../api'
import { go } from '../AuthApp'

export default function UserManagement() {
  const [users, setUsers] = useState([])
  const [form, setForm] = useState({ username: '', display_name: '', email: '' })
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const refresh = () => authApi.users().then((data) => setUsers(data.users)).catch((err) => setError(err.message))
  useEffect(() => { refresh() }, [])
  const create = async (event) => {
    event.preventDefault(); setError('')
    try {
      const data = await authApi.createUser(form)
      setNotice(`臨時密碼（僅顯示這一次）：${data.temporary_password}`)
      setForm({ username: '', display_name: '', email: '' }); refresh()
    } catch (err) { setError(err.message) }
  }
  const rename = async (user) => {
    const username = window.prompt('輸入新的 username', user.username)
    if (username === null || username.trim() === user.username) return
    setError(''); setNotice('')
    try { await authApi.updateUser(user.id, { username }); refresh() }
    catch (err) { setError(err.message) }
  }
  return <main className="auth-admin"><header><h1>使用者管理</h1><button onClick={() => go('/auth-home')}>返回</button></header>
    <form className="auth-card compact" onSubmit={create}>
      <h2>建立使用者</h2><label>username<input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
      <label>display_name<input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></label>
      <label>email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><button>建立</button>
    </form>{notice && <p className="auth-notice">{notice}</p>}{error && <p className="auth-error">{error}</p>}
    <section className="user-list">{users.map((user) => <article key={user.id}>
      <div><strong>{user.username}</strong><span>{user.display_name || user.email || '—'}</span><small>{user.is_admin ? 'admin' : 'user'} · {user.status}</small></div>
      <button onClick={() => rename(user)}>變更 username</button>
      <button onClick={async () => { await authApi.updateUser(user.id, { status: user.status === 'active' ? 'disabled' : 'active' }); refresh() }}>{user.status === 'active' ? '停用' : '啟用'}</button>
      <button onClick={async () => { const data = await authApi.resetPassword(user.id); setNotice(`臨時密碼（僅顯示這一次）：${data.temporary_password}`); refresh() }}>重設密碼</button>
    </article>)}</section>
  </main>
}
