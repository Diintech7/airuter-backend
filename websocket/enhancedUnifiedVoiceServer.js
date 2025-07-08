const WebSocket = require("ws")
const { createClient } = require("@deepgram/sdk")

// Enhanced Deepgram Client with better error handling and diagnostics
class EnhancedDeepgramClient {
  constructor(apiKey) {
    this.apiKey = apiKey
    this.deepgram = createClient(apiKey)
    this.connection = null
    this.isConnected = false
    this.onTranscript = null
    this.onError = null
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 3
    this.connectionTimeout = 10000 // Reduced to 10 seconds
    this.lastConnectionOptions = null
  }

  async testConnection() {
    try {
      console.log("🔍 Testing Deepgram API key and connectivity...")

      // Test API key validity
      const response = await this.deepgram.manage.getProjects()
      console.log("✅ API key valid, projects found:", response.projects?.length || 0)

      // Test basic connectivity without live connection
      console.log("✅ Deepgram REST API connectivity confirmed")
      return true
    } catch (error) {
      console.error("❌ Deepgram REST API test failed:", error)
      throw error
    }
  }

  async connect(options = {}) {
    try {
      // Test basic connectivity first
      await this.testConnection()

      // Simplified connection options to avoid potential issues
      const connectionOptions = {
        model: options.model || "nova-2",
        language: options.language || "en-US",
        smart_format: true,
        interim_results: false,
        punctuate: true,
        encoding: "linear16",
        sample_rate: 16000,
        channels: 1,
        // Remove potentially problematic options
        // endpointing: 300,
        // utterance_end_ms: 1000,
        // vad_events: true,
        ...options,
      }

      this.lastConnectionOptions = connectionOptions

      console.log("🔗 Creating Deepgram live connection with simplified options:", connectionOptions)
      
      // Add connection diagnostics
      console.log("🔧 Connection diagnostics:")
      console.log("  - API Key length:", this.apiKey.length)
      console.log("  - SDK Version:", require("@deepgram/sdk/package.json").version)
      console.log("  - Node Version:", process.version)
      console.log("  - Environment:", process.env.NODE_ENV)

      this.connection = this.deepgram.listen.live(connectionOptions)

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          console.error("❌ Connection timeout - this might be a network/firewall issue")
          this.cleanup()
          reject(new Error(`Connection timeout after ${this.connectionTimeout}ms - possible network/firewall issue`))
        }, this.connectionTimeout)

        this.connection.on("open", () => {
          clearTimeout(timeout)
          console.log("✅ Deepgram live connection opened successfully")
          this.isConnected = true
          this.reconnectAttempts = 0
          resolve(true)
        })

        this.connection.on("transcript", (data) => {
          try {
            console.log("📝 Raw transcript data received")

            const transcript = data.channel?.alternatives?.[0]?.transcript
            const confidence = data.channel?.alternatives?.[0]?.confidence

            if (transcript && transcript.trim() && this.onTranscript) {
              console.log(`📝 Transcript: "${transcript}" (confidence: ${confidence})`)
              this.onTranscript(transcript, data)
            } else if (data.type === "UtteranceEnd") {
              console.log("🔚 Utterance ended")
            }
          } catch (error) {
            console.error("❌ Error processing transcript:", error)
          }
        })

