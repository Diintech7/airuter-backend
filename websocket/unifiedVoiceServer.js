const WebSocket = require("ws")
const mongoose = require("mongoose")
const ApiKey = require("../models/ApiKey")
const Agent = require("../models/AgentProfile")
const connectDB = require("../config/db")
connectDB()

// New imports for AI SDK
import { streamText } from "ai" // [^5][^6]
import { openai } from "@ai-sdk/openai" // [^5][^6]

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

// Helper to normalize DID (pad with leading zeros to 11 digits, trim whitespace)
function normalizeDID(did) {
  let str = String(did).trim()
  str = str.replace(/\D/g, "")
  return str.padStart(11, "0")
}

// Language detection mapping
const LANGUAGE_MAPPING = {
  hi: "hi-IN",
  en: "en-US",
  bn: "bn-IN",
  te: "te-IN",
  ta: "ta-IN",
  mr: "mr-IN",
  gu: "gu-IN",
  kn: "kn-IN",
  ml: "ml-IN",
  pa: "pa-IN",
  or: "or-IN",
  as: "as-IN",
  ur: "ur-IN",
}

// FIXED: Valid Sarvam voice options
const VALID_SARVAM_VOICES = [
  "meera",
  "pavithra",
  "maitreyi",
  "arvind",
  "amol",
  "amartya",
  "diya",
  "neel",
  "misha",
  "vian",
  "arjun",
  "maya",
  "anushka",
  "abhilash",
  "manisha",
  "vidya",
  "arya",
  "karun",
  "hitesh",
]

// FIXED: Voice mapping function to ensure valid voice selection
const getValidSarvamVoice = (voiceSelection) => {
  if (!voiceSelection || voiceSelection === "default") {
    return "anushka" // Default fallback
  }

  // If it's already a valid Sarvam voice, return it
  if (VALID_SARVAM_VOICES.includes(voiceSelection)) {
    return voiceSelection
  }

  // Map common voice selections to valid Sarvam voices
  const voiceMapping = {
    "male-professional": "arvind",
    "female-professional": "anushka",
    "male-friendly": "amol",
    "female-friendly": "maya",
    neutral: "anushka",
    default: "anushka",
  }

  return voiceMapping[voiceSelection] || "anushka"
}

// Get supported Sarvam language code
const getSarvamLanguage = (detectedLang, defaultLang = "hi") => {
  const lang = detectedLang?.toLowerCase() || defaultLang
  return LANGUAGE_MAPPING[lang] || LANGUAGE_MAPPING[defaultLang] || "hi-IN"
}

