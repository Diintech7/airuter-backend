const WebSocket = require("ws")
const mongoose = require("mongoose")
const ApiKey = require("../models/ApiKey")
const Agent = require("../models/AgentProfile")
const connectDB = require("../config/db")
connectDB()

const fetch = globalThis.fetch || require("node-fetch")

if (!fetch) {
  console.error("❌ Fetch not available. Please use Node.js 18+ or install node-fetch@2")
  process.exit(1)
}

// Performance timing helper
const createTimer = (label) => {
  const start = Date.now()
  return {
    start,
    end: () => {
      const duration = Date.now() - start
      console.log(`⏱️ [TIMING] ${label}: ${duration}ms`)
      return duration
    },
    checkpoint: (checkpointName) => {
      const duration = Date.now() - start
      console.log(`⏱️ [CHECKPOINT] ${label} - ${checkpointName}: ${duration}ms`)
      return duration
    },
  }
}

// Helper to split text into sentences for chunked TTS
const splitIntoSentences = (text) => {
  // Basic sentence splitting, can be improved with a more robust NLP library if needed
  // This regex attempts to split by common sentence endings followed by whitespace or end of string
  return text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text]
}

// Get supported Sarvam language code
const getSarvamLanguage = (detectedLang, defaultLang = "hi") => {
  const lang = detectedLang?.toLowerCase() || defaultLang
  if (lang === "hi") return "hi" // Explicitly return 'hi' for Hindi as requested
  if (lang === "en") return "en-US" // Sarvam typically uses en-US for English
  // Default for other Indian languages, assuming they need -IN extension
  return `${lang}-IN`
}

// Get Deepgram language code
const getDeepgramLanguage = (detectedLang, defaultLang = "hi") => {
  const lang = detectedLang?.toLowerCase() || defaultLang
  // Deepgram uses 'hi' for Hindi, 'en-US' for English
  if (lang === "hi") return "hi"
  if (lang === "en") return "en-US"
  // For other Indian languages, Deepgram might use just the base code or specific variants.
  return lang // Default to base code for others
}

// Function to get valid Sarvam voice
const getValidSarvamVoice = (voiceSelection) => {
  // Placeholder implementation, replace with actual logic
  return voiceSelection || "defaultVoice"
}