        this.connection.on("error", (error) => {
          clearTimeout(timeout)
          console.error("❌ Deepgram live connection error:", {
            error: error,
            message: error.message || "Unknown error",
            type: error.type || "unknown",
            timestamp: new Date().toISOString(),
          })

          // Enhanced error diagnostics
          if (error.message && error.message.includes("network error")) {
            console.error("🔍 Network Error Diagnostics:")
            console.error("  - This usually indicates:")
            console.error("    1. Firewall blocking WebSocket connections")
            console.error("    2. Corporate network restrictions")
            console.error("    3. ISP blocking WebSocket traffic")
            console.error("    4. Deepgram service temporarily unavailable")
            console.error("  - Try:")
            console.error("    1. Check if you can access wss://api.deepgram.com directly")
            console.error("    2. Test from a different network")
            console.error("    3. Check firewall/proxy settings")
          }

          if (error.message && error.message.includes("non-101 status code")) {
            console.error("🔍 HTTP Status Error Diagnostics:")
            console.error("  - This indicates the server returned an HTTP error instead of upgrading to WebSocket")
            console.error("  - Possible causes:")
            console.error("    1. Invalid API key (but yours validated successfully)")
            console.error("    2. Rate limiting")
            console.error("    3. Service temporarily unavailable")
            console.error("    4. Invalid connection parameters")
          }

          this.isConnected = false

          if (this.onError) {
            this.onError(error)
          }

          // Don't auto-reconnect for network errors - they're likely persistent
          if (error.message && error.message.includes("network error")) {
            console.log("❌ Network error detected - skipping auto-reconnect")
            reject(error)
            return
          }

          // Try to reconnect for other errors
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++
            console.log(`🔄 Attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${2000 * this.reconnectAttempts}ms`)
            setTimeout(() => {
              this.connect(this.lastConnectionOptions).catch(reject)
            }, 2000 * this.reconnectAttempts)
          } else {
            reject(error)
          }
        })

        this.connection.on("close", (event) => {
          console.log("🔌 Deepgram connection closed:", {
            code: event?.code,
            reason: event?.reason,
            wasClean: event?.wasClean,
            timestamp: new Date().toISOString(),
          })
          this.isConnected = false
        })

        this.connection.on("warning", (warning) => {
          console.warn("⚠️ Deepgram warning:", warning)
        })

        this.connection.on("metadata", (metadata) => {
          console.log("📊 Deepgram metadata:", metadata)
        })

        // Add connection state logging
        console.log("🔄 WebSocket connection initiated...")
      })
    } catch (error) {
      console.error("❌ Failed to connect to Deepgram:", error)
      throw error
    }
  }

  sendAudio(audioData) {
    if (!this.connection || !this.isConnected) {
      console.warn("⚠️ Deepgram not connected, cannot send audio")
      return false
    }

    try {
      if (!audioData || audioData.length === 0) {
        console.warn("⚠️ Empty audio data, skipping")
        return false
      }

      console.log(`📤 Sending audio to Deepgram (${audioData.length} bytes)`)
      this.connection.send(audioData)
      return true
    } catch (error) {
      console.error("❌ Error sending audio to Deepgram:", error)
      return false
    }
  }

  cleanup() {
    if (this.connection) {
      try {
        this.connection.finish()
      } catch (error) {
        console.error("❌ Error finishing Deepgram connection:", error)
      }
    }
    this.connection = null
    this.isConnected = false
  }

  close() {
    this.cleanup()
  }
}

// Mock LMNT Client for testing
class MockLMNTClient {
  constructor(apiKey) {
    this.apiKey = apiKey
    this.isInitialized = false
  }

  async initialize() {
    try {
      if (!this.apiKey) {
        throw new Error("LMNT API key not provided")
      }

      // Simulate initialization delay
      await new Promise(resolve => setTimeout(resolve, 100))
      
      this.isInitialized = true
      console.log("✅ Mock LMNT client initialized successfully")
      return true
    } catch (error) {
      console.error("❌ Failed to initialize Mock LMNT client:", error)
      throw error
    }
  }

  async synthesize(text, options = {}) {
    if (!this.isInitialized) {
      await this.initialize()
    }

    try {
      console.log(`🎵 Mock TTS synthesis: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`)

      // Simulate API delay
      await new Promise((resolve) => setTimeout(resolve, 300))

      // Generate mock audio data (simple sine wave)
      const sampleRate = 8000
      const duration = Math.min(Math.max(text.length * 0.08, 1), 5) // 1-5 seconds based on text length
      const samples = Math.floor(sampleRate * duration)
      const audioBuffer = Buffer.alloc(samples * 2) // 16-bit samples

      // Generate a more realistic audio pattern
      const baseFreq = 200
      const freqVariation = text.length % 200
      
      for (let i = 0; i < samples; i++) {
        const t = i / sampleRate
        const frequency = baseFreq + freqVariation + Math.sin(t * 2) * 50
        const envelope = Math.exp(-t * 0.5) // Decay envelope
        const sample = Math.sin(2 * Math.PI * frequency * t) * envelope * 16384
        audioBuffer.writeInt16LE(Math.round(sample), i * 2)
      }

      console.log(`✅ Mock TTS generated ${audioBuffer.length} bytes of audio (${duration.toFixed(1)}s)`)
      return audioBuffer
    } catch (error) {
      console.error("❌ Mock LMNT synthesis error:", error)
      throw error
    }
  }
}

