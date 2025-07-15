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

    // FIXED: Fast DID-based agent lookup with immediate response
    const loadAgentByDIDAndSendGreeting = async (didNumber) => {
      try {
        const originalDid = didNumber;
        const normalizedDid = normalizeDID(didNumber);
        console.log(`🔍 [AGENT_LOOKUP] Searching for agent with DID:`, {
          originalDid,
          normalizedDid,
          type: typeof didNumber
        });
        const startTime = Date.now();

        const agent = await Agent.findOne({ didNumber: normalizedDid });
        const lookupTime = Date.now() - startTime;
        console.log(`⚡ [AGENT_LOOKUP] DID lookup completed in ${lookupTime}ms`);

        if (!agent) {
          console.error(`❌ [AGENT_LOOKUP] No agent found for DID: ${normalizedDid}`);
          return null;
        }

        // Set session variables
        tenantId = agent.tenantId
        agentConfig = agent
        currentLanguage = agent.language || 'hi'
        detectedLanguage = currentLanguage

        console.log(`✅ [AGENT_LOOKUP] Agent found:`)
        console.log(`   - Agent Name: ${agent.agentName}`)
        console.log(`   - Tenant ID: ${agent.tenantId}`)
        console.log(`   - DID Number: ${agent.didNumber}`)
        console.log(`   - Default Language: ${currentLanguage}`)
        console.log(`   - Personality: ${agent.personality}`)
        console.log(`   - Category: ${agent.category}`)
        console.log(`   - Voice Selection: ${agent.voiceSelection}`)
        console.log(`   - First Message: ${agent.firstMessage}`)
        console.log(`   - Pre-generated Audio: ${agent.audioBytes ? `✅ Available (${agent.audioBytes.length} bytes)` : "❌ Not Available"}`)

        // FIXED: Immediate greeting with fallback
        if (agent.audioBytes && agent.audioBytes.length > 0) {
          // Send pre-generated audio immediately
          await sendImmediateGreeting(agent)
        } else {
          // FIXED: Send text-based greeting immediately, then generate audio in background
          await sendInstantTextGreeting(agent)
          // Generate audio in background for next time
          generateAudioInBackground(agent)
        }

        return agent
      } catch (error) {
        console.error(`❌ [AGENT_LOOKUP] Error: ${error.message}`)
        return null
      }
    }

    // FIXED: Instant text greeting for agents without pre-generated audio
    const sendInstantTextGreeting = async (agent) => {
      if (connectionGreetingSent || !sessionId) {
        return
      }

      console.log(`⚡ [INSTANT_GREETING] Sending text greeting for agent: ${agent.agentName}`)
      
      try {
        // Send text greeting immediately
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

        // Generate audio and send it
        await generateAndSendGreetingAudio(agent)
        connectionGreetingSent = true

      } catch (error) {
        console.error(`❌ [INSTANT_GREETING] Error: ${error.message}`)
      }
    }

    // FIXED: Generate and send greeting audio quickly
    const generateAndSendGreetingAudio = async (agent) => {
      try {
        console.log(`🎵 [GREETING_AUDIO] Generating for: "${agent.firstMessage}"`)
        
        const validVoice = getValidSarvamVoice(agent.voiceSelection)
        const sarvamLanguage = getSarvamLanguage(currentLanguage)
        
        console.log(`🎵 [GREETING_AUDIO] Using voice: ${validVoice} (mapped from: ${agent.voiceSelection})`)
        
        if (!apiKeys.sarvam) {
          throw new Error("Sarvam API key not available")
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

        isPlayingAudio = true
        setTimeout(() => {
          isPlayingAudio = false
        }, 3000)

        // Save audio for future use
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

      } catch (error) {
        console.error(`❌ [GREETING_AUDIO] Error: ${error.message}`)
      }
    }

    // Background audio generation for future use
    const generateAudioInBackground = async (agent) => {
      // Don't await this - let it run in background
      setImmediate(async () => {
        try {
          console.log(`🔄 [BACKGROUND_AUDIO] Generating for future use: ${agent.agentName}`)
          
          const validVoice = getValidSarvamVoice(agent.voiceSelection)
          const sarvamLanguage = getSarvamLanguage(currentLanguage)
          
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

          if (response.ok) {
            const responseData = await response.json()
            if (responseData.audios && responseData.audios.length > 0) {
              const audioBuffer = Buffer.from(responseData.audios[0], "base64")
              
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
              
              console.log(`✅ [BACKGROUND_AUDIO] Audio generated and saved for future use`)
            }
          }
        } catch (error) {
          console.error(`❌ [BACKGROUND_AUDIO] Error: ${error.message}`)
        }
      })
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

    // Language detection using OpenAI
    const detectLanguage = async (text) => {
      try {
        if (!apiKeys.openai || !text.trim()) {
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

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKeys.openai}`,
          },
          body: JSON.stringify(requestBody),
        })

        if (!response.ok) {
          console.error(`❌ [LANGUAGE_DETECT] OpenAI API error: ${response.status}`)
          return currentLanguage || 'hi'
        }

        const data = await response.json()
        if (data.choices && data.choices[0] && data.choices[0].message) {
          const detectedLang = data.choices[0].message.content.trim().toLowerCase()
          console.log(`🌐 [LANGUAGE_DETECT] Detected: ${detectedLang} from text: "${text}"`)
          return detectedLang
        }

        return currentLanguage || 'hi'
      } catch (error) {
        console.error(`❌ [LANGUAGE_DETECT] Error: ${error.message}`)
        return currentLanguage || 'hi'
      }
    }

    // FIXED: Generate and save audio bytes with proper voice validation
    const generateAndSaveAudioBytes = async (text, agentId, targetLanguage = null) => {
      try {
        const useLanguage = targetLanguage || currentLanguage || 'hi'
        console.log(`🎵 [AUDIO_GEN] Generating audio bytes for: "${text}" in language: ${useLanguage}`)

        if (!apiKeys.sarvam) {
          throw new Error("Sarvam API key not available")
        }

        const sarvamLanguage = getSarvamLanguage(useLanguage)
        const validVoice = getValidSarvamVoice(agentConfig?.voiceSelection)

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

        console.log(`🎵 [AUDIO_GEN] Sarvam request:`, {
          target_language_code: sarvamLanguage,
          speaker: validVoice,
          text_length: text.length,
          original_voice: agentConfig?.voiceSelection
        })

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
          console.error(`❌ [AUDIO_GEN] Sarvam API error: ${response.status}`, errorText)
          throw new Error(`Sarvam API error: ${response.status}`)
        }

        const responseData = await response.json()
        if (!responseData.audios || responseData.audios.length === 0) {
          throw new Error("No audio data received")
        }

        const audioBase64 = responseData.audios[0]
        const audioBuffer = Buffer.from(audioBase64, "base64")

        // Save audio bytes to database if this is for the first message
        if (agentId && !agentConfig.audioBytes) {
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
                language: useLanguage,
                speaker: validVoice,
                provider: "sarvam",
              },
            },
          )

          console.log(`✅ [AUDIO_GEN] Audio bytes saved to database: ${audioBuffer.length} bytes`)

          // Update agent config with new audio
          agentConfig.audioBytes = audioBuffer
          agentConfig.audioMetadata = {
            format: "mp3",
            sampleRate: 22050,
            channels: 1,
            size: audioBuffer.length,
            generatedAt: new Date(),
            language: useLanguage,
            speaker: validVoice,
            provider: "sarvam",
          }
        }

        return audioBuffer
      } catch (error) {
        console.error(`❌ [AUDIO_GEN] Error: ${error.message}`)
        return null
      }
    }

    // Optimized Deepgram connection with dynamic language
    const connectToDeepgram = async () => {
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

    // Handle Deepgram responses
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

    // Text processing queue with language detection
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

            const openaiResponse = await sendToOpenAI(queueItem.text)
            if (openaiResponse) {
              await synthesizeWithSarvam(openaiResponse, detectedLanguage)
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

    // Enhanced OpenAI Integration with agent profile fields
    const sendToOpenAI = async (userMessage) => {
      if (isProcessingOpenAI || !apiKeys.openai || !userMessage.trim()) {
        return null
      }

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

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKeys.openai}`,
          },
          body: JSON.stringify(requestBody),
        })

        if (!response.ok) {
          console.error(`❌ [OPENAI] API error: ${response.status}`)
          return null
        }

        const data = await response.json()

        if (data.choices && data.choices[0] && data.choices[0].message) {
          const openaiResponse = data.choices[0].message.content

          fullConversationHistory.push({
            role: "assistant",
            content: openaiResponse,
          })

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

    // FIXED: Enhanced Sarvam TTS Synthesis with proper voice validation
    const synthesizeWithSarvam = async (text, targetLanguage = null) => {
      if (!apiKeys.sarvam || !text.trim()) {
        return
      }

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

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
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
              }))
            }

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

      if (currentTTSSocket) {
        currentTTSSocket.close()
      }
    })

    console.log(`✅ [SESSION] WebSocket ready, waiting for SIP start event`)
  })
}

module.exports = { setupUnifiedVoiceServer }
