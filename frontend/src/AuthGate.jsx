import { createContext, useContext, useEffect, useState } from 'react'

const authOrigin = import.meta.env.VITE_AUTH_ORIGIN || `${window.location.protocol}//${window.location.hostname}:${import.meta.env.VITE_AUTH_PORT}`
const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

function authUrl(path) {
  const target = encodeURIComponent(window.location.href)
  return `${authOrigin}${path}?next=${target}`
}

export default function AuthGate({ children }) {
  const [ready, setReady] = useState(false)
  const [user, setUser] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'same-origin' }).then(async (response) => {
      if (!response.ok) {
        window.location.replace(authUrl('/login'))
        return
      }
      const { user } = await response.json()
      if (user.must_change_password) window.location.replace(authUrl('/change-password'))
      else { setUser(user); setReady(true) }
    }).catch(() => setError('登入服務目前無法使用'))
  }, [])

  if (error) return <main className="home-shell"><div className="error-banner">{error}</div></main>
  if (!ready) return <main className="home-shell"><p>正在驗證登入狀態…</p></main>
  return <AuthContext.Provider value={user}>{children}</AuthContext.Provider>
}
