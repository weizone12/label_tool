let csrfToken = ''

async function request(path, options = {}) {
  if (options.method && options.method !== 'GET') {
    const response = await fetch('/api/auth/csrf', { credentials: 'same-origin' })
    if (!response.ok) throw new Error('無法取得 CSRF 權杖')
    csrfToken = (await response.json()).csrf_token
  }
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...options.headers,
    },
  })
  if (response.status === 204) return null
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '請求失敗')
  if (data.csrf_token) csrfToken = data.csrf_token
  return data
}

export const authApi = {
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),
  changePassword: (current_password, new_password) => request('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password, new_password }) }),
  users: () => request('/api/admin/users'),
  createUser: (body) => request('/api/admin/users', { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (id, body) => request(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  resetPassword: (id) => request(`/api/admin/users/${id}/reset-password`, { method: 'POST', body: '{}' }),
}
