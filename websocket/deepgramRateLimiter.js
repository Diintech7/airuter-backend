class DeepgramRateLimiter {
    constructor() {
      this.connections = new Map() // sessionId -> connection info
      this.globalLimits = {
        connectionsPerMinute: 10,
        connectionsPerHour: 100,
        currentMinuteConnections: 0,
        currentHourConnections: 0,
        minuteResetTime: Date.now() + 60000,
        hourResetTime: Date.now() + 3600000,
      }
      this.sessionLimits = new Map() // sessionId -> { attempts, lastAttempt, backoffUntil }
  
      // Reset counters periodically
      setInterval(() => this.resetCounters(), 30000)
    }
  
    resetCounters() {
      const now = Date.now()
  
      if (now >= this.globalLimits.minuteResetTime) {
        this.globalLimits.currentMinuteConnections = 0
        this.globalLimits.minuteResetTime = now + 60000
        console.log("🔄 Reset minute connection counter")
      }
  
      if (now >= this.globalLimits.hourResetTime) {
        this.globalLimits.currentHourConnections = 0
        this.globalLimits.hourResetTime = now + 3600000
        console.log("🔄 Reset hour connection counter")
      }
  
      // Clean up old session limits
      for (const [sessionId, limits] of this.sessionLimits.entries()) {
        if (now - limits.lastAttempt > 300000) {
          // 5 minutes
          this.sessionLimits.delete(sessionId)
        }
      }
    }
  
    canConnect(sessionId) {
      const now = Date.now()
  
      // Check global limits
      if (this.globalLimits.currentMinuteConnections >= this.globalLimits.connectionsPerMinute) {
        return {
          allowed: false,
          reason: "Global minute limit exceeded",
          waitTime: this.globalLimits.minuteResetTime - now,
        }
      }
  
      if (this.globalLimits.currentHourConnections >= this.globalLimits.connectionsPerHour) {
        return {
          allowed: false,
          reason: "Global hour limit exceeded",
          waitTime: this.globalLimits.hourResetTime - now,
        }
      }
  
      // Check session-specific limits
      const sessionLimits = this.sessionLimits.get(sessionId)
      if (sessionLimits) {
        if (now < sessionLimits.backoffUntil) {
          return {
            allowed: false,
            reason: "Session in backoff period",
            waitTime: sessionLimits.backoffUntil - now,
          }
        }
      }
  
      return { allowed: true }
    }
  
    recordConnection(sessionId, success = true) {
      const now = Date.now()
  
      // Update global counters
      this.globalLimits.currentMinuteConnections++
      this.globalLimits.currentHourConnections++
  
      // Update session limits
      const sessionLimits = this.sessionLimits.get(sessionId) || {
        attempts: 0,
        lastAttempt: 0,
        backoffUntil: 0,
      }
  
      if (success) {
        // Reset session limits on success
        sessionLimits.attempts = 0
        sessionLimits.backoffUntil = 0
      } else {
        // Increase backoff on failure
        sessionLimits.attempts++
        const backoffTime = Math.min(1000 * Math.pow(2, sessionLimits.attempts), 60000) // Max 1 minute
        sessionLimits.backoffUntil = now + backoffTime
        console.log(`⏳ Session ${sessionId} backing off for ${backoffTime}ms (attempt ${sessionLimits.attempts})`)
      }
  
      sessionLimits.lastAttempt = now
      this.sessionLimits.set(sessionId, sessionLimits)
    }
  
    getConnectionInfo(sessionId) {
      return this.connections.get(sessionId)
    }
  
    setConnectionInfo(sessionId, info) {
      this.connections.set(sessionId, info)
    }
  
    removeConnection(sessionId) {
      this.connections.delete(sessionId)
    }
  
    getStats() {
      return {
        globalLimits: this.globalLimits,
        activeConnections: this.connections.size,
        sessionsWithLimits: this.sessionLimits.size,
      }
    }
  }
  
  module.exports = { DeepgramRateLimiter }
  