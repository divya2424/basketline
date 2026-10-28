import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './app/App.jsx'
import { localCollector, setTransport } from './analytics/analytics.js'
import { createBackendTransport } from './analytics/backendTransport.js'
import { createTeeTransport } from './analytics/eventTransport.js'
import { API_BASE_URL } from './api/httpClient.js'
import './styles/global.css'

// Keep every event locally (console / __ecommerceAnalytics) and send campaign
// impressions, clicks and basket additions to the analytics service.
if (API_BASE_URL) setTransport(createTeeTransport([localCollector, createBackendTransport()]))

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
