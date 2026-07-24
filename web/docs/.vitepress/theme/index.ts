import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import PracticePage from '../components/PracticePage.vue'
import ContinueReading from '../components/ContinueReading.vue'
import './custom.css'

const KEY = 'interview-last-read'

export default {
  ...DefaultTheme,
  enhanceApp({ app, router }) {
    app.component('PracticePage', PracticePage)
    app.component('ContinueReading', ContinueReading)

    // 阅读进度记忆：记录最后阅读的非首页章节 + 每个章节内的滚动位置
    // 注意：VitePress 1.x 自带轻量路由（createRouter），并非 vue-router，
    // 没有 afterEach / currentRoute，只有响应式 router.route（.path/.component/.data）
    // 与 onBeforeRouteChange / onAfterRouteChange 钩子，回调参数为标准化后的 href。
    const isBrowser = typeof window !== 'undefined'
    const r = router as any

    const saveLast = () => {
      if (!isBrowser) return
      const path: string = r.route.path
      if (path === '/' || path === '/index.html' || path.endsWith('/practice.html')) return
      const h1 = document.querySelector('.vp-doc h1')?.textContent?.trim()
      const title = h1 || document.title || path
      try {
        const data = JSON.parse(localStorage.getItem(KEY) || '{}')
        data.last = { path, title, ts: Date.now() }
        localStorage.setItem(KEY, JSON.stringify(data))
      } catch (e) {}
    }

    if (isBrowser) {
      r.onAfterRouteChange = (href: string) => {
        setTimeout(() => {
          saveLast()
          // 恢复到本章上次滚动位置（仅当没有锚点时，避免覆盖锚点跳转）
          if (!href.includes('#')) {
            try {
              const data = JSON.parse(localStorage.getItem(KEY) || '{}')
              const y = data.scroll?.[r.route.path]
              if (typeof y === 'number') window.scrollTo(0, y)
            } catch (e) {}
          }
        }, 400)
      }

      window.addEventListener('scroll', () => {
        const path: string = r.route.path
        if (!path || path === '/' || path.endsWith('/practice.html')) return
        try {
          const data = JSON.parse(localStorage.getItem(KEY) || '{}')
          data.scroll = data.scroll || {}
          data.scroll[path] = window.scrollY
          localStorage.setItem(KEY, JSON.stringify(data))
        } catch (e) {}
      }, { passive: true })
    }
  },
  Layout: () => {
    return h(DefaultTheme.Layout, null, {
      'home-features-before': () => h(ContinueReading),
    })
  },
}
