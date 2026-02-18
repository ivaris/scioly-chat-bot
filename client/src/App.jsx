import React, { useState, useEffect } from 'react'
import { generateClient } from 'aws-amplify/data'

const client = generateClient()

export default function App() {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(false)
  const [provider, setProvider] = useState('openai')
  const [topic, setTopic] = useState('forensics')
  const [topics, setTopics] = useState(['forensics','designer genes'])
  const [preprocessing, setPreprocessing] = useState(false)
  const [importing, setImporting] = useState(false)
  
  // keep topics limited to allowed set (forensics, designer genes)

  // when topic changes, import files under the topic directory on the server
  useEffect(()=>{
    (async ()=>{
      if (!topic) return
      setImporting(true)
      try{
        const { errors } = await client.mutations.documentsImportTopic({ topic, provider })
        if (errors?.length) console.error('import-topic failed', errors)
      }catch(e){
        console.error('import-topic failed', e)
      }
      setImporting(false)
    })()
  },[topic, provider])

  const send = async () => {
    if (!input.trim()) return
    if (!provider || !topic) {
      setMessages(prev => [...prev, { role: 'assistant', content: "Please select a provider and a topic ('forensics' or 'designer genes') before chatting." }])
      return
    }
    const userMsg = { role: 'user', content: input }
    const next = [...messages, userMsg]
    setMessages(next)
    setInput('')
    setLoading(true)

    try {
      const { data, errors } = await client.mutations.chat({
        messagesJson: JSON.stringify(next),
        provider,
        topic,
      })
      if (errors?.length) throw new Error(errors.map((e) => e.message).join(', '))

      const reply = data?.reply || data?.error || 'No response'
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Error: ' + String(err) }])
    } finally {
      setLoading(false)
    }
  }

  const onKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
  }

  return (
    <div className="app">
      <h1>Chatbot</h1>
      <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:12}}>
        <label>Provider:</label>
        <select value={provider} onChange={e=>setProvider(e.target.value)}>
          <option value="openai">OpenAI</option>
          <option value="google">Google (Gemini)</option>
          <option value="bedrock">Bedrock</option>
        </select>

        <label style={{marginLeft:12}}>Topic:</label>
        <select value={topic} onChange={e=>setTopic(e.target.value)}>
          {topics.map(t=> <option key={t} value={t}>{t}</option>)}
        </select>

        <button onClick={async()=>{
          setPreprocessing(true)
          try{
            await client.mutations.documentsPreprocess({ provider })

            const { data } = await client.queries.documentsTopics()
            setTopics(data?.topics || [])
          }catch(e){}
          setPreprocessing(false)
        }}>Preprocess</button>
      </div>
      <div className="chat">
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="role">{m.role}</div>
            <div className="content">{m.content}</div>
          </div>
        ))}
        {loading && <div className="msg assistant">...thinking</div>}
      </div>

      {/* File upload removed — manage files by copying into local_docs/ or uploads/ */}

      <div className="composer">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="Type a message (Cmd/Ctrl+Enter to send)"
        />
        <button onClick={send}>Send</button>
      </div>

      {(loading || preprocessing || importing) && (
        <div className="spinner-overlay">
          <div className="spinner" />
        </div>
      )}
    </div>
  )
}
