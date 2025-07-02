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
    const language = url.searchParams.get("language") || "en"

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
      
      const greetingText = getGreetingMessage(language)
      console.log("👋 Greeting text:", greetingText)

      try {
        // Generate session ID if not exists
        if (!sessionId) {
          sessionId = generateSessionId()
        }

        const synthesisOptions = {
          voice: "lily",
          language: language === 'en' ? 'en' : 'hi', // LMNT might not support all languages
          speed: 1.0,
        }

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
          console.log("❌ WebSocket not open, cannot send greeting")
        }

      } catch (error) {
        console.log("❌ Failed to send greeting:")
        
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
        return false
      }

      if (deepgramWs.readyState !== WebSocket.OPEN) {
        return false
      }

      if (!deepgramReady) {
        return false
      }

      try {
        const buffer = audioData instanceof Buffer ? audioData : Buffer.from(audioData)

        deepgramWs.send(buffer)
        return true
      } catch (error) {

        // If it's a rate limiting error, we should back off
        if (error.message.includes("429") || error.message.includes("rate limit")) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }

        return false
      }
    }

    // Queue audio data with overflow protection
    const queueAudioData = (audioData) => {
      // Prevent queue overflow
      if (audioQueue.length >= MAX_QUEUE_SIZE) {
        audioQueue.shift() // Remove oldest chunk
      }

      audioQueue.push(audioData)

      // Start processing if not already running
      if (!isProcessingQueue) {
        processAudioQueue()
      }
    }

    // Deepgram WebSocket connection function with exponential backoff
    const connectToDeepgram = async (options = {}) => {
      return new Promise((resolve, reject) => {
        try {

          if (!process.env.DEEPGRAM_API_KEY) {
            const error = "STT API key not configured"
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


          deepgramWs.binaryType = "arraybuffer"

          // Add connection timeout with exponential backoff
          const connectionTimeout = setTimeout(() => {
            if (deepgramWs) {
              deepgramWs.close()
            }
            reject(new Error("STT connection timeout"))
          }, 15000)

          deepgramWs.onopen = () => {
            clearTimeout(connectionTimeout)
            deepgramReady = true
            deepgramConnected = true
            reconnectAttempts = 0 // Reset reconnect attempts on successful connection
            reconnectDelay = 1000 // Reset delay

            // Process any queued audio
            if (audioQueue.length > 0) {
              processAudioQueue()
            }

            resolve()
          }

          deepgramWs.onmessage = (event) => {
            try {
              const rawData = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString()

              const data = JSON.parse(rawData)

              // Check for different types of Deepgram responses
              if (data.type === "Results") {

                if (data.channel?.alternatives?.[0]?.transcript) {
                  const transcript = data.channel.alternatives[0].transcript
                  const confidence = data.channel.alternatives[0].confidence
                  const is_final = data.is_final

                  // Enhanced console logging for STT text
                  if (transcript.trim()) {
                   
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
              } else if (data.type === "SpeechStarted") {
               
              } else if (data.type === "UtteranceEnd") {
              } else {
              }
            } catch (parseError) {
            }
          }

          deepgramWs.onerror = (error) => {
            clearTimeout(connectionTimeout)
            deepgramReady = false
            deepgramConnected = false

            // Check if it's a rate limiting error
            if (error.message && error.message.includes("429")) {
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
            deepgramReady = false
            deepgramConnected = false

            // Handle rate limiting (429) or other recoverable errors
            if (event.code === 1006 || event.code === 1011 || event.reason.includes("429")) {

              if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++
                const delay = Math.min(reconnectDelay * Math.pow(2, reconnectAttempts - 1), 30000) // Max 30 seconds

                setTimeout(() => {
                  connectToDeepgram(options).catch((err) => {
                  })
                }, delay)
              } else {
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
        }
      }
    }

    // LMNT synthesis function with comprehensive error handling and multiple API approaches
    const synthesizeWithLMNT = async (text, options = {}) => {
    
      if (!lmntApiKey) {
        const error = "TTS API key not configured in environment variables"
        throw new Error(error)
      }

      const synthesisOptions = {
        voice: options.voice || "lily",
        language: options.language || "en",
        speed: options.speed || 1.0,
        format: "wav",
        sample_rate: 8000,
      }


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


          const response = await fetch(attempt.url, requestOptions)


          if (!response.ok) {
            const errorText = await response.text()
            continue // Try next approach
          }

          const contentType = response.headers.get("content-type")

          if (contentType && contentType.includes("application/json")) {
            // Handle JSON response
            const jsonResponse = await response.json()

            if (jsonResponse.audio_url) {
              const audioResponse = await fetch(jsonResponse.audio_url)
              if (!audioResponse.ok) {
                throw new Error(`Failed to fetch audio from URL: ${audioResponse.status}`)
              }
              const audioBuffer = await audioResponse.arrayBuffer()
              return Buffer.from(audioBuffer)
            } else if (jsonResponse.audio) {
              // Direct audio data in JSON
              const audioBuffer = Buffer.from(jsonResponse.audio, "base64")
              return audioBuffer
            } else {
              throw new Error("Unexpected JSON response format: " + JSON.stringify(jsonResponse))
            }
          } else {
            // Handle binary audio response
            const audioBuffer = await response.arrayBuffer()

            if (audioBuffer.byteLength === 0) {
              throw new Error("TTS returned empty audio buffer")
            }

            console.log(`✅ TTS: Successfully got audio from ${attempt.name}`)
            return Buffer.from(audioBuffer)
          }
        } catch (error) {

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
     
        // Check if message is binary (audio data) or text (JSON commands)
        let isTextMessage = false
        let data = null

        if (typeof message === "string") {
          // Definitely a text message
          isTextMessage = true
          try {
            data = JSON.parse(message)
          } catch (parseError) {
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
            } else {
              // Doesn't look like JSON, treat as binary audio
              isTextMessage = false
            }
          } catch (parseError) {
            // Failed to parse as JSON, treat as binary audio data
            isTextMessage = false
          }
        }

        if (isTextMessage && data) {
        
          if (data.type === "start" && data.uuid) {
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
    
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(audioResponse))
              } else {
              }
            } catch (error) {
    
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
    
          // This is audio data for transcription
    
          // Initialize Deepgram if not already connected
          if (!deepgramConnected) {
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