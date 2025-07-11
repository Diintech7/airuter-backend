const WebSocket = require("ws")
const FormData = require("form-data")
const fs = require("fs")
const path = require("path")

// Use native fetch (Node.js 18+) or fallback
const fetch = globalThis.fetch || require("node-fetch")

if (!fetch) {
  console.error("❌ Fetch not available. Please use Node.js 18+ or install node-fetch@2")
  process.exit(1)
}

const setupUnifiedVoiceServer = (wss) => {
  console.log("🚀 Unified Voice WebSocket server initialized for SIP Integration")

  // Create audio storage directory
  const audioDir = path.join(__dirname, "audio_storage")
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true })
  }

  wss.on("connection", (ws, req) => {
    console.log("🔗 New SIP voice connection established")
    console.log("📡 SIP Connection Details:", {
      timestamp: new Date().toISOString(),
      clientIP: req.socket.remoteAddress,
      userAgent: req.headers["user-agent"],
      origin: req.headers.origin,
    })

    // SIP Session State
    let sessionId = null
    let source = null
    let destination = null
    let audioChunkCount = 0
    let sessionStarted = false

    // Speech Processing State
    let deepgramWs = null
    let deepgramReady = false
    let deepgramConnected = false
    let accumulatedTranscripts = []
    let emptyAudioCount = 0
    let isProcessingResponse = false

    // Audio Storage
    let audioFileList = []
    let audioFileCounter = 0
    let audioPlaybackInterval = null

    // TTS Configuration
    const lmntApiKey = process.env.LMNT_API_KEY

    // Extract language from URL parameters
    const url = new URL(req.url, "http://localhost")
    const language = url.searchParams.get("language") || "en"

    console.log(`🌐 SIP Connection established with language: ${language}`)
    console.log(`🔑 TTS API Key configured: ${lmntApiKey ? "Yes" : "❌ NO"}`)

    // Enhanced SIP data logging
    const logSipData = (data, type = "UNKNOWN") => {
      const timestamp = new Date().toISOString()
      console.log("=".repeat(60))
      console.log(`📞 SIP DATA RECEIVED - ${timestamp}`)
      console.log(`🔍 Type: ${type}`)
      console.log(`📊 Size: ${typeof data === "string" ? data.length : data.byteLength || "unknown"} bytes`)

      if (typeof data === "string") {
        console.log(`📝 Content: ${data.substring(0, 200)}${data.length > 200 ? "..." : ""}`)
      }

      console.log(`🆔 Session: ${sessionId || "Not set"}`)
      console.log("=".repeat(60))
    }

    // Get greeting message based on language
    const getGreetingMessage = (lang) => {
      const greetings = {
        hi: "नमस्ते! मैं आपकी सहायता के लिए यहाँ हूँ। आप मुझसे कुछ भी पूछ सकते हैं।",
        en: "Hello! How can I help you today? Feel free to ask me anything.",
        es: "¡Hola! ¿Cómo puedo ayudarte hoy?",
        fr: "Bonjour! Comment puis-je vous aider aujourd'hui?",
      }
      return greetings[lang] || greetings["en"]
    }

    // Convert buffer to Python-like bytes string
    const bufferToPythonBytesString = (buffer) => {
      let result = "b'"
      for (let i = 0; i < buffer.length; i++) {
        const byte = buffer[i]
        if (byte >= 32 && byte <= 126 && byte !== 92 && byte !== 39) {
          result += String.fromCharCode(byte)
        } else {
          result += "\\x" + byte.toString(16).padStart(2, "0")
        }
      }
      result += "'"
      return result
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
      offset += 2 // PCM
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

    // Save audio file to storage
    const saveAudioFile = (audioData) => {
      try {
        const timestamp = Date.now()
        const filename = `audio_${sessionId}_${timestamp}.wav`
        const filepath = path.join(audioDir, filename)

        // Create WAV file with header
        const audioWithHeader = createWAVHeader(audioData, 8000, 1, 16)
        fs.writeFileSync(filepath, audioWithHeader)

        audioFileList.push({
          filename: filename,
          filepath: filepath,
          timestamp: timestamp,
          size: audioData.length,
        })

        console.log(`💾 Audio file saved: ${filename} (${audioData.length} bytes)`)
        console.log(`📁 Total audio files: ${audioFileList.length}`)

        return filepath
      } catch (error) {
        console.log("❌ Error saving audio file:", error.message)
        return null
      }
    }

    // LMNT TTS synthesis
    const synthesizeWithLMNT = async (text, options = {}) => {
      console.log("🔊 TTS: Synthesizing text:", text.substring(0, 100) + "...")

      if (!lmntApiKey) {
        throw new Error("TTS API key not configured")
      }

      const synthesisOptions = {
        voice: options.voice || "lily",
        format: "wav",
        sample_rate: 8000,
        speed: options.speed || 1.0,
      }

      const requestOptions = {
        method: "POST",
        headers: {
          "X-API-Key": lmntApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: text,
          voice: synthesisOptions.voice,
          format: synthesisOptions.format,
          sample_rate: synthesisOptions.sample_rate,
          speed: synthesisOptions.speed,
        }),
      }

      const response = await fetch("https://api.lmnt.com/v1/ai/speech", requestOptions)

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`TTS API error: ${response.status} - ${errorText}`)
      }

      const audioBuffer = await response.arrayBuffer()
      console.log(`✅ TTS: Audio generated, size: ${audioBuffer.byteLength} bytes`)
      return Buffer.from(audioBuffer)
    }

    // Send audio to SIP in the required format
    const sendAudioToSIP = async (audioData, isGreeting = false) => {
      try {
        audioChunkCount++

        const audioBuffer = Buffer.from(audioData)
        const audioWithHeader = createWAVHeader(audioBuffer, 8000, 1, 16)
        const pythonBytesString = bufferToPythonBytesString(audioWithHeader)

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

        console.log(`📤 Sending ${isGreeting ? "GREETING" : "RESPONSE"} audio to SIP:`)
        console.log(`   Session ID: ${sessionId}`)
        console.log(`   Count: ${audioChunkCount}`)
        console.log(`   Audio size: ${audioBuffer.length} bytes`)

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(audioResponse))
          console.log(`✅ ${isGreeting ? "Greeting" : "Response"} audio sent successfully!`)
          return true
        } else {
          console.log("❌ WebSocket not open, cannot send audio")
          return false
        }
      } catch (error) {
        console.log("❌ Failed to send audio to SIP:", error.message)
        return false
      }
    }

    // Send initial greeting when session starts
    const sendInitialGreeting = async () => {
      if (!sessionStarted || !lmntApiKey) {
        console.log("⚠️ Cannot send greeting: session not started or TTS not configured")
        return
      }

      try {
        const greetingText = getGreetingMessage(language)
        console.log("👋 Generating initial greeting:", greetingText)

        const audioData = await synthesizeWithLMNT(greetingText, { voice: "lily", speed: 1.0 })
        const success = await sendAudioToSIP(audioData, true)

        if (success) {
          console.log("✅ Initial greeting sent successfully!")
        } else {
          console.log("❌ Failed to send initial greeting")
        }
      } catch (error) {
        console.log("❌ Failed to generate/send initial greeting:", error.message)
      }
    }

    // Start audio playback cycle (every 5 seconds)
    const startAudioPlaybackCycle = () => {
      if (audioPlaybackInterval) {
        clearInterval(audioPlaybackInterval)
      }

      audioPlaybackInterval = setInterval(async () => {
        if (!sessionStarted || audioFileList.length === 0) {
          return
        }

        try {
          // Get next audio file in rotation
          const audioFile = audioFileList[audioFileCounter % audioFileList.length]
          audioFileCounter++

          console.log(`🔄 Playing audio file ${audioFileCounter}: ${audioFile.filename}`)

          // Read the audio file
          const audioData = fs.readFileSync(audioFile.filepath)

          // Remove WAV header (44 bytes) to get raw audio data
          const rawAudioData = audioData.slice(44)

          // Send to SIP
          const success = await sendAudioToSIP(rawAudioData, false)

          if (success) {
            console.log(`✅ Audio file ${audioFile.filename} sent successfully`)
          } else {
            console.log(`❌ Failed to send audio file ${audioFile.filename}`)
          }
        } catch (error) {
          console.log("❌ Error in audio playback cycle:", error.message)
        }
      }, 5000) // Every 5 seconds

      console.log("🔄 Audio playback cycle started (every 5 seconds)")
    }

    // Connect to Deepgram for STT
    const connectToDeepgram = async () => {
      return new Promise((resolve, reject) => {
        try {
          console.log("🎙️ Connecting to Deepgram STT...")

          if (!process.env.DEEPGRAM_API_KEY) {
            reject(new Error("Deepgram API key not configured"))
            return
          }

          const deepgramUrl = new URL("wss://api.deepgram.com/v1/listen")
          deepgramUrl.searchParams.append("sample_rate", "8000")
          deepgramUrl.searchParams.append("channels", "1")
          deepgramUrl.searchParams.append("interim_results", "false")
          deepgramUrl.searchParams.append("language", language)
          deepgramUrl.searchParams.append("model", "nova-2")
          deepgramUrl.searchParams.append("smart_format", "true")
          deepgramUrl.searchParams.append("punctuate", "true")

          deepgramWs = new WebSocket(deepgramUrl.toString(), ["token", process.env.DEEPGRAM_API_KEY])

          const connectionTimeout = setTimeout(() => {
            if (deepgramWs) deepgramWs.close()
            reject(new Error("Deepgram connection timeout"))
          }, 15000)

          deepgramWs.onopen = () => {
            clearTimeout(connectionTimeout)
            deepgramReady = true
            deepgramConnected = true
            console.log("✅ Deepgram STT connection established")
            resolve()
          }

          deepgramWs.onmessage = (event) => {
            try {
              const data = JSON.parse(event.data)

              if (data.type === "Results" && data.channel?.alternatives?.[0]?.transcript) {
                const transcript = data.channel.alternatives[0].transcript.trim()
                const is_final = data.is_final

                if (transcript && is_final) {
                  console.log("🗣️ TRANSCRIPT:", transcript)
                  accumulatedTranscripts.push(transcript)
                  console.log("📝 ACCUMULATED TRANSCRIPTS:", accumulatedTranscripts)
                  console.log("📊 Total transcripts:", accumulatedTranscripts.length)

                  // Reset empty audio count when we get text
                  emptyAudioCount = 0
                }
              }
            } catch (parseError) {
              console.log("❌ Error parsing STT response:", parseError.message)
            }
          }

          deepgramWs.onerror = (error) => {
            clearTimeout(connectionTimeout)
            deepgramReady = false
            deepgramConnected = false
            console.log("❌ Deepgram error:", error.message)
            reject(error)
          }

          deepgramWs.onclose = (event) => {
            clearTimeout(connectionTimeout)
            deepgramReady = false
            deepgramConnected = false
            console.log(`🎙️ Deepgram connection closed: ${event.code} - ${event.reason}`)

            // Auto-reconnect after 2 seconds
            setTimeout(() => {
              console.log("🔄 Attempting to reconnect to Deepgram...")
              connectToDeepgram().catch((err) => {
                console.log("❌ Deepgram reconnection failed:", err.message)
              })
            }, 2000)
          }
        } catch (error) {
          reject(error)
        }
      })
    }

    // Check if audio is empty/silent
    const isAudioEmpty = (audioData) => {
      const buffer = audioData instanceof Buffer ? audioData : Buffer.from(audioData)

      // Check if buffer is too small
      if (buffer.length < 100) return true

      // Calculate RMS (Root Mean Square) to detect silence
      let sum = 0
      for (let i = 0; i < buffer.length; i++) {
        const sample = buffer[i] - 128 // Convert to signed
        sum += sample * sample
      }
      const rms = Math.sqrt(sum / buffer.length)

      // Consider audio empty if RMS is below threshold
      const silenceThreshold = 5
      return rms < silenceThreshold
    }

    // Process audio data
    const processAudioData = async (audioData) => {
      if (!sessionStarted) {
        console.log("⚠️ Session not started, ignoring audio data")
        return
      }

      try {
        // Save all incoming audio files
        saveAudioFile(audioData)

        const isEmpty = isAudioEmpty(audioData)

        if (isEmpty) {
          emptyAudioCount++
          console.log(`🔇 Empty audio detected (${emptyAudioCount}/20)`)

          // After 20 empty audio chunks, process accumulated transcripts
          if (emptyAudioCount >= 20 && accumulatedTranscripts.length > 0 && !isProcessingResponse) {
            console.log("🔄 Processing accumulated transcripts after 20 empty audio chunks")
            await processAccumulatedTranscripts()
          }
        } else {
          // Send audio to Deepgram for transcription if connected
          if (deepgramReady && deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
            console.log(`🎵 Sending audio to Deepgram: ${audioData.length} bytes`)
            deepgramWs.send(audioData)
          } else {
            console.log("⚠️ Deepgram not ready, audio saved but not transcribed")
          }
        }
      } catch (error) {
        console.log("❌ Error processing audio:", error.message)
      }
    }

    // Process accumulated transcripts and convert to speech
    const processAccumulatedTranscripts = async () => {
      if (accumulatedTranscripts.length === 0 || isProcessingResponse) return

      isProcessingResponse = true
      const allTranscripts = accumulatedTranscripts.join(" ")

      console.log("🔄 Converting accumulated transcripts to speech:", allTranscripts)

      try {
        // Generate AI response
        const responseText = `I heard you say: ${allTranscripts}. Thank you for sharing that with me. How can I help you further?`

        // Convert to audio
        const audioData = await synthesizeWithLMNT(responseText, { voice: "lily", speed: 1.0 })

        // Send audio back to SIP
        await sendAudioToSIP(audioData, false)

        // Reset state
        accumulatedTranscripts = []
        emptyAudioCount = 0

        console.log("✅ Transcripts processed and audio response sent")
        console.log("🔄 Ready for next conversation cycle")
      } catch (error) {
        console.log("❌ Failed to process accumulated transcripts:", error.message)
      } finally {
        isProcessingResponse = false
      }
    }

    // Handle incoming messages
    ws.on("message", async (message) => {
      try {
        logSipData(message, "INCOMING_MESSAGE")

        // Check if message is JSON (SIP control data) or binary (audio data)
        let isJsonMessage = false
        let data = null

        if (typeof message === "string") {
          isJsonMessage = true
          try {
            data = JSON.parse(message)
          } catch (parseError) {
            console.log("❌ Failed to parse JSON:", parseError.message)
            return
          }
        } else if (message instanceof Buffer) {
          // Try to parse as JSON first
          try {
            const messageStr = message.toString("utf8")
            if (messageStr.trim().startsWith("{") && messageStr.trim().endsWith("}")) {
              data = JSON.parse(messageStr)
              isJsonMessage = true
            }
          } catch (parseError) {
            // Not JSON, treat as audio data
            isJsonMessage = false
          }
        }

        if (isJsonMessage && data) {
          console.log("📋 Processing SIP JSON message:", JSON.stringify(data, null, 2))

          // Handle SIP start event - FIXED: Check for both uuid and session_id
          if (data.event === "start" && (data.uuid || data.session_id)) {
            sessionId = data.uuid || data.session_id
            source = data.Source
            destination = data.Destination
            sessionStarted = true
            audioChunkCount = 0
            accumulatedTranscripts = []
            emptyAudioCount = 0
            audioFileList = []
            audioFileCounter = 0

            console.log("✅ SIP SESSION STARTED:")
            console.log(`   Session ID: ${sessionId}`)
            console.log(`   Source: ${source}`)
            console.log(`   Destination: ${destination}`)

            // Initialize Deepgram connection
            try {
              await connectToDeepgram()
              console.log("✅ Deepgram initialized for session")
            } catch (error) {
              console.log("❌ Failed to initialize Deepgram:", error.message)
            }

            // Send initial greeting immediately
            setTimeout(async () => {
              await sendInitialGreeting()
              // Start audio playback cycle after greeting
              setTimeout(() => {
                startAudioPlaybackCycle()
              }, 2000)
            }, 500)

            // Send session started confirmation
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "session_started",
                  session_id: sessionId,
                  message: "SIP session initialized successfully",
                }),
              )
            }
          }
          // Handle play completion event
          else if (data.session_id && data.played === "true") {
            console.log("🔊 Audio playback completed for session:", data.session_id)
          }
          // Handle other SIP events
          else {
            console.log("❓ Unknown SIP event:", data)
          }
        } else {
          // Handle audio data - Process immediately if session is started
          if (sessionStarted && sessionId) {
            console.log("🎵 Processing audio data for session:", sessionId)
            await processAudioData(message)
          } else {
            console.log("⚠️ Received audio data but session not started")
          }
        }
      } catch (error) {
        console.log("❌ Error processing message:", error.message)
        console.log("❌ Stack:", error.stack)
      }
    })

    // Handle connection close
    ws.on("close", () => {
      console.log("🔗 SIP connection closed")
      console.log("📊 Session statistics:")
      console.log(`   Session ID: ${sessionId || "Not set"}`)
      console.log(`   Audio chunks sent: ${audioChunkCount}`)
      console.log(`   Audio files saved: ${audioFileList.length}`)
      console.log(`   Accumulated transcripts: ${accumulatedTranscripts.length}`)

      // Clean up intervals
      if (audioPlaybackInterval) {
        clearInterval(audioPlaybackInterval)
        audioPlaybackInterval = null
      }

      // Clean up Deepgram connection
      if (deepgramWs) {
        deepgramWs.close()
        deepgramWs = null
      }

      // Reset state
      sessionId = null
      sessionStarted = false
      audioChunkCount = 0
      accumulatedTranscripts = []
      emptyAudioCount = 0
      deepgramReady = false
      deepgramConnected = false
      isProcessingResponse = false
      audioFileList = []
      audioFileCounter = 0
    })

    // Handle connection errors
    ws.on("error", (error) => {
      console.log("❌ SIP WebSocket error:", error.message)
    })

    console.log("✅ SIP WebSocket connection ready and waiting for start event")
  })
}

module.exports = { setupUnifiedVoiceServer }
