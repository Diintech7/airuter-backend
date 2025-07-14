const WebSocket = require("ws")
const FormData = require("form-data")
const fs = require("fs")
const path = require("path")
const { SarvamAIClient } = require("sarvamai")
const mongoose = require("mongoose")
const ApiKey = require("./ApiKey") // Assuming models are in the same directory
const Tenant = require("./Tenant")

const fetch = globalThis.fetch || require("node-fetch")

if (!fetch) {
  console.error("❌ Fetch not available. Please use Node.js 18+ or install node-fetch@2")
  process.exit(1)
}

// Database connection
const connectToDatabase = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/voice_server"
    await mongoose.connect(mongoUri)
    console.log("✅ Connected to MongoDB")
  } catch (error) {
    console.error("❌ MongoDB connection error:", error.message)
    process.exit(1)
  }
}

// Initialize database connection
connectToDatabase()

const setupUnifiedVoiceServer = (wss) => {
  console.log("🚀 Unified Voice WebSocket server initialized with Database Integration")

  wss.on("connection", (ws, req) => {
    console.log("🔗 New unified voice connection established")
    console.log("📡 SIP Connection Details:", {
      timestamp: new Date().toISOString(),
      clientIP: req.socket.remoteAddress,
      userAgent: req.headers["user-agent"],
      origin: req.headers.origin,
    })

    // Extract tenant ID from URL parameters or headers
    const url = new URL(req.url, "http://localhost")
    const tenantId = url.searchParams.get("tenantId") || req.headers["x-tenant-id"] || "default"
    const language = url.searchParams.get("language") || "hi"

    console.log(`🏢 Tenant ID: ${tenantId}`)
    console.log(`🌐 Language: ${language}`)

    // API Keys will be loaded from database
    let apiKeys = {
      deepgram: null,
      sarvam: null,
      openai: null
    }

    // Load API keys from database
    const loadApiKeys = async () => {
      try {
        console.log(`🔑 Loading API keys for tenant: ${tenantId}`)
        
        // Check if tenant exists
        const tenant = await Tenant.findOne({ tenantId, status: "active" })
        if (!tenant) {
          console.error(`❌ Tenant not found or inactive: ${tenantId}`)
          return false
        }

        console.log(`✅ Active tenant found: ${tenant.tenantName}`)

        // Load API keys for the tenant
        const keys = await ApiKey.find({ 
          tenantId, 
          isActive: true 
        })

        if (keys.length === 0) {
          console.error(`❌ No active API keys found for tenant: ${tenantId}`)
          return false
        }

        // Decrypt and assign API keys
        for (const keyDoc of keys) {
          const decryptedKey = keyDoc.getDecryptedKey()
          
          switch (keyDoc.provider) {
            case "deepgram":
              apiKeys.deepgram = decryptedKey
              console.log(`✅ Deepgram API key loaded for ${tenantId}`)
              break
            case "sarvam":
              apiKeys.sarvam = decryptedKey
              console.log(`✅ Sarvam API key loaded for ${tenantId}`)
              break
            case "openai":
              apiKeys.openai = decryptedKey
              console.log(`✅ OpenAI API key loaded for ${tenantId}`)
              break
          }

          // Update usage statistics
          await ApiKey.updateOne(
            { _id: keyDoc._id },
            { 
              $inc: { "usage.totalRequests": 1 },
              $set: { "usage.lastUsed": new Date() }
            }
          )
        }

        console.log(`🔑 API Keys loaded:`)
        console.log(`   - Deepgram: ${apiKeys.deepgram ? "✅ Yes" : "❌ NO"}`)
        console.log(`   - Sarvam TTS: ${apiKeys.sarvam ? "✅ Yes" : "❌ NO"}`)
        console.log(`   - OpenAI: ${apiKeys.openai ? "✅ Yes" : "❌ NO"}`)

        return true
      } catch (error) {
        console.error(`❌ Error loading API keys: ${error.message}`)
        return false
      }
    }

    console.log(`🎙️ VAD Configuration:`)
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
    let isProcessingOpenAI = false
    let fullConversationHistory = []
    let silenceTimeout = null
    const SILENCE_DURATION = 2000
    let isSpeaking = false

    // Audio streaming and interruption management
    let currentTTSSocket = null
    let isPlayingAudio = false
    let audioQueue = []
    let currentAudioChunk = 0
    let shouldInterruptAudio = false
    let greetingInProgress = false

    // Audio processing
    const MIN_CHUNK_SIZE = 320
    const SEND_INTERVAL = 50
    const GREETING_PROTECTION_DELAY = 5000

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

    // Audio interruption handler
    const interruptCurrentAudio = () => {
      if (greetingInProgress) {
        console.log("🛑 [AUDIO] Interruption blocked - greeting in progress")
        return
      }

      console.log("🛑 [AUDIO] Interrupting current audio playback")
      shouldInterruptAudio = true
      isPlayingAudio = false
      audioQueue = []
      
      if (currentTTSSocket) {
        try {
          currentTTSSocket.close()
          console.log("🛑 [SARVAM] TTS socket closed due to interruption")
        } catch (error) {
          console.log("❌ [SARVAM] Error closing TTS socket:", error.message)
        }
        currentTTSSocket = null
      }
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
            console.log(`🤖 [OPENAI] Sending text to OpenAI: "${queueItem.text}"`)
            const openaiResponse = await sendToOpenAI(queueItem.text)

            if (openaiResponse) {
              console.log(`✅ [OPENAI] Received response: "${openaiResponse}"`)
              console.log(`🔊 [SARVAM] Sending to voice synthesis: "${openaiResponse}"`)
              await synthesizeAndSendResponse(openaiResponse)
              console.log(`✅ [SARVAM] Voice response sent successfully`)
            } else {
              console.log(`❌ [OPENAI] No response received for: "${queueItem.text}"`)
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

    // Persistent Deepgram Connection
    const connectToDeepgram = async () => {
      return new Promise((resolve, reject) => {
        try {
          console.log("🎙️ Establishing PERSISTENT connection to Deepgram...")

          if (!apiKeys.deepgram) {
            const error = "Deepgram API key not available for this tenant"
            console.log("❌", error)
            reject(new Error(error))
            return
          }

          const deepgramUrl = new URL("wss://api.deepgram.com/v1/listen")
          deepgramUrl.searchParams.append("sample_rate", "8000")
          deepgramUrl.searchParams.append("channels", "1")
          deepgramUrl.searchParams.append("encoding", "linear16")
          deepgramUrl.searchParams.append("model", "nova-2")
          deepgramUrl.searchParams.append("language", "hi")
          deepgramUrl.searchParams.append("interim_results", "true")
          deepgramUrl.searchParams.append("smart_format", "true")
          deepgramUrl.searchParams.append("endpointing", "300")

          deepgramWs = new WebSocket(deepgramUrl.toString(), { 
            headers: { Authorization: `Token ${apiKeys.deepgram}` } 
          })
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
            console.log("❌ Deepgram connection error:", error.message)
            reject(error)
          }

          deepgramWs.onclose = (event) => {
            clearTimeout(connectionTimeout)
            deepgramReady = false
            deepgramConnected = false
            console.log(`🎙️ Deepgram connection closed: ${event.code} - ${event.reason}`)

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
            }
          }
        } catch (error) {
          console.log("❌ Error creating Deepgram connection:", error.message)
          reject(error)
        }
      })
    }

    // Handle Deepgram responses
    const handleDeepgramResponse = async (data) => {
      console.log(`📡 [DEEPGRAM] Received response type: ${data.type}`)
      
      if (deepgramWs && deepgramWs._lastSendTime) {
        const now = Date.now()
        const duration = now - deepgramWs._lastSendTime
        console.log(`[DEEPGRAM] Time from audio send to response: ${duration} ms`)
        deepgramWs._lastSendTime = null
      }

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

            resetSilenceTimer()

            if (is_final) {
              currentTranscript += (currentTranscript ? " " : "") + transcript.trim()
              console.log(`📝 [DEEPGRAM] Final accumulated transcript: "${currentTranscript}"`)

              addToTextQueue(currentTranscript, "final_transcript")
              startSilenceTimer()

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
              const displayTranscript = currentTranscript + (currentTranscript ? " " : "") + transcript.trim()
              console.log(`📝 [DEEPGRAM] Interim transcript: "${displayTranscript}"`)

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
        
        if (isPlayingAudio) {
          interruptCurrentAudio()
        }

        resetSilenceTimer()
        isSpeaking = true

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

        if (isSpeaking) {
          isSpeaking = false
          startSilenceTimer()

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
      }
    }

    // Send audio to Deepgram
    const sendAudioToDeepgram = async (audioData) => {
      if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN || !deepgramReady) {
        console.log("⚠️ [DEEPGRAM] Connection not ready, skipping audio chunk")
        return false
      }

      try {
        const buffer = audioData instanceof Buffer ? audioData : Buffer.from(audioData)

        if (buffer.length >= MIN_CHUNK_SIZE) {
          const deepgramSendTime = Date.now()
          deepgramWs._lastSendTime = deepgramSendTime
          deepgramWs.send(buffer)
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

    // Silence detection
    const startSilenceTimer = () => {
      if (silenceTimeout) {
        clearTimeout(silenceTimeout)
      }

      vadState.lastUtteranceEnd = Date.now()

      silenceTimeout = setTimeout(() => {
        vadState.silenceDuration = Date.now() - vadState.lastUtteranceEnd
        console.log(`🔕 [VAD] ${SILENCE_DURATION}ms silence detected`)
        console.log(`   - Processing transcript: "${currentTranscript}"`)
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
      if (currentTranscript.trim() && !isProcessingOpenAI) {
        console.log(`🔕 [SILENCE] Processing complete utterance: "${currentTranscript}"`)
        addToTextQueue(currentTranscript.trim(), "complete_utterance")
        currentTranscript = ""
      }
    }

    // OpenAI Integration
    const sendToOpenAI = async (userMessage) => {
      if (isProcessingOpenAI || !apiKeys.openai || !userMessage.trim()) {
        console.log(
          `⚠️ [OPENAI] Skipping request - Processing: ${isProcessingOpenAI}, API Key: ${!!apiKeys.openai}, Message: "${userMessage}"`,
        )
        return null
      }

      isProcessingOpenAI = true
      console.log(`🤖 [OPENAI] Sending request for tenant ${tenantId}:`)
      console.log(`   - Message: "${userMessage}"`)
      console.log(`   - Session ID: ${sessionId}`)

      const openaiStartTime = Date.now()

      try {
        const apiUrl = "https://api.openai.com/v1/chat/completions"

        fullConversationHistory.push({
          role: "user",
          content: userMessage,
        })

        const requestBody = {
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a helpful voice assistant for telephonic conversations. Keep responses very short and conversational, maximum 2-3 sentences. You're speaking to someone over the phone so be natural and brief. Respond in ${language === "hi-IN" ? "Hindi" : "Hindi"}.`
            },
            ...fullConversationHistory.slice(-10)
          ],
          max_tokens: 150,
          temperature: 0.5,
        }

        console.log(`🤖 [OPENAI] Making API request...`)
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKeys.openai}`
          },
          body: JSON.stringify(requestBody),
        })

        const openaiEndTime = Date.now()
        console.log(`[OPENAI] API call duration: ${openaiEndTime - openaiStartTime} ms`)

        if (!response.ok) {
          const errorText = await response.text()
          console.log(`❌ [OPENAI] API error: ${response.status} - ${errorText}`)
          return null
        }

        const data = await response.json()
        console.log(`✅ [OPENAI] API response received`)

        if (data.choices && data.choices[0] && data.choices[0].message) {
          const openaiResponse = data.choices[0].message.content

          console.log(`🤖 [OPENAI] Response: "${openaiResponse}"`)

          fullConversationHistory.push({
            role: "assistant",
            content: openaiResponse,
          })

          // Update usage statistics
          await updateApiKeyUsage("openai")

          return openaiResponse
        }

        return null
      } catch (error) {
        console.log(`❌ [OPENAI] API error: ${error.message}`)
        return null
      } finally {
        isProcessingOpenAI = false
      }
    }

    // TTS Synthesis with Sarvam
    const synthesizeAndSendResponse = async (text) => {
      if (!apiKeys.sarvam || !text.trim()) {
        console.log(`[SARVAM] Skipping synthesis - API Key: ${!!apiKeys.sarvam}, Text: "${text}"`)
        return
      }

      const sarvamStartTime = Date.now()

      try {
        const requestBody = {
          inputs: [text],
          target_language_code: language === "hi-IN" ? "hi-IN" : "hi-IN",
          speaker: language === "hi-IN" ? "anushka" : "abhilash",
          pitch: 0,
          pace: 1.0,
          loudness: 1.0,
          speech_sample_rate: 22050,
          enable_preprocessing: true,
          model: "bulbul:v2"
        }

        console.log("[SARVAM] TTS Request for tenant", tenantId, ":", requestBody)

        const response = await fetch("https://api.sarvam.ai/text-to-speech", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "API-Subscription-Key": apiKeys.sarvam,
          },
          body: JSON.stringify(requestBody),
        })

        const sarvamEndTime = Date.now()
        console.log(`[SARVAM] TTS API call duration: ${sarvamEndTime - sarvamStartTime} ms`)

        if (!response.ok) {
          const errorText = await response.text()
          let errorData
          try {
            errorData = JSON.parse(errorText)
          } catch {
            errorData = { error: errorText }
          }
          console.error("[SARVAM] API Error:", {
            status: response.status,
            error: errorData.error || "Unknown error",
            requestBody,
          })
          throw new Error(`Sarvam AI API error: ${response.status} - ${errorData.error || "Unknown error"}`)
        }

        const responseData = await response.json()
        if (!responseData.audios || responseData.audios.length === 0) {
          throw new Error("No audio data received from Sarvam AI")
        }

        const audioBase64 = responseData.audios[0]
        const audioBuffer = Buffer.from(audioBase64, 'base64')
        const pythonBytesString = bufferToPythonBytesString(audioBuffer)

        const audioResponse = {
          data: {
            session_id: sessionId,
            count: 1,
            audio_bytes_to_play: pythonBytesString,
            sample_rate: 22050,
            channels: 1,
            sample_width: 2,
            is_streaming: false,
            format: "mp3",
          },
          type: "ai_response",
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(audioResponse))
          ws.send(JSON.stringify({
            type: "ai_response_complete",
            session_id: sessionId,
            total_chunks: 1,
          }))
          console.log(`[SARVAM] Audio sent to client (${audioBuffer.length} bytes)`)
        }

        // Update usage statistics
        await updateApiKeyUsage("sarvam")

      } catch (error) {
        console.log(`[SARVAM] TTS error: ${error.message}`)
      }
    }

    // Update API key usage statistics
    const updateApiKeyUsage = async (provider) => {
      try {
        await ApiKey.updateOne(
          { tenantId, provider, isActive: true },
          { 
            $inc: { 
              "usage.totalRequests": 1,
              "usage.monthlyUsage": 1 
            },
            $set: { "usage.lastUsed": new Date() }
          }
        )
      } catch (error) {
        console.log(`❌ Error updating usage for ${provider}:`, error.message)
      }
    }

    // Utility functions
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

    const sendGreeting = async () => {
      if (connectionGreetingSent || !apiKeys.sarvam || !sessionId) {
        console.log(`⚠️ [GREETING] Skipping greeting - Sent: ${connectionGreetingSent}, API Key: ${!!apiKeys.sarvam}, Session: ${!!sessionId}`)
        return
      }

      const greetings = {
        hi: "नमस्कार! एआई तोता में संपर्क करने के लिए धन्यवाद। बताइए, मैं आपकी किस प्रकार मदद कर सकता हूँ?",
        en: "Hi! Thank you for contacting Aitota.",
      }

      const greetingText = greetings["hi"]
      console.log(`👋 [GREETING] Sending greeting for tenant ${tenantId}: "${greetingText}"`)

      try {
        await new Promise(resolve => setTimeout(resolve, 1000))
        await synthesizeAndSendResponse(greetingText)
        connectionGreetingSent = true
        console.log(`✅ [GREETING] Greeting sent successfully!`)
      } catch (error) {
        console.log(`❌ [GREETING] Failed to send greeting: ${error.message}`)
        connectionGreetingSent = true
        greetingInProgress = false
        
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "greeting_fallback",
            session_id: sessionId,
            message: greetingText,
            error: error.message
          }))
        }
      }
    }

    // WebSocket message handling
    ws.on("message", async (message) => {
      try {
        let isTextMessage = false
        let data = null

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

          if (data.event === "start" && data.session_id) {
            sessionId = data.session_id
            audioChunkCount = 0
            currentTranscript = ""
            isSpeaking = false
            fullConversationHistory = []
            textProcessingQueue = []
            isProcessingQueue = false
            isPlayingAudio = false
            shouldInterruptAudio = false
            greetingInProgress = false

            console.log(`✅ [SESSION] SIP Call Started:`)
            console.log(`   - Session ID: ${sessionId}`)
            console.log(`   - Language: ${language}`)

            // Load API keys for this tenant
            const keysLoaded = await loadApiKeys()
            if (!keysLoaded) {
              console.log(`❌ [SESSION] Cannot start session - API keys not available`)
              ws.send(JSON.stringify({
                type: "error",
                message: "API keys not configured for this tenant",
                session_id: sessionId
              }))
              return
            }

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

            // Connect to Deepgram for the session
            try {
              await connectToDeepgram()
              console.log(`✅ [SESSION] Persistent Deepgram connection established for session ${sessionId}`)
            } catch (error) {
              console.log(`❌ [SESSION] Failed to connect to Deepgram: ${error.message}`)
              ws.send(JSON.stringify({
                type: "error",
                session_id: sessionId,
                message: "Failed to connect to speech recognition service"
              }))
            }

            // Send greeting after connection is established
            setTimeout(() => {
              sendGreeting()
            }, 2000)
          } else if (data.type === "synthesize") {
            console.log(`🔊 [MESSAGE] TTS synthesis request: "${data.text}"`)
            if (data.session_id) {
              sessionId = data.session_id
            }
            await synthesizeAndSendResponse(data.text)
          } else if (data.data && data.data.hangup === "true") {
            console.log(`📞 [SESSION] Hangup request received for session ${sessionId}`)
            
            // Close Deepgram connection
            if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
              console.log(`🎙️ [DEEPGRAM] Closing persistent connection due to hangup`)
              deepgramWs.close(1000, "Call ended")
            }
            
            // Close TTS connection
            if (currentTTSSocket) {
              console.log(`🛑 [SARVAM] Closing TTS connection due to hangup`)
              currentTTSSocket.close()
            }
            
            ws.close(1000, "Hangup requested")
          }
        } else {
          // Handle audio data
          console.log(`🎵 [AUDIO] Received audio buffer size: ${message.length} bytes`)
          
          if (isPlayingAudio && !greetingInProgress) {
            interruptCurrentAudio()
          } else if (isPlayingAudio && greetingInProgress) {
            console.log("🛡️ [AUDIO] Audio interruption blocked - greeting protection active")
          }

          if (deepgramConnected && deepgramReady) {
            await sendAudioToDeepgram(message)
          } else {
            console.log(`⚠️ [AUDIO] Audio received but Deepgram not connected`)
          }
        }
      } catch (error) {
        console.log(`❌ [MESSAGE] Error processing message: ${error.message}`)
      }
    })

    // Connection cleanup
    ws.on("close", () => {
      console.log(`🔗 [SESSION] Unified voice connection closed for session ${sessionId}`)
      console.log(`📊 [SESSION] Final statistics:`)
      console.log(`   - Tenant ID: ${tenantId}`)
      console.log(`   - Session ID: ${sessionId || "Not set"}`)
      console.log(`   - Audio chunks processed: ${audioChunkCount}`)
      console.log(`   - Conversation history: ${fullConversationHistory.length} messages`)
      console.log(`📊 [VAD] Final VAD statistics:`)
      console.log(`   - Speech events detected: ${vadState.totalSpeechEvents}`)
      console.log(`   - Utterance ends detected: ${vadState.totalUtteranceEnds}`)

      // Close Deepgram connection
      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        console.log(`🎙️ [DEEPGRAM] Closing persistent connection for session ${sessionId}`)
        deepgramWs.close(1000, "Session ended")
      }

      // Close TTS connection
      if (currentTTSSocket) {
        console.log(`🛑 [SARVAM] Closing TTS connection for session ${sessionId}`)
        currentTTSSocket.close()
      }

      // Cleanup
      resetSilenceTimer()
      sessionId = null
      audioChunkCount = 0
      deepgramReady = false
      deepgramConnected = false
      connectionGreetingSent = false
      currentTranscript = ""
      isSpeaking = false
      isPlayingAudio = false
      shouldInterruptAudio = false
      greetingInProgress = false
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
      
      if (currentTTSSocket) {
        console.log(`🛑 [SARVAM] Closing TTS connection due to error`)
        currentTTSSocket.close()
      }
    })

    console.log(`✅ [SESSION] WebSocket connection ready, waiting for SIP 'start' event`)
  })
}

module.exports = { setupUnifiedVoiceServer }
