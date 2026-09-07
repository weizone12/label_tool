import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import networkConfig from '../network-config.json' with { type: 'json' }

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_AUTH_PORT': JSON.stringify(String(networkConfig.authFrontendPort)),
  },
  server: {
    port: networkConfig.labelFrontendPort,
    proxy: {
      '/api/auth': `${networkConfig.scheme}://${networkConfig.backendBindHost}:${networkConfig.authBackendPort}`,
      '/api/admin': `${networkConfig.scheme}://${networkConfig.backendBindHost}:${networkConfig.authBackendPort}`,
      '/api': `${networkConfig.scheme}://${networkConfig.backendBindHost}:${networkConfig.labelBackendPort}`,
    },
  },
})
