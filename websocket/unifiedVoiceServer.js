const WebSocket = require("ws")
const mongoose = require("mongoose")
const ApiKey = require("../models/ApiKey")
const Agent = require("../models/AgentProfile")
const connectDB = require("../config/db")
connectDB()

const fetch = globalThis.fetch || require("node-fetch")
const { AbortController } = require('abort-controller')

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
    }
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

// Valid Sarvam voice options
const VALID_SARVAM_VOICES = [
  'meera', 'pavithra', 'maitreyi', 'arvind', 'amol', 'amartya', 
  'diya', 'neel', 'misha', 'vian', 'arjun', 'maya', 'anushka', 
  'abhilash', 'manisha', 'vidya', 'arya', 'karun', 'hitesh'
];

// Voice mapping function to ensure valid voice selection
const getValidSarvamVoice = (voiceSelection) => {
  if (!voiceSelection || voiceSelection === 'default') {
    return 'anushka';
  }
  
  if (VALID_SARVAM_VOICES.includes(voiceSelection)) {
    return voiceSelection;
  }
  
  const voiceMapping = {
    'male-professional': 'arvind',
    'female-professional': 'anushka',
    'male-friendly': 'amol',
    'female-friendly': 'maya',
    'neutral': 'anushka'
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

// Text chunking for streaming TTS
const chunkText = (text, maxChars = 80) => {
  if (text.length <= maxChars) return [text];
  
  const chunks = [];
  const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim());
  
  let currentChunk = '';
  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length <= maxChars) {
      currentChunk += sentence + ' ';
    } else {
      if (currentChunk.trim()) chunks.push(currentChunk.trim());
      currentChunk = sentence + ' ';
    }
  }
  
  if (currentChunk.trim()) chunks.push(currentChunk.trim());
  return chunks.length > 0 ? chunks : [text];
};

