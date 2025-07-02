const WebSocket = require("ws")
const FormData = require("form-data")

// Use native fetch (Node.js 18+) or fallback
const fetch = globalThis.fetch || require("node-fetch")

if (!fetch) {
  console.error("❌ Fetch not available. Please use Node.js 18+ or install node-fetch@2")
  process.exit(1)
}

const setupUnifiedVoiceServer = (wss) => {
  console.log("🚀 Unified Voice WebSocket server initialized")

  wss.on("connection", (ws, req) => {
    console.log("🔗 New unified voice connection established")

    // Deepgram client state
    let deepgramWs = null
    let deepgramReady = false
    let audioBuffer = []
    let deepgramConnected = false

    // Rate limiting state
    let audioQueue = []
    let isProcessingQueue = false
    let lastSentTime = 0
    const MIN_SEND_INTERVAL = 250 // Minimum 250ms between sends to Deepgram
    const MAX_QUEUE_SIZE = 50 // Maximum queued audio chunks
    let reconnectAttempts = 0
    const MAX_RECONNECT_ATTEMPTS = 5
    let reconnectDelay = 1000 // Start with 1 second

    // LMNT client state
    const lmntApiKey = process.env.LMNT_API_KEY

    // Session state
    let sessionId = null
    let audioChunkCount = 0
    let connectionGreetingSent = false

    // Extract language from URL parameters
    const url = new URL(req.url, "http://localhost")
    const language = url.searchParams.get("language") || "hi"

    console.log(`🌐 Connection established with language: ${language}`)
    console.log(`🔑 TTS API Key configured: ${lmntApiKey ? "Yes (" + lmntApiKey.substring(0, 8) + "...)" : "❌ NO"}`)

    // Default greeting messages based on language
    const getGreetingMessage = (lang) => {
      const greetings = {
        'hi': 'नमस्ते! मैं आपकी सहायता के लिए यहाँ हूँ। आप मुझसे कुछ भी पूछ सकते हैं।',
        'en': 'Hi! Hello, how can I help you today? Feel free to ask me anything.',
        'es': '¡Hola! ¿Cómo puedo ayudarte hoy?',
        'fr': 'Bonjour! Comment puis-je vous aider aujourd\'hui?',
        'de': 'Hallo! Wie kann ich Ihnen heute helfen?',
        'it': 'Ciao! Come posso aiutarti oggi?',
        'pt': 'Olá! Como posso ajudá-lo hoje?',
        'ja': 'こんにちは！今日はどのようにお手伝いできますか？',
        'ko': '안녕하세요! 오늘 어떻게 도와드릴까요?',
        'zh': '你好！我今天可以如何帮助您？',
        'ar': 'مرحبا! كيف يمكنني مساعدتك اليوم؟',
        'ru': 'Привет! Как я могу помочь вам сегодня?'
      }
      return greetings[lang] || greetings['en']
    }

    // Convert buffer to Python-like bytes string representation
    const bufferToPythonBytesString = (buffer) => {
      let result = "b'"
      for (let i = 0; i < buffer.length; i++) {
        const byte = buffer[i]
        if (byte >= 32 && byte <= 126 && byte !== 92 && byte !== 39) {
          // Printable ASCII characters (except backslash and single quote)
          result += String.fromCharCode(byte)
        } else {
          // Non-printable characters as hex escape sequences
          result += '\\x' + byte.toString(16).padStart(2, '0')
        }
      }
      result += "'"
      return result
    }

    // Function to send default greeting
    const sendGreeting = async () => {
      if (connectionGreetingSent || !lmntApiKey) {
        return
      }

      console.log("👋 ==================== SENDING CONNECTION GREETING ====================")
      console.log("👋 Language:", language)
      
      const greetingText = getGreetingMessage(language)
      console.log("👋 Greeting text:", greetingText)

      try {
        // Generate session ID if not exists
        if (!sessionId) {
          sessionId = generateSessionId()
        }

        const synthesisOptions = {
          voice: "lily",
          language: language === 'hi' ? 'hi' : 'en', // LMNT might not support all languages
          speed: 1.0,
        }

        console.log("👋 Synthesizing greeting with options:", synthesisOptions)
        const audioData = await synthesizeWithErrorHandling(greetingText, synthesisOptions)

        if (!audioData || audioData.length === 0) {
          throw new Error("Received empty greeting audio data from TTS")
        }

        console.log("✅ Greeting: Successfully received audio data, size:", audioData.length, "bytes")

        // Convert audio to the required format with raw bytes
        const audioBuffer = Buffer.from(audioData)
        const audioWithHeader = createWAVHeader(audioBuffer, 8000, 1, 16)
        const pythonBytesString = bufferToPythonBytesString(audioWithHeader)

        // Increment chunk count
        audioChunkCount++

        // Send greeting audio in the required format with raw bytes
        const greetingResponse = {
          data: {
            session_id: sessionId,
            count: audioChunkCount,
            audio_bytes_to_play: pythonBytesString,
            sample_rate: 8000,
            channels: 1,
            sample_width: 2,
          },
          type: "greeting"
        }

        console.log("✅ ==================== SENDING GREETING AUDIO ====================")
        console.log("✅ Greeting session_id:", greetingResponse.data.session_id)
        console.log("✅ Greeting count:", greetingResponse.data.count)
        console.log("✅ Greeting audio bytes preview:", pythonBytesString.substring(0, 100) + "...")

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(greetingResponse))
          console.log("✅ 👋 Connection greeting sent successfully!")
          connectionGreetingSent = true
        } else {
          console.error("❌ WebSocket not open, cannot send greeting")
        }

      } catch (error) {
        console.error("❌ ==================== GREETING ERROR ====================")
        console.error("❌ Failed to send greeting:", error.message)
        console.error("❌ Full error:", error)
        
        // Don't send error to client for greeting failure, just log it
        // The connection should still work normally
        connectionGreetingSent = true // Mark as sent to avoid retrying
      }
    }

    // Audio queue processor with rate limiting
    const processAudioQueue = async () => {
      if (isProcessingQueue || audioQueue.length === 0) {
        return
      }

      isProcessingQueue = true

      while (audioQueue.length > 0 && deepgramReady && deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        const now = Date.now()
        const timeSinceLastSend = now - lastSentTime

        // Enforce minimum interval between sends
        if (timeSinceLastSend < MIN_SEND_INTERVAL) {
          const waitTime = MIN_SEND_INTERVAL - timeSinceLastSend
          console.log(`⏱️ Rate limiting: waiting ${waitTime}ms before next send`)
          await new Promise((resolve) => setTimeout(resolve, waitTime))
        }

        const audioData = audioQueue.shift()
        const success = await sendAudioToDeepgramThrottled(audioData)

        if (!success) {
          // If send failed, put the audio back at the front of the queue
          audioQueue.unshift(audioData)
          break
        }

        lastSentTime = Date.now()

        // Small delay between chunks to prevent overwhelming
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      isProcessingQueue = false

      // Continue processing if there are more items in queue
      if (audioQueue.length > 0) {
        setTimeout(processAudioQueue, MIN_SEND_INTERVAL)
      }
    }

    // Enhanced audio sending with better error handling
    const sendAudioToDeepgramThrottled = async (audioData) => {
      if (!deepgramWs) {
        console.error("❌ STT: Cannot send audio - WebSocket not initialized")
        return false
      }

      if (deepgramWs.readyState !== WebSocket.OPEN) {
        console.error("❌ STT: Cannot send audio - WebSocket not open, current state:", deepgramWs.readyState)
        return false
      }

      if (!deepgramReady) {
        console.error("❌ STT: Cannot send audio - Client not ready")
        return false
      }

      try {
        const buffer = audioData instanceof Buffer ? audioData : Buffer.from(audioData)
        console.log("🎵 STT: Sending audio data, size:", buffer.length, "bytes")

        deepgramWs.send(buffer)
        return true
      } catch (error) {
        console.error("❌ STT: Error sending audio data:", error)

        // If it's a rate limiting error, we should back off
        if (error.message.includes("429") || error.message.includes("rate limit")) {
          console.log("🚫 Rate limit detected, backing off...")
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }

        return false
      }
    }

    // Queue audio data with overflow protection
    const queueAudioData = (audioData) => {
      // Prevent queue overflow
      if (audioQueue.length >= MAX_QUEUE_SIZE) {
        console.warn("⚠️ Audio queue full, dropping oldest chunk")
        audioQueue.shift() // Remove oldest chunk
      }

      audioQueue.push(audioData)
      console.log(`📊 Audio queued. Queue size: ${audioQueue.length}`)

      // Start processing if not already running
      if (!isProcessingQueue) {
        processAudioQueue()
      }
    }

    // Deepgram WebSocket connection function with exponential backoff
    const connectToDeepgram = async (options = {}) => {
      return new Promise((resolve, reject) => {
        try {
          console.log("🎙️ Connecting to STT with options:", JSON.stringify(options))
          console.log("🎙️ STT API Key present:", !!process.env.DEEPGRAM_API_KEY)
          console.log(
            "🎙️ STT API Key preview:",
            process.env.DEEPGRAM_API_KEY ? process.env.DEEPGRAM_API_KEY.substring(0, 12) + "..." : "MISSING",
          )

          if (!process.env.DEEPGRAM_API_KEY) {
            const error = "STT API key not configured"
            console.error("❌ STT:", error)
            reject(new Error(error))
            return
          }

          // Build Deepgram WebSocket URL
          const deepgramUrl = new URL("wss://api.deepgram.com/v1/listen")
          deepgramUrl.searchParams.append("sample_rate", "16000")
          deepgramUrl.searchParams.append("channels", "1")
          deepgramUrl.searchParams.append("interim_results", "true")
          deepgramUrl.searchParams.append("language", options.language || "en")
          deepgramUrl.searchParams.append("model", "nova-2")
          deepgramUrl.searchParams.append("smart_format", "true")
          deepgramUrl.searchParams.append("punctuate", "true")
          deepgramUrl.searchParams.append("diarize", "false")

          console.log("🎙️ STT URL:", deepgramUrl.toString())

          deepgramWs = new WebSocket(deepgramUrl.toString(), ["token", process.env.DEEPGRAM_API_KEY])
          deepgramWs.binaryType = "arraybuffer"

          // Add connection timeout with exponential backoff
          const connectionTimeout = setTimeout(() => {
            console.error("❌ STT: Connection timeout after 15 seconds")
            if (deepgramWs) {
              deepgramWs.close()
            }
            reject(new Error("STT connection timeout"))
          }, 15000)

          deepgramWs.onopen = () => {
            clearTimeout(connectionTimeout)
            console.log("✅ STT: WebSocket connection established successfully")
            deepgramReady = true
            deepgramConnected = true
            reconnectAttempts = 0 // Reset reconnect attempts on successful connection
            reconnectDelay = 1000 // Reset delay

            // Process any queued audio
            console.log("🎙️ STT: Processing", audioQueue.length, "queued audio chunks")
            if (audioQueue.length > 0) {
              processAudioQueue()
            }

            resolve()
          }

          deepgramWs.onmessage = (event) => {
            try {
              const rawData = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString()
              console.log("🎙️ STT: Raw message received:", rawData.substring(0, 500))

              const data = JSON.parse(rawData)
              console.log("🎙️ STT: Parsed data:", JSON.stringify(data, null, 2))

              // Check for different types of Deepgram responses
              if (data.type === "Results") {
                console.log("🎙️ STT: Received Results message")

                if (data.channel?.alternatives?.[0]?.transcript) {
                  const transcript = data.channel.alternatives[0].transcript
                  const confidence = data.channel.alternatives[0].confidence
                  const is_final = data.is_final

                  console.log("📝 STT: Found transcript:", transcript)
                  console.log("📝 STT: Confidence:", confidence)
                  console.log("📝 STT: Is final:", is_final)

                  // Enhanced console logging for STT text
                  if (transcript.trim()) {
                    console.log("🗣️ ==================== STT TRANSCRIPT ====================")
                    console.log("🗣️ SPEECH TO TEXT:", transcript)
                    console.log("🗣️ CONFIDENCE SCORE:", (confidence * 100).toFixed(2) + "%")
                    console.log("🗣️ STATUS:", is_final ? "FINAL" : "INTERIM")
                    console.log("🗣️ LANGUAGE:", language)
                    console.log("🗣️ TIMESTAMP:", new Date().toISOString())
                    console.log("🗣️ =====================================================")

                    console.log("📤 STT: Sending transcript to client:", transcript)
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(
                        JSON.stringify({
                          type: "transcript",
                          data: transcript,
                          confidence: confidence,
                          is_final: is_final,
                          language: language,
                        }),
                      )
                    }
                  }
                }
              } else if (data.type === "Metadata") {
                console.log("🎙️ STT: Received Metadata:", JSON.stringify(data, null, 2))
              } else if (data.type === "SpeechStarted") {
                console.log("🎙️ STT: Speech started detected")
                console.log("🗣️ ==================== SPEECH DETECTION ====================")
                console.log("🗣️ USER STARTED SPEAKING")
                console.log("🗣️ TIMESTAMP:", new Date().toISOString())
                console.log("🗣️ =====================================================")
              } else if (data.type === "UtteranceEnd") {
                console.log("🎙️ STT: Utterance end detected")
                console.log("🗣️ ==================== SPEECH DETECTION ====================")
                console.log("🗣️ USER STOPPED SPEAKING")
                console.log("🗣️ TIMESTAMP:", new Date().toISOString())
                console.log("🗣️ =====================================================")
              } else {
                console.log("🎙️ STT: Unknown message type:", data.type)
              }
            } catch (parseError) {
              console.error("❌ STT: Error parsing message:", parseError)
              console.error("❌ STT: Raw data:", event.data)
            }
          }

          deepgramWs.onerror = (error) => {
            clearTimeout(connectionTimeout)
            console.error("❌ STT: WebSocket error:", error)
            deepgramReady = false
            deepgramConnected = false

            // Check if it's a rate limiting error
            if (error.message && error.message.includes("429")) {
              console.log("🚫 STT: Rate limit error detected")
              // Send rate limit error to client
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "error",
                    error: "Rate limit exceeded. Please slow down audio transmission.",
                  }),
                )
              }
            }

            reject(error)
          }

          deepgramWs.onclose = (event) => {
            clearTimeout(connectionTimeout)
            console.log(`🎙️ STT: Connection closed with code ${event.code}, reason: ${event.reason}`)
            deepgramReady = false
            deepgramConnected = false

            // Handle rate limiting (429) or other recoverable errors
            if (event.code === 1006 || event.code === 1011 || event.reason.includes("429")) {
              console.log("🔄 STT: Attempting to reconnect due to recoverable error...")

              if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++
                const delay = Math.min(reconnectDelay * Math.pow(2, reconnectAttempts - 1), 30000) // Max 30 seconds

                console.log(
                  `🔄 STT: Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
                )

                setTimeout(() => {
                  connectToDeepgram(options).catch((err) => {
                    console.error("❌ STT: Reconnection failed:", err)
                  })
                }, delay)
              } else {
                console.error("❌ STT: Max reconnection attempts reached")
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: "error",
                      error: "STT connection failed after multiple attempts. Please refresh and try again.",
                    }),
                  )
                }
              }
            }
          }
        } catch (error) {
          console.error("❌ STT: Error during setup:", error)
          reject(error)
        }
      })
    }

    // Close Deepgram connection function
    const closeDeepgram = () => {
      console.log("🎙️ STT: Closing connection")
      deepgramReady = false
      deepgramConnected = false
      audioQueue = [] // Clear queue
      isProcessingQueue = false

      if (deepgramWs) {
        try {
          deepgramWs.close(1000, "Client closing")
          console.log("✅ STT: WebSocket closed successfully")
        } catch (error) {
          console.error("❌ STT: Error closing WebSocket:", error)
        }
      }
    }

    // LMNT synthesis function with comprehensive error handling and multiple API approaches
    const synthesizeWithLMNT = async (text, options = {}) => {
      console.log("🔊 ==================== TTS SYNTHESIS START ====================")
      console.log("🔊 TTS: Starting synthesis for text:", text.substring(0, 100) + "...")
      console.log("🔊 TTS: API Key present:", !!lmntApiKey)
      console.log("🔊 TTS: API Key preview:", lmntApiKey ? lmntApiKey.substring(0, 12) + "..." : "MISSING")

      if (!lmntApiKey) {
        const error = "TTS API key not configured in environment variables"
        console.error("❌ TTS:", error)
        throw new Error(error)
      }

      const synthesisOptions = {
        voice: options.voice || "lily",
        language: options.language || "en",
        speed: options.speed || 1.0,
        format: "wav",
        sample_rate: 8000,
      }

      console.log("🔊 TTS: Final synthesis options:", JSON.stringify(synthesisOptions, null, 2))

      // Try multiple LMNT API approaches
      const apiAttempts = [
        {
          name: "LMNT v1/ai/speech (JSON)",
          url: "https://api.lmnt.com/v1/ai/speech",
          method: "json",
        },
        {
          name: "LMNT v1/ai/speech (FormData)",
          url: "https://api.lmnt.com/v1/ai/speech",
          method: "form",
        },
      ]

      for (const attempt of apiAttempts) {
        try {
          console.log(`🔊 TTS: Trying ${attempt.name}...`)

          const requestOptions = {
            method: "POST",
            headers: {
              "X-API-Key": lmntApiKey,
            },
          }

          if (attempt.method === "json") {
            requestOptions.headers["Content-Type"] = "application/json"
            requestOptions.body = JSON.stringify({
              text: text,
              voice: synthesisOptions.voice,
              format: synthesisOptions.format,
              language: synthesisOptions.language,
              sample_rate: synthesisOptions.sample_rate,
              speed: synthesisOptions.speed,
            })
          } else if (attempt.method === "form") {
            const form = new FormData()
            form.append("text", text)
            form.append("voice", synthesisOptions.voice)
            form.append("format", synthesisOptions.format)
            form.append("language", synthesisOptions.language)
            form.append("sample_rate", synthesisOptions.sample_rate.toString())
            form.append("speed", synthesisOptions.speed.toString())

            requestOptions.headers = {
              ...requestOptions.headers,
              ...form.getHeaders(),
            }
            requestOptions.body = form
          }

          console.log(`🔊 TTS: Making ${attempt.method.toUpperCase()} request to:`, attempt.url)

          const response = await fetch(attempt.url, requestOptions)

          console.log(`🔊 TTS: Response status:`, response.status)

          if (!response.ok) {
            const errorText = await response.text()
            console.error(`❌ TTS: ${attempt.name} failed with status ${response.status}:`, errorText)
            continue // Try next approach
          }

          const contentType = response.headers.get("content-type")
          console.log(`🔊 TTS: Response content-type:`, contentType)

          if (contentType && contentType.includes("application/json")) {
            // Handle JSON response
            const jsonResponse = await response.json()
            console.log(`🔊 TTS: JSON response:`, JSON.stringify(jsonResponse, null, 2))

            if (jsonResponse.audio_url) {
              console.log(`🔊 TTS: Fetching audio from URL:`, jsonResponse.audio_url)
              const audioResponse = await fetch(jsonResponse.audio_url)
              if (!audioResponse.ok) {
                throw new Error(`Failed to fetch audio from URL: ${audioResponse.status}`)
              }
              const audioBuffer = await audioResponse.arrayBuffer()
              console.log(`✅ TTS: Downloaded audio buffer, size:`, audioBuffer.byteLength, "bytes")
              return Buffer.from(audioBuffer)
            } else if (jsonResponse.audio) {
              // Direct audio data in JSON
              console.log(`🔊 TTS: Found direct audio data in JSON response`)
              const audioBuffer = Buffer.from(jsonResponse.audio, "base64")
              console.log(`✅ TTS: Decoded audio buffer, size:`, audioBuffer.length, "bytes")
              return audioBuffer
            } else {
              throw new Error("Unexpected JSON response format: " + JSON.stringify(jsonResponse))
            }
          } else {
            // Handle binary audio response
            const audioBuffer = await response.arrayBuffer()
            console.log(`✅ TTS: Received binary audio buffer, size:`, audioBuffer.byteLength, "bytes")

            if (audioBuffer.byteLength === 0) {
              throw new Error("TTS returned empty audio buffer")
            }

            console.log(`✅ TTS: Successfully got audio from ${attempt.name}`)
            return Buffer.from(audioBuffer)
          }
        } catch (error) {
          console.error(`❌ TTS: ${attempt.name} failed:`, error.message)

          // If this is the last attempt, throw the error
          if (attempt === apiAttempts[apiAttempts.length - 1]) {
            throw error
          }

          continue // Try next approach
        }
      }

      throw new Error("All TTS API attempts failed")
    }

    // Enhanced synthesis wrapper with comprehensive error handling
    const synthesizeWithErrorHandling = async (text, options = {}) => {
      console.log("🔊 ==================== SYNTHESIS WRAPPER START ====================")

      try {
        // Send immediate acknowledgment to client
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "synthesis_started",
              text: text.substring(0, 50) + "...",
              status: "processing",
            }),
          )
        }

        const result = await synthesizeWithLMNT(text, options)

        console.log("✅ Synthesis wrapper: Success, audio size:", result.length)
        return result
      } catch (error) {
        console.error("❌ ==================== SYNTHESIS WRAPPER ERROR ====================")
        console.error("❌ Synthesis wrapper error:", error.message)
        console.error("❌ Full error:", error)
        console.error("❌ Stack:", error.stack)

        // Send error to client
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "synthesis_error",
              error: error.message,
              details: error.stack,
            }),
          )
        }

        throw error
      }
    }

    // Convert browser audio to PCM format
    const convertToPCM = async (audioBuffer) => {
      try {
        // Browser audio is typically already in the right format
        // Just ensure it's a proper buffer
        return audioBuffer instanceof Buffer ? audioBuffer : Buffer.from(audioBuffer)
      } catch (error) {
        console.error("❌ Error converting audio to PCM:", error)
        return audioBuffer
      }
    }

    // Create WAV header for audio data
    const createWAVHeader = (audioBuffer, sampleRate = 8000, channels = 1, bitsPerSample = 16) => {
      const byteRate = (sampleRate * channels * bitsPerSample) / 8
      const blockAlign = (channels * bitsPerSample) / 8
      const dataSize = audioBuffer.length
      const fileSize = 36 + dataSize

      const header = Buffer.alloc(44)
      let offset = 0

      // RIFF header
      header.write("RIFF", offset)
      offset += 4
      header.writeUInt32LE(fileSize, offset)
      offset += 4
      header.write("WAVE", offset)
      offset += 4

      // fmt chunk
      header.write("fmt ", offset)
      offset += 4
      header.writeUInt32LE(16, offset)
      offset += 4
      header.writeUInt16LE(1, offset)
      offset += 2 // audio format (PCM)
      header.writeUInt16LE(channels, offset)
      offset += 2
      header.writeUInt32LE(sampleRate, offset)
      offset += 4
      header.writeUInt32LE(byteRate, offset)
      offset += 4
      header.writeUInt16LE(blockAlign, offset)
      offset += 2
      header.writeUInt16LE(bitsPerSample, offset)
      offset += 2

      // data chunk
      header.write("data", offset)
      offset += 4
      header.writeUInt32LE(dataSize, offset)

      return Buffer.concat([header, audioBuffer])
    }

    // Generate session ID
    const generateSessionId = () => {
      return "session_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9)
    }

    // Handle incoming messages
    ws.on("message", async (message) => {
      try {
        console.log("📨 ==================== MESSAGE RECEIVED ====================")
        console.log("📨 Received message, type:", typeof message, "length:", message.length)

        // Check if message is binary (audio data) or text (JSON commands)
        let isTextMessage = false
        let data = null

        if (typeof message === "string") {
          // Definitely a text message
          isTextMessage = true
          try {
            data = JSON.parse(message)
          } catch (parseError) {
            console.error("❌ Failed to parse string message as JSON:", parseError)
            return
          }
        } else if (message instanceof Buffer) {
          // Could be text or binary - try to parse as JSON first
          try {
            const messageStr = message.toString("utf8")

            // Check if it looks like JSON
            if (messageStr.trim().startsWith("{") && messageStr.trim().endsWith("}")) {
              data = JSON.parse(messageStr)
              isTextMessage = true
              console.log("✅ Successfully parsed buffer as JSON text message")
            } else {
              // Doesn't look like JSON, treat as binary audio
              isTextMessage = false
              console.log("🎵 Buffer doesn't look like JSON, treating as binary audio data")
            }
          } catch (parseError) {
            // Failed to parse as JSON, treat as binary audio data
            isTextMessage = false
            console.log("🎵 Failed to parse buffer as JSON, treating as binary audio data")
          }
        }

        if (isTextMessage && data) {
          console.log("📝 Processing text message")
          console.log("📝 Parsed JSON data:", JSON.stringify(data, null, 2))
          if (data.type === "start" && data.uuid) {
            console.log("🚀 Processing START command")
            // Handle session start
            sessionId = data.uuid
            audioChunkCount = 0
            console.log("✅ Session started with ID:", sessionId)
    
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "session_started",
                  session_id: sessionId,
                  language: language,
                }),
              )
            }
    
            // Send greeting after session start (with a small delay to ensure client is ready)
            setTimeout(() => {
              sendGreeting()
            }, 1000)
    
          } else if (data.type === "synthesize") {
            console.log("🔊 ==================== PROCESSING SYNTHESIZE COMMAND ====================")
            console.log("🔊 Synthesis text:", data.text)
    
            try {
              const synthesisOptions = {
                voice: data.voice || "lily",
                language: data.language || language,
                speed: data.speed || 1.0,
              }
    
              const audioData = await synthesizeWithErrorHandling(data.text, synthesisOptions)
    
              if (!audioData || audioData.length === 0) {
                throw new Error("Received empty audio data from TTS")
              }
    
              console.log("✅ TTS: Successfully received audio data, size:", audioData.length, "bytes")
    
              // Convert audio to the required format with raw bytes
              const audioBuffer = Buffer.from(audioData)
              const audioWithHeader = createWAVHeader(audioBuffer, 8000, 1, 16)
              const pythonBytesString = bufferToPythonBytesString(audioWithHeader)
    
              // Increment chunk count
              audioChunkCount++
    
              // Send audio in the required format with raw bytes
              const audioResponse = {
                data: {
                  session_id: sessionId || generateSessionId(),
                  count: audioChunkCount,
                  audio_bytes_to_play: pythonBytesString,
                  sample_rate: 8000,
                  channels: 1,
                  sample_width: 2,
                },
              }
    
              console.log("✅ ==================== SENDING AUDIO RESPONSE ====================")
              console.log("✅ Sending audio response with session_id:", audioResponse.data.session_id)
              console.log("✅ Count:", audioResponse.data.count)
              console.log("✅ Audio bytes preview:", pythonBytesString.substring(0, 100) + "...")
    
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(audioResponse))
                console.log("✅ Audio sent in JSON format successfully")
              } else {
                console.error("❌ WebSocket not open, cannot send audio response")
              }
            } catch (error) {
              console.error("❌ ==================== SYNTHESIS ERROR ====================")
              console.error("❌ Synthesis error:", error.message)
    
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "error",
                    error: `Speech synthesis failed: ${error.message}`,
                  }),
                )
              }
            }
          }
        } else {
          console.log("🎵 Processing binary message (audio data), size:", message.length)
    
          // This is audio data for transcription
          console.log("🎙️ Received audio data for transcription, size:", message.length)
    
          // Initialize Deepgram if not already connected
          if (!deepgramConnected) {
            console.log("🎙️ Initializing STT connection...")
            try {
              await connectToDeepgram({
                language: language,
                model: "nova-2",
                punctuate: true,
                diarize: false,
                tier: "enhanced",
              })
              console.log("✅ STT connection established")
            } catch (error) {
              console.error("❌ Failed to connect to STT:", error)
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "error",
                    error: "Failed to initialize transcription service: " + error.message,
                  }),
                )
              }
              return
            }
          }
    
          // Convert browser audio to PCM format
          const pcmAudio = await convertToPCM(message)
    
          // Queue the audio data instead of sending immediately
          queueAudioData(pcmAudio)
        }
      } catch (error) {
        console.error("❌ ==================== MESSAGE PROCESSING ERROR ====================")
        console.error("❌ Error processing message:", error.message)
        console.error("❌ Full error:", error)
    
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "error",
              error: error.message,
            }),
          )
        }
      }
    })
    
    // Handle connection close
    ws.on("close", () => {
      console.log("🔗 Unified voice connection closed")
    
      // Clean up Deepgram connection
      closeDeepgram()
    
      // Reset state
      sessionId = null
      audioChunkCount = 0
      audioBuffer = []
      audioQueue = []
      deepgramReady = false
      deepgramConnected = false
      isProcessingQueue = false
      connectionGreetingSent = false
    })
    
    // Handle connection errors
    ws.on("error", (error) => {
      console.error("❌ WebSocket error:", error)
    })
    
    // Send connection confirmation
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "connected",
          language: language,
          services: ["transcription", "synthesis"],
          lmnt_configured: !!lmntApiKey,
          rate_limiting: {
            min_send_interval: MIN_SEND_INTERVAL,
            max_queue_size: MAX_QUEUE_SIZE,
          },
        }),
      )
    
      // Send greeting after a short delay to ensure client is ready
      setTimeout(() => {
        sendGreeting()
      }, 1500)
    }
  })
}

module.exports = { setupUnifiedVoiceServer }