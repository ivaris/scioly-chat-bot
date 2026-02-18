import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { Amplify } from 'aws-amplify'
import amplifyconfig from './amplifyconfiguration.json'

Amplify.configure(amplifyconfig)

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
