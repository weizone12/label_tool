// Retry reads only: a failed write may already have reached the server.
export async function fetchResponse(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const attempts = method === 'GET' ? 3 : 1
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(path, { credentials: 'same-origin', ...options })
    } catch (cause) {
      if (cause.name === 'AbortError') throw cause
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
        continue
      }
      throw new Error(`連線中斷，無法完成 ${method} ${path}。請確認網路與平台服務後重試；若為儲存操作，請先保留目前頁面。`, { cause })
    }
  }
}

export async function readJson(response, path) {
  try {
    return await response.json()
  } catch (cause) {
    throw new Error(`伺服器回應不完整或格式錯誤（${response.status} ${path}），請重試。`, { cause })
  }
}