const setupUnifiedVoiceServer = (wss) => {
  console.log("🚀 Unified Voice WebSocket server initialized with Optimized Streaming")

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
    const MAX_RECONNECT_ATTEMPTS = 3
    const reconnectDelay = 1000

    // Audio and conversation state
    let connectionGreetingSent = false
    let currentTranscript = ""
    let fullConversationHistory = []
    let silenceTimeout = null
    const SILENCE_DURATION = 1500
    let isSpeaking = false

    // Optimized processing state
    let isProcessingOpenAI = false
    let currentOpenAIRequest = null
    let pendingTTSRequests = new Map()
    let ttsChunkCounter = 0
    let shouldInterruptGeneration = false
    let lastProcessedText = ""
    let processingDebounceTimer = null

    // Audio streaming state
    let isPlayingAudio = false
    let audioInterrupted = false
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

    // INSTANT GREETING: Send audio bytes immediately when DID matches
    const sendInstantGreeting = async (didNumber) => {
      const overallTimer = createTimer("INSTANT_GREETING_TOTAL")
      
      try {
        const didTimer = createTimer("DID_LOOKUP")
        const normalizedDid = normalizeDID(didNumber);
        
        console.log(`🔍 [INSTANT_GREETING] DID lookup: ${normalizedDid}`)

        const agent = await Agent.findOne({ didNumber: normalizedDid })
          .select('tenantId agentName firstMessage audioBytes audioMetadata language voiceSelection')
          .lean()
          .exec();
        
        didTimer.end()

        if (!agent) {
          console.error(`❌ [INSTANT_GREETING] No agent found for DID: ${normalizedDid}`)
          overallTimer.end()
          return null;
        }

        // Set session variables immediately
        tenantId = agent.tenantId
        agentConfig = agent
        currentLanguage = agent.language || 'hi'
        detectedLanguage = currentLanguage

        console.log(`✅ [INSTANT_GREETING] Agent matched: ${agent.agentName}`)

        // Send greeting INSTANTLY
        if (agent.audioBytes && agent.audioBytes.length > 0) {
          const audioTimer = createTimer("INSTANT_AUDIO_SEND")
          
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
            ws.send(JSON.stringify({
              type: "ai_response_complete",
              session_id: sessionId,
              total_chunks: 1,
            }))
            audioTimer.end()
            console.log(`🚀 [INSTANT_GREETING] Pre-generated audio sent: ${agent.audioBytes.length} bytes`)
          }
        } else {
          // Send text immediately and start streaming audio generation
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "instant_text_greeting",
              session_id: sessionId,
              message: agent.firstMessage,
              agent: agent.agentName,
              timestamp: new Date().toISOString()
            }))
            console.log(`📝 [INSTANT_GREETING] Text greeting sent, starting audio generation`)
          }
          
          // Start immediate streaming TTS
          streamingTTSGeneration(agent.firstMessage, currentLanguage, true)
        }

        connectionGreetingSent = true
        greetingInProgress = false
        isPlayingAudio = true

        // Reset playing state after reasonable time
        setTimeout(() => {
          isPlayingAudio = false
        }, 2000)

        overallTimer.end()
        return agent

      } catch (error) {
        console.error(`❌ [INSTANT_GREETING] Error: ${error.message}`)
        overallTimer.end()
        return null
      }
    }

    // Load API keys for the tenant with caching
    const loadApiKeysForTenant = async (tenantId) => {
      const timer = createTimer("API_KEYS_LOAD")
      
      try {
        // Check if keys are already loaded
        if (apiKeys.deepgram && apiKeys.sarvam && apiKeys.openai) {
          timer.end()
          return true
        }

        console.log(`🔑 [API_KEYS] Loading keys for tenant: ${tenantId}`)

        const keys = await ApiKey.find({
          tenantId,
          isActive: true,
        })
        .select('provider encryptedKey')
        .lean()
        .exec()

        if (keys.length === 0) {
          console.error(`❌ [API_KEYS] No active API keys found for tenant: ${tenantId}`)
          timer.end()
          return false
        }

        // Decrypt keys efficiently
        for (const keyDoc of keys) {
          const decryptedKey = ApiKey.decryptKey(keyDoc.encryptedKey)

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
        }

        console.log(`🔑 [API_KEYS] Loaded: Deepgram=${!!apiKeys.deepgram}, Sarvam=${!!apiKeys.sarvam}, OpenAI=${!!apiKeys.openai}`)

        timer.end()
        return true
      } catch (error) {
        console.error(`❌ [API_KEYS] Error: ${error.message}`)
        timer.end()
        return false
      }
    }

    // Optimized language detection with caching
    const detectLanguage = async (text) => {
      const timer = createTimer("LANGUAGE_DETECTION")
      
      try {
        if (!apiKeys.openai || !text.trim() || text.length < 10) {
          timer.end()
          return currentLanguage || 'hi'
        }

        // Skip detection if recently detected and text is similar
        if (detectedLanguage && text.length < 50) {
          timer.end()
          return detectedLanguage
        }

        const requestBody = {
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: "Detect language. Reply with only the language code: hi, en, bn, te, ta, mr, gu, kn, ml, pa, or, as, ur. Nothing else."
            },
            {
              role: "user",
              content: text.substring(0, 200) // Only send first 200 chars
            }
          ],
          max_tokens: 5,
          temperature: 0,
        }

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKeys.openai}`,
          },
          body: JSON.stringify(requestBody),
        })

        if (!response.ok) {
          timer.end()
          return currentLanguage || 'hi'
        }

        const data = await response.json()
        if (data.choices && data.choices[0] && data.choices[0].message) {
          const detectedLang = data.choices[0].message.content.trim().toLowerCase()
          console.log(`🌐 [LANGUAGE_DETECT] Detected: ${detectedLang}`)
          timer.end()
          return detectedLang
        }

        timer.end()
        return currentLanguage || 'hi'
      } catch (error) {
        console.error(`❌ [LANGUAGE_DETECT] Error: ${error.message}`)
        timer.end()
        return currentLanguage || 'hi'
      }
    }

    // Optimized Deepgram connection
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
          deepgramUrl.searchParams.append("endpointing", "200")

          console.log(`🎤 [DEEPGRAM] Connecting with language: ${deepgramLanguage}`)

          deepgramWs = new WebSocket(deepgramUrl.toString(), {
            headers: { Authorization: `Token ${apiKeys.deepgram}` },
          })
          deepgramWs.binaryType = "arraybuffer"

          const connectionTimeout = setTimeout(() => {
            if (deepgramWs) deepgramWs.close()
            timer.end()
            reject(new Error("Deepgram connection timeout"))
          }, 5000)

          deepgramWs.onopen = () => {
            clearTimeout(connectionTimeout)
            deepgramReady = true
            deepgramConnected = true
            reconnectAttempts = 0
            timer.end()
            console.log(`✅ [DEEPGRAM] Connected with language: ${deepgramLanguage}`)
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
              const delay = Math.min(reconnectDelay * Math.pow(2, reconnectAttempts - 1), 10000)
              console.log(`🔄 [DEEPGRAM] Reconnecting in ${delay}ms`)

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

    // Handle Deepgram responses with immediate interruption
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
              currentTranscript += (currentTranscript ? " " : "") + transcript.trim()
              
              // Immediate processing with debounce
              debouncedProcessing(currentTranscript)
              
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
        console.log(`🎤 [DEEPGRAM] Speech started - interrupting audio`)
        interruptAllGeneration()
        resetSilenceTimer()
        isSpeaking = true
      } else if (data.type === "UtteranceEnd") {
        console.log(`🎤 [DEEPGRAM] Utterance ended`)
        if (isSpeaking) {
          isSpeaking = false
          startSilenceTimer()
        }
      }
    }

    // Debounced processing to avoid duplicate calls
    const debouncedProcessing = (text) => {
      if (processingDebounceTimer) {
        clearTimeout(processingDebounceTimer)
      }
      
      processingDebounceTimer = setTimeout(() => {
        if (text.trim() && text !== lastProcessedText) {
          lastProcessedText = text
          processUserInput(text)
        }
      }, 200)
    }

    // Interrupt all generation immediately
    const interruptAllGeneration = () => {
      if (greetingInProgress) {
        console.log("🛑 [INTERRUPT] Blocked - greeting in progress")
        return
      }

      console.log("🛑 [INTERRUPT] Stopping all generation")
      shouldInterruptGeneration = true
      isPlayingAudio = false
      audioInterrupted = true

      // Cancel current OpenAI request
      if (currentOpenAIRequest) {
        currentOpenAIRequest.abort()
        currentOpenAIRequest = null
      }

      // Cancel pending TTS requests
      pendingTTSRequests.clear()
      
      // Reset state
      setTimeout(() => {
        shouldInterruptGeneration = false
        audioInterrupted = false
      }, 100)
    }

    // Process user input with streaming
    const processUserInput = async (userMessage) => {
      if (isProcessingOpenAI || !apiKeys.openai || !userMessage.trim()) {
        return
      }

      const timer = createTimer("USER_INPUT_PROCESSING")
      isProcessingOpenAI = true

      try {
        // Detect language first
        const newDetectedLanguage = await detectLanguage(userMessage)
        if (newDetectedLanguage !== detectedLanguage) {
          detectedLanguage = newDetectedLanguage
          console.log(`🌐 [LANGUAGE_SWITCH] Language changed to: ${detectedLanguage}`)
        }

        // Get OpenAI response
        const openaiResponse = await streamingOpenAIRequest(userMessage)
        if (openaiResponse && !shouldInterruptGeneration) {
          // Start streaming TTS immediately
          streamingTTSGeneration(openaiResponse, detectedLanguage)
        }

        timer.end()
      } catch (error) {
        console.error(`❌ [USER_INPUT] Error: ${error.message}`)
        timer.end()
      } finally {
        isProcessingOpenAI = false
      }
    }

    // Optimized OpenAI request with abortion support
    const streamingOpenAIRequest = async (userMessage) => {
      const timer = createTimer("OPENAI_STREAMING")
      
      try {
        // Check for duplicates
        if (fullConversationHistory.length > 0) {
          const lastMessage = fullConversationHistory[fullConversationHistory.length - 1]
          if (lastMessage.role === "user" && lastMessage.content === userMessage) {
            console.log("🔄 [OPENAI] Duplicate message detected, skipping")
            timer.end()
            return null
          }
        }

        fullConversationHistory.push({
          role: "user",
          content: userMessage,
        })

        // Optimized system prompt
        const systemPrompt = `You are ${agentConfig?.agentName || "Assistant"}, a ${agentConfig?.personality || "formal"} voice assistant.

