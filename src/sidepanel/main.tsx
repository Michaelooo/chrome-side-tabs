import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import '../styles/globals.css'

document.body.style.backgroundColor = '#1c1c1c'
document.body.style.color = '#e0e0e0'
document.body.style.overflow = 'hidden'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
