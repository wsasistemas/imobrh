import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Bibliotecas grandes e estáveis em arquivos próprios: o navegador as guarda em cache
// entre versões do portal, e o bundle principal fica abaixo do limite de 500 kB.
function vendorChunk(moduleId: string): string | null {
  if (!moduleId.includes('node_modules')) return null
  if (moduleId.includes('@supabase')) return 'supabase'
  if (/[\\/]node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/.test(moduleId)) return 'react'
  return null
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: { groups: [{ name: vendorChunk }] },
      },
    },
  },
})