// Get Deepgram language code
const getDeepgramLanguage = (detectedLang, defaultLang = "hi") => {
  const lang = detectedLang?.toLowerCase() || defaultLang
  // Deepgram uses different format
  const deepgramMapping = {
    hi: "hi",
    en: "en-US",
    bn: "bn",
    te: "te",
    ta: "ta",
    mr: "mr",
    gu: "gu",
    kn: "kn",
    ml: "ml",
    pa: "pa",
    or: "or",
    as: "as",
    ur: "ur",
  }
  return deepgramMapping[lang] || deepgramMapping[defaultLang] || "hi"
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
    let textProcessingQueue = []
    let isProcessingQueue = false
    let currentTranscript = "" // Accumulates interim Deepgram transcripts
    let isProcessingOpenAIStream = false // Renamed flag for streaming
    let fullConversationHistory = []
    let silenceTimeout = null
    const SILENCE_DURATION = 2000
    let isSpeaking = false

    // Audio streaming and interruption management
    let currentTTSSocket = null // Not used for Sarvam direct API, but kept for consistency
    let isPlayingAudio = false
    let audioQueue = [] // To manage audio chunks for sequential playback
    let shouldInterruptAudio = false
    let greetingInProgress = false
    let currentOpenAIResponseBuffer = "" // Buffer for accumulating OpenAI stream text

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

    // INSTANT GREETING: Send audio bytes immediately when DID matches
    const sendInstantGreeting = async (didNumber) => {
      const overallTimer = createTimer("INSTANT_GREETING_TOTAL")

      try {
        // Step 1: DID lookup
        const didTimer = createTimer("DID_LOOKUP")
        const originalDid = didNumber
        const normalizedDid = normalizeDID(didNumber)

        console.log(`🔍 [INSTANT_GREETING] DID lookup started:`, {
          originalDid,
          normalizedDid,
          timestamp: new Date().toISOString(),
        })

        const agent = await Agent.findOne({ didNumber: normalizedDid }).lean()
        didTimer.end()

        if (!agent) {
          console.error(`❌ [INSTANT_GREETING] No agent found for DID: ${normalizedDid}`)
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

          // Send audio bytes immediately
          const pythonBytesString = bufferToPythonBytesString(agent.audioBytes)

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
        greetingInProgress = false
        isPlayingAudio = true

        // This timeout is a heuristic. For actual audio completion, client feedback is better.
        setTimeout(() => {
          isPlayingAudio = false
        }, 3000)

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

        try {
          console.log(`🔄 [BACKGROUND_AUDIO] Starting generation for: ${agent.agentName}`)

          // Load API keys first
          const keysLoaded = await loadApiKeysForTenant(agent.tenantId)
          if (!keysLoaded || !apiKeys.sarvam) {
            console.error(`❌ [BACKGROUND_AUDIO] API keys not available`)
            timer.end()
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

        // Using AI SDK's streamText for consistency, though generateText is also suitable for single-shot detection.
        const { text: detectedLangText } = await streamText({
          // [^5][^6]
          model: openai("gpt-4o-mini"),
          system: `You are a language detector. Detect the language of the given text and respond with just the language code (hi for Hindi, en for English, bn for Bengali, te for Telugu, ta for Tamil, mr for Marathi, gu for Gujarati, kn for Kannada, ml for Malayalam, pa for Punjabi, or for Odia, as for Assamese, ur for Urdu). If you're unsure or the text is mixed, respond with the dominant language. Only respond with the language code, nothing else.`,
          prompt: text,
          max_tokens: 10,
          temperature: 0.1,
        })

        const detectedLang = detectedLangText.trim().toLowerCase()
        console.log(`🌐 [LANGUAGE_DETECT] Detected: ${detectedLang} from text: "${text}"`)
        timer.end()
        return detectedLang
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
          deepgramUrl.searchParams.append("endpointing", "300")

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
            resetSilenceTimer()

            if (is_final) {
              currentTranscript += (currentTranscript ? " " : "") + transcript.trim()
              addToTextQueue(currentTranscript, "final_transcript")
              currentTranscript = "" // FIXED: Clear currentTranscript after adding final to queue to prevent duplicates
              startSilenceTimer()

              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "transcript",
                    data: transcript,
                    confidence: confidence,
                    is_final: true,
                    language: currentLanguage,
                    accumulated: currentTranscript, // This will be empty now, which is correct for a new utterance
                    agent: agentConfig?.agentName,
                  }),
                )
              }
            }
            isSpeaking = true
          }
        }
      } else if (data.type === "SpeechStarted") {
        console.log(`🎤 [DEEPGRAM] Speech started`)
        if (isPlayingAudio) {
          interruptCurrentAudio()
        }
        resetSilenceTimer()
        isSpeaking = true
        vadState.totalSpeechEvents++
      } else if (data.type === "UtteranceEnd") {
        console.log(`🎤 [DEEPGRAM] Utterance ended`)
        if (isSpeaking) {
          isSpeaking = false
          startSilenceTimer()
        }
        vadState.totalUtteranceEnds++
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
      isPlayingAudio = false
      audioQueue = [] // Clear audio queue on interruption
      currentOpenAIResponseBuffer = "" // Clear any buffered OpenAI text

      // No currentTTSSocket for Sarvam direct API, but good to keep for other TTS
      if (currentTTSSocket) {
        try {
          currentTTSSocket.close()
        } catch (error) {
          console.error("❌ [AUDIO] Error closing TTS socket:", error.message)
        }
        currentTTSSocket = null
      }
      // Send a signal to client to stop playing if needed
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "audio_interrupted", session_id: sessionId }))
      }
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
      const queueTimer = createTimer("TEXT_QUEUE_PROCESSING")

      while (textProcessingQueue.length > 0) {
        const queueItem = textProcessingQueue.shift()

        try {
          if (queueItem.text && queueItem.text.length > 0) {
            // Detect language first
            const newDetectedLanguage = await detectLanguage(queueItem.text)
            if (newDetectedLanguage !== detectedLanguage) {
              detectedLanguage = newDetectedLanguage
              console.log(`🌐 [LANGUAGE_SWITCH] Language changed to: ${detectedLanguage}`)
            }

            // Send to OpenAI for streaming response
            await sendToOpenAIStream(queueItem.text) // Changed to streaming function
          }
          queueItem.processed = true
        } catch (error) {
          console.error(`❌ [QUEUE] Error processing: ${error.message}`)
        }
      }

      queueTimer.end()
      isProcessingQueue = false
    }

    // Send audio to Deepgram with timing
    const sendAudioToDeepgram = async (audioData) => {
      if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN || !deepgramReady) {
        return false
      }

      try {
        const buffer = audioData instanceof Buffer ? audioData : Buffer.from(audioData)
        if (buffer.length >= 320) {
          // Deepgram expects chunks of at least 320 bytes for 8kHz, 16-bit mono
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
      console.log(`🔇 [SILENCE] Detected after ${vadState.silenceDuration}ms`)
      if (currentTranscript.trim() && !isProcessingOpenAIStream) {
        // Check streaming flag
        addToTextQueue(currentTranscript.trim(), "complete_utterance")
        currentTranscript = ""
      }
    }

    // NEW: Enhanced OpenAI Integration with streaming (using AI SDK)
    const sendToOpenAIStream = async (userMessage) => {
      if (isProcessingOpenAIStream || !apiKeys.openai || !userMessage.trim()) {
        return null
      }

      const timer = createTimer("OPENAI_PROCESSING_STREAM")
      isProcessingOpenAIStream = true
      currentOpenAIResponseBuffer = "" // Reset buffer for new response

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

        console.log(`🤖 [OPENAI] Sending streaming request with:`)
        console.log(`   - Language: ${detectedLanguage || currentLanguage}`)
        console.log(`   - Personality: ${agentConfig?.personality || "formal"}`)
        console.log(`   - Model: ${agentConfig?.llmSelection === "openai" ? "gpt-4o-mini" : "gpt-4o-mini"}`)

        const openaiStreamTimer = createTimer("OPENAI_API_STREAM_CALL")
        const result = await streamText({
          // [^5][^6]
          model: openai(agentConfig?.llmSelection === "openai" ? "gpt-4o-mini" : "gpt-4o-mini"),
          messages: [{ role: "system", content: systemPrompt }, ...fullConversationHistory.slice(-10)],
          max_tokens: 150,
          temperature: agentConfig?.personality === "formal" ? 0.3 : 0.7,
          onChunk: async ({ chunk }) => {
            if (shouldInterruptAudio) {
              console.log("🛑 [OPENAI_STREAM] Interrupted, stopping chunk processing.")
              return // Stop processing chunks if interrupted
            }
            if (chunk.type === "text-delta") {
              currentOpenAIResponseBuffer += chunk.text
              // Process and synthesize text in chunks (e.g., by sentence)
              await processOpenAIResponseChunk(currentOpenAIResponseBuffer, detectedLanguage)
            }
          },
          onFinish: ({ text, finishReason, usage }) => {
            openaiStreamTimer.end()
            console.log(`🤖 [OPENAI] Stream finished. Total response: "${text}"`)
            // Ensure any remaining buffered text is processed
            if (currentOpenAIResponseBuffer.length > 0) {
              processOpenAIResponseChunk(currentOpenAIResponseBuffer, detectedLanguage, true) // Force process remaining
            }
            fullConversationHistory.push({
              role: "assistant",
              content: text, // Save the full response
            })
            isProcessingOpenAIStream = false
            timer.end()
          },
        })

        // Await the full text to ensure onFinish is called and flag is reset.
        await result.text
      } catch (error) {
        console.error(`❌ [OPENAI] Error during streaming: ${error.message}`)
        timer.end()
      } finally {
        isProcessingOpenAIStream = false // Ensure flag is reset even on error
      }
    }

    // NEW: Function to process OpenAI response chunks and send to Sarvam
    const processOpenAIResponseChunk = async (buffer, language, force = false) => {
      // Simple sentence splitting for demonstration. More robust NLP might be needed.
      // Look for sentence-ending punctuation followed by a space or end of string.
      const sentenceEndings = /[.!?]\s|\n/
      let lastSentenceEndIndex = -1

      // Find the last complete sentence in the buffer
      let match
      while ((match = sentenceEndings.exec(buffer)) !== null) {
        lastSentenceEndIndex = match.index + match[0].length
      }

      if (lastSentenceEndIndex !== -1 || force) {
        let textToSynthesize
        if (lastSentenceEndIndex !== -1) {
          textToSynthesize = buffer.substring(0, lastSentenceEndIndex).trim()
          currentOpenAIResponseBuffer = buffer.substring(lastSentenceEndIndex)
        } else if (force && buffer.length > 0) {
          textToSynthesize = buffer.trim()
          currentOpenAIResponseBuffer = "" // Clear buffer if forced
        } else {
          return // No complete sentence yet, and not forced
        }

        if (textToSynthesize.length > 0) {
          console.log(`🎵 [SARVAM_CHUNK] Synthesizing chunk: "${textToSynthesize}"`)
          await synthesizeWithSarvam(textToSynthesize, language)
        }
      }
    }

    // Enhanced Sarvam TTS Synthesis with timing
    const synthesizeWithSarvam = async (text, targetLanguage = null) => {
      if (!apiKeys.sarvam || !text.trim() || shouldInterruptAudio) {
        // Check interruption flag
        console.log(`🛑 [SARVAM] Skipping synthesis due to interruption or empty text.`)
        return
      }

      const timer = createTimer("SARVAM_TTS_PROCESSING")

      try {
        const useLanguage = targetLanguage || currentLanguage || "hi"
        const validVoice = getValidSarvamVoice(agentConfig?.voiceSelection)
        const sarvamLanguage = getSarvamLanguage(useLanguage)

        console.log(`🎵 [SARVAM] Generating TTS for: "${text}"`)
        console.log(`   - Language: ${sarvamLanguage}`)
        console.log(`   - Voice: ${validVoice} (mapped from: ${agentConfig?.voiceSelection || "default"})`)
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

        const apiTimer = createTimer("SARVAM_API_CALL")
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
          console.error(`❌ [SARVAM] API error: ${response.status}`, errorText)
          throw new Error(`Sarvam API error: ${response.status}`)
        }

        const parseTimer = createTimer("SARVAM_RESPONSE_PARSE")
        const responseData = await response.json()
        parseTimer.end()

        if (!responseData.audios || responseData.audios.length === 0) {
          throw new Error("No audio data received")
        }

        const audioBase64 = responseData.audios[0]
        const audioBuffer = Buffer.from(audioBase64, "base64")
        const pythonBytesString = bufferToPythonBytesString(audioBuffer)

        // Check interruption flag again before sending
        if (shouldInterruptAudio) {
          console.log(`🛑 [SARVAM] Audio generated but not sent due to interruption.`)
          return
        }

        const audioResponse = {
          data: {
            session_id: sessionId,
            count: 1, // This count might need to be dynamic if we send multiple chunks
            audio_bytes_to_play: pythonBytesString,
            sample_rate: 22050,
            channels: 1,
            sample_width: 2,
            is_streaming: false, // This is false because Sarvam sends full audio per request
            format: "mp3",
          },
          type: "ai_response",
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(audioResponse))
          // For true streaming, you might send a "chunk_complete" and a final "response_complete"
          // For now, sending complete for each chunk.
          ws.send(
            JSON.stringify({
              type: "ai_response_complete",
              session_id: sessionId,
              total_chunks: 1,
            }),
          )
          console.log(`✅ [SARVAM] Audio bytes sent (${audioBuffer.length} bytes)`)
        }

        isPlayingAudio = true
        // This timeout is a heuristic. For actual audio completion, client feedback is better.
        // For streaming, this needs to be managed per chunk or by client.
        setTimeout(() => {
          isPlayingAudio = false
        }, 3000)

        timer.end()
      } catch (error) {
        console.error(`❌ [SARVAM] Error: ${error.message}`)
        timer.end()
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
          console.log(`📨 [MESSAGE] Received:`, data)

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
            // This path is for explicit synthesize requests, not for LLM responses
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
          // This is audio data
          if (isPlayingAudio && !greetingInProgress) {
            interruptCurrentAudio()
          }

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
      currentOpenAIResponseBuffer = "" // Reset buffer on close

      cleanupTimer.end()
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