const setupUnifiedVoiceServer = (wss) => {
  console.log("🚀 Unified Voice WebSocket server initialized with Dynamic Language Detection")

  wss.on("connection", (ws, req) => {
    console.log("🔗 New unified voice connection established")
    console.log("📡 SIP Connection Details:", {
      timestamp: new Date().toISOString(),
      clientIP: req.socket.remoteAddress,
      userAgent: req.headers["user-agent"],
      origin: req.headers.origin,
    })

    // Session variables
    let sessionId = null
    let destinationNumber = null
    let sourceNumber = null
    let tenantId = null
    let agentConfig = null
    let currentLanguage = null // Track current conversation language
    let detectedLanguage = null // Track detected language from user input

    // API keys cache
    const apiKeys = {
      deepgram: null,
      sarvam: null,
      openai: null,
    }

    // Connection state
    let deepgramWs = null
    let deepgramReady = false
    let deepgramConnected = false
    let reconnectAttempts = 0
    const MAX_RECONNECT_ATTEMPTS = 5
    const reconnectDelay = 1000

    // Audio and conversation state
    let audioChunkCount = 0
    let connectionGreetingSent = false
    let userUtteranceBuffer = "" // Accumulates user's speech for LLM processing
    let lastDeepgramFinalTimestamp = 0 // To prevent processing same final transcript twice
    let isProcessingOpenAI = false
    let fullConversationHistory = []
    let silenceTimeout = null
    const SILENCE_DURATION = 2000 // 2 seconds of silence to trigger processing
    let isSpeaking = false // Indicates if user is actively speaking

    // Audio streaming and interruption management
    let shouldInterruptAudio = false // Flag to signal TTS to stop
    let greetingInProgress = false // Flag to prevent interruption during initial greeting

    // VAD state (for logging/debugging, not directly used for processing flow anymore)
    const vadState = {
      speechActive: false,
      lastSpeechStarted: null,
      lastUtteranceEnd: null,
      speechDuration: 0,
      silenceDuration: 0,
      totalSpeechEvents: 0,
      totalUtteranceEnds: 0,
    }

    // INSTANT GREETING: Send audio bytes immediately when DID matches
    const sendInstantGreeting = async (didNumber) => {
      const overallTimer = createTimer("INSTANT_GREETING_TOTAL")

      try {
        // Step 1: DID lookup - using didNumber directly
        const didTimer = createTimer("DID_LOOKUP")

        console.log(`🔍 [INSTANT_GREETING] DID lookup started:`, {
          didNumber,
          timestamp: new Date().toISOString(),
        })

        const agent = await Agent.findOne({ didNumber: didNumber }).lean() // Use didNumber directly
        didTimer.end()

        if (!agent) {
          console.error(`❌ [INSTANT_GREETING] No agent found for DID: ${didNumber}`)
          overallTimer.end()
          return null
        }

        // Set session variables immediately
        tenantId = agent.tenantId
        agentConfig = agent
        currentLanguage = agent.language || "hi"
        detectedLanguage = currentLanguage

        console.log(`✅ [INSTANT_GREETING] Agent matched instantly:`)
        console.log(`   - Agent Name: ${agent.agentName}`)
        console.log(`   - DID: ${agent.didNumber}`)
        console.log(`   - First Message: ${agent.firstMessage}`)
        console.log(`   - Audio Available: ${agent.audioBytes ? `YES (${agent.audioBytes.length} bytes)` : "NO"}`)

        // Step 2: Send greeting immediately - NO WAITING
        if (agent.audioBytes && agent.audioBytes.length > 0) {
          const audioTimer = createTimer("INSTANT_AUDIO_SEND")
          greetingInProgress = true // Set flag

          // Send audio bytes immediately
          const pythonBytesString = bufferToPythonBytesString(agent.audioBytes)

          const audioResponse = {
            data: {
              session_id: sessionId,
              count: 1,
              audio_bytes_to_play: pythonBytesString,
              sample_rate: agent.audioMetadata?.sampleRate || 22050,
              channels: 1,
              sample_width: 2,
              is_streaming: false,
              format: agent.audioMetadata?.format || "mp3",
            },
            type: "ai_response",
          }

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(audioResponse))
            ws.send(
              JSON.stringify({
                type: "ai_response_complete",
                session_id: sessionId,
                total_chunks: 1,
              }),
            )
            audioTimer.end()
            console.log(`🚀 [INSTANT_GREETING] Pre-generated audio sent INSTANTLY`)
          }
          greetingInProgress = false // Reset flag after sending
        } else {
          // No pre-generated audio - send text immediately and generate audio in background
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "instant_text_greeting",
                session_id: sessionId,
                message: agent.firstMessage,
                agent: agent.agentName,
                timestamp: new Date().toISOString(),
              }),
            )
            console.log(`📝 [INSTANT_GREETING] Text greeting sent instantly`)
          }

          // Generate audio in background - don't wait for it
          generateGreetingAudioBackground(agent)
        }

        connectionGreetingSent = true
        overallTimer.end()
        return agent
      } catch (error) {
        console.error(`❌ [INSTANT_GREETING] Error: ${error.message}`)
        overallTimer.end()
        return null
      }
    }

    // Background audio generation (non-blocking)
    const generateGreetingAudioBackground = async (agent) => {
      // Don't await - run in background
      setImmediate(async () => {
        const timer = createTimer("BACKGROUND_AUDIO_GENERATION")
        greetingInProgress = true // Set flag

        try {
          console.log(`🔄 [BACKGROUND_AUDIO] Starting generation for: ${agent.agentName}`)

          // Load API keys first
          const keysLoaded = await loadApiKeysForTenant(agent.tenantId)
          if (!keysLoaded || !apiKeys.sarvam) {
            console.error(`❌ [BACKGROUND_AUDIO] API keys not available`)
            timer.end()
            greetingInProgress = false
            return
          }

          const validVoice = getValidSarvamVoice(agent.voiceSelection)
          const sarvamLanguage = getSarvamLanguage(currentLanguage)

          const sarvamTimer = createTimer("SARVAM_TTS_BACKGROUND")

          const requestBody = {
            inputs: [agent.firstMessage],
            target_language_code: sarvamLanguage,
            speaker: validVoice,
            pitch: 0,
            pace: 1.0,
            loudness: 1.0,
            speech_sample_rate: 22050,
            enable_preprocessing: true,
            model: "bulbul:v2",
          }

          const response = await fetch("https://api.sarvam.ai/text-to-speech", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "API-Subscription-Key": apiKeys.sarvam,
            },
            body: JSON.stringify(requestBody),
          })

          sarvamTimer.end()

          if (response.ok) {
            const responseData = await response.json()
            if (responseData.audios && responseData.audios.length > 0) {
              const audioBuffer = Buffer.from(responseData.audios[0], "base64")
              const pythonBytesString = bufferToPythonBytesString(audioBuffer)

              // Send audio immediately
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
                ws.send(
                  JSON.stringify({
                    type: "ai_response_complete",
                    session_id: sessionId,
                    total_chunks: 1,
                  }),
                )
                console.log(`🎵 [BACKGROUND_AUDIO] Audio generated and sent: ${audioBuffer.length} bytes`)
              }

              // Save for future use
              await Agent.updateOne(
                { _id: agent._id },
                {
                  audioBytes: audioBuffer,
                  audioMetadata: {
                    format: "mp3",
                    sampleRate: 22050,
                    channels: 1,
                    size: audioBuffer.length,
                    generatedAt: new Date(),
                    language: currentLanguage,
                    speaker: validVoice,
                    provider: "sarvam",
                  },
                },
              )

              console.log(`✅ [BACKGROUND_AUDIO] Audio saved for future instant use`)
            }
          } else {
            console.error(`❌ [BACKGROUND_AUDIO] Sarvam API error: ${response.status}`)
          }

          timer.end()
        } catch (error) {
          console.error(`❌ [BACKGROUND_AUDIO] Error: ${error.message}`)
          timer.end()
        } finally {
          greetingInProgress = false // Reset flag
        }
      })
    }

    // Load API keys for the tenant with timing
    const loadApiKeysForTenant = async (tenantId) => {
      const timer = createTimer("API_KEYS_LOAD")

      try {
        console.log(`🔑 [API_KEYS] Loading keys for tenant: ${tenantId}`)

        const keys = await ApiKey.find({
          tenantId,
          isActive: true,
        }).lean()

        timer.checkpoint("DB_QUERY_COMPLETE")

        if (keys.length === 0) {
          console.error(`❌ [API_KEYS] No active API keys found for tenant: ${tenantId}`)
          timer.end()
          return false
        }

        const decryptTimer = createTimer("API_KEYS_DECRYPT")

        for (const keyDoc of keys) {
          const decryptedKey = ApiKey.decryptKey(keyDoc.encryptedKey)

          switch (keyDoc.provider) {
            case "deepgram":
              apiKeys.deepgram = decryptedKey
              console.log(`✅ [API_KEYS] Deepgram key loaded`)
              break
            case "sarvam":
              apiKeys.sarvam = decryptedKey
              console.log(`✅ [API_KEYS] Sarvam key loaded`)
              break
            case "openai":
              apiKeys.openai = decryptedKey
              console.log(`✅ [API_KEYS] OpenAI key loaded`)
              break
          }

          ApiKey.updateOne(
            { _id: keyDoc._id },
            {
              $inc: { "usage.totalRequests": 1 },
              $set: { "usage.lastUsed": new Date() },
            },
          ).exec()
        }

        decryptTimer.end()

        console.log(`🔑 [API_KEYS] Providers ready:`)
        console.log(`   - Deepgram (STT): ${apiKeys.deepgram ? "✅" : "❌"}`)
        console.log(`   - Sarvam (TTS): ${apiKeys.sarvam ? "✅" : "❌"}`)
        console.log(`   - OpenAI (LLM): ${apiKeys.openai ? "✅" : "❌"}`)

        timer.end()
        return true
      } catch (error) {
        console.error(`❌ [API_KEYS] Error: ${error.message}`)
        timer.end()
        return false
      }
    }

    // Language detection using OpenAI with timing
    const detectLanguage = async (text) => {
      const timer = createTimer("LANGUAGE_DETECTION")

      try {
        if (!apiKeys.openai || !text.trim()) {
          timer.end()
          return currentLanguage || "hi"
        }

        const requestBody = {
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a language detector. Detect the language of the given text and respond with just the language code (hi for Hindi, en for English, bn for Bengali, te for Telugu, ta for Tamil, mr for Marathi, gu for Gujarati, kn for Kannada, ml for Malayalam, pa for Punjabi, or for Odia, as for Assamese, ur for Urdu). If you're unsure or the text is mixed, respond with the dominant language. Only respond with the language code, nothing else.`,
            },
            {
              role: "user",
              content: text,
            },
          ],
          max_tokens: 10,
          temperature: 0.1,
        }

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKeys.openai}`,
          },
          body: JSON.stringify(requestBody),
        })

        timer.checkpoint("OPENAI_RESPONSE_RECEIVED")

        if (!response.ok) {
          console.error(`❌ [LANGUAGE_DETECT] OpenAI API error: ${response.status}`)
          timer.end()
          return currentLanguage || "hi"
        }

        const data = await response.json()
        if (data.choices && data.choices[0] && data.choices[0].message) {
          const detectedLang = data.choices[0].message.content.trim().toLowerCase()
          console.log(`🌐 [LANGUAGE_DETECT] Detected: ${detectedLang} from text: "${text}"`)
          timer.end()
          return detectedLang
        }

        timer.end()
        return currentLanguage || "hi"
      } catch (error) {
        console.error(`❌ [LANGUAGE_DETECT] Error: ${error.message}`)
        timer.end()
        return currentLanguage || "hi"
      }
    }

    // Optimized Deepgram connection with timing
    const connectToDeepgram = async () => {
      const timer = createTimer("DEEPGRAM_CONNECTION")

      return new Promise((resolve, reject) => {
        try {
          if (!apiKeys.deepgram) {
            timer.end()
            reject(new Error("Deepgram API key not available"))
            return
          }

          const deepgramLanguage = getDeepgramLanguage(currentLanguage)
          const deepgramUrl = new URL("wss://api.deepgram.com/v1/listen")
          deepgramUrl.searchParams.append("sample_rate", "8000")
          deepgramUrl.searchParams.append("channels", "1")
          deepgramUrl.searchParams.append("encoding", "linear16")
          deepgramUrl.searchParams.append("model", "nova-2")
          deepgramUrl.searchParams.append("language", deepgramLanguage)
          deepgramUrl.searchParams.append("interim_results", "true")
          deepgramUrl.searchParams.append("smart_format", "true")
          deepgramUrl.searchParams.append("endpointing", "300") // Adjust endpointing for faster utterance detection

          console.log(`🎤 [DEEPGRAM] Connecting with language: ${deepgramLanguage}`)

          deepgramWs = new WebSocket(deepgramUrl.toString(), {
            headers: { Authorization: `Token ${apiKeys.deepgram}` },
          })
          deepgramWs.binaryType = "arraybuffer"

          const connectionTimeout = setTimeout(() => {
            if (deepgramWs) deepgramWs.close()
            timer.end()
            reject(new Error("Deepgram connection timeout"))
          }, 10000)

          deepgramWs.onopen = () => {
            clearTimeout(connectionTimeout)
            deepgramReady = true
            deepgramConnected = true
            reconnectAttempts = 0
            timer.end()
            console.log(`✅ [DEEPGRAM] Connected and ready with language: ${deepgramLanguage}`)
            resolve()
          }

          deepgramWs.onmessage = async (event) => {
            try {
              const data = JSON.parse(event.data)
              await handleDeepgramResponse(data)
            } catch (parseError) {
              console.error("❌ [DEEPGRAM] Parse error:", parseError.message)
            }
          }

          deepgramWs.onerror = (error) => {
            clearTimeout(connectionTimeout)
            deepgramReady = false
            deepgramConnected = false
            timer.end()
            console.error("❌ [DEEPGRAM] Connection error:", error.message)
            reject(error)
          }

          deepgramWs.onclose = (event) => {
            clearTimeout(connectionTimeout)
            deepgramReady = false
            deepgramConnected = false
            console.log(`🎙️ [DEEPGRAM] Connection closed: ${event.code}`)

            if (event.code !== 1000 && sessionId && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
              reconnectAttempts++
              const delay = Math.min(reconnectDelay * Math.pow(2, reconnectAttempts - 1), 30000)
              console.log(`🔄 [DEEPGRAM] Reconnecting in ${delay}ms (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)

              setTimeout(() => {
                connectToDeepgram().catch((err) => {
                  console.error("❌ [DEEPGRAM] Reconnection failed:", err.message)
                })
              }, delay)
            }
          }
        } catch (error) {
          console.error("❌ [DEEPGRAM] Setup error:", error.message)
          timer.end()
          reject(error)
        }
      })
    }

    // New function to process user utterance (LLM + TTS)
    const processUserUtterance = async (text) => {
      if (!text.trim() || isProcessingOpenAI) {
        console.log(`📝 [UTTERANCE_PROCESS] Skipping (empty or OpenAI busy): "${text}"`)
        return
      }
      console.log(`📝 [UTTERANCE_PROCESS] Processing: "${text}"`)

      // Detect language first
      const newDetectedLanguage = await detectLanguage(text)
      if (newDetectedLanguage !== detectedLanguage) {
        detectedLanguage = newDetectedLanguage
        console.log(`🌐 [LANGUAGE_SWITCH] Language changed to: ${detectedLanguage}`)
      }

      const openaiResponse = await sendToOpenAI(text)
      if (openaiResponse) {
        await synthesizeWithSarvam(openaiResponse, detectedLanguage)
      }
    }

    // Handle Deepgram responses with timing
    const handleDeepgramResponse = async (data) => {
      const timer = createTimer("DEEPGRAM_RESPONSE_PROCESSING")

      if (data.type === "Results") {
        const channel = data.channel
        if (channel && channel.alternatives && channel.alternatives.length > 0) {
          const transcript = channel.alternatives[0].transcript
          const confidence = channel.alternatives[0].confidence
          const is_final = data.is_final

          console.log(`🎤 [DEEPGRAM] Transcript: "${transcript}" (confidence: ${confidence}, final: ${is_final})`)

          if (transcript && transcript.trim()) {
            resetSilenceTimer() // User is speaking, reset silence timer

            if (is_final) {
              // Only process if this final transcript is new or significantly different
              // This helps prevent processing the same final segment multiple times
              if (Date.now() - lastDeepgramFinalTimestamp > 500 || !userUtteranceBuffer.includes(transcript.trim())) {
                userUtteranceBuffer += (userUtteranceBuffer ? " " : "") + transcript.trim()
                console.log(`🎤 [DEEPGRAM] Final transcript added to buffer: "${userUtteranceBuffer}"`)
                await processUserUtterance(userUtteranceBuffer)
                userUtteranceBuffer = "" // Clear buffer after processing
                lastDeepgramFinalTimestamp = Date.now()
              }
              isSpeaking = false // User finished speaking for this utterance
              startSilenceTimer() // Start silence timer after final utterance
            } else {
              // Interim results - update client if needed, but don't process with LLM yet
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "transcript_interim", // New type for interim
                    data: transcript,
                    confidence: confidence,
                    is_final: false,
                    language: currentLanguage,
                    agent: agentConfig?.agentName,
                  }),
                )
              }
              // Do NOT accumulate interim results into userUtteranceBuffer for LLM processing
              // The final transcript or silence will trigger the full utterance processing
            }
          }
        }
      } else if (data.type === "SpeechStarted") {
        console.log(`🎤 [DEEPGRAM] Speech started`)
        if (shouldInterruptAudio === false && greetingInProgress === false) {
          // Only interrupt if not already interrupting and not greeting
          interruptCurrentAudio()
        }
        resetSilenceTimer()
        isSpeaking = true
        userUtteranceBuffer = "" // Clear buffer on new speech start
      } else if (data.type === "UtteranceEnd") {
        console.log(`🎤 [DEEPGRAM] Utterance ended`)
        if (isSpeaking) {
          isSpeaking = false
          // If there's accumulated speech that hasn't been finalized by Deepgram yet, process it
          if (userUtteranceBuffer.trim()) {
            console.log(`🎤 [DEEPGRAM] Utterance end, processing buffer: "${userUtteranceBuffer}"`)
            await processUserUtterance(userUtteranceBuffer)
            userUtteranceBuffer = "" // Clear buffer after processing
          }
          startSilenceTimer() // Start silence timer after utterance ends
        }
      }

      timer.end()
    }

    // Audio interruption handler
    const interruptCurrentAudio = () => {
      if (greetingInProgress) {
        console.log("🛑 [AUDIO] Interruption blocked - greeting in progress")
        return
      }

      console.log("🛑 [AUDIO] Interrupting current audio playback")
      shouldInterruptAudio = true
      // No need to close currentTTSSocket if we're doing chunked TTS, as each chunk is a new fetch
      // The loop in synthesizeWithSarvam will check shouldInterruptAudio
    }

    // Silence detection
    const startSilenceTimer = () => {
      if (silenceTimeout) {
        clearTimeout(silenceTimeout)
      }

      vadState.lastUtteranceEnd = Date.now()

      silenceTimeout = setTimeout(() => {
        vadState.silenceDuration = Date.now() - vadState.lastUtteranceEnd
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
    }

    const handleSilenceDetected = async () => {
      console.log(`🔇 [SILENCE] Detected after ${vadState.silenceDuration}ms`)
      // If there's any accumulated speech and we're not already processing OpenAI
      if (userUtteranceBuffer.trim() && !isProcessingOpenAI) {
        console.log(`🔇 [SILENCE] Processing buffer due to silence: "${userUtteranceBuffer}"`)
        await processUserUtterance(userUtteranceBuffer)
        userUtteranceBuffer = "" // Clear buffer after processing
      }
    }

    // Send audio to Deepgram with timing
    const sendAudioToDeepgram = async (audioData) => {
      if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN || !deepgramReady) {
        return false
      }

      try {
        const buffer = audioData instanceof Buffer ? audioData : Buffer.from(audioData)
        if (buffer.length >= 320) {
          // Deepgram expects chunks of at least 320 bytes for 8kHz 16-bit mono
          deepgramWs.send(buffer)
          return true
        }
        return false
      } catch (error) {
        console.error("❌ [DEEPGRAM] Send error:", error.message)
        return false
      }
    }

    // Enhanced OpenAI Integration with timing
    const sendToOpenAI = async (userMessage) => {
      if (isProcessingOpenAI || !apiKeys.openai || !userMessage.trim()) {
        return null
      }

      const timer = createTimer("OPENAI_PROCESSING")
      isProcessingOpenAI = true

      try {
        fullConversationHistory.push({
          role: "user",
          content: userMessage,
        })

        // Enhanced system prompt with all agent profile fields
        const systemPrompt = `You are ${agentConfig?.agentName || "an AI assistant"}, a ${agentConfig?.category || "helpful"} voice assistant.

AGENT PROFILE:
- Name: ${agentConfig?.agentName || "Assistant"}
- Description: ${agentConfig?.description || "A helpful AI assistant"}
- Category: ${agentConfig?.category || "General"}
- Personality: ${agentConfig?.personality || "formal"} (be ${agentConfig?.personality || "formal"} in your responses)
- Brand Info: ${agentConfig?.brandInfo || "No specific brand information"}
- Context Memory: ${agentConfig?.contextMemory || "No additional context"}

LANGUAGE INSTRUCTIONS:
- Default language: ${currentLanguage || agentConfig?.language || "hi"}
- Current user language: ${detectedLanguage || currentLanguage || "hi"}
- Always respond in the same language the user is speaking
- If user speaks in ${detectedLanguage}, respond in ${detectedLanguage}
- Maintain your personality and characteristics regardless of language

RESPONSE GUIDELINES:
- Keep responses very short and conversational for phone calls (1-2 sentences max)
- Match the user's language exactly
- Be ${agentConfig?.personality || "formal"} in your tone
- Stay in character as ${agentConfig?.agentName || "Assistant"}
- Consider the context: ${agentConfig?.contextMemory || "general conversation"}`

        const requestBody = {
          model: agentConfig?.llmSelection === "openai" ? "gpt-4o-mini" : "gpt-4o-mini",
          messages: [{ role: "system", content: systemPrompt }, ...fullConversationHistory.slice(-10)],
          max_tokens: 150,
          temperature: agentConfig?.personality === "formal" ? 0.3 : 0.7,
        }

        console.log(`🤖 [OPENAI] Sending request with:`)
        console.log(`   - Language: ${detectedLanguage || currentLanguage}`)
        console.log(`   - Personality: ${agentConfig?.personality || "formal"}`)
        console.log(`   - Model: ${requestBody.model}`)

        const openaiTimer = createTimer("OPENAI_API_CALL")
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKeys.openai}`,
          },
          body: JSON.stringify(requestBody),
        })
        openaiTimer.end()

        if (!response.ok) {
          console.error(`❌ [OPENAI] API error: ${response.status}`)
          timer.end()
          return null
        }

        const parseTimer = createTimer("OPENAI_RESPONSE_PARSE")
        const data = await response.json()
        parseTimer.end()

        if (data.choices && data.choices[0] && data.choices[0].message) {
          const openaiResponse = data.choices[0].message.content

          fullConversationHistory.push({
            role: "assistant",
            content: openaiResponse,
          })

          console.log(`🤖 [OPENAI] Response received: "${openaiResponse}"`)
          timer.end()
          return openaiResponse
        }

        timer.end()
        return null
      } catch (error) {
        console.error(`❌ [OPENAI] Error: ${error.message}`)
        timer.end()
        return null
      } finally {
        isProcessingOpenAI = false
      }
    }

    // Enhanced Sarvam TTS Synthesis with simulated streaming
    const synthesizeWithSarvam = async (text, targetLanguage = null) => {
      if (!apiKeys.sarvam || !text.trim()) {
        return
      }

      const sentences = splitIntoSentences(text)
      const useLanguage = targetLanguage || currentLanguage || "hi"
      const validVoice = getValidSarvamVoice(agentConfig?.voiceSelection)
      const sarvamLanguage = getSarvamLanguage(useLanguage)

      console.log(`🎵 [SARVAM] Starting TTS generation for ${sentences.length} chunks.`)
      shouldInterruptAudio = false // Reset interruption flag for new response

      for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i]
        if (shouldInterruptAudio) {
          console.log("🛑 [SARVAM] Interrupted during sentence processing.")
          break // Stop processing further chunks
        }

        const timer = createTimer(`SARVAM_TTS_PROCESSING_CHUNK_${i}`)
        try {
          console.log(`🎵 [SARVAM] Generating TTS for chunk ${i + 1}/${sentences.length}: "${sentence}"`)
          console.log(`   - Language: ${sarvamLanguage}`)
          console.log(`   - Voice: ${validVoice} (mapped from: ${agentConfig?.voiceSelection || "default"})`)
          console.log(`   - Agent: ${agentConfig?.agentName}`)

          const requestBody = {
            inputs: [sentence], // Send one sentence at a time
            target_language_code: sarvamLanguage,
            speaker: validVoice,
            pitch: 0,
            pace: 1.0,
            loudness: 1.0,
            speech_sample_rate: 22050,
            enable_preprocessing: true,
            model: "bulbul:v2",
          }

          const apiTimer = createTimer(`SARVAM_API_CALL_CHUNK_${i}`)
          const response = await fetch("https://api.sarvam.ai/text-to-speech", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "API-Subscription-Key": apiKeys.sarvam,
            },
            body: JSON.stringify(requestBody),
          })
          apiTimer.end()

          if (!response.ok) {
            const errorText = await response.text()
            console.error(`❌ [SARVAM] API error for chunk ${i + 1}: ${response.status}`, errorText)
            throw new Error(`Sarvam API error: ${response.status}`)
          }

          const parseTimer = createTimer(`SARVAM_RESPONSE_PARSE_CHUNK_${i}`)
          const responseData = await response.json()
          parseTimer.end()

          if (!responseData.audios || responseData.audios.length === 0) {
            throw new Error("No audio data received for chunk")
          }

          const audioBase64 = responseData.audios[0]
          const audioBuffer = Buffer.from(audioBase64, "base64")
          const pythonBytesString = bufferToPythonBytesString(audioBuffer)

          const audioResponse = {
            data: {
              session_id: sessionId,
              count: i + 1, // Chunk count
              audio_bytes_to_play: pythonBytesString,
              sample_rate: 22050,
              channels: 1,
              sample_width: 2,
              is_streaming: false, // Still sending full audio per chunk, not byte stream
              format: "mp3",
            },
            type: "ai_response",
          }

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(audioResponse))
            console.log(`✅ [SARVAM] Audio chunk ${i + 1} sent (${audioBuffer.length} bytes)`)
          }

          timer.end()
        } catch (error) {
          console.error(`❌ [SARVAM] Error processing chunk ${i + 1}: ${error.message}`)
          timer.end()
          // Continue to next chunk even if one fails
        }
      }
      // After all chunks are sent (or interrupted), signal completion
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "ai_response_complete",
            session_id: sessionId,
            total_chunks: sentences.length,
          }),
        )
      }
    }

    // Utility function
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

    // WebSocket message handling
    ws.on("message", async (message) => {
      const messageTimer = createTimer("MESSAGE_PROCESSING")

      try {
        let isTextMessage = false
        let data = null

        if (typeof message === "string") {
          isTextMessage = true
          try {
            data = JSON.parse(message)
          } catch (parseError) {
            console.error("❌ Failed to parse JSON:", parseError.message)
            messageTimer.end()
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
          console.log(`📨 [MESSAGE] Received: `, data)

          if (data.event === "start" && data.session_id) {
            sessionId = data.session_id
            destinationNumber = data.Destination
            sourceNumber = data.Source

            console.log(`✅ [SESSION] SIP Call Started:`)
            console.log(`   - Session ID: ${sessionId}`)
            console.log(`   - Source: ${sourceNumber}`)
            console.log(`   - Destination (DID): ${destinationNumber}`)

            // IMMEDIATE ACTION: Send greeting without waiting for anything else
            const agent = await sendInstantGreeting(destinationNumber)
            if (!agent) {
              console.error(`❌ [SESSION] No agent found for DID: ${destinationNumber}`)
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: `No agent configured for DID: ${destinationNumber}`,
                  session_id: sessionId,
                }),
              )
              messageTimer.end()
              return
            }

            // Load API keys in background
            const keysLoaded = await loadApiKeysForTenant(tenantId)
            if (!keysLoaded) {
              console.error(`❌ [SESSION] API keys not available for tenant: ${tenantId}`)
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "API keys not configured for tenant",
                  session_id: sessionId,
                }),
              )
              messageTimer.end()
              return
            }

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "session_started",
                  session_id: sessionId,
                  agent: agentConfig.agentName,
                  did_number: destinationNumber,
                  tenant_id: tenantId,
                  providers: {
                    stt: agentConfig.sttSelection || "deepgram",
                    tts: agentConfig.ttsSelection || "sarvam",
                    llm: agentConfig.llmSelection || "openai",
                  },
                  message: "Agent matched and greeting sent",
                }),
              )
            }

            // Connect to Deepgram in background
            try {
              await connectToDeepgram()
              console.log(`✅ [SESSION] Deepgram connected for ${agentConfig.agentName}`)
            } catch (error) {
              console.error(`❌ [SESSION] Deepgram connection failed: ${error.message}`)
            }
          } else if (data.type === "synthesize") {
            if (data.session_id) {
              sessionId = data.session_id
            }
            await synthesizeWithSarvam(data.text, data.language || currentLanguage)
          } else if (data.data && data.data.hangup === "true") {
            console.log(`📞 [SESSION] Hangup for session ${sessionId}`)

            if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
              deepgramWs.close(1000, "Call ended")
            }

            shouldInterruptAudio = true // Ensure any ongoing TTS stops

            ws.close(1000, "Hangup requested")
          }
        } else {
          // This is audio data
          if (deepgramConnected && deepgramReady) {
            await sendAudioToDeepgram(message)
          }
        }

        messageTimer.end()
      } catch (error) {
        console.error(`❌ [MESSAGE] Processing error: ${error.message}`)
        messageTimer.end()
      }
    })

    // Connection cleanup
    ws.on("close", () => {
      const cleanupTimer = createTimer("SESSION_CLEANUP")

      console.log(`🔗 [SESSION] Connection closed for session ${sessionId}`)
      console.log(
        `📊 [STATS] Agent: ${agentConfig?.agentName || "Unknown"}, DID: ${destinationNumber}, Tenant: ${tenantId}`,
      )

      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.close(1000, "Session ended")
      }

      resetSilenceTimer()
      sessionId = null
      destinationNumber = null
      sourceNumber = null
      tenantId = null
      agentConfig = null
      currentLanguage = null
      detectedLanguage = null
      audioChunkCount = 0
      deepgramReady = false
      deepgramConnected = false
      connectionGreetingSent = false
      userUtteranceBuffer = "" // Clear buffer
      isSpeaking = false
      shouldInterruptAudio = true
      greetingInProgress = false
      fullConversationHistory = []

      cleanupTimer.end()
    })

    ws.on("error", (error) => {
      console.error(`❌ [SESSION] WebSocket error: ${error.message}`)
      shouldInterruptAudio = true // Ensure any ongoing TTS stops
    })

    console.log(`✅ [SESSION] WebSocket ready, waiting for SIP start event`)
  })
}

module.exports = { setupUnifiedVoiceServer }