Context: ${agentConfig?.description || "Helpful assistant"}
Language: Always respond in ${detectedLanguage || currentLanguage || "hi"}
Style: ${agentConfig?.personality || "formal"}, conversational, 1-2 sentences max

Keep responses very brief for phone calls.`

        const requestBody = {
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            ...fullConversationHistory.slice(-8)
          ],
          max_tokens: 100,
          temperature: agentConfig?.personality === "formal" ? 0.2 : 0.5,
        }

        // Create AbortController for cancellation
        const controller = new AbortController()
        currentOpenAIRequest = controller

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKeys.openai}`,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`OpenAI API error: ${response.status}`)
        }

        const data = await response.json()

        if (data.choices && data.choices[0] && data.choices[0].message) {
          const openaiResponse = data.choices[0].message.content

          fullConversationHistory.push({
            role: "assistant",
            content: openaiResponse,
          })

          console.log(`🤖 [OPENAI] Response: "${openaiResponse}"`)
          timer.end()
          return openaiResponse
        }

        timer.end()
        return null
      } catch (error) {
        if (error.name === 'AbortError') {
          console.log("🛑 [OPENAI] Request aborted")
        } else {
          console.error(`❌ [OPENAI] Error: ${error.message}`)
        }
        timer.end()
        return null
      } finally {
        currentOpenAIRequest = null
      }
    }

    // Streaming TTS generation with chunking
    const streamingTTSGeneration = async (text, targetLanguage = null, isGreeting = false) => {
      if (!apiKeys.sarvam || !text.trim() || shouldInterruptGeneration) {
        return
      }

      const timer = createTimer("STREAMING_TTS")
      
      try {
        const useLanguage = targetLanguage || currentLanguage || 'hi'
        const validVoice = getValidSarvamVoice(agentConfig?.voiceSelection)
        const sarvamLanguage = getSarvamLanguage(useLanguage)

        // Chunk text for streaming
        const chunks = chunkText(text, 80)
        console.log(`🎵 [STREAMING_TTS] Processing ${chunks.length} chunks`)

        // Process chunks concurrently but send in order
        const chunkPromises = chunks.map(async (chunk, index) => {
          if (shouldInterruptGeneration) return null

          const chunkId = `${ttsChunkCounter++}_${index}`
          const chunkTimer = createTimer(`TTS_CHUNK_${chunkId}`)

          try {
            const requestBody = {
              inputs: [chunk],
              target_language_code: sarvamLanguage,
              speaker: validVoice,
              pitch: 0,
              pace: 1.1,
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
              throw new Error(`Sarvam API error: ${response.status}`)
            }

            const responseData = await response.json()

            if (responseData.audios && responseData.audios.length > 0) {
              const audioBase64 = responseData.audios[0]
              const audioBuffer = Buffer.from(audioBase64, "base64")
              
              chunkTimer.end()
              return {
                index,
                audioBuffer,
                chunkId
              }
            }

            chunkTimer.end()
            return null
          } catch (error) {
            console.error(`❌ [TTS_CHUNK] Error for chunk ${chunkId}: ${error.message}`)
            chunkTimer.end()
            return null
          }
        })

        // Send audio chunks as they complete
        const results = await Promise.allSettled(chunkPromises)
        let sentChunks = 0

        for (const result of results) {
          if (result.status === 'fulfilled' && result.value && !shouldInterruptGeneration) {
            const { audioBuffer, index, chunkId } = result.value

            const pythonBytesString = bufferToPythonBytesString(audioBuffer)
            const audioResponse = {
              data: {
                session_id: sessionId,
                count: sentChunks + 1,
                audio_bytes_to_play: pythonBytesString,
                sample_rate: 22050,
                channels: 1,
                sample_width: 2,
                is_streaming: true,
                format: "mp3",
                chunk_id: chunkId,
                total_chunks: chunks.length,
              },
              type: "ai_response",
            }

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(audioResponse))
              sentChunks++
              console.log(`✅ [STREAMING_TTS] Sent chunk ${sentChunks}/${chunks.length} (${audioBuffer.length} bytes)`)
            }
          }
        }

        // Send completion signal
        if (ws.readyState === WebSocket.OPEN && sentChunks > 0) {
          ws.send(JSON.stringify({
            type: "ai_response_complete",
            session_id: sessionId,
            total_chunks: sentChunks,
          }))
        }

        timer.end()
      } catch (error) {
        console.error(`❌ [STREAMING_TTS] Error: ${error.message}`)
        timer.end()
      }
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

    // Silence detection with optimized timing
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
      if (currentTranscript.trim() && !isProcessingOpenAI) {
        processUserInput(currentTranscript.trim())
        currentTranscript = ""
      }
    }

    // Optimized buffer conversion
    const bufferToPythonBytesString = (buffer) => {
      const hexString = buffer.toString('hex')
      return `b'${hexString.match(/../g).map(byte => `\\x${byte}`).join('')}'`
    }

    // WebSocket message handling with optimized parsing
    ws.on("message", async (message) => {
      const messageTimer = createTimer("MESSAGE_PROCESSING")
      
      try {
        let data = null
        let isTextMessage = false

        // Optimized message parsing
        if (typeof message === "string") {
          try {
            data = JSON.parse(message)
            isTextMessage = true
          } catch {
            isTextMessage = false
          }
        } else if (Buffer.isBuffer(message)) {
          const messageStr = message.toString('utf8')
          if (messageStr.trim().startsWith("{")) {
            try {
              data = JSON.parse(messageStr)
              isTextMessage = true
            } catch {
              isTextMessage = false
            }
          }
        }

        if (isTextMessage && data) {
          console.log(`📨 [MESSAGE] Received:`, data.type || data.event)

          if (data.event === "start" && data.session_id) {
            sessionId = data.session_id
            destinationNumber = data.Destination
            sourceNumber = data.Source

            console.log(`✅ [SESSION] SIP Call Started:`)
            console.log(`   - Session ID: ${sessionId}`)
            console.log(`   - Source: ${sourceNumber}`)
            console.log(`   - Destination: ${destinationNumber}`)

            // IMMEDIATE ACTION: Send greeting without waiting
            const agent = await sendInstantGreeting(destinationNumber)
            if (!agent) {
              ws.send(JSON.stringify({
                type: "error",
                message: `No agent for DID: ${destinationNumber}`,
                session_id: sessionId,
              }))
              messageTimer.end()
              return
            }

            // Load API keys in background
            loadApiKeysForTenant(tenantId).then(loaded => {
              if (loaded) connectToDeepgram().catch(console.error)
            })

            ws.send(JSON.stringify({
              type: "session_started",
              session_id: sessionId,
              agent: agentConfig.agentName,
              did_number: destinationNumber,
              tenant_id: tenantId,
            }))
          } else if (data.type === "synthesize") {
            streamingTTSGeneration(data.text, data.language || currentLanguage)
          } else if (data.data?.hangup === "true") {
            console.log(`📞 [SESSION] Hangup for ${sessionId}`)
            interruptAllGeneration()
            if (deepgramWs) deepgramWs.close(1000)
            ws.close(1000)
          }
        } else {
          // Audio data - handle with priority
          if (isPlayingAudio && !greetingInProgress) {
            interruptAllGeneration()
          }

          if (deepgramConnected) {
            await sendAudioToDeepgram(message)
          }
        }

        messageTimer.end()
      } catch (error) {
        console.error(`❌ [MESSAGE] Error: ${error.message}`)
        messageTimer.end()
      }
    })

    // Connection cleanup
    ws.on("close", () => {
      console.log(`🔗 [SESSION] Connection closed for ${sessionId}`)
      interruptAllGeneration()
      
      if (deepgramWs) deepgramWs.close(1000)
      if (silenceTimeout) clearTimeout(silenceTimeout)
      if (processingDebounceTimer) clearTimeout(processingDebounceTimer)

      // Reset all state
      sessionId = null
      destinationNumber = null
      sourceNumber = null
      tenantId = null
      agentConfig = null
      currentLanguage = null
      detectedLanguage = null
      currentTranscript = ""
      fullConversationHistory = []
      isSpeaking = false
      isPlayingAudio = false
      isProcessingOpenAI = false
      currentOpenAIRequest = null
      pendingTTSRequests.clear()
      ttsChunkCounter = 0
      shouldInterruptGeneration = false
      audioInterrupted = false
      greetingInProgress = false
    })

    ws.on("error", (error) => {
      console.error(`❌ [SESSION] WebSocket error: ${error.message}`)
      interruptAllGeneration()
    })
  })
}

module.exports = { setupUnifiedVoiceServer }
