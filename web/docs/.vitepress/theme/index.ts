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
    const isBrowser = typeof window !== 'undefined'

    const saveLast = () => {
      if (!isBrowser) return
      const path = router.currentRoute.value.path
      if (path === '/' || path === '/practice') return
      const h1 = document.querySelector('.vp-doc h1')?.textContent?.trim()
      const title = h1 || document.title || path
      try {
        const data = JSON.parse(localStorage.getItem(KEY) || '{}')
        data.last = { path, title, ts: Date.now() }
        localStorage.setItem(KEY, JSON.stringify(data))
      } catch (e) {}
    }

    if (isBrowser) {
      router.afterEach((to) => {
        setTimeout(() => {
          saveLast()
          // 恢复到本章上次滚动位置（仅当没有锚点时，避免覆盖锚点跳转）
          if (!to.hash) {
            try {
              const data = JSON.parse(localStorage.getItem(KEY) || '{}')
              const y = data.scroll?.[to.path]
              if (typeof y === 'number') window.scrollTo(0, y)
            } catch (e) {}
          }
        }, 400)
      })

      window.addEventListener('scroll', () => {
        const path = router.currentRoute.value.path
        if (!path || path === '/') return
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
