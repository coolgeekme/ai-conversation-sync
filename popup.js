// Popup UI logic

const status = document.getElementById('status')
const syncBtn = document.getElementById('sync-btn')

// Load saved config
chrome.storage.local.get(['githubToken', 'githubRepo'], (data) => {
  if (data.githubToken) document.getElementById('github-token').value = data.githubToken
  if (data.githubRepo) document.getElementById('github-repo').value = data.githubRepo
})

// Save config on input
document.getElementById('github-token').addEventListener('change', (e) => {
  chrome.storage.local.set({ githubToken: e.target.value })
})
document.getElementById('github-repo').addEventListener('change', (e) => {
  chrome.storage.local.set({ githubRepo: e.target.value })
})

syncBtn.addEventListener('click', async () => {
  const token = document.getElementById('github-token').value.trim()
  const repo = document.getElementById('github-repo').value.trim()
  
  if (!token || !repo) {
    setStatus('Enter your GitHub token and repo first', 'error')
    return
  }

  syncBtn.disabled = true
  setStatus('Syncing...', '')

  const platforms = [
    { id: 'chatgpt', url: 'https://chatgpt.com', file: 'public/chatgpt_sessions.tar.gz' },
    { id: 'claude', url: 'https://claude.ai', file: 'public/claude_web_sessions.tar.gz' },
  ]

  let success = 0
  let errors = []

  for (const platform of platforms) {
    try {
      updateCount(platform.id, '...')
      const data = await extractFromTab(platform)
      if (data && data.sessions && data.sessions.length > 0) {
        await pushToGitHub(token, repo, platform.file, data)
        updateCount(platform.id, `${data.sessions.length} chats · ${data.total_messages} msgs`)
        success++
      } else {
        updateCount(platform.id, '0 found')
        errors.push(`${platform.id}: no conversations found`)
      }
    } catch (e) {
      updateCount(platform.id, 'failed')
      errors.push(`${platform.id}: ${e.message}`)
    }
  }

  syncBtn.disabled = false
  if (errors.length === 0) {
    setStatus(`Synced ${success} platforms. Dashboard updates in ~30s.`, 'success')
  } else if (success > 0) {
    setStatus(`Partial sync: ${success} OK, ${errors.length} failed`, '')
    console.error(errors)
  } else {
    setStatus(errors.join(' | '), 'error')
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
  // Find or create a tab for this platform
  const tabs = await chrome.tabs.query({ url: `${platform.url}/*` })
  let tabId
  
  if (tabs.length > 0) {
    tabId = tabs[0].id
  } else {
    const tab = await chrome.tabs.create({ url: platform.url, active: false })
    tabId = tab.id
    // Wait for page to load
    await new Promise(r => setTimeout(r, 3000))
  }

  // Execute content script to read IndexedDB
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractConversations,
    world: 'MAIN'  // Need MAIN world to access page's IndexedDB
  })

  return results[0]?.result
}

async function pushToGitHub(token, repo, filePath, data) {
  // Convert to JSON, compress as tar.gz (same as Claude Code exporter)
  const json = JSON.stringify(data)
  
  // Base64 encode the JSON (GitHub API expects base64 content)
  const base64 = btoa(unescape(encodeURIComponent(json)))
  
  // Check if file exists to get SHA
  let sha = null
  try {
    const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
      headers: { Authorization: `token ${token}` }
    })
    if (getRes.ok) {
      const info = await getRes.json()
      sha = info.sha
    }
  } catch {}

  // Push to GitHub
  const body = {
    message: `data: ${filePath.includes('chatgpt') ? 'ChatGPT' : 'Claude.ai'} web sessions`,
    content: base64,
    ...(sha ? { sha } : {})
  }

  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
    method: 'PUT',
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.message || `HTTP ${res.status}`)
  }
}

