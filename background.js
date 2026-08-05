// Background service worker — auto-syncs periodically
const SYNC_INTERVAL_MINUTES = 5
const API_BASE = 'http://76.13.107.20:8080/api/upload'

// Create alarm for periodic sync
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('auto-sync', { periodInMinutes: SYNC_INTERVAL_MINUTES })
  console.log(`Auto-sync scheduled every ${SYNC_INTERVAL_MINUTES} minutes`)
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'auto-sync') return
  
  const platforms = [
    { id: 'chatgpt', url: 'https://chatgpt.com', platform: 'chatgpt-web' },
    { id: 'claude', url: 'https://claude.ai', platform: 'claude-web' },
  ]

  for (const platform of platforms) {
    try {
      const tabs = await chrome.tabs.query({ url: `${platform.url}/*` })
      if (tabs.length === 0) continue // Skip if no tab open

      const results = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: extractConversations,
        args: [0], // Full scan each time (simpler, reliable)
        world: 'MAIN'
      })

      const data = results[0]?.result
      if (data?.sessions?.length > 0) {
        const { userId } = await chrome.storage.local.get('userId')
        await fetch(API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform: platform.platform, userId, sessions: data.sessions })
        })
        console.log(`Auto-synced ${platform.id}: ${data.sessions.length} sessions`)
      }
    } catch (e) {
      console.error(`Auto-sync ${platform.id} failed:`, e)
    }
  }
})

// Reuse extraction function from popup.js
function extractConversations(sinceTimestamp) {
  const domain = window.location.hostname
  return new Promise((resolve) => {
    if (!window.indexedDB?.databases) {
      resolve({ sessions: [] })
      return
    }
    window.indexedDB.databases().then(async (dbs) => {
      let sessions = []
      for (const db of dbs) {
        const data = await readDB(db.name, domain)
        if (data?.sessions) sessions = sessions.concat(data.sessions)
      }
      resolve({ sessions: sessions.slice(0, 1000), platform: domain.includes('chatgpt') ? 'chatgpt-web' : 'claude-web' })
    }).catch(() => resolve({ sessions: [] }))
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
      setTimeout(() => { done = true; resolve(null) }, 10000)
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
    if (!id) return null
    const title = String(record.title || record.name || record.subject || 'Untitled').slice(0, 200)
    let messages = [], createTime = record.create_time || record.created_at || null
    let updateTime = record.update_time || record.updated_at || null

    if (record.mapping && typeof record.mapping === 'object') {
      messages = Object.values(record.mapping).filter(n => n?.message).map(n => ({
        role: n.message.author?.role === 'assistant' ? 'assistant' : 'user',
        content: typeof n.message.content === 'string' ? n.message.content.slice(0, 4000) : JSON.stringify(n.message.content).slice(0, 4000),
        timestamp: n.message.create_time || null
      })).filter(m => m.content).slice(-200)
    }
    if ((!messages.length || messages.length < 2) && record.messages && Array.isArray(record.messages)) {
      messages = record.messages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content.slice(0, 4000) : '',
        timestamp: m.timestamp || m.create_time || null
      })).filter(m => m.content).slice(-200)
    }
    if ((!messages.length || messages.length < 2) && record.chat_messages && Array.isArray(record.chat_messages)) {
      messages = record.chat_messages.map(m => ({
        role: m.sender === 'human' ? 'user' : 'assistant',
        content: (m.text || m.content || '').slice(0, 4000),
        timestamp: m.created_at || null
      })).filter(m => m.content).slice(-200)
    }
    if (!messages.length) return null
    return { id, title, platform: domain.includes('chatgpt') ? 'chatgpt-web' : 'claude-web', started_at: createTime, last_active: updateTime || createTime, message_count: messages.length, messages }
  }
}
