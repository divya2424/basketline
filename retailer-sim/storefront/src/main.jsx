import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './app/App.jsx'
import { localCollector, setTransport } from './analytics/analytics.js'
import { createBackendTransport } from './analytics/backendTransport.js'
import { createTeeTransport } from './analytics/eventTransport.js'
import './styles/global.css'

// Keep every event locally (console / __basketline) and send them to Basketline
// with its SDK, which is the only way this site talks to Basketline.
if (import.meta.env.VITE_BASKETLINE_API_URL) setTransport(createTeeTransport([localCollector, createBackendTransport()]))

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