// This function runs INSIDE the target page (chatgpt.com or claude.ai)
// It has full access to the page's IndexedDB
function extractConversations() {
  const domain = window.location.hostname
  
  return new Promise((resolve, reject) => {
    // Try to list IndexedDB databases
    if (!window.indexedDB || !window.indexedDB.databases) {
      resolve({ sessions: [], total_messages: 0, error: 'IndexedDB not accessible' })
      return
    }

    window.indexedDB.databases().then(async (dbs) => {
      const dbNames = dbs.map(d => d.name)
      let sessions = []
      let totalMessages = 0

      for (const dbName of dbNames) {
        const data = await readDatabase(dbName, domain)
        if (data) {
          sessions = sessions.concat(data.sessions)
          totalMessages += data.total_messages
        }
      }

      resolve({
        platform: domain.includes('chatgpt') ? 'chatgpt' : 'claude-ai',
        exported_at: new Date().toISOString(),
        total_sessions: sessions.length,
        total_messages: totalMessages,
        sessions: sessions.slice(0, 500), // Limit to avoid huge files
      })
    }).catch(err => {
      resolve({ sessions: [], total_messages: 0, error: err.message })
    })
  })

  function readDatabase(dbName, domain) {
    return new Promise((resolve) => {
      const request = window.indexedDB.open(dbName)
      let done = false
      
      request.onsuccess = (event) => {
        if (done) return
        const db = event.target.result
        
        try {
          const storeNames = Array.from(db.objectStoreNames)
          
          // ChatGPT common stores
          if (storeNames.includes('conversation') || storeNames.includes('history')) {
            extractFromStores(db, storeNames, domain).then(resolve)
          }
          // Claude common stores  
          else if (storeNames.includes('messages') || storeNames.includes('conversations')) {
            extractFromStores(db, storeNames, domain).then(resolve)
          }
          else {
            resolve(null)
          }
        } catch(e) {
          resolve(null)
        } finally {
          db.close()
          done = true
        }
      }
      
      request.onerror = () => resolve(null)
      
      // Timeout after 5 seconds
      setTimeout(() => { done = true; resolve(null) }, 5000)
    })
  }

  async function extractFromStores(db, storeNames, domain) {
    const sessions = []
    let totalMessages = 0

    for (const storeName of storeNames) {
      try {
        const tx = db.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const records = await getAllFromStore(store)
        
        for (const record of records) {
          const session = normalizeRecord(record, storeName, domain)
          if (session) {
            sessions.push(session)
            totalMessages += session.message_count || 0
          }
        }
      } catch(e) {
        // Skip inaccessible stores
      }
    }

    return { sessions, total_messages }
  }

  function getAllFromStore(store) {
    return new Promise((resolve) => {
      const request = store.getAll()
      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => resolve([])
    })
  }

  function normalizeRecord(record, storeName, domain) {
    // Handle various schemas
    const id = record.id || record.uuid || record.conversation_id || ''
    const title = record.title || record.name || record.subject || 'Untitled'
    
    // Find messages
    let messages = []
    let createTime = null
    let updateTime = null

    // ChatGPT conversation format
    if (record.create_time) createTime = record.create_time
    if (record.update_time) updateTime = record.update_time
    if (record.messages) {
      messages = Array.isArray(record.messages) ? record.messages : []
    }
    if (record.mapping) {
      // ChatGPT's conversation mapping structure
      const mapping = typeof record.mapping === 'object' ? record.mapping : {}
      messages = Object.values(mapping)
        .filter(n => n && n.message)
        .map(n => ({
          role: n.message.author?.role || 'unknown',
          content: extractContent(n.message.content),
          timestamp: n.message.create_time
        }))
    }

    // Claude conversation format
    if (record.created_at) createTime = record.created_at
    if (record.updated_at) updateTime = record.updated_at
    if (record.chat_messages) {
      messages = record.chat_messages.map(m => ({
        role: m.sender === 'human' ? 'user' : 'assistant',
        content: m.text || m.content || '',
        timestamp: m.created_at
      }))
    }

    // Truncate long content, limit messages
    const limitedMessages = messages.slice(-200).map(m => ({
      role: m.role === 'assistant' || m.role === 'model' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content.slice(0, 4000) : JSON.stringify(m.content).slice(0, 4000),
      timestamp: m.timestamp || m.create_time || null
    }))

    return {
      id: String(id),
      title: String(title).slice(0, 200),
      platform: domain.includes('chatgpt') ? 'chatgpt-web' : 'claude-web',
      started_at: createTime,
      last_active: updateTime || createTime,
      message_count: messages.length,
      messages: limitedMessages,
    }
  }

  function extractContent(content) {
    if (!content) return ''
    if (typeof content === 'string') return content.slice(0, 4000)
    if (Array.isArray(content)) {
      return content.map(part => {
        if (typeof part === 'string') return part
        if (part.text) return part.text
        return ''
      }).join(' ').slice(0, 4000)
    }
    if (content.parts) {
      return (Array.isArray(content.parts) ? content.parts : []).join(' ').slice(0, 4000)
    }
    return JSON.stringify(content).slice(0, 4000)
  }
}
