import React, { useEffect, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import {
  confirmSignIn,
  confirmResetPassword,
  fetchAuthSession,
  resetPassword,
  getCurrentUser,
  signIn,
  signOut,
} from 'aws-amplify/auth'

const client = generateClient({ authMode: 'userPool' })

function readGroups(session) {
  const groups = session?.tokens?.idToken?.payload?.['cognito:groups']
  return Array.isArray(groups) ? groups : []
}

export default function App() {
  const [authUser, setAuthUser] = useState(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [authMode, setAuthMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [resetCode, setResetCode] = useState('')
  const [resetEmail, setResetEmail] = useState('')
  const [resetNewPassword, setResetNewPassword] = useState('')
  const [resetCodeSent, setResetCodeSent] = useState(false)
  const [authError, setAuthError] = useState('')
  const [authLoading, setAuthLoading] = useState(true)

  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  const [topics, setTopics] = useState(['forensics', 'designer genes'])
  const [topic, setTopic] = useState('forensics')

  const [provider, setProvider] = useState('openai')
  const [adminTopic, setAdminTopic] = useState('forensics')
  const [savingProvider, setSavingProvider] = useState(false)
  const [preprocessing, setPreprocessing] = useState(false)
  const [showAdminModal, setShowAdminModal] = useState(false)

  const refreshSession = async () => {
    const user = await getCurrentUser()
    const session = await fetchAuthSession()
    setAuthUser(user)
    setIsAdmin(readGroups(session).includes('admin'))
  }

  const loadTopics = async () => {
    if (!client?.queries?.documentsTopics) return
    const { data } = await client.queries.documentsTopics()
    if (data?.topics?.length) {
      setTopics(data.topics)
      if (!data.topics.includes(topic)) setTopic(data.topics[0])
      if (!data.topics.includes(adminTopic)) setAdminTopic(data.topics[0])
    }
  }

  const loadProvider = async () => {
    if (!client?.queries?.getLlmProvider) return
    const { data } = await client.queries.getLlmProvider()
    if (data?.provider) setProvider(data.provider)
  }

  useEffect(() => {
    ;(async () => {
      try {
        await refreshSession()
        await Promise.all([loadTopics(), loadProvider()])
      } catch (_err) {
        setAuthUser(null)
        setIsAdmin(false)
      } finally {
        setAuthLoading(false)
      }
    })()
  }, [])

  const handleSignIn = async () => {
    setAuthError('')
    setAuthLoading(true)
    try {
      const result = await signIn({ username: email, password })
      if (result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        setAuthMode('newPassword')
      } else {
        await refreshSession()
        await Promise.all([loadTopics(), loadProvider()])
      }
    } catch (err) {
      const msg = err?.message || String(err)
      if (msg.includes('already a signed in user')) {
        try {
          await refreshSession()
          await Promise.all([loadTopics(), loadProvider()])
          setAuthError('')
        } catch (_e) {
          setAuthError(msg)
        }
      } else {
        setAuthError(msg)
      }
    } finally {
      setAuthLoading(false)
    }
  }

  const handleCompleteNewPassword = async () => {
    setAuthError('')
    setAuthLoading(true)
    try {
      if (!newPassword || newPassword.length < 8) {
        setAuthError('Please enter a new password (at least 8 characters).')
        return
      }
      await confirmSignIn({ challengeResponse: newPassword })
      await refreshSession()
      await Promise.all([loadTopics(), loadProvider()])
      setAuthMode('signin')
      setPassword('')
      setNewPassword('')
    } catch (err) {
      setAuthError(err?.message || String(err))
    } finally {
      setAuthLoading(false)
    }
  }

  const handleStartResetPassword = async () => {
    setAuthError('')
    setAuthLoading(true)
    try {
      await resetPassword({ username: resetEmail })
      setResetCodeSent(true)
    } catch (err) {
      setAuthError(err?.message || String(err))
    } finally {
      setAuthLoading(false)
    }
  }

  const handleConfirmResetPassword = async () => {
    setAuthError('')
    setAuthLoading(true)
    try {
      await confirmResetPassword({
        username: resetEmail,
        confirmationCode: resetCode,
        newPassword: resetNewPassword,
      })
      setAuthMode('signin')
      setEmail(resetEmail)
      setPassword('')
      setResetCode('')
      setResetNewPassword('')
      setResetCodeSent(false)
    } catch (err) {
      setAuthError(err?.message || String(err))
    } finally {
      setAuthLoading(false)
    }
  }

  const handleSignOut = async () => {
    setAuthLoading(true)
    try {
      await signOut()
      setAuthUser(null)
      setIsAdmin(false)
      setMessages([])
    } finally {
      setAuthLoading(false)
    }
  }

  const handleSaveProvider = async () => {
    if (!client?.mutations?.setLlmProvider) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `Admin provider API not deployed yet. Using local provider "${provider}" for chat requests.` }])
      return
    }
    setSavingProvider(true)
    try {
      const { errors } = await client.mutations.setLlmProvider({ provider })
      if (errors?.length) throw new Error(errors.map((e) => e.message).join(', '))
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `Provider update failed: ${String(err)}` }])
    } finally {
      setSavingProvider(false)
    }
  }

  const handlePreprocess = async () => {
    setPreprocessing(true)
    try {
      await client.mutations.documentsImportTopic({ topic: adminTopic })
      await client.mutations.documentsPreprocess()
      await loadTopics()
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `Preprocess failed: ${String(err)}` }])
    } finally {
      setPreprocessing(false)
    }
  }

  const send = async () => {
    if (!input.trim()) return
    if (!topic) {
      setMessages((prev) => [...prev, { role: 'assistant', content: "Please select a topic ('forensics' or 'designer genes') before chatting." }])
      return
    }
    const userMsg = { role: 'user', content: input }
    const next = [...messages, userMsg]
    setMessages(next)
    setInput('')
    setLoading(true)
    try {
      let { data, errors } = await client.mutations.chat({
        messagesJson: JSON.stringify(next),
        topic,
      })
      const oldProviderPrompt = data?.reply?.includes('Please select a provider')
      if (oldProviderPrompt) {
        const retry = await client.mutations.chat({
          messagesJson: JSON.stringify(next),
          topic,
          provider,
        })
        data = retry.data
        errors = retry.errors
      }
      if (errors?.length) throw new Error(errors.map((e) => e.message).join(', '))
      setMessages((prev) => [...prev, { role: 'assistant', content: data?.reply || data?.error || 'No response' }])
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${String(err)}` }])
    } finally {
      setLoading(false)
    }
  }

  const onKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
  }

  if (!authUser) {
    return (
      <div className="app auth-shell">
        <h1>Chatbot</h1>
        <div className="auth-card">
          <h2>{authMode === 'newPassword' ? 'Set New Password' : authMode === 'resetPassword' ? 'Reset Password' : 'Sign In'}</h2>
          <div className="auth-note">Account access is invite-only. Ask an admin to create your account.</div>
          {authMode !== 'resetPassword' && (
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              disabled={authMode === 'newPassword'}
            />
          )}
          {authMode === 'signin' && (
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
          )}
          {authMode === 'newPassword' && (
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password"
            />
          )}
          {authMode === 'resetPassword' && (
            <>
              <input
                type="email"
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
                placeholder="Email"
              />
              {resetCodeSent && (
                <>
                  <input
                    type="text"
                    value={resetCode}
                    onChange={(e) => setResetCode(e.target.value)}
                    placeholder="Reset code"
                  />
                  <input
                    type="password"
                    value={resetNewPassword}
                    onChange={(e) => setResetNewPassword(e.target.value)}
                    placeholder="New password"
                  />
                </>
              )}
            </>
          )}
          {authError && <div className="auth-error">{authError}</div>}
          <div className="auth-actions">
            {authMode === 'signin' && <button onClick={handleSignIn}>Sign In</button>}
            {authMode === 'signin' && <button className="secondary" onClick={() => { setAuthMode('resetPassword'); setResetEmail(email); }}>Forgot Password?</button>}
            {authMode === 'newPassword' && <button onClick={handleCompleteNewPassword}>Set Password</button>}
            {authMode === 'newPassword' && <button className="secondary" onClick={() => setAuthMode('signin')}>Back</button>}
            {authMode === 'resetPassword' && !resetCodeSent && <button onClick={handleStartResetPassword}>Send Code</button>}
            {authMode === 'resetPassword' && resetCodeSent && <button onClick={handleConfirmResetPassword}>Reset Password</button>}
            {authMode === 'resetPassword' && <button className="secondary" onClick={() => { setAuthMode('signin'); setResetCodeSent(false); }}>Back to Sign In</button>}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <h1>Chatbot</h1>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div>{isAdmin ? `Admin mode • Provider: ${provider}` : 'User mode'}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {isAdmin && <button className="secondary" onClick={() => setShowAdminModal(true)}>Admin Tools</button>}
          <button className="secondary" onClick={handleSignOut}>Sign out</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label>Topic:</label>
        <select value={topic} onChange={(e) => setTopic(e.target.value)}>
          {topics.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {isAdmin && showAdminModal && (
        <div className="admin-modal-overlay" onClick={() => setShowAdminModal(false)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-header">
              <strong>Admin Tools</strong>
              <button className="secondary" onClick={() => setShowAdminModal(false)}>Close</button>
            </div>
            <div className="admin-modal-row">
              <label>Provider:</label>
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="openai">OpenAI</option>
                <option value="google">Google (Gemini)</option>
                <option value="bedrock">Bedrock</option>
              </select>
              <button onClick={handleSaveProvider} disabled={savingProvider}>{savingProvider ? 'Saving...' : 'Save Provider'}</button>
            </div>
            <div className="admin-modal-row">
              <label>Preprocess Topic:</label>
              <select value={adminTopic} onChange={(e) => setAdminTopic(e.target.value)}>
                {topics.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <button onClick={handlePreprocess}>Preprocess</button>
            </div>
          </div>
        </div>
      )}

      <div className="chat">
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="role">{m.role}</div>
            <div className="content">{m.content}</div>
          </div>
        ))}
        {loading && <div className="msg assistant">...thinking</div>}
      </div>

      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="Type a message (Cmd/Ctrl+Enter to send)"
        />
        <button onClick={send}>Send</button>
      </div>

      {(loading || preprocessing || authLoading) && (
        <div className="spinner-overlay">
          <div className="spinner" />
        </div>
      )}
    </div>
  )
}
