import './styles/reset.scss'
import 'virtual:uno.css'
import './styles/base.scss'
import { createApp } from 'vue'
import App from './App.vue'
import { initNetClient } from './net-client.js'

initNetClient()
createApp(App).mount('#app')
