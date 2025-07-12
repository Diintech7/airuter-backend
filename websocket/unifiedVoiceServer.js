const WebSocket = require("ws")
const FormData = require("form-data")
const fs = require("fs")
const path = require("path")

const fetch = globalThis.fetch || require("node-fetch")

if (!fetch) {
  console.error("❌ Fetch not available. Please use Node.js 18+ or install node-fetch@2")
  process.exit(1)
}

const setupUnifiedVoiceServer = (wss) => {
  console.log("🚀 Unified Voice WebSocket server initialized with Persistent Deepgram Connection")

  wss.on("connection", (ws, req) => {
    console.log("🔗 New unified voice connection established")
    console.log("📡 SIP Connection Details:", {
      timestamp: new Date().toISOString(),
      clientIP: req.socket.remoteAddress,
      userAgent: req.headers["user-agent"],
      origin: req.headers.origin,
    })

    console.log("🎙️ VAD Configuration:")
    console.log("   - Speech Started events: ✅ Enabled")
    console.log("   - Utterance End detection: ✅ Enabled")
    console.log("   - Voice Activity Detection: ✅ Active")
    console.log("   - Endpointing: 300ms")
    console.log("   - VAD Turnoff: 700ms")
    console.log("   - Utterance End: 1000ms")

    // Persistent Deepgram connection variables
    let deepgramWs = null
    let deepgramReady = false
    let deepgramConnected = false
    let reconnectAttempts = 0
    const MAX_RECONNECT_ATTEMPTS = 5
    let reconnectDelay = 1000

    // Session management
    let sessionId = null
    let audioChunkCount = 0
    let connectionGreetingSent = false

    // Text processing queue system
    let textProcessingQueue = []
    let isProcessingQueue = false
    let currentTranscript = ""
    let isProcessingGemini = false
    let fullConversationHistory = []
    let silenceTimeout = null
    const SILENCE_DURATION = 2000
    let isSpeaking = false

    // Audio processing
    const MIN_CHUNK_SIZE = 320
    // const SEND_INTERVAL = 50
    // let lastAudioSent = 0
    const SEND_INTERVAL = 50

    // API Keys
    const lmntApiKey = process.env.LMNT_API_KEY
    const deepgramApiKey = process.env.DEEPGRAM_API_KEY
    const geminiApiKey = process.env.GEMINI_API_KEY

    const url = new URL(req.url, "http://localhost")
    const language = url.searchParams.get("language") || "en"

    console.log(`🌐 Connection established with language: ${language}`)
    console.log(`🔑 API Keys configured:`)
    console.log(`   - Deepgram: ${deepgramApiKey ? "✅ Yes" : "❌ NO"}`)
    console.log(`   - LMNT TTS: ${lmntApiKey ? "✅ Yes" : "❌ NO"}`)
    console.log(`   - Gemini: ${geminiApiKey ? "✅ Yes" : "❌ NO"}`)

    // VAD and speech detection state
    let vadState = {
      speechActive: false,
      lastSpeechStarted: null,
      lastUtteranceEnd: null,
      speechDuration: 0,
      silenceDuration: 0,
      totalSpeechEvents: 0,
      totalUtteranceEnds: 0,
    }

    // Text Processing Queue Management
    const addToTextQueue = (text, type = "transcript") => {
      const queueItem = {
        id: Date.now() + Math.random(),
        text: text.trim(),
        type: type,
        timestamp: new Date().toISOString(),
        processed: false,
      }

      textProcessingQueue.push(queueItem)
      console.log(`📝 [QUEUE] Added to text processing queue:`)
      console.log(`   - ID: ${queueItem.id}`)
      console.log(`   - Type: ${queueItem.type}`)
      console.log(`   - Text: "${queueItem.text}"`)
      console.log(`   - Queue Length: ${textProcessingQueue.length}`)

      // Process queue if not already processing
      if (!isProcessingQueue) {
        processTextQueue()
      }
    }

    const processTextQueue = async () => {
      if (isProcessingQueue || textProcessingQueue.length === 0) {
        return
      }

      isProcessingQueue = true
      console.log(`🔄 [QUEUE] Starting queue processing. Items in queue: ${textProcessingQueue.length}`)

      while (textProcessingQueue.length > 0) {
        const queueItem = textProcessingQueue.shift()

        try {
          console.log(`⚡ [QUEUE] Processing item:`)
          console.log(`   - ID: ${queueItem.id}`)
          console.log(`   - Text: "${queueItem.text}"`)
          console.log(`   - Timestamp: ${queueItem.timestamp}`)

          if (queueItem.text && queueItem.text.length > 0) {
            // Send to Gemini
            console.log(`🤖 [GEMINI] Sending text to Gemini: "${queueItem.text}"`)
            const geminiResponse = await sendToGemini(queueItem.text)

            if (geminiResponse) {
              console.log(`✅ [GEMINI] Received response: "${geminiResponse}"`)

              // Send to LMNT for voice synthesis
              console.log(`🔊 [LMNT] Sending to voice synthesis: "${geminiResponse}"`)
              await synthesizeAndSendResponse(geminiResponse)
              console.log(`✅ [LMNT] Voice response sent successfully`)
            } else {
              console.log(`❌ [GEMINI] No response received for: "${queueItem.text}"`)
            }
          }

          queueItem.processed = true
          console.log(`✅ [QUEUE] Item processed successfully: ${queueItem.id}`)
        } catch (error) {
          console.log(`❌ [QUEUE] Error processing item ${queueItem.id}:`, error.message)
        }
      }

      isProcessingQueue = false
      console.log(`🏁 [QUEUE] Queue processing completed`)
    }

    // Persistent Deepgram Connection - Connect once and keep alive
    const connectToDeepgram = async () => {
      return new Promise((resolve, reject) => {
        try {
          console.log("🎙️ Establishing PERSISTENT connection to Deepgram...")

          if (!deepgramApiKey) {
            const error = "Deepgram API key not configured"
            console.log("❌", error)
            reject(new Error(error))
            return
          }

          // Build Deepgram WebSocket URL with optimized parameters
          const deepgramUrl = new URL("wss://api.deepgram.com/v1/listen")
          deepgramUrl.searchParams.append("sample_rate", "8000")
          deepgramUrl.searchParams.append("channels", "1")
          deepgramUrl.searchParams.append("encoding", "linear16")
          deepgramUrl.searchParams.append("model", "nova-2")
          deepgramUrl.searchParams.append("language", "en-In")
          deepgramUrl.searchParams.append("interim_results", "true")
          deepgramUrl.searchParams.append("smart_format", "true")
          deepgramUrl.searchParams.append("endpointing", "300")

          deepgramWs = new WebSocket(deepgramUrl.toString(), { headers: { Authorization: `Token ${deepgramApiKey}` } })
          deepgramWs.binaryType = "arraybuffer"

          const connectionTimeout = setTimeout(() => {
            if (deepgramWs) {
              deepgramWs.close()
            }
            reject(new Error("Deepgram connection timeout"))
          }, 15000)

          deepgramWs.onopen = () => {
            clearTimeout(connectionTimeout)
            deepgramReady = true
            deepgramConnected = true
            reconnectAttempts = 0
            reconnectDelay = 1000
            console.log("✅ PERSISTENT Deepgram connection established and ready")
            console.log("🔄 Connection will remain alive until call termination")
            resolve()
          }

          deepgramWs.onmessage = async (event) => {
            try {
              const data = JSON.parse(event.data)
              await handleDeepgramResponse(data)
            } catch (parseError) {
              console.log("❌ Error parsing Deepgram response:", parseError.message)
            }
          }

          deepgramWs.onerror = (error) => {
            clearTimeout(connectionTimeout)
            deepgramReady = false
            deepgramConnected = false
            console.log("❌ Deepgram connection error:")
            console.log(`   - Message: ${error.message}`)
            if (error.code) console.log(`   - Error Code: ${error.code}`)
            if (error.reason) console.log(`   - Reason: ${error.reason}`)
            if (error.target && error.target.readyState === WebSocket.CLOSED) {
              console.log(`   - WebSocket State: CLOSED`)
            }
            // Attempt to log more specific error details if available (e.g., from a server response)
            if (error.target && error.target.response) {
              console.log(`   - Server Response: ${error.target.response}`)
            }
            reject(error)
          }

          deepgramWs.onclose = (event) => {
            clearTimeout(connectionTimeout)
            deepgramReady = false
            deepgramConnected = false
            console.log(`🎙️ Deepgram connection closed: ${event.code} - ${event.reason}`)

            // Only reconnect if not a normal closure and session is still active
            if (event.code !== 1000 && sessionId && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
              reconnectAttempts++
              const delay = Math.min(reconnectDelay * Math.pow(2, reconnectAttempts - 1), 30000)
              console.log(
                `🔄 Reconnecting to Deepgram in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
              )

              setTimeout(() => {
                connectToDeepgram().catch((err) => {
                  console.log("❌ Deepgram reconnection failed:", err.message)
                })
              }, delay)
            } else if (event.code === 1000) {
              console.log("✅ Deepgram connection closed normally")
            }
          }
        } catch (error) {
          console.log("❌ Error creating Deepgram connection:", error.message)
          reject(error)
        }
      })
    }

    // Handle Deepgram responses with comprehensive logging
    const handleDeepgramResponse = async (data) => {
      console.log(`📡 [DEEPGRAM] Received response type: ${data.type}`)

      if (data.type === "Results") {
        const channel = data.channel
        if (channel && channel.alternatives && channel.alternatives.length > 0) {
          const transcript = channel.alternatives[0].transcript
          const confidence = channel.alternatives[0].confidence
          const is_final = data.is_final

          if (transcript && transcript.trim()) {
            console.log(`📝 [DEEPGRAM] Transcript received:`)
            console.log(`   - Text: "${transcript}"`)
            console.log(`   - Confidence: ${confidence}`)
            console.log(`   - Is Final: ${is_final}`)
            console.log(`   - Session ID: ${sessionId}`)

            // Reset silence timer when we get speech
            resetSilenceTimer()

            if (is_final) {
              // Append to current transcript
              currentTranscript += (currentTranscript ? " " : "") + transcript.trim()
              console.log(`📝 [DEEPGRAM] Final accumulated transcript: "${currentTranscript}"`)

              // Add to processing queue
              addToTextQueue(currentTranscript, "final_transcript")

              // Start silence timer for final transcripts
              startSilenceTimer()

              // Send transcript to client
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "transcript",
                    data: transcript,
                    confidence: confidence,
                    is_final: true,
                    language: language,
                    accumulated: currentTranscript,
                  }),
                )
              }
            } else {
              // Interim results
              const displayTranscript = currentTranscript + (currentTranscript ? " " : "") + transcript.trim()
              console.log(`📝 [DEEPGRAM] Interim transcript: "${displayTranscript}"`)

              // Send interim transcript to client
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "transcript",
                    data: transcript,
                    confidence: confidence,
                    is_final: false,
                    language: language,
                    accumulated: displayTranscript,
                  }),
                )
              }
            }

            isSpeaking = true
          }
        }
      } else if (data.type === "SpeechStarted") {
        console.log(`🎙️ [DEEPGRAM] VAD: Speech started detected`)
        console.log(`   - Timestamp: ${data.timestamp}`)
        console.log(`   - Channel: ${data.channel}`)
        console.log(`   - Session ID: ${sessionId}`)

        // Reset silence timer immediately when speech starts
        resetSilenceTimer()
        isSpeaking = true

        // Send speech started event to client
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "speech_started",
              timestamp: data.timestamp,
              channel: data.channel,
              session_id: sessionId,
              message: "Speech activity detected by VAD",
            }),
          )
        }

        vadState.totalSpeechEvents++
      } else if (data.type === "UtteranceEnd") {
        console.log(`🎙️ [DEEPGRAM] VAD: Utterance end detected`)
        console.log(`   - Session ID: ${sessionId}`)
        console.log(`   - Current transcript: "${currentTranscript}"`)

        if (isSpeaking) {
          isSpeaking = false
          startSilenceTimer()

          // Send utterance end event to client
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "utterance_end",
                session_id: sessionId,
                accumulated_transcript: currentTranscript,
                message: "End of speech utterance detected",
              }),
            )
          }
        }
        vadState.totalUtteranceEnds++
      } else if (data.type === "Metadata") {
        console.log(`📊 [DEEPGRAM] Metadata received:`)
        console.log(`   - Request ID: ${data.request_id}`)
        console.log(`   - Model Info: ${JSON.stringify(data.model_info)}`)
        console.log(`   - Model UUID: ${data.model_uuid}`)
      } else {
        console.log(`📡 [DEEPGRAM] Other event: ${data.type}`, data)
      }
    }

    // Direct audio streaming to persistent Deepgram connection
    const sendAudioToDeepgram = async (audioData) => {
      if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN || !deepgramReady) {
        console.log("⚠️ [DEEPGRAM] Connection not ready, skipping audio chunk")
        return false
      }

      try {
        const buffer = audioData instanceof Buffer ? audioData : Buffer.from(audioData)

        if (buffer.length >= MIN_CHUNK_SIZE) {
          deepgramWs.send(buffer)
          // lastAudioSent = Date.now()
          console.log(`🎵 [DEEPGRAM] Audio sent: ${buffer.length} bytes`)
          return true
        }
        return false
      } catch (error) {
        console.log("❌ [DEEPGRAM] Error sending audio:", error.message)

        if (error.message.includes("connection") || error.message.includes("CLOSED")) {
          console.log("🔄 [DEEPGRAM] Attempting reconnection...")
          connectToDeepgram().catch((err) => {
            console.log("❌ [DEEPGRAM] Reconnection failed:", err.message)
          })
        }
        return false
      }
    }

    // Silence detection with logging
    const startSilenceTimer = () => {
      if (silenceTimeout) {
        clearTimeout(silenceTimeout)
      }

      vadState.lastUtteranceEnd = Date.now()

      silenceTimeout = setTimeout(() => {
        vadState.silenceDuration = Date.now() - vadState.lastUtteranceEnd
        console.log(`🔕 [VAD] ${SILENCE_DURATION}ms silence detected`)
        console.log(`   - Processing transcript: "${currentTranscript}"`)
        console.log(`   - Speech duration: ${vadState.speechDuration}ms`)
        console.log(`   - Silence duration: ${vadState.silenceDuration}ms`)
        handleSilenceDetected()
      }, SILENCE_DURATION)
    }

    const resetSilenceTimer = () => {
      if (silenceTimeout) {
        clearTimeout(silenceTimeout)
        silenceTimeout = null
      }

      if (!vadState.speechActive) {
        vadState.lastSpeechStarted = Date.now()
        vadState.speechActive = true
      }

      if (vadState.lastSpeechStarted) {
        vadState.speechDuration = Date.now() - vadState.lastSpeechStarted
      }
    }

    const handleSilenceDetected = async () => {
      if (currentTranscript.trim() && !isProcessingGemini) {
        console.log(`🔕 [SILENCE] Processing complete utterance: "${currentTranscript}"`)

        // Add to queue for processing
        addToTextQueue(currentTranscript.trim(), "complete_utterance")

        // Reset for next utterance
        currentTranscript = ""
      }
    }

    // Enhanced Gemini API Integration with logging
    const sendToGemini = async (userMessage) => {
      if (isProcessingGemini || !geminiApiKey || !userMessage.trim()) {
        console.log(
          `⚠️ [GEMINI] Skipping request - Processing: ${isProcessingGemini}, API Key: ${!!geminiApiKey}, Message: "${userMessage}"`,
        )
        return null
      }

      isProcessingGemini = true
      console.log(`🤖 [GEMINI] Sending request:`)
      console.log(`   - Message: "${userMessage}"`)
      console.log(`   - Session ID: ${sessionId}`)
      console.log(`   - Conversation History Length: ${fullConversationHistory.length}`)

      try {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${geminiApiKey}`

        // Add to conversation history
        fullConversationHistory.push({
          role: "user",
          parts: [{ text: userMessage }],
        })

        const requestBody = {
          contents: fullConversationHistory,
          generationConfig: {
            temperature: 0.7,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 1024,
          },
        }

        console.log(`🤖 [GEMINI] Making API request...`)
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        })

        if (!response.ok) {
          const errorText = await response.text()
          console.log(`❌ [GEMINI] API error: ${response.status} - ${errorText}`)
          return null
        }

        const data = await response.json()
        console.log(`✅ [GEMINI] API response received`)

        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
          const geminiResponse = data.candidates[0].content.parts[0].text

          console.log(`🤖 [GEMINI] Response: "${geminiResponse}"`)

          // Add to conversation history
          fullConversationHistory.push({
            role: "model",
            parts: [{ text: geminiResponse }],
          })

          console.log(`📚 [GEMINI] Updated conversation history length: ${fullConversationHistory.length}`)
          return geminiResponse
        }

        console.log(`❌ [GEMINI] No valid response in API data`)
        return null
      } catch (error) {
        console.log(`❌ [GEMINI] API error: ${error.message}`)
        return null
      } finally {
        isProcessingGemini = false
        console.log(`🤖 [GEMINI] Request processing completed`)
      }
    }

    // Enhanced TTS Synthesis with logging
    const synthesizeAndSendResponse = async (text) => {
      if (!lmntApiKey || !text.trim()) {
        console.log(`⚠️ [LMNT] Skipping synthesis - API Key: ${!!lmntApiKey}, Text: "${text}"`)
        return
      }

      try {
        console.log(`🔊 [LMNT] Starting synthesis:`)
        console.log(`   - Text: "${text}"`)
        console.log(`   - Language: ${language}`)
        console.log(`   - Session ID: ${sessionId}`)

        const synthesisOptions = {
          voice: "lily",
          language: language === "en" ? "en" : "hi",
          speed: 1.0,
          format: "wav",
          sample_rate: 8000,
        }

        console.log(`🔊 [LMNT] Synthesis options:`, synthesisOptions)
        const audioData = await synthesizeWithLMNT(text, synthesisOptions)

        if (audioData && audioData.length > 0) {
          console.log(`✅ [LMNT] Audio synthesized successfully: ${audioData.length} bytes`)

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
            type: "ai_response",
          }

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(audioResponse))
            console.log(`✅ [LMNT] Audio response sent to client`)
            console.log(`   - Chunk Count: ${audioChunkCount}`)
            console.log(`   - Audio Size: ${audioWithHeader.length} bytes`)
          } else {
            console.log(`❌ [LMNT] WebSocket not open, cannot send audio`)
          }
        } else {
          console.log(`❌ [LMNT] No audio data received from synthesis`)
        }
      } catch (error) {
        console.log(`❌ [LMNT] Synthesis failed: ${error.message}`)
      }
    }

    // TTS Synthesis with LMNT (unchanged but with enhanced logging)
    const synthesizeWithLMNT = async (text, options = {}) => {
      if (!lmntApiKey) {
        throw new Error("LMNT API key not configured")
      }

      console.log(`🔊 [LMNT] Making synthesis request to API...`)

      const requestOptions = {
        method: "POST",
        headers: {
          "X-API-Key": lmntApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: text,
          voice: options.voice || "lily",
          format: options.format || "wav",
          language: options.language || "en",
          sample_rate: options.sample_rate || 8000,
          speed: options.speed || 1.0,
        }),
      }

      const response = await fetch("https://api.lmnt.com/v1/ai/speech", requestOptions)

      if (!response.ok) {
        const errorText = await response.text()
        console.log(`❌ [LMNT] API error: ${response.status} - ${errorText}`)
        throw new Error(`LMNT API error: ${response.status} - ${errorText}`)
      }

      console.log(`✅ [LMNT] API response received successfully`)
      const contentType = response.headers.get("content-type")

      if (contentType && contentType.includes("application/json")) {
        const jsonResponse = await response.json()
        if (jsonResponse.audio_url) {
          console.log(`🔊 [LMNT] Fetching audio from URL...`)
          const audioResponse = await fetch(jsonResponse.audio_url)
          const audioBuffer = await audioResponse.arrayBuffer()
          return Buffer.from(audioBuffer)
        } else if (jsonResponse.audio) {
          console.log(`🔊 [LMNT] Processing base64 audio data...`)
          return Buffer.from(jsonResponse.audio, "base64")
        }
      } else {
        console.log(`🔊 [LMNT] Processing direct audio buffer...`)
        const audioBuffer = await response.arrayBuffer()
        return Buffer.from(audioBuffer)
      }

      throw new Error("Unexpected response format from LMNT")
    }

    // Utility functions (unchanged)
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

    const createWAVHeader = (audioBuffer, sampleRate = 8000, channels = 1, bitsPerSample = 16) => {
      const byteRate = (sampleRate * channels * bitsPerSample) / 8
      const blockAlign = (channels * bitsPerSample) / 8
      const dataSize = audioBuffer.length
      const fileSize = 36 + dataSize

      const header = Buffer.alloc(44)
      let offset = 0

      header.write("RIFF", offset)
      offset += 4
      header.writeUInt32LE(fileSize, offset)
      offset += 4
      header.write("WAVE", offset)
      offset += 4
      header.write("fmt ", offset)
      offset += 4
      header.writeUInt32LE(16, offset)
      offset += 4
      header.writeUInt16LE(1, offset)
      offset += 2
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
      header.write("data", offset)
      offset += 4
      header.writeUInt32LE(dataSize, offset)

      return Buffer.concat([header, audioBuffer])
    }

    const sendGreeting = async () => {
      if (connectionGreetingSent || !lmntApiKey || !sessionId) {
        return
      }

      const greetings = {
        hi: "नमस्ते! हैलो, Aitota से संपर्क करने के लिए धन्यवाद।",
        en: "Hi! Hello, thank you for contacting Aitota.",
      }

      const greetingText = greetings[language] || greetings["en"]
      console.log(`👋 [GREETING] Sending greeting: "${greetingText}"`)

      try {
        await synthesizeAndSendResponse(greetingText)
        connectionGreetingSent = true
        console.log(`✅ [GREETING] Greeting sent successfully!`)
      } catch (error) {
        console.log(`❌ [GREETING] Failed to send greeting: ${error.message}`)
        connectionGreetingSent = true
      }
    }

    // WebSocket message handling with enhanced logging
    ws.on("message", async (message) => {
      try {
        let isTextMessage = false
        let data = null

        // Parse message
        if (typeof message === "string") {
          isTextMessage = true
          try {
            data = JSON.parse(message)
          } catch (parseError) {
            console.log("❌ Failed to parse JSON:", parseError.message)
            return
          }
        } else if (message instanceof Buffer) {
          try {
            const messageStr = message.toString("utf8")
            if (messageStr.trim().startsWith("{") && messageStr.trim().endsWith("}")) {
              data = JSON.parse(messageStr)
              isTextMessage = true
            } else {
              isTextMessage = false
            }
          } catch (parseError) {
            isTextMessage = false
          }
        }

        if (isTextMessage && data) {
          console.log(`📨 [MESSAGE] Received control message:`, data)

          // Handle control messages
          if (data.event === "start" && data.session_id) {
            sessionId = data.session_id
            audioChunkCount = 0
            currentTranscript = ""
            isSpeaking = false
            fullConversationHistory = []
            textProcessingQueue = []
            isProcessingQueue = false

            console.log(`✅ [SESSION] SIP Call Started:`)
            console.log(`   - Session ID: ${sessionId}`)
            console.log(`   - Language: ${language}`)

            // Send session started confirmation
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "session_started",
                  session_id: sessionId,
                  language: language,
                  message: "SIP call started, establishing persistent Deepgram connection.",
                }),
              )
            }

            // Connect to Deepgram ONCE for the entire session
            try {
              await connectToDeepgram()
              console.log(`✅ [SESSION] Persistent Deepgram connection established for session ${sessionId}`)
            } catch (error) {
              console.log(`❌ [SESSION] Failed to connect to Deepgram: ${error.message}`)
            }

            // Send greeting after a short delay
            setTimeout(() => {
              sendGreeting()
            }, 500)
          } else if (data.type === "synthesize") {
            console.log(`🔊 [MESSAGE] TTS synthesis request: "${data.text}"`)
            if (data.session_id) {
              sessionId = data.session_id
            }
            await synthesizeAndSendResponse(data.text)
          } else if (data.data && data.data.hangup === "true") {
            console.log(`📞 [SESSION] Hangup request received for session ${sessionId}`)

            // Close Deepgram connection on hangup
            if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
              console.log(`🎙️ [DEEPGRAM] Closing persistent connection due to hangup`)
              deepgramWs.close(1000, "Call ended")
            }

            ws.close(1000, "Hangup requested")
          }
        } else {
          // Handle audio data - send to persistent Deepgram connection
          console.log(`Received audio buffer size: ${message.length} bytes`)
          if (deepgramConnected && deepgramReady) {
            // const now = Date.now()
            // if (now - lastAudioSent >= SEND_INTERVAL) {
            await sendAudioToDeepgram(message)
            // }
          } else {
            console.log(`⚠️ [AUDIO] Audio received but Deepgram not connected`)
          }
        }
      } catch (error) {
        console.log(`❌ [MESSAGE] Error processing message: ${error.message}`)
      }
    })

    // Enhanced connection cleanup
    ws.on("close", () => {
      console.log(`🔗 [SESSION] Unified voice connection closed for session ${sessionId}`)
      console.log(`📊 [SESSION] Final statistics:`)
      console.log(`   - Session ID: ${sessionId || "Not set"}`)
      console.log(`   - Audio chunks processed: ${audioChunkCount}`)
      console.log(`   - Conversation history: ${fullConversationHistory.length} messages`)
      console.log(`   - Text queue items processed: ${textProcessingQueue.filter((item) => item.processed).length}`)
      console.log(`📊 [VAD] Final VAD statistics:`)
      console.log(`   - Speech events detected: ${vadState.totalSpeechEvents}`)
      console.log(`   - Utterance ends detected: ${vadState.totalUtteranceEnds}`)
      console.log(`   - Last speech duration: ${vadState.speechDuration}ms`)
      console.log(`   - Last silence duration: ${vadState.silenceDuration}ms`)

      // Close persistent Deepgram connection
      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        console.log(`🎙️ [DEEPGRAM] Closing persistent connection for session ${sessionId}`)
        deepgramWs.close(1000, "Session ended")
      }

      // Cleanup
      resetSilenceTimer()

      // Reset all state
      sessionId = null
      audioChunkCount = 0
      deepgramReady = false
      deepgramConnected = false
      connectionGreetingSent = false
      currentTranscript = ""
      isSpeaking = false
      fullConversationHistory = []
      textProcessingQueue = []
      isProcessingQueue = false
      vadState = {
        speechActive: false,
        lastSpeechStarted: null,
        lastUtteranceEnd: null,
        speechDuration: 0,
        silenceDuration: 0,
        totalSpeechEvents: 0,
        totalUtteranceEnds: 0,
      }
    })

    ws.on("error", (error) => {
      console.log(`❌ [SESSION] WebSocket connection error: ${error.message}`)
    })

    console.log(`✅ [SESSION] WebSocket connection ready, waiting for SIP 'start' event`)
  })
}

module.exports = { setupUnifiedVoiceServer }
