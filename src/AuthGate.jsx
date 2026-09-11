import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase'
import LoginPage from './LoginPage'
import App from './App'

export default function AuthGate() {
  const [session, setSession] = useState(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setChecking(false)
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  if (checking) return null
  if (!session) return <LoginPage />
  return <App />
}
