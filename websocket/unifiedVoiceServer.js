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

// Performance logging utility
const performanceLogger = {
  log: (operation, startTime, additionalInfo = {}) => {
    const endTime = Date.now()
    const duration = endTime - startTime
    console.log(`⏱️  [PERF] ${operation}: ${duration}ms`, additionalInfo)
    return duration
  },
  
  start: (operation) => {
    const startTime = Date.now()
    console.log(`🚀 [PERF] Starting ${operation}...`)
    return startTime
  }
}

// Helper to normalize DID (pad with leading zeros to 11 digits, trim whitespace)
function normalizeDID(did) {
  let str = String(did).trim();
  str = str.replace(/\D/g, "");
  return str.padStart(11, '0');
}

// Language detection mapping
const LANGUAGE_MAPPING = {
  'hi': 'hi-IN',
  'en': 'en-US',
  'bn': 'bn-IN',
  'te': 'te-IN',
  'ta': 'ta-IN',
  'mr': 'mr-IN',
  'gu': 'gu-IN',
  'kn': 'kn-IN',
  'ml': 'ml-IN',
  'pa': 'pa-IN',
  'or': 'or-IN',
  'as': 'as-IN',
  'ur': 'ur-IN'
};

// FIXED: Valid Sarvam voice options
const VALID_SARVAM_VOICES = [
  'meera', 'pavithra', 'maitreyi', 'arvind', 'amol', 'amartya', 
  'diya', 'neel', 'misha', 'vian', 'arjun', 'maya', 'anushka', 
  'abhilash', 'manisha', 'vidya', 'arya', 'karun', 'hitesh'
];

// FIXED: Voice mapping function to ensure valid voice selection
const getValidSarvamVoice = (voiceSelection) => {
  if (!voiceSelection || voiceSelection === 'default') {
    return 'anushka'; // Default fallback
  }
  
  // If it's already a valid Sarvam voice, return it
  if (VALID_SARVAM_VOICES.includes(voiceSelection)) {
    return voiceSelection;
  }
  
  // Map common voice selections to valid Sarvam voices
  const voiceMapping = {
    'male-professional': 'arvind',
    'female-professional': 'anushka',
    'male-friendly': 'amol',
    'female-friendly': 'maya',
    'neutral': 'anushka',
    'default': 'anushka'
  };
  
  return voiceMapping[voiceSelection] || 'anushka';
};

// Get supported Sarvam language code
const getSarvamLanguage = (detectedLang, defaultLang = 'hi') => {
  const lang = detectedLang?.toLowerCase() || defaultLang;
  return LANGUAGE_MAPPING[lang] || LANGUAGE_MAPPING[defaultLang] || 'hi-IN';
};

// Get Deepgram language code
const getDeepgramLanguage = (detectedLang, defaultLang = 'hi') => {
  const lang = detectedLang?.toLowerCase() || defaultLang;
  // Deepgram uses different format
  const deepgramMapping = {
    'hi': 'hi',
    'en': 'en-US',
    'bn': 'bn',
    'te': 'te',
    'ta': 'ta',
    'mr': 'mr',
    'gu': 'gu',
    'kn': 'kn',
    'ml': 'ml',
    'pa': 'pa',
    'or': 'or',
    'as': 'as',
    'ur': 'ur'
  };
  return deepgramMapping[lang] || deepgramMapping[defaultLang] || 'hi';
};

