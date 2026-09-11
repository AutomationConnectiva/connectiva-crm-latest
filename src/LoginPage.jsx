import { useState } from 'react'
import { supabase } from './lib/supabase'
import { Mail, Lock, Loader2, LogIn, AlertCircle } from 'lucide-react'

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap');

  .login-root {
    --ink-950: #14161C; --ink-700: #4A4F5A; --ink-400: #8A8F99;
    --paper: #F6F5F1; --surface: #FFFFFF; --line: #E7E4DD;
    --accent: #0E6F5C; --accent-soft: #E3EFEA; --accent-ink: #0B5647;
    --red: #B23A3A; --red-soft: #F5E3E1;
    --navy: #081026;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    height: 100vh; width: 100%; display: flex; align-items: center; justify-content: center;
    background: var(--navy);
    background-image: radial-gradient(circle at 20% 20%, rgba(127,209,185,0.08), transparent 40%),
                       radial-gradient(circle at 80% 80%, rgba(127,209,185,0.06), transparent 40%);
  }
  .login-root *, .login-root *::before, .login-root *::after { box-sizing: border-box; }

  .login-card { width: 100%; max-width: 380px; background: var(--surface); border-radius: 20px; padding: 36px 32px; box-shadow: 0 24px 60px rgba(0,0,0,0.35); }
  .login-logo { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  .login-logo-dot { width: 28px; height: 28px; border-radius: 8px; background: #0E6F5C; flex-shrink: 0; }
  .login-logo-text { font-family: 'Fraunces', serif; font-size: 20px; color: var(--ink-950); }
  .login-logo-text span { color: var(--accent); }
  .login-title { font-family: 'Fraunces', serif; font-size: 26px; color: var(--ink-950); margin: 20px 0 4px; }
  .login-sub { font-size: 13.5px; color: var(--ink-400); margin: 0 0 26px; }

  .login-field { margin-bottom: 14px; }
  .login-field-label { display: block; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.03em; color: var(--ink-400); margin-bottom: 6px; }
  .login-input-wrap { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 10px; padding: 0 14px; background: var(--surface); transition: border-color .15s ease, box-shadow .15s ease; }
  .login-input-wrap:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .login-input-wrap input { flex: 1; border: none; outline: none; padding: 11px 0; font-size: 13.5px; font-family: inherit; color: var(--ink-950); background: transparent; }
  .login-input-wrap svg { color: var(--ink-400); flex-shrink: 0; }

  .login-error { display: flex; align-items: center; gap: 7px; padding: 10px 12px; border-radius: 10px; background: var(--red-soft); color: var(--red); font-size: 12.5px; margin-bottom: 14px; }

  .login-submit { display: flex; align-items: center; justify-content: center; gap: 7px; width: 100%; padding: 12px; border-radius: 10px; border: none; font-size: 13.5px; font-weight: 600; background: var(--navy); color: #fff; cursor: pointer; margin-top: 6px; transition: filter .15s ease; }
  .login-submit:hover:not(:disabled) { filter: brightness(1.3); }
  .login-submit:disabled { opacity: 0.6; cursor: not-allowed; }

  .login-spin { animation: login-spin-kf 0.8s linear infinite; }
  @keyframes login-spin-kf { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  .login-foot { text-align: center; font-size: 11.5px; color: rgba(255,255,255,0.35); margin-top: 22px; }
`

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if (error) setError(error.message)
  }

  return (
    <div className="login-root">
      <style>{CSS}</style>
      <div>
        <div className="login-card">
          <h1 className="login-title">Welcome back</h1>
          <p className="login-sub">Sign in with your team credentials to continue.</p>

          <form onSubmit={submit}>
            <div className="login-field">
              <label className="login-field-label">Email</label>
              <div className="login-input-wrap">
                <Mail size={15} />
                <input
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
              </div>
            </div>

            <div className="login-field">
              <label className="login-field-label">Password</label>
              <div className="login-input-wrap">
                <Lock size={15} />
                <input
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
            </div>

            {error && (
              <div className="login-error">
                <AlertCircle size={14} />
                {error}
              </div>
            )}

            <button type="submit" className="login-submit" disabled={loading}>
              {loading ? <Loader2 size={15} className="login-spin" /> : <LogIn size={15} />}
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
        <p className="login-foot">© 2026 ConnectivaCRM · Internal access only</p>
      </div>
    </div>
  )
}
