// Popup UI — syncs ChatGPT & Claude conversations via Vercel API
// Zero config: no tokens, no accounts. Just open ChatGPT/Claude and click Sync.

const API_BASE = 'https://hermes-topic-dashboard.vercel.app/api/upload'
const status = document.getElementById('status')
const syncBtn = document.getElementById('sync-btn')
const dashLink = document.getElementById('dashboard-link')

// Generate or load persistent user ID
async function getUserId() {
  const { userId } = await chrome.storage.local.get('userId')
  if (userId) return userId
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0')).join('')
  await chrome.storage.local.set({ userId: id })
  return id
}

// Update dashboard link
getUserId().then(id => {
  dashLink.href = `https://hermes-topic-dashboard.vercel.app?user=${id}`
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
        const res = await fetch(API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
          platform: platform.platform,
          userId: userId,
          sessions: data.sessions,
          })
        })
        
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        
        updateCount(platform.id, `${data.sessions.length} chats`)
        success++
        totalSessions += data.sessions.length
      } else {
        updateCount(platform.id, '0 found')
        errors.push(`${platform.id}: log in first`)
      }
    } catch (e) {
      updateCount(platform.id, 'failed')
      errors.push(`${platform.id}: ${e.message}`)
    }
  }

  syncBtn.disabled = false
  
  if (errors.length === 0) {
    setStatus(`Done! ${totalSessions} conversations. Dashboard updates in ~30s.`, 'success')
  } else if (success > 0) {
    setStatus(`Partial: ${success} OK, ${errors.length} failed`, '')
  } else {
    setStatus('Open ChatGPT or Claude.ai in a tab first', 'error')
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
  let tabId, shouldClose = false

  if (tabs.length > 0) {
    tabId = tabs[0].id
  } else {
    const tab = await chrome.tabs.create({ url: platform.url, active: true })
    tabId = tab.id; shouldClose = true
    await new Promise(r => setTimeout(r, 6000))
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractConversations,
      world: 'MAIN'
    })
    const result = results[0]?.result
    console.log('Extraction result:', JSON.stringify({ 
      platform: platform.id, 
      sessionCount: result?.sessions?.length,
      error: result?.error,
      firstFew: result?.sessions?.slice(0, 2)?.map(s => s.title)
    }))
    return result
  } finally {
    if (shouldClose) chrome.tabs.remove(tabId).catch(() => {})
  }
}

// Runs in page context — has access to IndexedDB
function extractConversations() {
  const domain = window.location.hostname

  return new Promise((resolve) => {
    if (!window.indexedDB?.databases) {
      resolve({ sessions: [], error: 'IndexedDB not supported' })
      return
    }

    window.indexedDB.databases().then(async (dbs) => {
      let allSessions = []
      for (const db of dbs) {
        const data = await readDB(db.name, domain)
        if (data?.sessions) allSessions = allSessions.concat(data.sessions)
      }
      resolve({
        platform: domain.includes('chatgpt') ? 'chatgpt-web' : 'claude-web',
        sessions: allSessions.slice(0, 1000),
        exported_at: new Date().toISOString(),
        total_sessions: allSessions.length,
      })
    }).catch(err => resolve({ sessions: [], error: err.message }))
  })

  function readDB(dbName, domain) {
    return new Promise((resolve) => {
      const req = window.indexedDB.open(dbName)
      let done = false
      req.onsuccess = (e) => {
        if (done) return
        const db = e.target.result
        extractStores(db, Array.from(db.objectStoreNames), domain).then(resolve).finally(() => { db.close(); done = true })
      }
      req.onerror = () => resolve(null)
      setTimeout(() => { done = true; resolve(null) }, 8000)
    })
  }

  async function extractStores(db, storeNames, domain) {
    const sessions = []
    for (const name of storeNames) {
      try {
        const tx = db.transaction(name, 'readonly')
        const records = await new Promise((res, rej) => {
          const r = tx.objectStore(name).getAll()
          r.onsuccess = () => res(r.result || [])
          r.onerror = () => rej(r.error)
        })
        for (const rec of records) {
          const s = normalize(rec, domain)
          if (s) sessions.push(s)
        }
      } catch {}
    }
    return { sessions }
  }

  function normalize(record, domain) {
    const id = String(record.id || record.uuid || record.conversation_id || '')
    const title = String(record.title || record.name || record.subject || 'Untitled').slice(0, 200)
    let messages = [], createTime = record.create_time || record.created_at || null
    let updateTime = record.update_time || record.updated_at || null

    if (record.mapping && typeof record.mapping === 'object') {
      messages = Object.values(record.mapping).filter(n => n?.message).map(n => ({
        role: n.message.author?.role === 'assistant' ? 'assistant' : 'user',
        content: extractText(n.message.content),
        timestamp: n.message.create_time || null
      })).filter(m => m.content)
    }
    if (record.messages && Array.isArray(record.messages)) {
      messages = record.messages.map(m => ({
        role: (m.role === 'assistant' || m.sender === 'assistant') ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content.slice(0, 4000) : extractText(m.content),
        timestamp: m.timestamp || m.create_time || null
      })).filter(m => m.content)
    }
    if (record.chat_messages && Array.isArray(record.chat_messages)) {
      messages = record.chat_messages.map(m => ({
        role: (m.sender === 'human' || m.role === 'user') ? 'user' : 'assistant',
        content: (m.text || m.content || '').slice(0, 4000),
        timestamp: m.created_at || null
      })).filter(m => m.content)
    }

    if (messages.length === 0) return null
    return { id, title, platform: domain.includes('chatgpt') ? 'chatgpt-web' : 'claude-web', started_at: createTime, last_active: updateTime || createTime, message_count: messages.length, messages: messages.slice(-300) }
  }

  function extractText(c) {
    if (!c) return ''
    if (typeof c === 'string') return c.slice(0, 4000)
    if (Array.isArray(c)) return c.map(p => typeof p === 'string' ? p : p?.text || '').join(' ').slice(0, 4000)
    if (c?.parts) return c.parts.join(' ').slice(0, 4000)
    return JSON.stringify(c).slice(0, 4000)
  }
}