const setupUnifiedVoiceServer = (wss) => {
  console.log("🚀 Unified Voice WebSocket server initialized with Dynamic Language Detection and Performance Logging")

  wss.on("connection", (ws, req) => {
    const connectionStartTime = performanceLogger.start("WebSocket Connection")
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
    let currentLanguage = null
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

    // OPTIMIZED: Parallel agent and API key loading
    const loadAgentAndApiKeys = async (didNumber) => {
      const totalStartTime = performanceLogger.start("Agent + API Keys Loading")
      
      try {
        const originalDid = didNumber
        const normalizedDid = normalizeDID(didNumber)
        
        console.log(`🔍 [AGENT_LOOKUP] Searching for agent with DID:`, {
          originalDid,
          normalizedDid,
          type: typeof didNumber
        })

        // PARALLEL EXECUTION: Load agent and prepare for API keys
        const agentStartTime = performanceLogger.start("Agent Database Query")
        const agentPromise = Agent.findOne({ didNumber: normalizedDid }).lean()
        
        const agent = await agentPromise
        performanceLogger.log("Agent Database Query", agentStartTime)

        if (!agent) {
          console.error(`❌ [AGENT_LOOKUP] No agent found for DID: ${normalizedDid}`)
          return null
        }

        // Set session variables immediately
        tenantId = agent.tenantId
        agentConfig = agent
        currentLanguage = agent.language || 'hi'
        detectedLanguage = currentLanguage

        console.log(`✅ [AGENT_LOOKUP] Agent found:`)
        console.log(`   - Agent Name: ${agent.agentName}`)
        console.log(`   - Tenant ID: ${agent.tenantId}`)
        console.log(`   - DID Number: ${agent.didNumber}`)
        console.log(`   - Default Language: ${currentLanguage}`)
        console.log(`   - Voice Selection: ${agent.voiceSelection}`)
        console.log(`   - First Message: ${agent.firstMessage}`)
        console.log(`   - Pre-generated Audio: ${agent.audioBytes ? `✅ Available (${agent.audioBytes.length} bytes)` : "❌ Not Available"}`)

        // PARALLEL EXECUTION: Load API keys while processing greeting
        const apiKeysPromise = loadApiKeysForTenant(agent.tenantId)
        
        // IMMEDIATE GREETING: Send greeting without waiting for API keys
        if (agent.audioBytes && agent.audioBytes.length > 0) {
          await sendImmediateGreeting(agent)
        } else {
          await sendInstantTextGreeting(agent)
        }

        // Wait for API keys to complete
        const keysLoaded = await apiKeysPromise
        if (!keysLoaded) {
          console.error(`❌ [API_KEYS] Failed to load API keys for tenant: ${agent.tenantId}`)
        }

        performanceLogger.log("Agent + API Keys Loading", totalStartTime, {
          agentName: agent.agentName,
          tenantId: agent.tenantId,
          hasPreAudio: !!agent.audioBytes
        })

        return agent
      } catch (error) {
        console.error(`❌ [AGENT_LOOKUP] Error: ${error.message}`)
        performanceLogger.log("Agent + API Keys Loading", totalStartTime, { error: error.message })
        return null
      }
    }

    // OPTIMIZED: Immediate text greeting with background audio generation
    const sendInstantTextGreeting = async (agent) => {
      if (connectionGreetingSent || !sessionId) {
        return
      }

      const startTime = performanceLogger.start("Instant Text Greeting")
      console.log(`⚡ [INSTANT_GREETING] Sending text greeting for agent: ${agent.agentName}`)
      
      try {
        // Send text greeting immediately (< 1ms)
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "instant_text_greeting",
            session_id: sessionId,
            message: agent.firstMessage,
            agent: agent.agentName,
            timestamp: new Date().toISOString()
          }))
          console.log(`✅ [INSTANT_GREETING] Text greeting sent instantly`)
        }

        // Generate audio in parallel (non-blocking)
        setImmediate(async () => {
          try {
            await generateAndSendGreetingAudio(agent)
            connectionGreetingSent = true
          } catch (error) {
            console.error(`❌ [INSTANT_GREETING] Audio generation error: ${error.message}`)
          }
        })

        performanceLogger.log("Instant Text Greeting", startTime)
      } catch (error) {
        console.error(`❌ [INSTANT_GREETING] Error: ${error.message}`)
        performanceLogger.log("Instant Text Greeting", startTime, { error: error.message })
      }
    }

    // OPTIMIZED: Fast greeting audio generation with timeout
    const generateAndSendGreetingAudio = async (agent) => {
      const startTime = performanceLogger.start("Greeting Audio Generation")
      
      try {
        console.log(`🎵 [GREETING_AUDIO] Generating for: "${agent.firstMessage}"`)
        
        const validVoice = getValidSarvamVoice(agent.voiceSelection)
        const sarvamLanguage = getSarvamLanguage(currentLanguage)
        
        console.log(`🎵 [GREETING_AUDIO] Using voice: ${validVoice} (mapped from: ${agent.voiceSelection})`)
        
        if (!apiKeys.sarvam) {
          // If API keys not loaded yet, wait briefly
          await new Promise(resolve => setTimeout(resolve, 100))
          if (!apiKeys.sarvam) {
            throw new Error("Sarvam API key not available")
          }
        }

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

        const sarvamStartTime = performanceLogger.start("Sarvam TTS API Call")
        
        // Add timeout to Sarvam API call
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 3000) // 3 second timeout

        const response = await fetch("https://api.sarvam.ai/text-to-speech", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "API-Subscription-Key": apiKeys.sarvam,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        })

        clearTimeout(timeoutId)
        performanceLogger.log("Sarvam TTS API Call", sarvamStartTime)

        if (!response.ok) {
          const errorText = await response.text()
          console.error(`❌ [GREETING_AUDIO] Sarvam API error: ${response.status}`, errorText)
          throw new Error(`Sarvam API error: ${response.status}`)
        }

        const responseData = await response.json()
        if (!responseData.audios || responseData.audios.length === 0) {
          throw new Error("No audio data received")
        }

        const audioBase64 = responseData.audios[0]
        const audioBuffer = Buffer.from(audioBase64, "base64")
        const pythonBytesString = bufferToPythonBytesString(audioBuffer)

        // Send audio immediately
        const sendStartTime = performanceLogger.start("Audio Bytes Send")
        
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
          console.log(`✅ [GREETING_AUDIO] Audio sent (${audioBuffer.length} bytes)`)
        }

        performanceLogger.log("Audio Bytes Send", sendStartTime)

        isPlayingAudio = true
        setTimeout(() => {
          isPlayingAudio = false
        }, 3000)

        // Save audio for future use (non-blocking)
        setImmediate(async () => {
          try {
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
            console.log(`✅ [GREETING_AUDIO] Audio saved for future instant use`)
          } catch (saveError) {
            console.error(`❌ [GREETING_AUDIO] Save error: ${saveError.message}`)
          }
        })

        performanceLogger.log("Greeting Audio Generation", startTime, {
          audioSize: audioBuffer.length,
          voice: validVoice,
          language: sarvamLanguage
        })

      } catch (error) {
        console.error(`❌ [GREETING_AUDIO] Error: ${error.message}`)
        performanceLogger.log("Greeting Audio Generation", startTime, { error: error.message })
      }
    }

    // OPTIMIZED: Immediate greeting with pre-generated audio
    const sendImmediateGreeting = async (agent) => {
      if (connectionGreetingSent || !sessionId) {
        return
      }

      const startTime = performanceLogger.start("Immediate Pre-generated Greeting")
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

        performanceLogger.log("Immediate Pre-generated Greeting", startTime, {
          audioSize: audioBuffer.length,
          hasMetadata: !!agent.audioMetadata
        })

      } catch (error) {
        console.error(`❌ [IMMEDIATE_GREETING] Error: ${error.message}`)
        performanceLogger.log("Immediate Pre-generated Greeting", startTime, { error: error.message })
        greetingInProgress = false
      }
    }

    // OPTIMIZED: Parallel API key loading
    const loadApiKeysForTenant = async (tenantId) => {
      const startTime = performanceLogger.start("API Keys Loading")
      
      try {
        console.log(`🔑 [API_KEYS] Loading keys for tenant: ${tenantId}`)

        const keys = await ApiKey.find({
          tenantId,
          isActive: true,
        }).lean()

        if (keys.length === 0) {
          console.error(`❌ [API_KEYS] No active API keys found for tenant: ${tenantId}`)
          performanceLogger.log("API Keys Loading", startTime, { error: "No keys found" })
          return false
        }

        // Parallel key decryption
        const keyPromises = keys.map(async (keyDoc) => {
          const decryptStartTime = Date.now()
          const decryptedKey = ApiKey.decryptKey(keyDoc.encryptedKey)
          
          console.log(`🔓 [API_KEYS] Decrypted ${keyDoc.provider} key in ${Date.now() - decryptStartTime}ms`)
          
          switch (keyDoc.provider) {
            case "deepgram":
              apiKeys.deepgram = decryptedKey
              break
            case "sarvam":
              apiKeys.sarvam = decryptedKey
              break
            case "openai":
              apiKeys.openai = decryptedKey
              break
          }

          // Update usage stats (non-blocking)
          setImmediate(() => {
            ApiKey.updateOne(
              { _id: keyDoc._id },
              {
                $inc: { "usage.totalRequests": 1 },
                $set: { "usage.lastUsed": new Date() },
              },
            ).exec()
          })
        })

        await Promise.all(keyPromises)

        console.log(`🔑 [API_KEYS] Providers ready:`)
        console.log(`   - Deepgram (STT): ${apiKeys.deepgram ? "✅" : "❌"}`)
        console.log(`   - Sarvam (TTS): ${apiKeys.sarvam ? "✅" : "❌"}`)
        console.log(`   - OpenAI (LLM): ${apiKeys.openai ? "✅" : "❌"}`)

        performanceLogger.log("API Keys Loading", startTime, {
          keysLoaded: keys.length,
          providers: {
            deepgram: !!apiKeys.deepgram,
            sarvam: !!apiKeys.sarvam,
            openai: !!apiKeys.openai
          }
        })

        return true
      } catch (error) {
        console.error(`❌ [API_KEYS] Error: ${error.message}`)
        performanceLogger.log("API Keys Loading", startTime, { error: error.message })
        return false
      }
    }

    // OPTIMIZED: Language detection with timeout
    const detectLanguage = async (text) => {
      const startTime = performanceLogger.start("Language Detection")
      
      try {
        if (!apiKeys.openai || !text.trim()) {
          performanceLogger.log("Language Detection", startTime, { result: "fallback", reason: "no API key or text" })
          return currentLanguage || 'hi'
        }

        const requestBody = {
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a language detector. Detect the language of the given text and respond with just the language code (hi for Hindi, en for English, bn for Bengali, te for Telugu, ta for Tamil, mr for Marathi, gu for Gujarati, kn for Kannada, ml for Malayalam, pa for Punjabi, or for Odia, as for Assamese, ur for Urdu). If you're unsure or the text is mixed, respond with the dominant language. Only respond with the language code, nothing else.`
            },
            {
              role: "user",
              content: text
            }
          ],
          max_tokens: 10,
          temperature: 0.1,
        }

        const openaiStartTime = performanceLogger.start("OpenAI Language Detection API")
        
        // Add timeout
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 2000) // 2 second timeout

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKeys.openai}`,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        })

        clearTimeout(timeoutId)
        performanceLogger.log("OpenAI Language Detection API", openaiStartTime)

        if (!response.ok) {
          console.error(`❌ [LANGUAGE_DETECT] OpenAI API error: ${response.status}`)
          performanceLogger.log("Language Detection", startTime, { error: `API error ${response.status}` })
          return currentLanguage || 'hi'
        }

        const data = await response.json()
        if (data.choices && data.choices[0] && data.choices[0].message) {
          const detectedLang = data.choices[0].message.content.trim().toLowerCase()
          console.log(`🌐 [LANGUAGE_DETECT] Detected: ${detectedLang} from text: "${text}"`)
          performanceLogger.log("Language Detection", startTime, { detected: detectedLang })
          return detectedLang
        }

        performanceLogger.log("Language Detection", startTime, { result: "fallback", reason: "no response data" })
        return currentLanguage || 'hi'
      } catch (error) {
        console.error(`❌ [LANGUAGE_DETECT] Error: ${error.message}`)
        performanceLogger.log("Language Detection", startTime, { error: error.message })
        return currentLanguage || 'hi'
      }
    }

    // OPTIMIZED: Deepgram connection with detailed logging
    const connectToDeepgram = async () => {
      const startTime = performanceLogger.start("Deepgram Connection")
      
      return new Promise((resolve, reject) => {
        try {
          if (!apiKeys.deepgram) {
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
          deepgramUrl.searchParams.append("endpointing", "300")

          console.log(`🎤 [DEEPGRAM] Connecting with language: ${deepgramLanguage}`)

          const connectionStartTime = performanceLogger.start("Deepgram WebSocket Connection")
          
          deepgramWs = new WebSocket(deepgramUrl.toString(), {
            headers: { Authorization: `Token ${apiKeys.deepgram}` },
          })
          deepgramWs.binaryType = "arraybuffer"

          const connectionTimeout = setTimeout(() => {
            if (deepgramWs) deepgramWs.close()
            reject(new Error("Deepgram connection timeout"))
          }, 5000) // Reduced timeout

          deepgramWs.onopen = () => {
            clearTimeout(connectionTimeout)
            deepgramReady = true
            deepgramConnected = true
            reconnectAttempts = 0
            
            performanceLogger.log("Deepgram WebSocket Connection", connectionStartTime)
            performanceLogger.log("Deepgram Connection", startTime, { language: deepgramLanguage })
            
            console.log(`✅ [DEEPGRAM] Connected and ready with language: ${deepgramLanguage}`)
            resolve()
          }

          deepgramWs.onmessage = async (event) => {
            const messageStartTime = Date.now()
            try {
              const data = JSON.parse(event.data)
              await handleDeepgramResponse(data)
              
              // Log processing time for final transcripts
              if (data.is_final && data.channel?.alternatives?.[0]?.transcript) {
                console.log(`⏱️  [DEEPGRAM] Message processed in ${Date.now() - messageStartTime}ms`)
              }
            } catch (parseError) {
              console.error("❌ [DEEPGRAM] Parse error:", parseError.message)
            }
          }

          deepgramWs.onerror = (error) => {
            clearTimeout(connectionTimeout)
            deepgramReady = false
            deepgramConnected = false
            console.error("❌ [DEEPGRAM] Connection error:", error.message)
            performanceLogger.log("Deepgram Connection", startTime, { error: error.message })
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
          performanceLogger.log("Deepgram Connection", startTime, { error: error.message })
          reject(error)
        }
      })
    }

    // Handle Deepgram responses with timing
    const handleDeepgramResponse = async (data) => {
      if (data.type === "Results") {
        const channel = data.channel
        if (channel && channel.alternatives && channel.alternatives.length > 0) {
          const transcript = channel.alternatives[0].transcript
          const confidence = channel.alternatives[0].confidence
          const is_final = data.is_final

          if (transcript && transcript.trim()) {
            resetSilenceTimer()

            if (is_final) {
              console.log(`📝 [TRANSCRIPT] Final: "${transcript}" (confidence: ${confidence})`)
              
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
        console.log(`🎤 [VAD] Speech started (${vadState.totalSpeechEvents} total)`)
      } else if (data.type === "UtteranceEnd") {
        if (isSpeaking) {
          isSpeaking = false
          startSilenceTimer()
        }
        vadState.totalUtteranceEnds++
        console.log(`🎤 [VAD] Utterance ended (${vadState.totalUtteranceEnds} total)`)
      }
    }

        // Audio interruption handler
        const interruptCurrentAudio = () => {
          if (greetingInProgress) {
            console.log("🛑 [AUDIO] Interruption blocked - greeting in progress")
            return
          }
    
          const startTime = performanceLogger.start("Audio Interruption")
          console.log("🛑 [AUDIO] Interrupting current audio playback")
          shouldInterruptAudio = true
          isPlayingAudio = false
          audioQueue = []
    
          if (currentTTSSocket) {
            try {
              currentTTSSocket.close()
              console.log("✅ [AUDIO] TTS socket closed successfully")
            } catch (error) {
              console.error("❌ [AUDIO] Error closing TTS socket:", error.message)
            } finally {
              currentTTSSocket = null
            }
          }
    
          performanceLogger.log("Audio Interruption", startTime)
        }
    
        // Text processing queue with timing
        const addToTextQueue = (text, type = "transcript") => {
          const queueItem = {
            id: Date.now() + Math.random(),
            text: text.trim(),
            type: type,
            timestamp: new Date().toISOString(),
            processed: false,
          }
    
          textProcessingQueue.push(queueItem)
          console.log(`📝 [QUEUE] Added: "${queueItem.text}" (${textProcessingQueue.length} items)`)
    
          if (!isProcessingQueue) {
            processTextQueue()
          }
        }
    
        const processTextQueue = async () => {
          if (isProcessingQueue || textProcessingQueue.length === 0) {
            return
          }
    
          isProcessingQueue = true
          const queueStartTime = performanceLogger.start("Text Queue Processing")
    
          while (textProcessingQueue.length > 0) {
            const queueItem = textProcessingQueue.shift()
            const itemStartTime = performanceLogger.start("Queue Item Processing")
    
            try {
              if (queueItem.text && queueItem.text.length > 0) {
                // Detect language first
                const langDetectStart = performanceLogger.start("Language Detection")
                const newDetectedLanguage = await detectLanguage(queueItem.text)
                performanceLogger.log("Language Detection", langDetectStart)
                
                if (newDetectedLanguage !== detectedLanguage) {
                  detectedLanguage = newDetectedLanguage
                  console.log(`🌐 [LANGUAGE_SWITCH] Language changed to: ${detectedLanguage}`)
                }
    
                // Process with OpenAI
                const openaiStart = performanceLogger.start("OpenAI Processing")
                const openaiResponse = await sendToOpenAI(queueItem.text)
                performanceLogger.log("OpenAI Processing", openaiStart)
    
                if (openaiResponse) {
                  const sarvamStart = performanceLogger.start("Sarvam TTS Generation")
                  await synthesizeWithSarvam(openaiResponse, detectedLanguage)
                  performanceLogger.log("Sarvam TTS Generation", sarvamStart)
                }
              }
              queueItem.processed = true
              performanceLogger.log("Queue Item Processing", itemStartTime, {
                textLength: queueItem.text.length,
                type: queueItem.type
              })
            } catch (error) {
              console.error(`❌ [QUEUE] Error processing: ${error.message}`)
              performanceLogger.log("Queue Item Processing", itemStartTime, {
                error: error.message,
                text: queueItem.text.substring(0, 20) + "..."
              })
            }
          }
    
          isProcessingQueue = false
          performanceLogger.log("Text Queue Processing", queueStartTime, {
            itemsProcessed: textProcessingQueue.length
          })
        }
    
        // Send audio to Deepgram with timing
        const sendAudioToDeepgram = async (audioData) => {
          const startTime = performanceLogger.start("Audio Send to Deepgram")
          
          if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN || !deepgramReady) {
            performanceLogger.log("Audio Send to Deepgram", startTime, { error: "Deepgram not ready" })
            return false
          }
    
          try {
            const buffer = audioData instanceof Buffer ? audioData : Buffer.from(audioData)
            if (buffer.length >= 320) {
              deepgramWs.send(buffer)
              performanceLogger.log("Audio Send to Deepgram", startTime, {
                bytesSent: buffer.length
              })
              return true
            }
            performanceLogger.log("Audio Send to Deepgram", startTime, {
              error: "Buffer too small",
              bufferSize: buffer.length
            })
            return false
          } catch (error) {
            console.error("❌ [DEEPGRAM] Send error:", error.message)
            performanceLogger.log("Audio Send to Deepgram", startTime, {
              error: error.message
            })
            return false
          }
        }
    
        // Silence detection with timing
        const startSilenceTimer = () => {
          if (silenceTimeout) {
            clearTimeout(silenceTimeout)
          }
    
          vadState.lastUtteranceEnd = Date.now()
    
          silenceTimeout = setTimeout(() => {
            vadState.silenceDuration = Date.now() - vadState.lastUtteranceEnd
            console.log(`⏳ [VAD] Silence detected (${vadState.silenceDuration}ms)`)
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
          const startTime = performanceLogger.start("Silence Handling")
          
          if (currentTranscript.trim() && !isProcessingOpenAI) {
            console.log(`🔇 [SILENCE] Processing final utterance: "${currentTranscript}"`)
            addToTextQueue(currentTranscript.trim(), "complete_utterance")
            currentTranscript = ""
          }
          
          performanceLogger.log("Silence Handling", startTime)
        }
    
        // Enhanced OpenAI Integration with timing
        const sendToOpenAI = async (userMessage) => {
          if (isProcessingOpenAI || !apiKeys.openai || !userMessage.trim()) {
            return null
          }
    
          const startTime = performanceLogger.start("OpenAI Request")
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
              messages: [
                { role: "system", content: systemPrompt },
                ...fullConversationHistory.slice(-10)
              ],
              max_tokens: 150,
              temperature: agentConfig?.personality === "formal" ? 0.3 : 0.7,
            }
    
            console.log(`🤖 [OPENAI] Sending request with:`)
            console.log(`   - Language: ${detectedLanguage || currentLanguage}`)
            console.log(`   - Personality: ${agentConfig?.personality || "formal"}`)
            console.log(`   - Model: ${requestBody.model}`)
    
            const apiStartTime = performanceLogger.start("OpenAI API Call")
            
            // Add timeout
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 5000) // 5 second timeout
    
            const response = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKeys.openai}`,
              },
              body: JSON.stringify(requestBody),
              signal: controller.signal
            })
    
            clearTimeout(timeoutId)
            performanceLogger.log("OpenAI API Call", apiStartTime)
    
            if (!response.ok) {
              const errorText = await response.text()
              console.error(`❌ [OPENAI] API error: ${response.status}`, errorText)
              performanceLogger.log("OpenAI Request", startTime, {
                error: `API error ${response.status}`,
                text: userMessage.substring(0, 20) + "..."
              })
              return null
            }
    
            const data = await response.json()
    
            if (data.choices && data.choices[0] && data.choices[0].message) {
              const openaiResponse = data.choices[0].message.content
    
              fullConversationHistory.push({
                role: "assistant",
                content: openaiResponse,
              })
    
              performanceLogger.log("OpenAI Request", startTime, {
                responseLength: openaiResponse.length,
                tokensUsed: data.usage?.total_tokens
              })
    
              return openaiResponse
            }
    
            performanceLogger.log("OpenAI Request", startTime, {
              error: "No response data",
              text: userMessage.substring(0, 20) + "..."
            })
            return null
          } catch (error) {
            console.error(`❌ [OPENAI] Error: ${error.message}`)
            performanceLogger.log("OpenAI Request", startTime, {
              error: error.message,
              text: userMessage.substring(0, 20) + "..."
            })
            return null
          } finally {
            isProcessingOpenAI = false
          }
        }
    
        // Enhanced Sarvam TTS with timing
        const synthesizeWithSarvam = async (text, targetLanguage = null) => {
          if (!apiKeys.sarvam || !text.trim()) {
            return
          }
    
          const startTime = performanceLogger.start("Sarvam TTS")
          
          try {
            const useLanguage = targetLanguage || currentLanguage || 'hi'
            const validVoice = getValidSarvamVoice(agentConfig?.voiceSelection)
            const sarvamLanguage = getSarvamLanguage(useLanguage)
    
            console.log(`🎵 [SARVAM] Generating TTS for: "${text}"`)
            console.log(`   - Language: ${sarvamLanguage}`)
            console.log(`   - Voice: ${validVoice} (mapped from: ${agentConfig?.voiceSelection || 'default'})`)
            console.log(`   - Agent: ${agentConfig?.agentName}`)
    
            const requestBody = {
              inputs: [text],
              target_language_code: sarvamLanguage,
              speaker: validVoice,
              pitch: 0,
              pace: 1.0,
              loudness: 1.0,
              speech_sample_rate: 22050,
              enable_preprocessing: true,
              model: "bulbul:v2",
            }
    
            const apiStartTime = performanceLogger.start("Sarvam API Call")
            
            // Add timeout
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 3000) // 3 second timeout
    
            const response = await fetch("https://api.sarvam.ai/text-to-speech", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "API-Subscription-Key": apiKeys.sarvam,
              },
              body: JSON.stringify(requestBody),
              signal: controller.signal
            })
    
            clearTimeout(timeoutId)
            performanceLogger.log("Sarvam API Call", apiStartTime)
    
            if (!response.ok) {
              const errorText = await response.text()
              console.error(`❌ [SARVAM] API error: ${response.status}`, errorText)
              throw new Error(`Sarvam API error: ${response.status}`)
            }
    
            const responseData = await response.json()
            if (!responseData.audios || responseData.audios.length === 0) {
              throw new Error("No audio data received")
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
              },
              type: "ai_response",
            }
    
            const sendStartTime = performanceLogger.start("Audio Response Send")
            
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(audioResponse))
              ws.send(JSON.stringify({
                type: "ai_response_complete",
                session_id: sessionId,
                total_chunks: 1,
              }))
              console.log(`✅ [SARVAM] Audio bytes sent (${audioBuffer.length} bytes)`)
            }
    
            performanceLogger.log("Audio Response Send", sendStartTime)
    
            isPlayingAudio = true
            setTimeout(() => {
              isPlayingAudio = false
            }, 3000)
    
            performanceLogger.log("Sarvam TTS", startTime, {
              audioSize: audioBuffer.length,
              voice: validVoice,
              language: sarvamLanguage
            })
    
          } catch (error) {
            console.error(`❌ [SARVAM] Error: ${error.message}`)
            performanceLogger.log("Sarvam TTS", startTime, {
              error: error.message,
              text: text.substring(0, 20) + "..."
            })
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
    
        // WebSocket message handling with timing
        ws.on("message", async (message) => {
          const startTime = performanceLogger.start("Message Processing")
          
          try {
            let isTextMessage = false
            let data = null
    
            if (typeof message === "string") {
              isTextMessage = true
              try {
                data = JSON.parse(message)
              } catch (parseError) {
                console.error("❌ Failed to parse JSON:", parseError.message)
                performanceLogger.log("Message Processing", startTime, {
                  error: "JSON parse error",
                  message: message.substring(0, 20) + "..."
                })
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
    
                const agentStartTime = performanceLogger.start("Agent Loading")
                const agent = await loadAgentAndApiKeys(destinationNumber)
                performanceLogger.log("Agent Loading", agentStartTime)
    
                if (!agent) {
                  console.error(`❌ [SESSION] No agent found for DID: ${destinationNumber}`)
                  ws.send(JSON.stringify({
                    type: "error",
                    message: `No agent configured for DID: ${destinationNumber}`,
                    session_id: sessionId,
                  }))
                  return
                }
    
                // Deepgram connection in background
                setImmediate(async () => {
                  try {
                    const dgStartTime = performanceLogger.start("Deepgram Connection")
                    await connectToDeepgram()
                    performanceLogger.log("Deepgram Connection", dgStartTime)
                    console.log(`✅ [SESSION] Deepgram connected for ${agentConfig.agentName}`)
                  } catch (error) {
                    console.error(`❌ [SESSION] Deepgram connection failed: ${error.message}`)
                  }
                })
    
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
    
                if (currentTTSSocket) {
                  currentTTSSocket.close()
                }
    
                ws.close(1000, "Hangup requested")
              }
            } else {
              if (isPlayingAudio && !greetingInProgress) {
                interruptCurrentAudio()
              }
    
              if (deepgramConnected && deepgramReady) {
                await sendAudioToDeepgram(message)
              }
            }
    
            performanceLogger.log("Message Processing", startTime, {
              type: isTextMessage ? "text" : "audio",
              size: message.length
            })
          } catch (error) {
            console.error(`❌ [MESSAGE] Processing error: ${error.message}`)
            performanceLogger.log("Message Processing", startTime, {
              error: error.message
            })
          }
        })
    
        // Connection cleanup
        ws.on("close", () => {
          const duration = performanceLogger.log("WebSocket Connection", connectionStartTime, {
            sessionId,
            agent: agentConfig?.agentName,
            did: destinationNumber
          })
          
          console.log(`🔗 [SESSION] Connection closed for session ${sessionId}`)
          console.log(`📊 [STATS] Agent: ${agentConfig?.agentName || "Unknown"}, DID: ${destinationNumber}, Tenant: ${tenantId}`)
          console.log(`⏱️  [PERF] Total connection duration: ${duration}ms`)
    
          if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
            deepgramWs.close(1000, "Session ended")
          }
    
          if (currentTTSSocket) {
            currentTTSSocket.close()
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
          performanceLogger.log("WebSocket Connection", connectionStartTime, {
            error: error.message,
            state: "error"
          })
    
          if (currentTTSSocket) {
            currentTTSSocket.close()
          }
        })
    
        console.log(`✅ [SESSION] WebSocket ready, waiting for SIP start event`)
      })
    }
    
    module.exports = { setupUnifiedVoiceServer }
