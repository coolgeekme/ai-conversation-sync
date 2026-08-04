// Popup UI — incremental sync for ChatGPT & Claude
// First sync: slow (scans all). After: lightning fast (delta only).

const API_BASE = 'https://hermes-topic-dashboard.vercel.app/api/upload'
const status = document.getElementById('status')
const syncBtn = document.getElementById('sync-btn')
const dashLink = document.getElementById('dashboard-link')
const chatgptCount = document.getElementById('chatgpt-count')
const claudeCount = document.getElementById('claude-count')

// Load counts from last sync
chrome.storage.local.get(['lastSync', 'chatgptTotal', 'claudeTotal'], (d) => {
  if (d.chatgptTotal) chatgptCount.textContent = `${d.chatgptTotal} synced`
  if (d.claudeTotal) claudeCount.textContent = `${d.claudeTotal} synced`
})

async function getUserId() {
  const { userId } = await chrome.storage.local.get('userId')
  if (userId) return userId
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0')).join('')
  await chrome.storage.local.set({ userId: id })
  return id
}

getUserId().then(id => {
  dashLink.href = `https://hermes-topic-dashboard.vercel.app?user=${id}`
})

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true
  const userId = await getUserId()
  const { lastSync = 0 } = await chrome.storage.local.get('lastSync')
  const isFirst = !lastSync

  if (isFirst) {
    setStatus('First sync — this may take a minute...', '')
  }

  const platforms = [
    { id: 'chatgpt', url: 'https://chatgpt.com', platform: 'chatgpt-web' },
    { id: 'claude', url: 'https://claude.ai', platform: 'claude-web' },
  ]

  let allSessions = {}
  let errors = []

  for (const platform of platforms) {
    try {
      updateCount(platform.id, isFirst ? 'scanning...' : 'checking...')
      
      // Extract: ALL on first sync, DELTA on subsequent
      const data = await extractFromTab(platform, isFirst ? 0 : lastSync)
      
      if (data && data.sessions) {
        allSessions[platform.platform] = data.sessions
        const count = data.isDelta ? `${data.sessions.length} new` : `${data.sessions.length} total`
        updateCount(platform.id, count)
        await chrome.storage.local.set({ [`${platform.id}Total`]: data.totalInStore })
      } else {
        updateCount(platform.id, '0 found')
        if (isFirst) errors.push(`${platform.id}: log in first`)
      }
    } catch (e) {
      updateCount(platform.id, 'failed')
      errors.push(`${platform.id}: ${e.message}`)
    }
  }

  // Upload each platform's sessions
  let uploaded = 0
  for (const [platform, sessions] of Object.entries(allSessions)) {
    if (sessions.length > 0) {
      try {
        const res = await fetch(API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform, userId, sessions, isDelta: !isFirst })
        })
        if (res.ok) uploaded++
      } catch {}
    }
  }

  // Update last sync time
  const now = Date.now()
  await chrome.storage.local.set({ lastSync: now })

  syncBtn.disabled = false
  if (errors.length === 0 && uploaded > 0) {
    const msg = isFirst 
      ? `Done! ${Object.values(allSessions).flat().length} conversations synced.`
      : `Done! ${Object.values(allSessions).flat().length} new conversations.`
    setStatus(msg, 'success')
  } else if (uploaded > 0) {
    setStatus(`Partial: ${uploaded} platforms OK`, '')
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

async function extractFromTab(platform, sinceTimestamp) {
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
      args: [sinceTimestamp],
      world: 'MAIN'
    })
    return results[0]?.result
  } finally {
    if (shouldClose) chrome.tabs.remove(tabId).catch(() => {})
  }
}

