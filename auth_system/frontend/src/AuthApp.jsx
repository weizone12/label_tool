import { useEffect, useState } from 'react'
import Login from './pages/Login'
import ChangePassword from './pages/ChangePassword'
import AuthHome from './pages/AuthHome'
import UserManagement from './pages/UserManagement'

const authPaths = ['/login', '/change-password', '/admin/users', '/auth-home']
export const isAuthPath = () => authPaths.includes(window.location.pathname)

export const go = (path) => {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export default function AuthApp() {
  const [path, setPath] = useState(window.location.pathname)
  useEffect(() => {
    const update = () => setPath(window.location.pathname)
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [])
  if (path === '/change-password') return <ChangePassword />
  if (path === '/admin/users') return <UserManagement />
  if (path === '/auth-home') return <AuthHome />
  return <Login />
}
