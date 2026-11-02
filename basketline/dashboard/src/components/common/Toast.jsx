import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

const ToastContext = createContext(() => {})

const TOAST_DURATION_MS = 2500

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null)
  const timerRef = useRef(null)

  const showToast = useCallback((message) => {
    clearTimeout(timerRef.current)
    setToast({ message, key: Date.now() })
    timerRef.current = setTimeout(() => setToast(null), TOAST_DURATION_MS)
  }, [])

  useEffect(() => () => clearTimeout(timerRef.current), [])

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toast ? (
          <div className="toast" key={toast.key}>
            {toast.message}
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}
