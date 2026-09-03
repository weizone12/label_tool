import { useState } from 'react'
import { authApi } from '../api'
import { go } from '../AuthApp'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = async (event) => {
    event.preventDefault()
    setError('')
    try {
      const { user } = await authApi.login(username, password)
      go(user.must_change_password ? '/change-password' : '/auth-home')
    } catch (err) { setError(err.message) }
  }
  return <main className="auth-shell"><form className="auth-card" onSubmit={submit}>
    <h1>使用者登入</h1>
    <label>帳號<input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label>
    <label>密碼<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    {error && <p className="auth-error">{error}</p>}
    <button type="submit">登入</button>
  </form></main>
}
