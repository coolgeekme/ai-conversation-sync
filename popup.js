// Popup UI — zero-config sync to Vercel API

const API_BASE = 'https://hermes-topic-dashboard.vercel.app/api'
const status = document.getElementById('status')
const syncBtn = document.getElementById('sync-btn')
const dashLink = document.getElementById('dashboard-link')

// Generate or load a persistent user ID on first run
async function getUserId() {
  const stored = await chrome.storage.local.get('userId')
  if (stored.userId) return stored.userId
  
  // Generate a random 12-char ID
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0')).join('')
  await chrome.storage.local.set({ userId: id })
  return id
}

// Update dashboard link with user ID
getUserId().then(userId => {
  dashLink.href = `https://hermes-topic-dashboard.vercel.app?user=${userId}`
})

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true
  setStatus('Syncing...', '')

  const userId = await getUserId()
  const platforms = [
    { id: 'chatgpt', url: 'https://chatgpt.com', platform: 'chatgpt-web' },
    { id: 'claude', url: 'https://claude.ai', platform: 'claude-web' },
  ]

  let success = 0
  let totalSessions = 0
  let errors = []

  for (const platform of platforms) {
    try {
      updateCount(platform.id, '...')
      const data = await extractFromTab(platform)
      
      if (data && data.sessions && data.sessions.length > 0) {
        // Upload to Vercel API
        const res = await fetch(`${API_BASE}/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId,
            platform: platform.platform,
            sessions: data.sessions,
          })
        })
        
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
        
        updateCount(platform.id, `${data.sessions.length} chats`)
        success++
        totalSessions += data.sessions.length
      } else {
        updateCount(platform.id, '0 found')
        errors.push(`${platform.id}: no conversations — log in first`)
      }
    } catch (e) {
      updateCount(platform.id, 'failed')
      errors.push(`${platform.id}: ${e.message}`)
    }
  }

  syncBtn.disabled = false
  
  if (errors.length === 0) {
    setStatus(`Synced ${totalSessions} conversations. Rebuilding...`, 'success')
    // Trigger rebuild
    await fetch(`${API_BASE}/rebuild?userId=${userId}`, { method: 'POST' }).catch(() => {})
    setStatus(`Done! ${totalSessions} conversations synced.`, 'success')
  } else if (success > 0) {
    setStatus(`Partial: ${success} OK. Open ChatGPT/Claude tabs first.`, '')
  } else {
    setStatus('Open ChatGPT or Claude.ai in a tab, then try again', 'error')
  }
})

function updateCount(platformId, text) {
  const el = document.getElementById(`${platformId}-count`)
  if (el) el.textContent = text
}

function setStatus(msg, cls) {
  status.textContent = msg
  status.className = `status ${cls}`
}

async function extractFromTab(platform) {
  const tabs = await chrome.tabs.query({ url: `${platform.url}/*` })
  let tabId
  let shouldClose = false

  if (tabs.length > 0) {
    tabId = tabs[0].id
  } else {
    // Open a new background tab
    const tab = await chrome.tabs.create({ url: platform.url, active: false })
    tabId = tab.id
    shouldClose = true
    // Wait for the page to load
    await new Promise(r => setTimeout(r, 4000))
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractConversations,
      world: 'MAIN'
    })
    return results[0]?.result
  } finally {
    if (shouldClose) {
      chrome.tabs.remove(tabId).catch(() => {})
    }
  }
}

// Runs inside the target page (chatgpt.com or claude.ai)
// Has full access to the page's IndexedDB
function extractConversations() {
  const domain = window.location.hostname

  return new Promise((resolve) => {
    if (!window.indexedDB || !window.indexedDB.databases) {
      resolve({ sessions: [], error: 'IndexedDB not supported' })
      return
    }

    window.indexedDB.databases().then(async (dbs) => {
      const dbNames = dbs.map(d => d.name)
      let allSessions = []
      let totalMessages = 0

      for (const dbName of dbNames) {
        const data = await readDatabase(dbName, domain)
        if (data && data.sessions) {
          allSessions = allSessions.concat(data.sessions)
          totalMessages += data.total_messages
        }
      }

      resolve({
        platform: domain.includes('chatgpt') ? 'chatgpt-web' : 'claude-web',
        exported_at: new Date().toISOString(),
        total_sessions: allSessions.length,
        total_messages: totalMessages,
        sessions: allSessions.slice(0, 1000),
      })
    }).catch(err => {
      resolve({ sessions: [], error: err.message })
    })
  })

  function readDatabase(dbName, domain) {
    return new Promise((resolve) => {
      const request = window.indexedDB.open(dbName)
      let done = false
      
      request.onsuccess = (event) => {
        if (done) return
        const db = event.target.result
        const storeNames = Array.from(db.objectStoreNames)
        
        try {
          extractFromStores(db, storeNames, domain).then(resolve)
        } catch(e) {
          resolve(null)
        } finally {
          db.close()
          done = true
        }
      }
      
      request.onerror = () => resolve(null)
      setTimeout(() => { done = true; resolve(null) }, 8000)
    })
  }

  async function extractFromStores(db, storeNames, domain) {
    const sessions = []
    let totalMessages = 0

    for (const storeName of storeNames) {
      try {
        const tx = db.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const records = await new Promise((resolve, reject) => {
          const req = store.getAll()
          req.onsuccess = () => resolve(req.result || [])
          req.onerror = () => reject(req.error)
        })
        
        for (const record of records) {
          const session = normalizeRecord(record, storeName, domain)
          if (session) {
            sessions.push(session)
            totalMessages += session.message_count || 0
          }
        }
      } catch(e) {}
    }

    return { sessions, total_messages }
  }

  function normalizeRecord(record, storeName, domain) {
    const id = String(record.id || record.uuid || record.conversation_id || '')
    const title = String(record.title || record.name || record.subject || 'Untitled').slice(0, 200)
    
    let messages = []
    let createTime = record.create_time || record.created_at || null
    let updateTime = record.update_time || record.updated_at || null

    // ChatGPT mapping structure
    if (record.mapping && typeof record.mapping === 'object') {
      messages = Object.values(record.mapping)
        .filter(n => n && n.message)
        .map(n => ({
          role: (n.message.author?.role === 'assistant' || n.message.author?.role === 'tool') ? 'assistant' : 'user',
          content: extractText(n.message.content),
          timestamp: n.message.create_time || null
        }))
        .filter(m => m.content)
    }
    
    // Direct messages array
    if (record.messages && Array.isArray(record.messages)) {
      messages = record.messages.map(m => ({
        role: (m.role === 'assistant' || m.role === 'model' || m.sender === 'assistant') ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content.slice(0, 4000) : extractText(m.content),
        timestamp: m.timestamp || m.create_time || m.created_at || null
      })).filter(m => m.content)
    }

    // Claude format
    if (record.chat_messages && Array.isArray(record.chat_messages)) {
      messages = record.chat_messages.map(m => ({
        role: (m.sender === 'human' || m.role === 'user') ? 'user' : 'assistant',
        content: (m.text || m.content || '').slice(0, 4000),
        timestamp: m.created_at || m.timestamp || null
      })).filter(m => m.content)
    }

    if (messages.length === 0) return null

    return {
      id,
      title,
      platform: domain.includes('chatgpt') ? 'chatgpt-web' : 'claude-web',
      started_at: createTime,
      last_active: updateTime || createTime,
      message_count: messages.length,
      messages: messages.slice(-300),
    }
  }

  function extractText(content) {
    if (!content) return ''
    if (typeof content === 'string') return content.slice(0, 4000)
    if (Array.isArray(content)) {
      return content.map(part => {
        if (typeof part === 'string') return part
        if (part && part.text) return part.text
        return ''
      }).join(' ').slice(0, 4000)
    }
    if (content && content.parts && Array.isArray(content.parts)) {
      return content.parts.join(' ').slice(0, 4000)
    }
    return JSON.stringify(content).slice(0, 4000)
  }
}
