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

// Language detection and mapping
const SUPPORTED_LANGUAGES = {
  'hi': 'hi-IN',
  'en': 'en-US',
  'hi-IN': 'hi-IN',
  'en-US': 'en-US',
  'bn': 'bn-IN',
  'te': 'te-IN',
  'ml': 'ml-IN',
  'ta': 'ta-IN',
  'kn': 'kn-IN',
  'gu': 'gu-IN',
  'mr': 'mr-IN',
  'or': 'or-IN',
  'pa': 'pa-IN',
  'ur': 'ur-IN'
}

const LANGUAGE_NAMES = {
  'hi': 'Hindi',
  'en': 'English',
  'hi-IN': 'Hindi',
  'en-US': 'English',
  'bn': 'Bengali',
  'te': 'Telugu',
  'ml': 'Malayalam',
  'ta': 'Tamil',
  'kn': 'Kannada',
  'gu': 'Gujarati',
  'mr': 'Marathi',
  'or': 'Odia',
  'pa': 'Punjabi',
  'ur': 'Urdu'
}

// Helper to normalize DID
function normalizeDID(did) {
  let str = String(did).trim()
  str = str.replace(/\D/g, "")
  return str.padStart(11, '0')
}

// Language detection function
function detectLanguage(text) {
  if (!text || text.trim().length === 0) return null
  
  const textLower = text.toLowerCase()
  
  // Hindi patterns
  const hindiPatterns = [
    /[\u0900-\u097F]/,  // Devanagari script
    /\b(मैं|आप|हम|तुम|यह|वह|कैसे|कहाँ|कब|क्या|हाँ|नहीं|जी|नमस्ते|धन्यवाद)\b/,
    /\b(hai|hoon|hain|kya|kaise|kahan|kab|nahin|nahi|ji|namaste|dhanyawad)\b/
  ]
  
  // English patterns
  const englishPatterns = [
    /\b(i|you|we|they|this|that|how|where|when|what|yes|no|hello|thank|thanks)\b/,
    /^[a-zA-Z0-9\s.,!?'"()-]+$/
  ]
  
  // Bengali patterns
  const bengaliPatterns = [
    /[\u0980-\u09FF]/,  // Bengali script
    /\b(আমি|আপনি|আমরা|তুমি|এই|সেই|কিভাবে|কোথায়|কখন|কি|হ্যাঁ|না|নমস্কার|ধন্যবাদ)\b/
  ]
  
  // Check for Hindi
  if (hindiPatterns.some(pattern => pattern.test(textLower))) {
    return 'hi-IN'
  }
  
  // Check for Bengali
  if (bengaliPatterns.some(pattern => pattern.test(textLower))) {
    return 'bn-IN'
  }
  
  // Check for English
  if (englishPatterns.some(pattern => pattern.test(textLower))) {
    return 'en-US'
  }
  
  // Default to Hindi if no clear detection
  return 'hi-IN'
}

// Get appropriate voice for language
function getVoiceForLanguage(language, agentVoice = 'anushka') {
  const voiceMap = {
    'hi-IN': ['anushka', 'meera', 'pavithra', 'maitreyi', 'diya', 'maya', 'manisha', 'vidya', 'arya'],
    'en-US': ['female-professional', 'male-professional', 'female-friendly', 'male-friendly'],
    'bn-IN': ['anushka', 'meera'], // Bengali support with available voices
    'te-IN': ['pavithra', 'maitreyi'],
    'ml-IN': ['meera', 'pavithra'],
    'ta-IN': ['diya', 'maya'],
    'kn-IN': ['manisha', 'vidya'],
    'gu-IN': ['arya', 'anushka'],
    'mr-IN': ['maitreyi', 'pavithra'],
    'or-IN': ['meera', 'diya'],
    'pa-IN': ['anushka', 'maya'],
    'ur-IN': ['anushka', 'meera']
  }
  
  const availableVoices = voiceMap[language] || voiceMap['hi-IN']
  return availableVoices.includes(agentVoice) ? agentVoice : availableVoices[0]
}

const setupUnifiedVoiceServer = (wss) => {
  console.log("🚀 Enhanced Unified Voice WebSocket server initialized with Dynamic Language Detection")

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
    let currentLanguage = null // Dynamic language tracking
    let detectedLanguage = null

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
    let shouldInterruptAudio = false
    let greetingInProgress = false

    // VAD state
    const vadState = {
      speechActive: false,
      lastSpeechStarted: null,
      lastUtteranceEnd: null,
      speechDuration: 0,
      silenceDuration: 0,
      totalSpeechEvents: 0,
      totalUtteranceEnds: 0,
    }

    // Fast DID-based agent lookup with immediate audio response
    const loadAgentByDIDAndSendGreeting = async (didNumber) => {
      try {
        const originalDid = didNumber
        const normalizedDid = normalizeDID(didNumber)
        console.log(`🔍 [AGENT_LOOKUP] Searching for agent with DID:`, {
          originalDid,
          normalizedDid,
          type: typeof didNumber
        })
        const startTime = Date.now()

        // Direct DID lookup from AgentProfile collection
        const agent = await Agent.findOne({ didNumber: normalizedDid })
        const lookupTime = Date.now() - startTime
        console.log(`⚡ [AGENT_LOOKUP] DID lookup completed in ${lookupTime}ms`)

        if (!agent) {
          console.error(`❌ [AGENT_LOOKUP] No agent found for DID: ${normalizedDid}`)
          return null
        }

        // Set session variables
        tenantId = agent.tenantId
        agentConfig = agent
        currentLanguage = agent.language || 'hi-IN' // Set default language from agent profile
        detectedLanguage = currentLanguage

        console.log(`✅ [AGENT_LOOKUP] Agent found:`)
        console.log(`   - Agent Name: ${agent.agentName}`)
        console.log(`   - Tenant ID: ${agent.tenantId}`)
        console.log(`   - DID Number: ${agent.didNumber}`)
        console.log(`   - Default Language: ${currentLanguage}`)
        console.log(`   - Personality: ${agent.personality}`)
        console.log(`   - Voice Selection: ${agent.voiceSelection}`)
        console.log(`   - First Message: ${agent.firstMessage}`)
        console.log(`   - Pre-generated Audio: ${agent.audioBytes ? `✅ Available (${agent.audioBytes.length} bytes)` : "❌ Not Available"}`)

        // IMMEDIATELY send greeting if audio bytes are available
        if (agent.audioBytes && agent.audioBytes.length > 0) {
          await sendImmediateGreeting(agent)
        }

        return agent
      } catch (error) {
        console.error(`❌ [AGENT_LOOKUP] Error: ${error.message}`)
        return null
      }
    }

    // Send immediate greeting with pre-generated audio bytes
    const sendImmediateGreeting = async (agent) => {
      if (connectionGreetingSent || !sessionId) {
        return
      }

      console.log(`🚀 [IMMEDIATE_GREETING] Sending for agent: ${agent.agentName}`)
      
      try {
        greetingInProgress = true
        
        const audioBuffer = agent.audioBytes
        const pythonBytesString = bufferToPythonBytesString(audioBuffer)

        const audioResponse = {
          data: {
            session_id: sessionId,
            count: 1,
            audio_bytes_to_play: pythonBytesString,
            sample_rate: agent.audioMetadata?.sampleRate || 22050,
            channels: agent.audioMetadata?.channels || 1,
            sample_width: 2,
            is_streaming: false,
            format: agent.audioMetadata?.format || "mp3",
            language: currentLanguage,
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
          console.log(`✅ [IMMEDIATE_GREETING] Audio bytes sent successfully (${audioBuffer.length} bytes)`)
        }

        connectionGreetingSent = true
        greetingInProgress = false
        isPlayingAudio = true

        setTimeout(() => {
          isPlayingAudio = false
        }, 3000)

      } catch (error) {
        console.error(`❌ [IMMEDIATE_GREETING] Error: ${error.message}`)
        greetingInProgress = false
      }
    }

    // Load API keys for the tenant
    const loadApiKeysForTenant = async (tenantId) => {
      try {
        console.log(`🔑 [API_KEYS] Loading keys for tenant: ${tenantId}`)
        const startTime = Date.now()

        const keys = await ApiKey.find({
          tenantId,
          isActive: true,
        }).lean()

        const loadTime = Date.now() - startTime
        console.log(`⚡ [API_KEYS] Keys loaded in ${loadTime}ms`)

        if (keys.length === 0) {
          console.error(`❌ [API_KEYS] No active API keys found for tenant: ${tenantId}`)
          return false
        }

        // Decrypt and assign API keys
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

          // Update usage statistics asynchronously
          ApiKey.updateOne(
            { _id: keyDoc._id },
            {
              $inc: { "usage.totalRequests": 1 },
              $set: { "usage.lastUsed": new Date() },
            },
          ).exec()
        }

        console.log(`🔑 [API_KEYS] Providers ready:`)
        console.log(`   - Deepgram (STT): ${apiKeys.deepgram ? "✅" : "❌"}`)
        console.log(`   - Sarvam (TTS): ${apiKeys.sarvam ? "✅" : "❌"}`)
        console.log(`   - OpenAI (LLM): ${apiKeys.openai ? "✅" : "❌"}`)

        return true
      } catch (error) {
        console.error(`❌ [API_KEYS] Error: ${error.message}`)
        return false
      }
    }

    // Generate and save audio bytes for agents without pre-generated audio
    const generateAndSaveAudioBytes = async (text, agentId, useCurrentLanguage = false) => {
      try {
        const targetLanguage = useCurrentLanguage ? currentLanguage : (agentConfig?.language || 'hi-IN')
        const voice = getVoiceForLanguage(targetLanguage, agentConfig?.voiceSelection)
        
        console.log(`🎵 [AUDIO_GEN] Generating audio bytes for: "${text}"`)
        console.log(`   - Language: ${targetLanguage}`)
        console.log(`   - Voice: ${voice}`)

        if (!apiKeys.sarvam) {
          throw new Error("Sarvam API key not available")
        }

        const requestBody = {
          inputs: [text],
          target_language_code: targetLanguage,
          speaker: voice,
          pitch: 0,
          pace: 1.0,
          loudness: 1.0,
          speech_sample_rate: 22050,
          enable_preprocessing: true,
          model: "bulbul:v2",
        }

        console.log(`🎵 [AUDIO_GEN] Request body:`, requestBody)

        const response = await fetch("https://api.sarvam.ai/text-to-speech", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "API-Subscription-Key": apiKeys.sarvam,
          },
          body: JSON.stringify(requestBody),
        })

        if (!response.ok) {
          const errorText = await response.text()
          console.error(`❌ [AUDIO_GEN] Sarvam API error: ${response.status} - ${errorText}`)
          throw new Error(`Sarvam API error: ${response.status} - ${errorText}`)
        }

        const responseData = await response.json()
        if (!responseData.audios || responseData.audios.length === 0) {
          throw new Error("No audio data received from Sarvam API")
        }

        const audioBase64 = responseData.audios[0]
        const audioBuffer = Buffer.from(audioBase64, "base64")

        // Save audio bytes to database only if it's the first message
        if (!useCurrentLanguage) {
          await Agent.updateOne(
            { _id: agentId },
            {
              audioBytes: audioBuffer,
              audioMetadata: {
                format: "mp3",
                sampleRate: 22050,
                channels: 1,
                size: audioBuffer.length,
                generatedAt: new Date(),
                language: targetLanguage,
                speaker: voice,
                provider: "sarvam",
              },
            },
          )
          console.log(`✅ [AUDIO_GEN] Audio bytes saved to database: ${audioBuffer.length} bytes`)
        }

        return audioBuffer
      } catch (error) {
        console.error(`❌ [AUDIO_GEN] Error: ${error.message}`)
        return null
      }
    }

    // Fallback greeting for agents without pre-generated audio
    const sendFallbackGreeting = async () => {
      if (connectionGreetingSent || !sessionId || !agentConfig) {
        return
      }

      console.log(`🔄 [FALLBACK_GREETING] Generating for agent: ${agentConfig.agentName}`)

      try {
        greetingInProgress = true

        const audioBuffer = await generateAndSaveAudioBytes(agentConfig.firstMessage, agentConfig._id, false)

        if (audioBuffer) {
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
              language: currentLanguage,
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
            console.log(`✅ [FALLBACK_GREETING] Audio bytes sent successfully (${audioBuffer.length} bytes)`)
          }
        } else {
          throw new Error("Failed to generate audio")
        }

        connectionGreetingSent = true
        greetingInProgress = false
        isPlayingAudio = true

        setTimeout(() => {
          isPlayingAudio = false
        }, 3000)

      } catch (error) {
        console.error(`❌ [FALLBACK_GREETING] Error: ${error.message}`)
        greetingInProgress = false

        // Send text fallback
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "greeting_fallback",
            session_id: sessionId,
            message: agentConfig.firstMessage,
            error: error.message,
          }))
        }
      }
    }

    // Optimized Deepgram connection with language support
    const connectToDeepgram = async () => {
      return new Promise((resolve, reject) => {
        try {
          if (!apiKeys.deepgram) {
            reject(new Error("Deepgram API key not available"))
            return
          }

          const deepgramUrl = new URL("wss://api.deepgram.com/v1/listen")
          deepgramUrl.searchParams.append("sample_rate", "8000")
          deepgramUrl.searchParams.append("channels", "1")
          deepgramUrl.searchParams.append("encoding", "linear16")
          deepgramUrl.searchParams.append("model", "nova-2")
          deepgramUrl.searchParams.append("language", currentLanguage || "hi-IN")
          deepgramUrl.searchParams.append("interim_results", "true")
          deepgramUrl.searchParams.append("smart_format", "true")
          deepgramUrl.searchParams.append("endpointing", "300")
          deepgramUrl.searchParams.append("detect_language", "true")

          console.log(`🎙️ [DEEPGRAM] Connecting with language: ${currentLanguage}`)

          deepgramWs = new WebSocket(deepgramUrl.toString(), {
            headers: { Authorization: `Token ${apiKeys.deepgram}` },
          })
          deepgramWs.binaryType = "arraybuffer"

          const connectionTimeout = setTimeout(() => {
            if (deepgramWs) deepgramWs.close()
            reject(new Error("Deepgram connection timeout"))
          }, 10000)

          deepgramWs.onopen = () => {
            clearTimeout(connectionTimeout)
            deepgramReady = true
            deepgramConnected = true
            reconnectAttempts = 0
            console.log(`✅ [DEEPGRAM] Connected and ready with language: ${currentLanguage}`)
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
          reject(error)
        }
      })
    }

    // Enhanced Deepgram response handler with language detection
    const handleDeepgramResponse = async (data) => {
      if (data.type === "Results") {
        const channel = data.channel
        if (channel && channel.alternatives && channel.alternatives.length > 0) {
          const transcript = channel.alternatives[0].transcript
          const confidence = channel.alternatives[0].confidence
          const is_final = data.is_final
          const detectedLang = data.channel?.detected_language

          if (transcript && transcript.trim()) {
            // Detect language from transcript
            const languageFromText = detectLanguage(transcript)
            
            // Update current language if detection is confident
            if (languageFromText && languageFromText !== currentLanguage) {
              console.log(`🌐 [LANG_DETECT] Language switched from ${currentLanguage} to ${languageFromText}`)
              currentLanguage = languageFromText
              detectedLanguage = languageFromText
            }

            resetSilenceTimer()

            if (is_final) {
              currentTranscript += (currentTranscript ? " " : "") + transcript.trim()
              addToTextQueue(currentTranscript, "final_transcript")
              startSilenceTimer()

              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: "transcript",
                  data: transcript,
                  confidence: confidence,
                  is_final: true,
                  language: currentLanguage,
                  detected_language: detectedLang,
                  accumulated: currentTranscript,
                  agent: agentConfig?.agentName,
                }))
              }
            }
            isSpeaking = true
          }
        }
      } else if (data.type === "SpeechStarted") {
        if (isPlayingAudio) {
          interruptCurrentAudio()
        }
        resetSilenceTimer()
        isSpeaking = true
        vadState.totalSpeechEvents++
      } else if (data.type === "UtteranceEnd") {
        if (isSpeaking) {
          isSpeaking = false
          startSilenceTimer()
        }
        vadState.totalUtteranceEnds++
      }
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
        } catch (error) {
          console.error("❌ [AUDIO] Error closing TTS socket:", error.message)
        }
        currentTTSSocket = null
      }
    }

    // Text processing queue
    const addToTextQueue = (text, type = "transcript") => {
      const queueItem = {
        id: Date.now() + Math.random(),
        text: text.trim(),
        type: type,
        timestamp: new Date().toISOString(),
        processed: false,
        language: currentLanguage,
      }

      textProcessingQueue.push(queueItem)
      console.log(`📝 [QUEUE] Added: "${queueItem.text}" (${textProcessingQueue.length} items) - Lang: ${currentLanguage}`)

      if (!isProcessingQueue) {
        processTextQueue()
      }
    }

    const processTextQueue = async () => {
      if (isProcessingQueue || textProcessingQueue.length === 0) {
        return
      }

      isProcessingQueue = true

      while (textProcessingQueue.length > 0) {
        const queueItem = textProcessingQueue.shift()

        try {
          if (queueItem.text && queueItem.text.length > 0) {
            const openaiResponse = await sendToOpenAI(queueItem.text, queueItem.language)
            if (openaiResponse) {
              await synthesizeWithSarvam(openaiResponse, queueItem.language)
            }
          }
          queueItem.processed = true
        } catch (error) {
          console.error(`❌ [QUEUE] Error processing: ${error.message}`)
        }
      }

      isProcessingQueue = false
    }

    // Send audio to Deepgram
    const sendAudioToDeepgram = async (audioData) => {
      if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN || !deepgramReady) {
        return false
      }

      try {
        const buffer = audioData instanceof Buffer ? audioData : Buffer.from(audioData)
        if (buffer.length >= 320) {
          deepgramWs.send(buffer)
          return true
        }
        return false
      } catch (error) {
        console.error("❌ [DEEPGRAM] Send error:", error.message)
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
      if (currentTranscript.trim() && !isProcessingOpenAI) {
        addToTextQueue(currentTranscript.trim(), "complete_utterance")
        currentTranscript = ""
      }
    }

    // Enhanced OpenAI Integration with dynamic language support
    const sendToOpenAI = async (userMessage, messageLanguage = null) => {
      if (isProcessingOpenAI || !apiKeys.openai || !userMessage.trim()) {
        return null
      }

      isProcessingOpenAI = true

      try {
        const effectiveLanguage = messageLanguage || currentLanguage || agentConfig?.language || 'hi-IN'
        const languageName = LANGUAGE_NAMES[effectiveLanguage] || 'Hindi'
        
        fullConversationHistory.push({
          role: "user",
          content: userMessage,
          language: effectiveLanguage,
        })

        // Enhanced system prompt with all agent profile fields
        const systemPrompt = `You are ${agentConfig?.agentName || "an AI assistant"}, a helpful voice assistant.

        AGENT PROFILE:
        - Name: ${agentConfig?.agentName}
        - Description: ${agentConfig?.description || "A helpful AI assistant"}
        - Category: ${agentConfig?.category || "General"}
        - Personality: ${agentConfig?.personality || "formal"}
        - Default Language: ${agentConfig?.language || "hi-IN"}
        - Current Language: ${effectiveLanguage} (${languageName})
        - Brand Information: ${agentConfig?.brandInfo || ""}
        - Context Memory: ${agentConfig?.contextMemory || ""}
        
        PERSONALITY TRAITS:
        ${agentConfig?.personality === 'formal' ? '- Maintain a professional and respectful tone\n- Use formal language and proper grammar\n- Be courteous and helpful' : ''}
        ${agentConfig?.personality === 'informal' ? '- Use casual, relaxed language\n- Be friendly and approachable\n- Keep conversation light and easy' : ''}
        ${agentConfig?.personality === 'friendly' ? '- Be warm and welcoming\n- Show genuine interest in helping\n- Use encouraging and positive language' : ''}
        ${agentConfig?.personality === 'flirty' ? '- Be playful and charming\n- Use light humor appropriately\n- Be engaging and charismatic' : ''}
        ${agentConfig?.personality === 'disciplined' ? '- Be direct and to the point\n- Focus on efficiency and results\n- Maintain clear boundaries' : ''}
        
        RESPONSE GUIDELINES:
        - Respond in ${languageName} (${effectiveLanguage}) unless user requests otherwise
        - Keep responses short and conversational for phone calls (1-2 sentences max)
        - Adapt to the user's language and tone
        - Incorporate brand information when relevant
        - Maintain context from previous interactions
        - ${agentConfig?.systemPrompt || "Be helpful and provide accurate information"}`
        
                const requestBody = {
                  model: "gpt-4",
                  messages: [
                    { role: "system", content: systemPrompt },
                    ...fullConversationHistory.slice(-10).map(msg => ({
                      role: msg.role,
                      content: msg.content
                    }))
                  ],
                  max_tokens: 150,
                  temperature: 0.5,
                }
        
                console.log(`🧠 [OPENAI] Request body:`, {
                  model: requestBody.model,
                  temperature: requestBody.temperature,
                  language: effectiveLanguage,
                  systemPrompt: systemPrompt.substring(0, 100) + "...",
                  messageCount: requestBody.messages.length
                })
        
                const response = await fetch("https://api.openai.com/v1/chat/completions", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKeys.openai}`,
                  },
                  body: JSON.stringify(requestBody),
                })
        
                if (!response.ok) {
                  const errorText = await response.text()
                  console.error(`❌ [OPENAI] API error: ${response.status} - ${errorText}`)
                  return null
                }
        
                const data = await response.json()
        
                if (data.choices && data.choices[0] && data.choices[0].message) {
                  const openaiResponse = data.choices[0].message.content
        
                  fullConversationHistory.push({
                    role: "assistant",
                    content: openaiResponse,
                    language: effectiveLanguage,
                  })
        
                  console.log(`🧠 [OPENAI] Response (${effectiveLanguage}): ${openaiResponse.substring(0, 100)}...`)
                  return openaiResponse
                }
        
                return null
              } catch (error) {
                console.error(`❌ [OPENAI] Error: ${error.message}`)
                return null
              } finally {
                isProcessingOpenAI = false
              }
            }
        
            // Enhanced Sarvam TTS Synthesis with language support
            const synthesizeWithSarvam = async (text, language = null) => {
              if (!apiKeys.sarvam || !text.trim()) {
                return
              }
        
              try {
                const targetLanguage = language || currentLanguage || agentConfig?.language || 'hi-IN'
                const voice = getVoiceForLanguage(targetLanguage, agentConfig?.voiceSelection)
                
                console.log(`🎵 [SARVAM] Requesting TTS for: "${text.substring(0, 50)}..."`)
                console.log(`   - Language: ${targetLanguage}`)
                console.log(`   - Voice: ${voice}`)
        
                const requestBody = {
                  inputs: [text],
                  target_language_code: targetLanguage,
                  speaker: voice,
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
        
                if (!response.ok) {
                  const errorText = await response.text()
                  console.error(`❌ [SARVAM] API error: ${response.status} - ${errorText}`)
                  throw new Error(`Sarvam API error: ${response.status} - ${errorText}`)
                }
        
                const responseData = await response.json()
                if (!responseData.audios || responseData.audios.length === 0) {
                  throw new Error("No audio data received from Sarvam API")
                }
        
                const audioBase64 = responseData.audios[0]
                const audioBuffer = Buffer.from(audioBase64, "base64")
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
                    language: targetLanguage,
                    voice: voice,
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
                  console.log(`✅ [SARVAM] Audio bytes sent (${audioBuffer.length} bytes)`)
                }
        
                isPlayingAudio = true
                setTimeout(() => {
                  isPlayingAudio = false
                }, 3000)
        
              } catch (error) {
                console.error(`❌ [SARVAM] Error: ${error.message}`)
                
                // Fallback to default language if current language fails
                if (language && language !== agentConfig?.language) {
                  console.log(`🔄 [SARVAM] Trying fallback to default language: ${agentConfig?.language}`)
                  await synthesizeWithSarvam(text, agentConfig?.language)
                }
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
              try {
                let isTextMessage = false
                let data = null
        
                if (typeof message === "string") {
                  isTextMessage = true
                  try {
                    data = JSON.parse(message)
                  } catch (parseError) {
                    console.error("❌ Failed to parse JSON:", parseError.message)
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
                  console.log(`📨 [MESSAGE] Received:`, data)
        
                  if (data.event === "start" && data.session_id) {
                    sessionId = data.session_id
                    destinationNumber = data.Destination
                    sourceNumber = data.Source
        
                    console.log(`✅ [SESSION] SIP Call Started:`)
                    console.log(`   - Session ID: ${sessionId}`)
                    console.log(`   - Source: ${sourceNumber}`)
                    console.log(`   - Destination (DID): ${destinationNumber}`)
        
                    // Fast agent lookup by DID and immediate greeting
                    const agent = await loadAgentByDIDAndSendGreeting(destinationNumber)
                    if (!agent) {
                      console.error(`❌ [SESSION] No agent found for DID: ${destinationNumber}`)
                      ws.send(JSON.stringify({
                        type: "error",
                        message: `No agent configured for DID: ${destinationNumber}`,
                        session_id: sessionId,
                      }))
                      return
                    }
        
                    // Load API keys
                    const keysLoaded = await loadApiKeysForTenant(tenantId)
                    if (!keysLoaded) {
                      console.error(`❌ [SESSION] API keys not available for tenant: ${tenantId}`)
                      ws.send(JSON.stringify({
                        type: "error",
                        message: "API keys not configured for tenant",
                        session_id: sessionId,
                      }))
                      return
                    }
        
                    // Send session started confirmation
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({
                        type: "session_started",
                        session_id: sessionId,
                        agent: agentConfig.agentName,
                        did_number: destinationNumber,
                        tenant_id: tenantId,
                        language: currentLanguage,
                        providers: {
                          stt: agentConfig.sttSelection || "deepgram",
                          tts: agentConfig.ttsSelection || "sarvam",
                          llm: agentConfig.llmSelection || "openai",
                        },
                        message: "Agent matched and greeting sent",
                      }))
                    }
        
                    // Connect to Deepgram
                    try {
                      await connectToDeepgram()
                      console.log(`✅ [SESSION] Deepgram connected for ${agentConfig.agentName}`)
                    } catch (error) {
                      console.error(`❌ [SESSION] Deepgram connection failed: ${error.message}`)
                    }
        
                    // If no pre-generated audio was available, send fallback greeting
                    if (!connectionGreetingSent) {
                      await sendFallbackGreeting()
                    }
                  } else if (data.type === "synthesize") {
                    if (data.session_id) {
                      sessionId = data.session_id
                    }
                    await synthesizeWithSarvam(data.text, data.language)
                  } else if (data.data && data.data.hangup === "true") {
                    console.log(`📞 [SESSION] Hangup for session ${sessionId}`)
        
                    if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
                      deepgramWs.close(1000, "Call ended")
                    }
        
                    if (currentTTSSocket) {
                      currentTTSSocket.close()
                    }
        
                    ws.close(1000, "Hangup requested")
                  }
                } else {
                  // Handle audio data
                  if (isPlayingAudio && !greetingInProgress) {
                    interruptCurrentAudio()
                  }
        
                  if (deepgramConnected && deepgramReady) {
                    await sendAudioToDeepgram(message)
                  }
                }
              } catch (error) {
                console.error(`❌ [MESSAGE] Processing error: ${error.message}`)
              }
            })
        
            // Connection cleanup
            ws.on("close", () => {
              console.log(`🔗 [SESSION] Connection closed for session ${sessionId}`)
              console.log(
                `📊 [STATS] Agent: ${agentConfig?.agentName || "Unknown"}, DID: ${destinationNumber}, Tenant: ${tenantId}`
              )
              console.log(`🌐 [LANGUAGE] Final conversation language: ${currentLanguage}`)
        
              // Cleanup connections
              if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
                deepgramWs.close(1000, "Session ended")
              }
        
              if (currentTTSSocket) {
                currentTTSSocket.close()
              }
        
              // Reset state
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
              currentTranscript = ""
              isSpeaking = false
              isPlayingAudio = false
              shouldInterruptAudio = false
              greetingInProgress = false
              fullConversationHistory = []
              textProcessingQueue = []
              isProcessingQueue = false
            })
        
            ws.on("error", (error) => {
              console.error(`❌ [SESSION] WebSocket error: ${error.message}`)
        
              if (currentTTSSocket) {
                currentTTSSocket.close()
              }
            })
        
            console.log(`✅ [SESSION] WebSocket ready, waiting for SIP start event`)
          })
        }
        
        module.exports = { setupUnifiedVoiceServer }
