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
    console.log("📡 SIP Connection Details:", {
      timestamp: new Date().toISOString(),
      clientIP: req.socket.remoteAddress,
      userAgent: req.headers["user-agent"],
      origin: req.headers.origin,
    })

    // Deepgram client state
    let deepgramWs = null
    let deepgramReady = false
    let audioBuffer = [] // Buffer for audio before Deepgram is connected
    let deepgramConnected = false

    // Rate limiting state for Deepgram
    let audioQueue = []
    let isProcessingQueue = false
    let lastSentTime = 0
    const MIN_SEND_INTERVAL = 250 // Minimum 250ms between sends to Deepgram
    const MAX_QUEUE_SIZE = 50 // Maximum queued audio chunks
    const MAX_BUFFER_SIZE = 100 // Maximum buffered audio chunks before Deepgram connects
    let reconnectAttempts = 0
    const MAX_RECONNECT_ATTEMPTS = 5
    let reconnectDelay = 1000 // Start with 1 second

    // LMNT client state
    const lmntApiKey = process.env.LMNT_API_KEY

    // Session state
    let sessionId = null
    let audioChunkCount = 0
    let connectionGreetingSent = false
    let sipDataReceived = 0

    // Voicebot conversation state
    let currentTranscript = ""
    let emptyAudioCount = 0
    const SILENCE_THRESHOLD = 10 // Number of consecutive empty/non-final Deepgram results to trigger TTS
    let isSpeaking = false // Flag to track if user is actively speaking

    // Extract language from URL parameters
    const url = new URL(req.url, "http://localhost")
    const language = url.searchParams.get("language") || "en"

    console.log(`🌐 Connection established with language: ${language}`)
    console.log(`🔑 TTS API Key configured: ${lmntApiKey ? "Yes (" + lmntApiKey.substring(0, 8) + "...)" : "❌ NO"}`)

    // Enhanced SIP data logging function
    const logSipData = (data, type = "UNKNOWN") => {
      const timestamp = new Date().toISOString()
      sipDataReceived++

      console.log("=".repeat(80))
      console.log(`📞 SIP TEAM DATA RECEIVED [${sipDataReceived}] - ${timestamp}`)
      console.log("=".repeat(80))
      console.log(`🔍 Data Type: ${type}`)
      console.log(`📊 Data Size: ${typeof data === "string" ? data.length : data.byteLength || "unknown"} bytes`)

      if (typeof data === "string") {
        console.log(`📝 Text Content: ${data.substring(0, 200)}${data.length > 200 ? "..." : ""}`)
      } else if (data instanceof Buffer) {
        console.log(`🎵 Audio Buffer: ${data.length} bytes`)
        console.log(`🎵 Audio Preview: ${data.toString("hex").substring(0, 40)}...`)
      }

      console.log(`🔗 Session ID: ${sessionId || "Not set"}`)
      console.log(`🌍 Language: ${language}`)
      console.log("=".repeat(80))

      // Send real-time notification to client about SIP data
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "sip_data_received",
            timestamp: timestamp,
            dataType: type,
            dataSize: typeof data === "string" ? data.length : data.byteLength || 0,
            sessionId: sessionId,
            count: sipDataReceived,
          }),
        )
      }
    }

    // Default greeting messages based on language
    const getGreetingMessage = (lang) => {
      const greetings = {
        hi: "नमस्ते! हैलो, Aitota से संपर्क करने के लिए धन्यवाद।",
        en: "Hi! Hello, thank you for contacting Aitota.",
        es: "¡Hola! Gracias por contactar con Aitota.",
        fr: "Bonjour ! Merci de contacter Aitota.",
        de: "Hallo! Danke, dass Sie Aitota kontaktiert haben.",
        it: "Ciao! Grazie per aver contattato Aitota.",
        pt: "Olá! Obrigado por entrar em contato com a Aitota.",
        ja: "こんにちは！Aitota にご連絡いただきありがとうございます。",
        ko: "안녕하세요! Aitota에 연락해 주셔서 감사합니다。",
        zh: "你好！感谢您联系 Aitota。",
        ar: "مرحبًا! شكرًا لتواصلك مع Aitota.",
        ru: "Привет! Спасибо, что обратились в Aitota.",
      }

      return greetings[lang] || greetings["en"]
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
          result += "\\x" + byte.toString(16).padStart(2, "0")
        }
      }
      result += "'"
      return result
    }

    // Function to send default greeting
    const sendGreeting = async () => {
      if (connectionGreetingSent || !lmntApiKey || !sessionId) {
        console.log("⚠️ Skipping greeting: already sent, no API key, or no session ID.")
        return
      }

      const greetingText = getGreetingMessage(language)
      console.log("👋 Greeting text:", greetingText)

      try {
        const synthesisOptions = {
          voice: "lily",
          language: language === "en" ? "en" : "hi", // LMNT might not support all languages
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
          type: "greeting",
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
        console.log("❌ Failed to send greeting:", error.message)
        connectionGreetingSent = true // Mark as sent to avoid retrying
        // Do NOT send error to SIP client
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
        console.log("⚠️ Deepgram WebSocket not available")
        return false
      }

      if (deepgramWs.readyState !== WebSocket.OPEN) {
        console.log("⚠️ Deepgram WebSocket not open, state:", deepgramWs.readyState)
        return false
      }

      if (!deepgramReady) {
        console.log("⚠️ Deepgram not ready")
        return false
      }

      try {
        const buffer = audioData instanceof Buffer ? audioData : Buffer.from(audioData)
        console.log(`🎵 Sending ${buffer.length} bytes to Deepgram for transcription.`) // Added log
        deepgramWs.send(buffer)
        return true
      } catch (error) {
        console.log("❌ Error sending audio to Deepgram:", error.message)

        // If it's a rate limiting error, we should back off
        if (error.message.includes("429") || error.message.includes("rate limit")) {
          console.log("⏳ Rate limit detected, backing off...")
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
        // Do NOT send error to SIP client
        return false
      }
    }

    // Queue audio data with overflow protection
    const queueAudioData = (audioData) => {
      // Prevent queue overflow
      if (audioQueue.length >= MAX_QUEUE_SIZE) {
        const removed = audioQueue.shift() // Remove oldest chunk
        console.log(`⚠️ Audio queue overflow, removed oldest chunk (${removed.length} bytes)`)
      }

      audioQueue.push(audioData)
      console.log(`🎵 Audio queued: ${audioData.length} bytes, queue size: ${audioQueue.length}`)

      // Start processing if not already running
      if (!isProcessingQueue) {
        processAudioQueue()
      }
    }

    // Deepgram WebSocket connection function with exponential backoff
    const connectToDeepgram = async (options = {}) => {
      return new Promise((resolve, reject) => {
        try {
          console.log("🎙️ Connecting to Deepgram STT service...")

          if (!process.env.DEEPGRAM_API_KEY) {
            const error = "STT API key not configured"
            console.log("❌", error)
            reject(new Error(error))
            return
          }

          // Build Deepgram WebSocket URL
          const deepgramUrl = new URL("wss://api.deepgram.com/v1/listen")
          // MODIFIED: Changed sample_rate to 8000Hz, common for telephony
          deepgramUrl.searchParams.append("sample_rate", "8000")
          deepgramUrl.searchParams.append("channels", "1")
          deepgramUrl.searchParams.append("interim_results", "true")
          deepgramUrl.searchParams.append("language", options.language || "en")
          deepgramUrl.searchParams.append("model", "nova-2")
          deepgramUrl.searchParams.append("smart_format", "true")
          deepgramUrl.searchParams.append("punctuate", "true")
          deepgramUrl.searchParams.append("diarize", "false")

          console.log(`🎙️ Deepgram URL: ${deepgramUrl.toString()}`) // Added log for Deepgram URL

          deepgramWs = new WebSocket(deepgramUrl.toString(), ["token", process.env.DEEPGRAM_API_KEY])

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
            console.log("✅ Deepgram STT connection established")

            // Process any queued audio
            if (audioQueue.length > 0) {
              console.log(`🎵 Processing ${audioQueue.length} queued audio chunks`)
              processAudioQueue()
            }

            resolve()
          }

          deepgramWs.onmessage = async (event) => {
            try {
              const rawData = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString()

              const data = JSON.parse(rawData)
              console.log("🎙️ Deepgram Raw Message:", JSON.stringify(data, null, 2)) // Detailed log for all Deepgram messages

              // Check for different types of Deepgram responses
              if (data.type === "Results") {
                console.log("🎙️ STT Result received:", data.type)

                if (data.channel?.alternatives?.[0]?.transcript) {
                  const transcript = data.channel.alternatives[0].transcript
                  const confidence = data.channel.alternatives[0].confidence
                  const is_final = data.is_final

                  if (transcript.trim()) {
                    // Speech detected
                    currentTranscript += (currentTranscript ? " " : "") + transcript.trim()
                    emptyAudioCount = 0 // Reset empty count on valid speech
                    isSpeaking = true
                    console.log("📝 Accumulated Transcript:", currentTranscript) // Log accumulated transcript

                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(
                        JSON.stringify({
                          type: "transcript",
                          data: transcript,
                          confidence: confidence,
                          is_final: is_final,
                          language: language,
                          accumulated: currentTranscript, // Send accumulated for debugging/display
                        }),
                      )
                    }
                  } else if (is_final) {
                    // Final result with empty transcript means silence or non-speech
                    emptyAudioCount++
                    console.log(
                      `🔇 Empty final transcript. Empty audio count: ${emptyAudioCount}. Not adding to accumulated transcript.`,
                    )
                    // If silence threshold reached and we were speaking, trigger TTS
                    if (isSpeaking && emptyAudioCount >= SILENCE_THRESHOLD) {
                      console.log(`🔇 Silence detected (${SILENCE_THRESHOLD} empty chunks). Triggering TTS.`)
                      isSpeaking = false // Mark as not speaking to prevent re-trigger
                      await processUserUtterance()
                    }
                  }
                }
              } else if (data.type === "Metadata") {
                console.log("🎙️ STT Metadata:", data)
              } else if (data.type === "SpeechStarted") {
                console.log("🎙️ STT: Speech started detected")
                isSpeaking = true
                emptyAudioCount = 0 // Reset on new speech
              } else if (data.type === "UtteranceEnd") {
                console.log("🎙️ STT: Utterance end detected. Triggering TTS.")
                if (isSpeaking) {
                  // Only trigger if we were actively speaking
                  isSpeaking = false
                  await processUserUtterance()
                } else {
                  console.log("🎙️ STT: Utterance end detected but not actively speaking, ignoring.")
                }
              } else {
                console.log("🎙️ STT: Unknown message type:", data.type)
              }
            } catch (parseError) {
              console.log("❌ Error parsing STT response:", parseError.message)
              // Do NOT send error to SIP client
            }
          }

          deepgramWs.onerror = (error) => {
            clearTimeout(connectionTimeout)
            deepgramReady = false
            deepgramConnected = false
            console.log("❌ Deepgram STT error:", error.message)

            // Check if it's a rate limiting error
            if (error.message && error.message.includes("429")) {
              console.log("⚠️ Rate limit exceeded for STT service")
            }
            // Do NOT send error to SIP client
            reject(error)
          }

          deepgramWs.onclose = (event) => {
            clearTimeout(connectionTimeout)
            deepgramReady = false
            deepgramConnected = false
            console.log(`🎙️ STT connection closed: ${event.code} - ${event.reason}`)

            // Handle rate limiting (429) or other recoverable errors
            if (event.code === 1006 || event.code === 1011 || event.reason.includes("429")) {
              console.log("🔄 Attempting to reconnect to STT service...")

              if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++
                const delay = Math.min(reconnectDelay * Math.pow(2, reconnectAttempts - 1), 30000) // Max 30 seconds
                console.log(`⏳ Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)

                setTimeout(() => {
                  connectToDeepgram(options).catch((err) => {
                    console.log("❌ STT reconnection failed:", err.message)
                    // Do NOT send error to SIP client
                  })
                }, delay)
              } else {
                console.log("❌ Max STT reconnection attempts reached")
                // Do NOT send error to SIP client
              }
            }
          }
        } catch (error) {
          console.log("❌ Error creating Deepgram connection:", error.message)
          // Do NOT send error to SIP client
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
          console.log("⚠️ Error closing STT WebSocket:", error.message)
          // Do NOT send error to SIP client
        }
      }
    }

    // LMNT synthesis function with comprehensive error handling and multiple API approaches
    const synthesizeWithLMNT = async (text, options = {}) => {
      console.log("🔊 TTS: Starting synthesis for text:", text.substring(0, 100) + "...")

      if (!lmntApiKey) {
        const error = "TTS API key not configured in environment variables"
        console.log("❌", error)
        throw new Error(error)
      }

      const synthesisOptions = {
        voice: options.voice || "lily",
        language: options.language || "en",
        speed: options.speed || 1.0,
        format: "wav",
        sample_rate: 8000,
      }

      console.log("🔊 TTS synthesis options:", synthesisOptions)

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
          console.log(`🔊 TTS: Trying ${attempt.name}`)

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

          console.log(`🔊 TTS: Making request to ${attempt.url}`)

          const response = await fetch(attempt.url, requestOptions)

          console.log(`🔊 TTS: Response status: ${response.status}`)

          if (!response.ok) {
            const errorText = await response.text()
            console.log(`❌ TTS: ${attempt.name} failed:`, errorText)
            continue // Try next approach
          }

          const contentType = response.headers.get("content-type")
          console.log(`🔊 TTS: Response content-type: ${contentType}`)

          if (contentType && contentType.includes("application/json")) {
            // Handle JSON response
            const jsonResponse = await response.json()
            console.log("🔊 TTS: Received JSON response")

            if (jsonResponse.audio_url) {
              console.log("🔊 TTS: Fetching audio from URL:", jsonResponse.audio_url)
              const audioResponse = await fetch(jsonResponse.audio_url)
              if (!audioResponse.ok) {
                throw new Error(`Failed to fetch audio from URL: ${audioResponse.status}`)
              }
              const audioBuffer = await audioResponse.arrayBuffer()
              console.log(`✅ TTS: Audio fetched from URL, size: ${audioBuffer.byteLength} bytes`)
              return Buffer.from(audioBuffer)
            } else if (jsonResponse.audio) {
              // Direct audio data in JSON
              const audioBuffer = Buffer.from(jsonResponse.audio, "base64")
              console.log(`✅ TTS: Direct audio from JSON, size: ${audioBuffer.length} bytes`)
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

            console.log(`✅ TTS: Successfully got audio from ${attempt.name}, size: ${audioBuffer.byteLength} bytes`)
            return Buffer.from(audioBuffer)
          }
        } catch (error) {
          console.log(`❌ TTS: ${attempt.name} failed:`, error.message)

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
      console.log("🔊 Starting TTS synthesis process...")

      try {
        // Send immediate acknowledgment to client
        if (ws.readyState === WebSocket.OPEN) {
          console.log("📤 Sending TTS processing notification to client")
        }

        const result = await synthesizeWithLMNT(text, options)

        console.log("✅ Synthesis wrapper: Success, audio size:", result.length)
        return result
      } catch (error) {
        console.log("❌ Synthesis wrapper failed:", error.message)

        // Do NOT send error to client
        throw error
      }
    }

    // Convert browser audio to PCM format (placeholder, as SIP audio should already be PCM)
    const convertToPCM = async (audioBuffer) => {
      try {
        // Assuming incoming SIP audio is already in a suitable PCM format (e.g., 16-bit, 8kHz/16kHz mono)
        const result = audioBuffer instanceof Buffer ? audioBuffer : Buffer.from(audioBuffer)
        console.log(`🎵 Audio converted to PCM: ${result.length} bytes`)
        return result
      } catch (error) {
        console.log("⚠️ PCM conversion warning:", error.message)
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

      console.log(`🎵 WAV header created: ${sampleRate}Hz, ${channels}ch, ${bitsPerSample}bit, ${dataSize} bytes`)
      return Buffer.concat([header, audioBuffer])
    }

    // Generate session ID (fallback if SIP doesn't provide one, but SIP provides it here)
    const generateSessionId = () => {
      const id = "session_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9)
      console.log("🆔 Generated session ID:", id)
      return id
    }

    // Function to process the accumulated user utterance and send a TTS response
    const processUserUtterance = async () => {
      if (currentTranscript.trim()) {
        console.log("🧠 Processing user utterance:", currentTranscript)
        const responseText = `You said: "${currentTranscript}". How can I help you further?` // Example echo response
        try {
          const synthesisOptions = {
            voice: "lily", // Or a dynamic voice based on language
            language: language === "en" ? "en" : "hi",
            speed: 1.0,
          }
          const audioData = await synthesizeWithErrorHandling(responseText, synthesisOptions)

          if (!audioData || audioData.length === 0) {
            throw new Error("Received empty audio data from TTS for response")
          }

          const audioBuffer = Buffer.from(audioData)
          const audioWithHeader = createWAVHeader(audioBuffer, 8000, 1, 16)
          const pythonBytesString = bufferToPythonBytesString(audioWithHeader)

          audioChunkCount++
          const audioResponse = {
            data: {
              session_id: sessionId,
              count: audioChunkCount,
              audio_bytes_to_play: pythonBytesString,
              sample_rate: 8000,
              channels: 1,
              sample_width: 2,
            },
          }

          console.log("📤 Sending synthesized response audio back to SIP client.")
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(audioResponse))
            console.log("✅ Synthesized response audio sent!")
          }
        } catch (error) {
          console.log("❌ Failed to synthesize and send response audio:", error.message)
          // Do NOT send error to SIP client
        }
      } else {
        console.log("🤷 No transcript to process for TTS response.")
      }
      // Reset for next utterance
      currentTranscript = ""
      emptyAudioCount = 0
      isSpeaking = false
      console.log("📝 Transcript and state reset for next utterance.") // Log transcript reset
    }

    // Handle incoming messages
    ws.on("message", async (message) => {
      try {
        console.log("📨 Message received from SIP team")

        // Check if message is binary (audio data) or text (JSON commands)
        let isTextMessage = false
        let data = null

        if (typeof message === "string") {
          // Definitely a text message
          isTextMessage = true
          logSipData(message, "TEXT_MESSAGE")
          try {
            data = JSON.parse(message)
            console.log("📋 Parsed JSON data:", JSON.stringify(data, null, 2))
          } catch (parseError) {
            console.log("❌ Failed to parse JSON:", parseError.message)
            // Do NOT send error to SIP client
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
              logSipData(messageStr, "JSON_BUFFER")
              console.log("📋 Parsed JSON from buffer:", JSON.stringify(data, null, 2))
            } else {
              // Doesn't look like JSON, treat as binary audio
              isTextMessage = false
              logSipData(message, "BINARY_AUDIO")
            }
          } catch (parseError) {
            // Failed to parse as JSON, treat as binary audio data
            isTextMessage = false
            logSipData(message, "BINARY_AUDIO")
          }
        }

        if (isTextMessage && data) {
          console.log("🔄 Processing text/JSON message...")

          if (data.event === "start" && data.session_id) {
            // Handle session start - use SIP-provided session ID
            sessionId = data.session_id
            audioChunkCount = 0
            currentTranscript = "" // Reset transcript for new session
            emptyAudioCount = 0
            isSpeaking = false
            console.log("✅ SIP Call Started with UUID:", sessionId)
            console.log("Source:", data.Source, "Destination:", data.Destination) // Log Source and Destination

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "session_started",
                  session_id: sessionId, // Echo back the SIP session ID
                  language: language,
                  message: "SIP call started, connecting to STT and sending greeting.",
                }),
              )
              console.log("📤 Session started confirmation sent with SIP session ID")
            }

            if (!deepgramConnected) {
              console.log("🎙️ Connecting to Deepgram for STT after SIP start...")
              try {
                await connectToDeepgram({
                  language: language,
                  model: "nova-2",
                  punctuate: true,
                  diarize: false,
                  tier: "enhanced",
                })
                console.log("✅ Deepgram connection established for STT after SIP start.")

                // Process any buffered audio data that arrived before Deepgram connected
                if (audioBuffer.length > 0) {
                  console.log(`🎵 Processing ${audioBuffer.length} buffered audio chunks`)
                  for (const audioData of audioBuffer) {
                    const pcmAudio = await convertToPCM(audioData)
                    queueAudioData(pcmAudio)
                  }
                  audioBuffer = [] // Clear buffer after processing
                }
              } catch (error) {
                console.log("❌ Failed to initialize Deepgram after SIP start:", error.message)
                // Do NOT send error to SIP client
              }
            } else {
              console.log("✅ Deepgram already connected for STT.")
            }

            // Send greeting after a short delay to ensure client is ready and STT is connecting
            setTimeout(() => {
              console.log("👋 Sending initial greeting after SIP start...")
              sendGreeting()
            }, 500) // Reduced delay
          } else if (data.type === "synthesize") {
            console.log("🔊 TTS synthesis request received")
            console.log("📝 Text to synthesize:", data.text)

            // Use SIP-provided session ID if available
            if (data.session_id) {
              sessionId = data.session_id
              console.log("🆔 Using SIP-provided session ID for TTS:", sessionId)
            }

            try {
              const synthesisOptions = {
                voice: data.voice || "lily",
                language: data.language || language,
                speed: data.speed || 1.0,
              }

              console.log("🔊 TTS options:", synthesisOptions)

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
              console.log("📊 Audio chunk count incremented to:", audioChunkCount)

              // Send audio with the exact session ID from SIP team
              const audioResponse = {
                data: {
                  session_id: sessionId, // Use the SIP-provided session ID
                  count: audioChunkCount,
                  audio_bytes_to_play: pythonBytesString,
                  sample_rate: 8000,
                  channels: 1,
                  sample_width: 2,
                },
              }

              console.log("📤 Sending synthesized audio response:")
              console.log("   Session ID (from SIP):", audioResponse.data.session_id)
              console.log("   Count:", audioResponse.data.count)
              console.log("   Audio bytes preview:", pythonBytesString.substring(0, 50) + "...")

              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(audioResponse))
                console.log("✅ Synthesized audio sent with SIP session ID!")
              } else {
                console.log("❌ WebSocket not open, cannot send audio")
              }
            } catch (error) {
              console.log("❌ TTS synthesis failed:", error.message)
              // Do NOT send error to SIP client
            }
          } else if (data.type === "start_stt") {
            console.log("🎙️ STT service start requested (explicitly)")

            // Use the session ID provided by SIP team
            if (data.session_id) {
              sessionId = data.session_id
              console.log("🆔 Using SIP-provided session ID:", sessionId)
            }

            // Initialize Deepgram only when STT is requested
            if (!deepgramConnected) {
              console.log("🎙️ Connecting to Deepgram for STT...")
              try {
                await connectToDeepgram({
                  language: data.language || language,
                  model: "nova-2",
                  punctuate: true,
                  diarize: false,
                  tier: "enhanced",
                })
                console.log("✅ Deepgram connection established for STT")

                // Process any buffered audio data
                if (audioBuffer.length > 0) {
                  console.log(`🎵 Processing ${audioBuffer.length} buffered audio chunks`)
                  for (const audioData of audioBuffer) {
                    const pcmAudio = await convertToPCM(audioData)
                    queueAudioData(pcmAudio)
                  }
                  audioBuffer = [] // Clear buffer after processing
                }

                // Send confirmation
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: "stt_started",
                      session_id: sessionId,
                      message: "Speech-to-text service activated",
                    }),
                  )
                }
              } catch (error) {
                console.log("❌ Failed to initialize Deepgram:", error.message)
                // Do NOT send error to SIP client
              }
            } else {
              console.log("✅ Deepgram already connected")
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "stt_ready",
                    session_id: sessionId,
                    message: "Speech-to-text service already active",
                  }),
                )
              }
            }
          } else if (data.type === "stop_stt") {
            console.log("🎙️ STT service stop requested")
            closeDeepgram()

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "stt_stopped",
                  session_id: sessionId,
                  message: "Speech-to-text service deactivated",
                }),
              )
            }
          } else if (data.session_id && data.played === "true") {
            console.log(`▶️ Play Event received for session_id: ${data.session_id}`)
            // Handle play event if needed, e.g., log or trigger next action
          } else if (data.data && data.data.hangup === "true") {
            console.log(`📞 Hangup request received for session_id: ${data.data.session_id}`)
            ws.close(1000, "Hangup requested by Voicebot")
          } else if (data.data && data.data.stream_stop === "true") {
            console.log(`🛑 Stream stop request received for session_id: ${data.data.session_id}`)
            closeDeepgram() // Stop STT streaming
            // Optionally, close the main WebSocket if stream_stop implies end of call
            // ws.close(1000, "Stream stop requested by Voicebot");
          } else {
            console.log("❓ Unknown message type or missing required fields:", data.type || data.event, data)
          }
        } else {
          console.log("🎵 Audio data received.")
          logSipData(message, "AUDIO_DATA_QUEUED")

          // If Deepgram is ready, queue audio for transcription
          if (deepgramConnected && deepgramReady) {
            const pcmAudio = await convertToPCM(message)
            queueAudioData(pcmAudio)
          } else {
            // If Deepgram not ready, buffer it
            audioBuffer.push(message)

            // Limit buffer size to prevent memory issues
            if (audioBuffer.length > MAX_BUFFER_SIZE) {
              // Use MAX_BUFFER_SIZE here
              audioBuffer.shift() // Remove oldest audio chunk
              console.log(
                `⚠️ Audio buffer overflow, removed oldest chunk (before STT connected). Current size: ${audioBuffer.length}`,
              )
            }
            console.log(`🎵 Audio buffered: ${audioBuffer.length} chunks stored (waiting for STT)`)
          }
        }
      } catch (error) {
        console.log("❌ Error processing message:", error.message)
        console.log("❌ Error stack:", error.stack)

        // Do NOT send error to SIP client
      }
    })

    // Handle connection close
    ws.on("close", () => {
      console.log("🔗 Unified voice connection closed")
      console.log("📊 Session statistics:")
      console.log(`   SIP data received: ${sipDataReceived} messages`)
      console.log(`   Audio chunks processed: ${audioChunkCount}`)
      console.log(`   Session ID: ${sessionId || "Not set"}`)

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
      sipDataReceived = 0
      currentTranscript = ""
      emptyAudioCount = 0
      isSpeaking = false
    })

    // Handle connection errors
    ws.on("error", (error) => {
      console.log("❌ WebSocket connection error:", error.message)
      // Do NOT send error to SIP client
    })

    // No initial greeting on connection, it will be sent after SIP 'start' event
    console.log("✅ WebSocket connection confirmed, waiting for SIP 'start' event.")
  })
}

module.exports = { setupUnifiedVoiceServer }