// Runs in page context — incremental extraction
function extractConversations(sinceTimestamp) {
  const domain = window.location.hostname
  const isFirst = !sinceTimestamp

  return new Promise((resolve) => {
    if (!window.indexedDB?.databases) {
      resolve({ sessions: [], error: 'IndexedDB not supported' })
      return
    }

    window.indexedDB.databases().then(async (dbs) => {
      let allSessions = []
      let totalInStore = 0

      for (const db of dbs) {
        const data = await readDB(db.name, domain, sinceTimestamp)
        if (data) {
          allSessions = allSessions.concat(data.sessions)
          totalInStore += data.totalInStore
        }
      }

      resolve({
        sessions: allSessions.slice(0, 2000),
        totalInStore,
        isDelta: !isFirst,
        exported_at: new Date().toISOString(),
      })
    }).catch(err => resolve({ sessions: [], error: err.message }))
  })

  function readDB(dbName, domain, sinceTimestamp) {
    return new Promise((resolve) => {
      const req = window.indexedDB.open(dbName)
      let done = false
      req.onsuccess = (e) => {
        if (done) return
        const db = e.target.result
        extractStores(db, Array.from(db.objectStoreNames), domain, sinceTimestamp).then(resolve).finally(() => { db.close(); done = true })
      }
      req.onerror = () => resolve(null)
      setTimeout(() => { done = true; resolve(null) }, 15000)
    })
  }

  async function extractStores(db, storeNames, domain, sinceTimestamp) {
    const sessions = []
    let totalInStore = 0

    for (const name of storeNames) {
      try {
        const tx = db.transaction(name, 'readonly')
        const store = tx.objectStore(name)
        
        // Use cursor for incremental: only fetch records updated after last sync
        if (sinceTimestamp && store.indexNames.contains('update_time')) {
          const index = store.index('update_time')
          const range = IDBKeyRange.lowerBound(sinceTimestamp, true)
          const records = await cursorAll(index, range)
          
          for (const rec of records) {
            const s = normalize(rec, domain)
            if (s) sessions.push(s)
          }
        } else {
          // First sync or no update_time index: get all
          const records = await cursorAll(store)
          totalInStore = records.length
          
          for (const rec of records) {
            const s = normalize(rec, domain)
            if (s) sessions.push(s)
          }
        }
      } catch {}
    }

    return { sessions, totalInStore }
  }

  function cursorAll(source, range) {
    return new Promise((resolve) => {
      const results = []
      const request = (range ? source.openCursor(range) : source.openCursor())
      request.onsuccess = (e) => {
        const cursor = e.target.result
        if (cursor) {
          results.push(cursor.value)
          cursor.continue()
        } else {
          resolve(results)
        }
      }
      request.onerror = () => resolve(results)
    })
  }

  function normalize(record, domain) {
    const id = String(record.id || record.uuid || record.conversation_id || '')
    if (!id) return null
    const title = String(record.title || record.name || record.subject || 'Untitled').slice(0, 200)
    let messages = []
    let createTime = record.create_time || record.created_at || null
    let updateTime = record.update_time || record.updated_at || record.last_active || createTime

    // ChatGPT mapping
    if (record.mapping && typeof record.mapping === 'object') {
      messages = Object.values(record.mapping)
        .filter(n => n?.message)
        .map(n => ({
          role: n.message.author?.role === 'assistant' ? 'assistant' : 'user',
          content: extractText(n.message.content),
          timestamp: n.message.create_time || null
        })).filter(m => m.content).slice(-200)
    }
    // Direct messages array
    if ((!messages.length || messages.length < 2) && record.messages && Array.isArray(record.messages)) {
      messages = record.messages.map(m => ({
        role: (m.role === 'assistant' || m.sender === 'assistant') ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content.slice(0, 4000) : extractText(m.content),
        timestamp: m.timestamp || m.create_time || m.created_at || null
      })).filter(m => m.content).slice(-200)
    }
    // Claude format
    if ((!messages.length || messages.length < 2) && record.chat_messages && Array.isArray(record.chat_messages)) {
      messages = record.chat_messages.map(m => ({
        role: (m.sender === 'human' || m.role === 'user') ? 'user' : 'assistant',
        content: (m.text || m.content || '').slice(0, 4000),
        timestamp: m.created_at || m.timestamp || null
      })).filter(m => m.content).slice(-200)
    }

    if (!messages.length) return null
    return {
      id, title,
      platform: domain.includes('chatgpt') ? 'chatgpt-web' : 'claude-web',
      started_at: createTime,
      last_active: updateTime || createTime,
      message_count: record.messages?.length || record.chat_messages?.length || messages.length,
      messages,
    }
  }

  function extractText(c) {
    if (!c) return ''
    if (typeof c === 'string') return c.slice(0, 4000)
    if (Array.isArray(c)) return c.map(p => typeof p === 'string' ? p : p?.text || '').join(' ').slice(0, 4000)
    if (c?.parts) return (Array.isArray(c.parts) ? c.parts : []).join(' ').slice(0, 4000)
    return JSON.stringify(c).slice(0, 4000)
  }
}
