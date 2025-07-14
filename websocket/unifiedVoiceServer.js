const WebSocket = require("ws")
const FormData = require("form-data")
const fs = require("fs")
const path = require("path")
const { SarvamAIClient } = require("sarvamai")

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
    let greetingInProgress = false // Add flag to prevent interruption during greeting

    // Audio processing
    const MIN_CHUNK_SIZE = 320
    const SEND_INTERVAL = 50
    const GREETING_PROTECTION_DELAY = 5000 // 5 seconds protection for greeting

    // API Keys
    const sarvamApiKey = process.env.SARVAM_API_KEY
    const deepgramApiKey = process.env.DEEPGRAM_API_KEY
    const openaiApiKey = process.env.OPENAI_API_KEY

    const url = new URL(req.url, "http://localhost")
    const language = url.searchParams.get("language") || "en"

    console.log(`🌐 Connection established with language: ${language}`)
    console.log(`🔑 API Keys configured:`)
    console.log(`   - Deepgram: ${deepgramApiKey ? "✅ Yes" : "❌ NO"}`)
    console.log(`   - Sarvam TTS: ${sarvamApiKey ? "✅ Yes" : "❌ NO"}`)
    console.log(`   - OpenAI: ${openaiApiKey ? "✅ Yes" : "❌ NO"}`)

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
      // Don't interrupt if greeting is in progress
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
            // Send to OpenAI
            console.log(`🤖 [OPENAI] Sending text to OpenAI: "${queueItem.text}"`)
            const openaiResponse = await sendToOpenAI(queueItem.text)

            if (openaiResponse) {
              console.log(`✅ [OPENAI] Received response: "${openaiResponse}"`)

              // Send to Sarvam TTS for voice synthesis
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
            console.log("❌ Deepgram connection error:", error.message)
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
        
        // Interrupt current audio when user starts speaking
        if (isPlayingAudio) {
          interruptCurrentAudio()
        }

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

        // Add to queue for processing
        addToTextQueue(currentTranscript.trim(), "complete_utterance")

        // Reset for next utterance
        currentTranscript = ""
      }
    }

    // Enhanced OpenAI API Integration with logging
    const sendToOpenAI = async (userMessage) => {
      if (isProcessingOpenAI || !openaiApiKey || !userMessage.trim()) {
        console.log(
          `⚠️ [OPENAI] Skipping request - Processing: ${isProcessingOpenAI}, API Key: ${!!openaiApiKey}, Message: "${userMessage}"`,
        )
        return null
      }

      isProcessingOpenAI = true
      console.log(`🤖 [OPENAI] Sending request:`)
      console.log(`   - Message: "${userMessage}"`)
      console.log(`   - Session ID: ${sessionId}`)
      console.log(`   - Conversation History Length: ${fullConversationHistory.length}`)

      try {
        const apiUrl = "https://api.openai.com/v1/chat/completions"

        // Add to conversation history
        fullConversationHistory.push({
          role: "user",
          content: userMessage,
        })

        const requestBody = {
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a helpful voice assistant for telephonic conversations. Keep responses very short and conversational, maximum 2-3 sentences. You're speaking to someone over the phone so be natural and brief. Respond in ${language === "hi" ? "Hindi" : "English"}.`
            },
            ...fullConversationHistory.slice(-10) // Keep last 10 messages for context
          ],
          max_tokens: 150,
          temperature: 0.7,
        }

        console.log(`🤖 [OPENAI] Making API request...`)
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "Authorization": `Bearer ${openaiApiKey}`
          },
          body: JSON.stringify(requestBody),
        })

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

          // Add to conversation history
          fullConversationHistory.push({
            role: "assistant",
            content: openaiResponse,
          })

          console.log(`📚 [OPENAI] Updated conversation history length: ${fullConversationHistory.length}`)
          return openaiResponse
        }

        console.log(`❌ [OPENAI] No valid response in API data`)
        return null
      } catch (error) {
        console.log(`❌ [OPENAI] API error: ${error.message}`)
        return null
      } finally {
        isProcessingOpenAI = false
        console.log(`🤖 [OPENAI] Request processing completed`)
      }
    }

    // Enhanced TTS Synthesis with Sarvam Non-Streaming API
    const synthesizeAndSendResponse = async (text) => {
      if (!sarvamApiKey || !text.trim()) {
        console.log(`[SARVAM] Skipping synthesis - API Key: ${!!sarvamApiKey}, Text: "${text}"`)
        return;
      }

      try {
        console.log(`[SARVAM] Using non-streaming TTS for: "${text}"`);
        const client = new SarvamAIClient({
          apiSubscriptionKey: sarvamApiKey,
        });

        const response = await client.textToSpeech.convert({
          text,
          model: "bulbul:v2",
          speaker: language === "hi" ? "anushka" : "meera",
          target_language_code: language === "hi" ? "hi-IN" : "en-IN",
        });

        if (response && response.audio) {
          // Send the audio to the client
          const audioBuffer = Buffer.from(response.audio, "base64");
          const pythonBytesString = bufferToPythonBytesString(audioBuffer);

          const audioResponse = {
            data: {
              session_id: sessionId,
              count: 1,
              audio_bytes_to_play: pythonBytesString,
              sample_rate: 8000,
              channels: 1,
              sample_width: 2,
              is_streaming: false,
              format: "mp3",
            },
            type: "ai_response",
          };

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(audioResponse));
            ws.send(JSON.stringify({
              type: "ai_response_complete",
              session_id: sessionId,
              total_chunks: 1,
            }));
            console.log(`[SARVAM] Non-streaming audio sent to client`);
          }
        } else {
          console.log(`[SARVAM] No audio received from TTS`);
        }
      } catch (error) {
        console.log(`[SARVAM] Non-streaming TTS error: ${error.message}`);
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
      if (connectionGreetingSent || !sarvamApiKey || !sessionId) {
        console.log(`⚠️ [GREETING] Skipping greeting - Sent: ${connectionGreetingSent}, API Key: ${!!sarvamApiKey}, Session: ${!!sessionId}`)
        return
      }

      // Test Sarvam API key
      console.log(`🔑 [SARVAM] Testing API key: ${sarvamApiKey.substring(0, 10)}...`)
      
      const greetings = {
        hi: "नमस्ते! Aitota से संपर्क करने के लिए धन्यवाद।",
        en: "Hi! Thank you for contacting Aitota.",
      }

      const greetingText = greetings[language] || greetings["en"]
      console.log(`👋 [GREETING] Sending greeting: "${greetingText}"`)

      try {
        // Add a longer delay to ensure Deepgram connection is stable
        await new Promise(resolve => setTimeout(resolve, 1000))
        
        await synthesizeAndSendResponse(greetingText)
        connectionGreetingSent = true
        console.log(`✅ [GREETING] Greeting sent successfully!`)
      } catch (error) {
        console.log(`❌ [GREETING] Failed to send greeting: ${error.message}`)
        connectionGreetingSent = true
        greetingInProgress = false // Reset protection on error
        
        // Send a simple text response as fallback
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "greeting_fallback",
            session_id: sessionId,
            message: greetingText,
            error: error.message
          }))
          console.log(`📝 [GREETING] Sent fallback text response`)
        }
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
            isPlayingAudio = false
            shouldInterruptAudio = false
            greetingInProgress = false // Reset greeting protection

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

            // Send greeting after a longer delay to ensure connection stability
            setTimeout(() => {
              sendGreeting()
            }, 2000) // Increased from 500ms to 2000ms
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
            
            // Close any active TTS connection
            if (currentTTSSocket) {
              console.log(`🛑 [SARVAM] Closing TTS connection due to hangup`)
              currentTTSSocket.close()
            }
            
            ws.close(1000, "Hangup requested")
          }
        } else {
          // Handle audio data - send to persistent Deepgram connection
          console.log(`🎵 [AUDIO] Received audio buffer size: ${message.length} bytes`)
          
          // If we're currently playing audio and receive user audio, interrupt (unless greeting is protected)
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

      // Close any active TTS connection
      if (currentTTSSocket) {
        console.log(`🛑 [SARVAM] Closing TTS connection for session ${sessionId}`)
        currentTTSSocket.close()
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
      
      // Close any active TTS connection
      if (currentTTSSocket) {
        console.log(`🛑 [SARVAM] Closing TTS connection due to error`)
        currentTTSSocket.close()
      }
    })

    console.log(`✅ [SESSION] WebSocket connection ready, waiting for SIP 'start' event`)
  })
}

module.exports = { setupUnifiedVoiceServer }
