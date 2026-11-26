import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'
import { resolve } from 'node:path'

// 확장 화면 빌드. 결과는 ../extension/ui/ 에 들어가고 확장이 그대로 연다(외부 서버 요청 없음).
// 테마는 hitomi-web WEBUI(frontend/vite.config.ts)와 같은 값으로 맞춘다.
export default defineConfig({
  base: './',
  plugins: [vue(), ui({
    router: false,
    colorMode: false,
    autoImport: { dts: 'src/auto-imports.d.ts' },
    components: { dts: 'src/components.d.ts' },
    ui: { colors: { primary: 'emerald', neutral: 'zinc' } },
    theme: { defaultVariants: { size: 'lg' }, colors: ['primary', 'success', 'warning', 'error', 'info'] },
    icon: { clientBundle: { scan: true, icons: ['lucide:search', 'lucide:check', 'lucide:trash-2', 'lucide:rotate-ccw', 'lucide:external-link', 'lucide:download', 'lucide:refresh-cw', 'lucide:loader-circle', 'lucide:circle-alert', 'lucide:image-off', 'lucide:x', 'lucide:chevron-down', 'lucide:chevron-up', 'lucide:chevron-left', 'lucide:chevron-right', 'lucide:chevrons-left', 'lucide:chevrons-right', 'lucide:ellipsis', 'lucide:ellipsis-vertical', 'lucide:maximize-2', 'lucide:image', 'lucide:square', 'lucide:circle-stop', 'lucide:library', 'lucide:hard-drive-download', 'lucide:plug', 'lucide:unplug', 'lucide:archive', 'lucide:list-checks', 'lucide:square-arrow-out-up-right', 'lucide:circle', 'lucide:circle-check', 'lucide:pencil', 'lucide:file-check', 'lucide:upload', 'lucide:info', 'lucide:triangle-alert', 'lucide:minus', 'lucide:plus', 'lucide:check-circle', 'lucide:layout-grid', 'lucide:list'] } },
  })],
  build: {
    outDir: resolve(__dirname, '../extension/ui'),
    emptyOutDir: true,
    rollupOptions: { input: { sidebar: resolve(__dirname, 'sidebar.html'), manager: resolve(__dirname, 'manager.html') } },
  },
})
