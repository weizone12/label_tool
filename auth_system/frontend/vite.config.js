import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import networkConfig from '../../network-config.json' with { type: 'json' }

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_LABEL_TOOL_PORT': JSON.stringify(String(networkConfig.labelFrontendPort)),
  },
  server: {
    port: networkConfig.authFrontendPort,
    proxy: { '/api': `${networkConfig.scheme}://${networkConfig.backendBindHost}:${networkConfig.authBackendPort}` },
  },
})
