import { createContext, useContext, useEffect, useState } from 'react'
import { fetchResponse, readJson } from './http.js'

const authOrigin = import.meta.env.VITE_AUTH_ORIGIN || `${window.location.protocol}//${window.location.hostname}:${import.meta.env.VITE_AUTH_PORT}`
const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

export function authUrl(path) {
  const target = encodeURIComponent(window.location.href)
  return `${authOrigin}${path}?next=${target}`
}

export default function AuthGate({ children }) {
  const [ready, setReady] = useState(false)
  const [user, setUser] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError('')
    fetchResponse('/api/auth/me').then(async (response) => {
      if (cancelled) return
      if (response.status === 401) {
        window.location.replace(authUrl('/login'))
        return
      }
      if (!response.ok) throw new Error(`登入服務暫時無法驗證（${response.status}），請重試。`)
      const { user } = await readJson(response, '/api/auth/me')
      if (cancelled) return
      if (user.must_change_password) window.location.replace(authUrl('/change-password'))
      else { setUser(user); setReady(true) }
    }).catch((err) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [attempt])

  if (error) return <main className="home-shell"><div className="error-banner">{error}</div><button className="secondary-button" onClick={() => setAttempt((value) => value + 1)}>重新連線</button></main>
  if (!ready) return <main className="home-shell"><p>正在驗證登入狀態…</p></main>
  return <AuthContext.Provider value={user}>{children}</AuthContext.Provider>
}
