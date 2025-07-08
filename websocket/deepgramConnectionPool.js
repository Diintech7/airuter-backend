const WebSocket = require("ws")
const { DeepgramRateLimiter } = require("./deepgramRateLimiter")
require('dotenv').config();

class DeepgramConnectionPool {
  constructor() {
    this.rateLimiter = new DeepgramRateLimiter()
    this.connections = new Map() // sessionId -> { ws, lastUsed, language, ready }
    this.maxConnections = 5
    this.connectionTimeout = 30000 // 30 seconds
    this.maxRetries = 3

    // Cleanup old connections periodically
    setInterval(() => this.cleanup(), 15000)
  }

  cleanup() {
    const now = Date.now()
    const toRemove = []

    for (const [sessionId, conn] of this.connections.entries()) {
      if (now - conn.lastUsed > this.connectionTimeout) {
        toRemove.push(sessionId)
      }
    }

    toRemove.forEach((sessionId) => {
      console.log(`🧹 Cleaning up old connection for session: ${sessionId}`)
      this.closeConnection(sessionId)
    })
  }

  async getConnection(sessionId, language = "en") {
    // Check if we already have a connection for this session
    const existing = this.connections.get(sessionId)
    if (existing && existing.ws.readyState === WebSocket.OPEN && existing.ready) {
      existing.lastUsed = Date.now()
      console.log(`♻️ Reusing existing connection for session: ${sessionId}`)
      return existing.ws
    }

    // Remove any dead connections
    if (existing) {
      this.closeConnection(sessionId)
    }

    // Check rate limits
    const canConnect = this.rateLimiter.canConnect(sessionId)
    if (!canConnect.allowed) {
      const waitSeconds = Math.ceil(canConnect.waitTime / 1000)
      throw new Error(`Rate limited: ${canConnect.reason}. Wait ${waitSeconds} seconds`)
    }

    // Create new connection
    return this.createConnection(sessionId, language)
  }

  async createConnection(sessionId, language) {
    return new Promise((resolve, reject) => {
      try {
        console.log(`🔗 Creating new Deepgram connection for session: ${sessionId}`)

        if (!process.env.DEEPGRAM_API_KEY) {
          throw new Error("Deepgram API key not configured")
        }

        // Build optimized Deepgram URL
        const deepgramUrl = new URL("wss://api.deepgram.com/v1/listen")
        const params = {
          sample_rate: "16000",
          channels: "1",
          interim_results: "true",
          language: language,
          model: "nova-2",
          smart_format: "true",
          punctuate: "true",
          diarize: "false",
          endpointing: "500", // Longer endpointing to reduce reconnections
          vad_events: "true", // Voice activity detection
          utterance_end_ms: "1000", // Utterance end detection
        }

        Object.entries(params).forEach(([key, value]) => {
          deepgramUrl.searchParams.append(key, value)
        })

        const ws = new WebSocket(deepgramUrl.toString(), ["token", process.env.DEEPGRAM_API_KEY])
        ws.binaryType = "arraybuffer"

        const connectionTimeout = setTimeout(() => {
          console.error(`❌ Connection timeout for session: ${sessionId}`)
          ws.close()
          this.rateLimiter.recordConnection(sessionId, false)
          reject(new Error("Connection timeout"))
        }, 10000)

        ws.onopen = () => {
          clearTimeout(connectionTimeout)
          console.log(`✅ Deepgram connected for session: ${sessionId}`)

          const connectionInfo = {
            ws,
            lastUsed: Date.now(),
            language,
            ready: true,
            sessionId,
          }

          this.connections.set(sessionId, connectionInfo)
          this.rateLimiter.recordConnection(sessionId, true)
          this.rateLimiter.setConnectionInfo(sessionId, connectionInfo)

          resolve(ws)
        }

        ws.onerror = (error) => {
          clearTimeout(connectionTimeout)
          console.error(`❌ Deepgram error for session ${sessionId}:`, error)
          this.rateLimiter.recordConnection(sessionId, false)
          this.connections.delete(sessionId)
          reject(error)
        }

        ws.onclose = (event) => {
          clearTimeout(connectionTimeout)
          console.log(`🔌 Deepgram closed for session ${sessionId}, code: ${event.code}`)

          if (event.code === 1008 || event.code === 1011) {
            // Rate limited or server error
            this.rateLimiter.recordConnection(sessionId, false)
          }

          this.connections.delete(sessionId)
          this.rateLimiter.removeConnection(sessionId)
        }
      } catch (error) {
        console.error(`❌ Error creating connection for session ${sessionId}:`, error)
        this.rateLimiter.recordConnection(sessionId, false)
        reject(error)
      }
    })
  }

  closeConnection(sessionId) {
    const conn = this.connections.get(sessionId)
    if (conn && conn.ws) {
      try {
        conn.ws.close(1000, "Session ended")
      } catch (error) {
        console.error(`Error closing connection for session ${sessionId}:`, error)
      }
    }
    this.connections.delete(sessionId)
    this.rateLimiter.removeConnection(sessionId)
  }

  closeAllConnections() {
    console.log(`🛑 Closing all Deepgram connections (${this.connections.size} active)`)
    for (const sessionId of this.connections.keys()) {
      this.closeConnection(sessionId)
    }
  }

  getStats() {
    return {
      activeConnections: this.connections.size,
      rateLimiterStats: this.rateLimiter.getStats(),
    }
  }
}

module.exports = { DeepgramConnectionPool }
