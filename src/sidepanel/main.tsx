import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import '../styles/globals.css'

document.body.style.backgroundColor = 'var(--t-bg)'
document.body.style.color = 'var(--t-text)'
document.body.style.overflow = 'hidden'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
