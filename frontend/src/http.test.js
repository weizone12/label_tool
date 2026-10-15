import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { fetchResponse, readJson } from './http.js'

const originalFetch = globalThis.fetch
const originalTimeout = globalThis.setTimeout
afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalTimeout
})

test('a transient read failure recovers without sending a write', async () => {
  let calls = 0
  globalThis.setTimeout = (resolve) => { resolve() }
  globalThis.fetch = async (_path, options) => {
    assert.equal(options.credentials, 'same-origin')
    if (++calls < 3) throw new TypeError('Failed to fetch')
    return new Response('{"ok":true}')
  }
  assert.deepEqual(await readJson(await fetchResponse('/api/projects'), '/api/projects'), { ok: true })
  assert.equal(calls, 3)
})

test('a failed save is never automatically replayed and identifies the endpoint', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls += 1; throw new TypeError('Failed to fetch') }
  await assert.rejects(fetchResponse('/api/projects/p/images/i/annotation', { method: 'PUT', body: '{}' }), /PUT \/api\/projects\/p\/images\/i\/annotation/)
  assert.equal(calls, 1)
})

test('HTTP authentication failures are returned for the caller to handle', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 401 }) }
  assert.equal((await fetchResponse('/api/auth/me')).status, 401)
  assert.equal(calls, 1)
})

test('an offline read has bounded retries and a useful error', async () => {
  let calls = 0
  globalThis.setTimeout = (resolve) => { resolve() }
  globalThis.fetch = async () => { calls += 1; throw new TypeError('Failed to fetch') }
  await assert.rejects(fetchResponse('/api/auth/me'), /GET \/api\/auth\/me/)
  assert.equal(calls, 3)
})

test('an intentional abort is not retried', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls += 1; throw new DOMException('Cancelled', 'AbortError') }
  await assert.rejects(fetchResponse('/api/projects'), { name: 'AbortError' })
  assert.equal(calls, 1)
})

test('a broken response body identifies the response and endpoint', async () => {
  await assert.rejects(readJson(new Response('<html>Proxy error</html>', { status: 502 }), '/api/auth/me'), /502 \/api\/auth\/me/)
})
