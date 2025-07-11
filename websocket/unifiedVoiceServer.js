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
    let lastPlayedEvent = null

    // Speech Processing State
    let deepgramWs = null
    let deepgramReady = false
    let deepgramConnected = false
    let accumulatedTranscripts = []
    let emptyAudioCount = 0
    let isProcessingResponse = false

    // Audio Storage and Playback
    let audioFileList = []
    let audioFileCounter = 0
    let audioPlaybackInterval = null
    let greetingSent = false
    let waitingForPlayEvent = false

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
      console.log(`🆔 Session: ${sessionId || "Not set"}`)
      console.log("=".repeat(60))
    }

    // Get greeting message based on language
    const getGreetingMessage = (lang) => {
      const greetings = {
        hi: "नमस्ते! मैं आपकी सहायता के लिए यहाँ हूँ।",
        en: "Hello! How can I help you today?",
        es: "¡Hola! ¿Cómo puedo ayudarte?",
        fr: "Bonjour! Comment puis-je vous aider?",
      }
      return greetings[lang] || greetings["en"]
    }

    // Convert buffer to Python-like bytes string (EXACT format as per PDF)
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

    // Create WAV header for audio data (8kHz, 16-bit, mono as per SIP spec)
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

    // Save audio file to storage (limited to prevent overflow)
    const saveAudioFile = (audioData) => {
      try {
        // Limit audio file storage to prevent overflow
        if (audioFileList.length >= 50) {
          console.log("⚠️ Audio file limit reached, rotating files")
          // Remove oldest file
          const oldestFile = audioFileList.shift()
          try {
            if (fs.existsSync(oldestFile.filepath)) {
              fs.unlinkSync(oldestFile.filepath)
            }
          } catch (err) {
            console.log("⚠️ Could not delete old file:", err.message)
          }
        }

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
          rawData: audioData, // Store raw data for playback
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

    // Send audio to SIP in the EXACT format specified in PDF
    const sendAudioToSIP = async (audioData, isGreeting = false) => {
      try {
        if (!sessionStarted || !sessionId) {
          console.log("❌ Cannot send audio: session not started")
          return false
        }

        // Don't send if we're waiting for a play event
        if (waitingForPlayEvent && !isGreeting) {
          console.log("⏳ Waiting for play event, skipping audio send")
          return false
        }

        audioChunkCount++

        // Ensure audio data is a Buffer
        const audioBuffer = Buffer.isBuffer(audioData) ? audioData : Buffer.from(audioData)

        // Create WAV with proper header
        const audioWithHeader = createWAVHeader(audioBuffer, 8000, 1, 16)

        // Convert to Python bytes string as per SIP protocol (EXACT format from PDF)
        const pythonBytesString = bufferToPythonBytesString(audioWithHeader)

        // Create SIP audio response EXACTLY as specified in PDF
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
        console.log(`   WAV size: ${audioWithHeader.length} bytes`)

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(audioResponse))
          console.log(`✅ ${isGreeting ? "Greeting" : "Response"} audio sent successfully!`)

          // Set waiting flag for play event
          waitingForPlayEvent = true

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
      if (!sessionStarted || !sessionId || greetingSent) {
        console.log("⚠️ Cannot send greeting: session not started or already sent")
        return
      }

      try {
        console.log("👋 Preparing to send initial greeting...")

        if (lmntApiKey) {
          // Generate TTS greeting
          const greetingText = getGreetingMessage(language)
          console.log("🔊 Generating TTS greeting:", greetingText)

          const audioData = await synthesizeWithLMNT(greetingText, { voice: "lily", speed: 1.0 })

          // Remove WAV header from TTS response (first 44 bytes) to get raw PCM data
          const rawAudioData = audioData.slice(44)

          const success = await sendAudioToSIP(rawAudioData, true)

          if (success) {
            greetingSent = true
            console.log("✅ TTS greeting sent successfully!")
          }
        } else {
          // Send a basic audio greeting (silence)
          console.log("🔊 Sending basic audio greeting (no TTS available)")

          // Generate 1 second of silence at 8kHz, 16-bit
          const sampleRate = 8000
          const duration = 1 // 1 second
          const bytesPerSample = 2 // 16-bit
          const silenceBuffer = Buffer.alloc(sampleRate * duration * bytesPerSample, 0)

          const success = await sendAudioToSIP(silenceBuffer, true)

          if (success) {
            greetingSent = true
            console.log("✅ Basic greeting sent successfully!")
          }
        }
      } catch (error) {
        console.log("❌ Failed to send initial greeting:", error.message)
      }
    }

    // Start audio playback cycle (only when not waiting for play events)
    const startAudioPlaybackCycle = () => {
      if (audioPlaybackInterval) {
        clearInterval(audioPlaybackInterval)
      }

      console.log("🔄 Starting audio playback cycle (every 5 seconds)")

      audioPlaybackInterval = setInterval(async () => {
        if (!sessionStarted || !sessionId || audioFileList.length === 0) {
          console.log("⚠️ Skipping playback: session not active or no audio files")
          return
        }

        // Don't send if waiting for play event
        if (waitingForPlayEvent) {
          console.log("⏳ Waiting for play event, skipping scheduled playback")
          return
        }

        try {
          // Get next audio file in rotation
          const audioFile = audioFileList[audioFileCounter % audioFileList.length]
          audioFileCounter++

          console.log(`🔄 Playing audio file ${audioFileCounter}: ${audioFile.filename}`)
          console.log(`📊 File size: ${audioFile.size} bytes`)

          // Use the raw audio data (without WAV header)
          const success = await sendAudioToSIP(audioFile.rawData, false)

          if (success) {
            console.log(`✅ Audio file ${audioFile.filename} sent successfully`)
          } else {
            console.log(`❌ Failed to send audio file ${audioFile.filename}`)
          }
        } catch (error) {
          console.log("❌ Error in audio playback cycle:", error.message)
        }
      }, 5000) // Every 5 seconds

      console.log("✅ Audio playback cycle started")
    }

    // Connect to Deepgram for STT (improved connection handling)
    const connectToDeepgram = async () => {
      return new Promise((resolve) => {
        try {
          console.log("🎙️ Connecting to Deepgram STT...")

          if (!process.env.DEEPGRAM_API_KEY) {
            console.log("⚠️ Deepgram API key not configured, skipping STT")
            resolve()
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
          deepgramUrl.searchParams.append("keepalive", "true")

          deepgramWs = new WebSocket(deepgramUrl.toString(), ["token", process.env.DEEPGRAM_API_KEY])

          const connectionTimeout = setTimeout(() => {
            if (deepgramWs) {
              deepgramWs.close()
            }
            console.log("⚠️ Deepgram connection timeout, continuing without STT")
            resolve()
          }, 15000) // Increased timeout

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
            resolve()
          }

          deepgramWs.onclose = (event) => {
            clearTimeout(connectionTimeout)
            deepgramReady = false
            deepgramConnected = false
            console.log(`🎙️ Deepgram connection closed: ${event.code} - ${event.reason}`)

            // Try to reconnect after 5 seconds
            setTimeout(() => {
              if (sessionStarted) {
                console.log("🔄 Attempting to reconnect to Deepgram...")
                connectToDeepgram()
              }
            }, 5000)
          }
        } catch (error) {
          console.log("❌ Deepgram connection error:", error.message)
          resolve()
        }
      })
    }

    // Process audio data
    const processAudioData = async (audioData) => {
      if (!sessionStarted) {
        console.log("⚠️ Session not started, ignoring audio data")
        return
      }

      try {
        // Save incoming audio files
        saveAudioFile(audioData)

        // Send to Deepgram if available
        if (deepgramReady && deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
          deepgramWs.send(audioData)
        }
      } catch (error) {
        console.log("❌ Error processing audio:", error.message)
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

          // Handle SIP start event (EXACT format from PDF)
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
            greetingSent = false
            waitingForPlayEvent = false

            console.log("✅ SIP SESSION STARTED:")
            console.log(`   Session ID: ${sessionId}`)
            console.log(`   Source: ${source}`)
            console.log(`   Destination: ${destination}`)

            // Initialize Deepgram connection (non-blocking)
            connectToDeepgram().then(() => {
              console.log("✅ Deepgram initialization completed")
            })

            // Send initial greeting immediately
            setTimeout(async () => {
              await sendInitialGreeting()

              // Start audio playback cycle after greeting
              setTimeout(() => {
                startAudioPlaybackCycle()
              }, 2000)
            }, 1000)
          }
          // Handle play completion event (EXACT format from PDF)
          else if (data.session_id && data.played === "true") {
            console.log("🔊 Audio playback completed for session:", data.session_id)
            lastPlayedEvent = Date.now()
            waitingForPlayEvent = false // Reset waiting flag

            // Send next audio immediately after play event
            if (audioFileList.length > 0) {
              setTimeout(async () => {
                const audioFile = audioFileList[audioFileCounter % audioFileList.length]
                audioFileCounter++
                console.log(`🔄 Sending next audio after play event: ${audioFile.filename}`)
                await sendAudioToSIP(audioFile.rawData, false)
              }, 500) // Small delay
            }
          }
          // Handle hangup request (from PDF)
          else if (data.data && data.data.hangup === "true") {
            console.log("📞 Hangup request received for session:", data.data.session_id)
            // Close the connection
            ws.close()
          }
          // Handle stream stop request (from PDF)
          else if (data.data && data.data.stream_stop === "true") {
            console.log("🛑 Stream stop request received for session:", data.data.session_id)
            // Stop audio playback
            if (audioPlaybackInterval) {
              clearInterval(audioPlaybackInterval)
              audioPlaybackInterval = null
            }
          }
          // Handle other SIP events
          else {
            console.log("❓ Unknown SIP event:", data)
          }
        } else {
          // Handle audio data
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
      console.log(`   Greeting sent: ${greetingSent}`)

      // Clean up intervals
      if (audioPlaybackInterval) {
        clearInterval(audioPlaybackInterval)
        audioPlaybackInterval = null
        console.log("🛑 Audio playback cycle stopped")
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
      greetingSent = false
      waitingForPlayEvent = false
    })

    // Handle connection errors
    ws.on("error", (error) => {
      console.log("❌ SIP WebSocket error:", error.message)
    })

    console.log("✅ SIP WebSocket connection ready and waiting for start event")
  })
}

module.exports = { setupUnifiedVoiceServer }