// Network diagnostics helper
async function runNetworkDiagnostics() {
  console.log("🔍 Running network diagnostics...")
  
  try {
    // Test basic HTTP connectivity to Deepgram
    const https = require('https')
    const testUrl = 'https://api.deepgram.com'
    
    return new Promise((resolve) => {
      const req = https.get(testUrl, (res) => {
        console.log(`✅ HTTP connectivity to Deepgram: ${res.statusCode}`)
        resolve(true)
      })
      
      req.on('error', (error) => {
        console.error(`❌ HTTP connectivity test failed: ${error.message}`)
        resolve(false)
      })
      
      req.setTimeout(5000, () => {
        console.error("❌ HTTP connectivity test timeout")
        req.destroy()
        resolve(false)
      })
    })
  } catch (error) {
    console.error("❌ Network diagnostics failed:", error)
    return false
  }
}

const setupEnhancedUnifiedVoiceServer = (wss) => {
  console.log("🚀 Enhanced Unified Voice WebSocket server initialized")

  wss.on("connection", (ws, req) => {
    console.log("🔗 New enhanced voice connection established")

    let deepgramClient = null
    let lmntClient = null
    let sessionId = null
    let messageCount = 0
    let connectionStartTime = Date.now()

    // Extract parameters from URL
    const url = new URL(req.url, "http://localhost")
    const language = url.searchParams.get("language") || "hi"
    const model = url.searchParams.get("model") || "nova-2"

    console.log(`🌐 Connection established with language: ${language}, model: ${model}`)
    console.log("🔧 Environment check:", {
      hasDeepgramKey: !!process.env.DEEPGRAM_API_KEY,
      hasLmntKey: !!process.env.LMNT_API_KEY,
      deepgramKeyLength: process.env.DEEPGRAM_API_KEY ? process.env.DEEPGRAM_API_KEY.length : 0,
      nodeEnv: process.env.NODE_ENV,
    })

    // Enhanced Deepgram initialization with better error handling
    const initializeDeepgram = async () => {
      if (!process.env.DEEPGRAM_API_KEY) {
        console.error("❌ DEEPGRAM_API_KEY not configured")
        return { success: false, error: "DEEPGRAM_API_KEY not configured" }
      }

      try {
        // Run network diagnostics first
        const networkOk = await runNetworkDiagnostics()
        if (!networkOk) {
          console.warn("⚠️ Network connectivity issues detected")
        }

        deepgramClient = new EnhancedDeepgramClient(process.env.DEEPGRAM_API_KEY)

        deepgramClient.onTranscript = (transcript, data) => {
          if (ws.readyState === WebSocket.OPEN) {
            const response = {
              data: {
                session_id: sessionId,
                count: ++messageCount,
                text: transcript,
                transcription_data: {
                  transcript: transcript,
                  confidence: data.channel?.alternatives?.[0]?.confidence || 0.9,
                  words: data.channel?.alternatives?.[0]?.words || [],
                  language: language,
                  timestamp: Date.now(),
                  latency: Date.now() - connectionStartTime,
                },
              },
              type: "transcription_response",
              session_id: sessionId,
              timestamp: Date.now(),
            }

            console.log("📤 Sending transcription response")
            ws.send(JSON.stringify(response))
          }
        }

        deepgramClient.onError = (error) => {
          console.error("❌ Deepgram client error:", error)
          if (ws.readyState === WebSocket.OPEN) {
            const errorResponse = {
              data: {
                session_id: sessionId,
                count: ++messageCount,
                error: `Deepgram connection failed: ${error.message || "Network connectivity issue"}`,
                error_details: {
                  type: error.type || "connection_error",
                  message: error.message || "Unknown error",
                  suggestion: "This appears to be a network connectivity issue. Please check your firewall/proxy settings.",
                },
              },
              type: "transcription_error",
              session_id: sessionId,
              timestamp: Date.now(),
            }
            ws.send(JSON.stringify(errorResponse))
          }
        }

        const deepgramLanguageCode = getDeepgramLanguageCode(language)
        
        // Try to connect with timeout
        const connectPromise = deepgramClient.connect({
          language: deepgramLanguageCode,
          model: model,
          smart_format: true,
          interim_results: false,
          encoding: "linear16",
          sample_rate: 16000,
          channels: 1,
        })

        // Add overall timeout for the entire connection process
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error("Overall connection timeout - likely network/firewall issue"))
          }, 30000) // 30 second overall timeout
        })

        await Promise.race([connectPromise, timeoutPromise])

        console.log("✅ Enhanced Deepgram client initialized successfully")
        return { success: true }
      } catch (error) {
        console.error("❌ Failed to initialize enhanced Deepgram:", error)
        deepgramClient = null
        
        // Provide helpful error message based on error type
        let userFriendlyError = error.message
        if (error.message && error.message.includes("network error")) {
          userFriendlyError = "Network connectivity issue - please check firewall/proxy settings"
        } else if (error.message && error.message.includes("timeout")) {
          userFriendlyError = "Connection timeout - likely network/firewall blocking WebSocket connections"
        }
        
        return {
          success: false,
          error: userFriendlyError,
          details: {
            type: error.constructor.name,
            originalMessage: error.message,
          },
        }
      }
    }

    // Enhanced LMNT initialization
    const initializeLMNT = async () => {
      if (!process.env.LMNT_API_KEY) {
        console.error("❌ LMNT_API_KEY not configured")
        return { success: false, error: "LMNT_API_KEY not configured" }
      }

      try {
        lmntClient = new MockLMNTClient(process.env.LMNT_API_KEY)
        await lmntClient.initialize()
        console.log("✅ Enhanced LMNT client initialized successfully")
        return { success: true }
      } catch (error) {
        console.error("❌ Failed to initialize enhanced LMNT:", error)
        lmntClient = null
        return {
          success: false,
          error: error.message,
          details: {
            type: error.constructor.name,
            stack: error.stack,
          },
        }
      }
    }

    // Helper function for language codes
    function getDeepgramLanguageCode(lang) {
      const languageMap = {
        hi: "hi-IN",
        en: "en-US",
        te: "te-IN",
        ta: "ta-IN",
        bn: "bn-IN",
        gu: "gu-IN",
        kn: "kn-IN",
        ml: "ml-IN",
        mr: "mr-IN",
        or: "or-IN",
        pa: "pa-IN",
        ur: "ur-IN",
      }
      return languageMap[lang] || "en-US"
    }

    // Enhanced message handler
    ws.on("message", async (message) => {
      const messageStartTime = Date.now()

      try {
        let data
        try {
          const messageStr = message.toString()
          data = JSON.parse(messageStr)
          console.log("📥 Received message:", {
            event: data.event,
            session_id: data.session_id || data.uuid,
            language: data.language,
            hasAudioData: !!data.audio_data,
            audioDataLength: data.audio_data ? data.audio_data.length : 0,
            timestamp: messageStartTime,
          })
        } catch (parseError) {
          console.error("❌ Invalid message format:", parseError.message)
          sendErrorResponse("Invalid JSON message format")
          return
        }

        switch (data.event) {
          case "start":
            await handleStartEvent(data)
            break
          case "transcribe":
            await handleTranscribeEvent(data, messageStartTime)
            break
          case "synthesize":
            await handleSynthesizeEvent(data, messageStartTime)
            break
          default:
            console.warn("⚠️ Unknown event:", data.event)
            sendErrorResponse(`Unknown event type: ${data.event}`)
        }
      } catch (error) {
        console.error("❌ Error processing message:", error)
        sendErrorResponse(`Message processing failed: ${error.message}`)
      }
    })

    // Event handlers
    async function handleStartEvent(data) {
      sessionId = data.uuid || data.session_id || generateSessionId()
      messageCount = 0
      connectionStartTime = Date.now()

      console.log("🎬 Session started with ID:", sessionId)

      // Initialize services with timeout
      console.log("🔄 Initializing services...")
      
      const [deepgramResult, lmntResult] = await Promise.allSettled([
        Promise.race([
          initializeDeepgram(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Deepgram initialization timeout")), 35000))
        ]),
        initializeLMNT()
      ])

      const services = []
      const serviceStatus = {}

      // Handle LMNT result
      if (lmntResult.status === 'fulfilled' && lmntResult.value.success) {
        services.push("synthesis")
        serviceStatus.synthesis = "connected"
      } else {
        serviceStatus.synthesis = "failed"
        serviceStatus.synthesis_error = lmntResult.status === 'fulfilled' ? lmntResult.value.error : lmntResult.reason.message
      }

      // Handle Deepgram result
      if (deepgramResult.status === 'fulfilled' && deepgramResult.value.success) {
        services.push("transcription")
        serviceStatus.transcription = "connected"
      } else {
        serviceStatus.transcription = "failed"
        const error = deepgramResult.status === 'fulfilled' ? deepgramResult.value.error : deepgramResult.reason.message
        serviceStatus.transcription_error = error
        console.log("⚠️ Transcription service failed to initialize:", error)
      }

      const connectionResponse = {
        data: {
          session_id: sessionId,
          count: 0,
          status: "connected",
          services: services,
          language: language,
          model: model,
          service_status: serviceStatus,
          server_info: {
            version: "2.0.0-enhanced",
            capabilities: ["transcription", "synthesis", "multi-language"],
            supported_languages: Object.keys({
              hi: "hi-IN",
              en: "en-US",
              te: "te-IN",
              ta: "ta-IN",
              bn: "bn-IN",
              gu: "gu-IN",
              kn: "kn-IN",
              ml: "ml-IN",
              mr: "mr-IN",
              or: "or-IN",
              pa: "pa-IN",
              ur: "ur-IN",
            }),
          },
          diagnostics: {
            deepgram_available: serviceStatus.transcription === "connected",
            lmnt_available: serviceStatus.synthesis === "connected",
            network_tested: true,
          }
        },
        type: "connection_established",
        session_id: sessionId,
        timestamp: Date.now(),
      }

      console.log("📤 Sending enhanced connection response")
      ws.send(JSON.stringify(connectionResponse))
    }

    async function handleTranscribeEvent(data, startTime) {
      if (!sessionId) {
        sessionId = data.session_id || data.uuid || generateSessionId()
      }

      if (!deepgramClient || !deepgramClient.isConnected) {
        console.error("⚠️ Deepgram not available for transcription")
        sendErrorResponse("Transcription service unavailable - connection failed during initialization", "transcription_error")
        return
      }

      if (!data.audio_data) {
        sendErrorResponse("No audio data provided for transcription", "transcription_error")
        return
      }

      try {
        const audioBuffer = Buffer.from(data.audio_data, "base64")
        console.log(`📤 Processing audio for transcription (${audioBuffer.length} bytes)`)

        const sent = deepgramClient.sendAudio(audioBuffer)
        if (!sent) {
          throw new Error("Failed to send audio to Deepgram")
        }

        console.log(`✅ Audio sent to Deepgram successfully (latency: ${Date.now() - startTime}ms)`)
      } catch (error) {
        console.error("❌ Error processing transcription:", error)
        sendErrorResponse(`Audio processing failed: ${error.message}`, "transcription_error")
      }
    }

    async function handleSynthesizeEvent(data, startTime) {
      const textToSynthesize = data.text || data.message
      if (!textToSynthesize) {
        sendErrorResponse("No text provided for synthesis", "tts_error")
        return
      }

      if (!lmntClient || !lmntClient.isInitialized) {
        console.error("⚠️ LMNT not available for synthesis")
        sendErrorResponse("TTS service unavailable", "tts_error")
        return
      }

      try {
        const synthesisOptions = {
          voice: "lily",
          language: language,
          speed: 1.0,
        }

        console.log(`🎵 Synthesizing text: "${textToSynthesize.substring(0, 50)}${textToSynthesize.length > 50 ? '...' : ''}"`)
        const audioData = await lmntClient.synthesize(textToSynthesize, synthesisOptions)

        const wavAudio = convertToWAV(audioData)
        const base64Audio = Buffer.from(wavAudio).toString("base64")

        const response = {
          data: {
            session_id: sessionId,
            count: ++messageCount,
            audio_bytes_to_play: base64Audio,
            sample_rate: 8000,
            channels: 1,
            sample_width: 2,
            synthesis_info: {
              text: textToSynthesize,
              voice: synthesisOptions.voice,
              language: synthesisOptions.language,
              audio_length: wavAudio.length,
              latency: Date.now() - startTime,
            },
          },
          type: "tts_response",
          session_id: sessionId,
          timestamp: Date.now(),
        }

        console.log(`📤 Sending TTS response (${wavAudio.length} bytes, latency: ${Date.now() - startTime}ms)`)
        ws.send(JSON.stringify(response))
      } catch (error) {
        console.error("❌ Error in TTS synthesis:", error)
        sendErrorResponse(`TTS processing failed: ${error.message}`, "tts_error")
      }
    }

    // Helper functions
    function sendErrorResponse(errorMessage, errorType = "error") {
      if (ws.readyState === WebSocket.OPEN) {
        const errorResponse = {
          data: {
            session_id: sessionId,
            count: ++messageCount,
            error: errorMessage,
            status: "error",
            timestamp: Date.now(),
          },
          type: errorType,
          session_id: sessionId,
          timestamp: Date.now(),
        }

        console.log("📤 Sending error response:", errorMessage)
        ws.send(JSON.stringify(errorResponse))
      }
    }

    function convertToWAV(audioBuffer, sampleRate = 8000, channels = 1, sampleWidth = 2) {
      const byteRate = sampleRate * channels * sampleWidth
      const blockAlign = channels * sampleWidth
      const dataSize = audioBuffer.length
      const fileSize = 36 + dataSize

      const wavBuffer = Buffer.alloc(44 + dataSize)
      let offset = 0

      // RIFF header
      wavBuffer.write("RIFF", offset)
      offset += 4
      wavBuffer.writeUInt32LE(fileSize, offset)
      offset += 4
      wavBuffer.write("WAVE", offset)
      offset += 4

      // fmt chunk
      wavBuffer.write("fmt ", offset)
      offset += 4
      wavBuffer.writeUInt32LE(16, offset)
      offset += 4
      wavBuffer.writeUInt16LE(1, offset)
      offset += 2
      wavBuffer.writeUInt16LE(channels, offset)
      offset += 2
      wavBuffer.writeUInt32LE(sampleRate, offset)
      offset += 4
      wavBuffer.writeUInt32LE(byteRate, offset)
      offset += 4
      wavBuffer.writeUInt16LE(blockAlign, offset)
      offset += 2
      wavBuffer.writeUInt16LE(sampleWidth * 8, offset)
      offset += 2

      // data chunk
      wavBuffer.write("data", offset)
      offset += 4
      wavBuffer.writeUInt32LE(dataSize, offset)
      offset += 4
      audioBuffer.copy(wavBuffer, offset)

      return wavBuffer
    }

    function generateSessionId() {
      return require("crypto").randomUUID()
    }

    // Connection cleanup
    ws.on("close", () => {
      console.log("🔌 Enhanced voice connection closed")

      if (deepgramClient) {
        deepgramClient.close()
        deepgramClient = null
      }

      if (lmntClient) {
        lmntClient = null
      }
    })

    ws.on("error", (error) => {
      console.error("❌ Enhanced WebSocket error:", error)
    })

    // Send initial connection confirmation
    if (ws.readyState === WebSocket.OPEN) {
      sessionId = generateSessionId()
      const initialResponse = {
        data: {
          session_id: sessionId,
          count: 0,
          status: "initializing",
          language: language,
          model: model,
          server_version: "2.0.0-enhanced",
          message: "Initializing services... This may take a moment for Deepgram connection."
        },
        type: "connection_initializing",
        session_id: sessionId,
        timestamp: Date.now(),
      }

      console.log("📤 Sending initial connection response")
      ws.send(JSON.stringify(initialResponse))
    }
  })
}

module.exports = {
  setupEnhancedUnifiedVoiceServer,
  EnhancedDeepgramClient,
  MockLMNTClient,
}
