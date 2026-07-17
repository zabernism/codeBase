import DefaultTheme from 'vitepress/theme'
import PracticePage from '../components/PracticePage.vue'

export default {
  ...DefaultTheme,
  enhanceApp({ app }) {
    app.component('PracticePage', PracticePage)
  },
}
