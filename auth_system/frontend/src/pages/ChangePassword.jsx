import { useState } from 'react'
import { authApi } from '../api'
import { go } from '../AuthApp'

export default function ChangePassword() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState('')
  const submit = async (event) => {
    event.preventDefault()
    try { await authApi.changePassword(current, next); go('/auth-home') }
    catch (err) { setError(err.message) }
  }
  return <main className="auth-shell"><form className="auth-card" onSubmit={submit}>
    <h1>修改密碼</h1><p>新密碼至少需要 12 個字元。</p>
    <label>目前密碼<input type="password" required value={current} onChange={(event) => setCurrent(event.target.value)} /></label>
    <label>新密碼<input type="password" minLength="12" required value={next} onChange={(event) => setNext(event.target.value)} /></label>
    {error && <p className="auth-error">{error}</p>}<button type="submit">儲存新密碼</button>
  </form></main>
}
