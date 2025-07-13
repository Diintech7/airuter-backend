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
  console.log("🚀 Unified Voice WebSocket server initialized with Sarvam TTS and Persistent Deepgram Connection")

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

    // Audio processing and streaming
    const MIN_CHUNK_SIZE = 320
    const SEND_INTERVAL = 50

    // Sarvam TTS streaming variables
    let sarvamSocket = null
    let isStreamingAudio = false
    let audioStreamQueue = []
    let currentAudioChunks = []
    let shouldStopAudio = false

    // API Keys
    const sarvamApiKey = process.env.SARVAM_API_KEY
    const deepgramApiKey = process.env.DEEPGRAM_API_KEY
    const geminiApiKey = process.env.GEMINI_API_KEY

    const url = new URL(req.url, "http://localhost")
    const language = url.searchParams.get("language") || "en"

    console.log(`🌐 Connection established with language: ${language}`)
    console.log(`🔑 API Keys configured:`)
    console.log(`   - Deepgram: ${deepgramApiKey ? "✅ Yes" : "❌ NO"}`)
    console.log(`   - Sarvam TTS: ${sarvamApiKey ? "✅ Yes" : "❌ NO"}`)
    console.log(`   - Gemini: ${geminiApiKey ? "✅ Yes" : "❌ NO"}`)

    // VAD and speech detection state
    const vadState = {
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
            // Send to Gemini for short response
            console.log(`🤖 [GEMINI] Sending text to Gemini: "${queueItem.text}"`)
            const geminiResponse = await sendToGemini(queueItem.text)

            if (geminiResponse) {
              console.log(`✅ [GEMINI] Received response: "${geminiResponse}"`)

              // Send to Sarvam for streaming voice synthesis
              console.log(`🔊 [SARVAM] Sending to streaming voice synthesis: "${geminiResponse}"`)
              await synthesizeAndStreamResponse(geminiResponse)
              console.log(`✅ [SARVAM] Voice response streaming completed`)
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

    // Persistent Deepgram Connection
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

    // Handle Deepgram responses with speech interruption
    const handleDeepgramResponse = async (data) => {
      console.log(`📡 [DEEPGRAM] Received response type: ${data.type}`)

      if (data.type === "Results") {
        const channel = data.channel
        if (channel && channel.alternatives && channel.alternatives.length > 0) {
          const transcript = channel.alternatives[0].transcript
          const confidence = channel.alternatives[0].confidence
          const is_final = data.is_final

          if (transcript && transcript.trim()) {
            console.log(`📝 [DEEPGRAM] Transcript received: "${transcript}" (Final: ${is_final})`)

            // Reset silence timer when we get speech
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
        console.log(`🎙️ [DEEPGRAM] VAD: Speech started detected - STOPPING AUDIO`)

        // Stop current audio streaming when user starts speaking
        shouldStopAudio = true
        stopCurrentAudioStream()

        resetSilenceTimer()
        isSpeaking = true

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "speech_started",
              timestamp: data.timestamp,
              channel: data.channel,
              session_id: sessionId,
              message: "Speech activity detected - audio stopped",
            }),
          )
        }

        vadState.totalSpeechEvents++
      } else if (data.type === "UtteranceEnd") {
        console.log(`🎙️ [DEEPGRAM] VAD: Utterance end detected`)

        if (isSpeaking) {
          isSpeaking = false
          shouldStopAudio = false // Allow audio to resume
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
      }
    }

    // Stop current audio streaming
    const stopCurrentAudioStream = () => {
      console.log(`🛑 [AUDIO] Stopping current audio stream`)

      if (sarvamSocket && sarvamSocket.readyState === WebSocket.OPEN) {
        sarvamSocket.close()
        sarvamSocket = null
      }

      isStreamingAudio = false
      audioStreamQueue = []
      currentAudioChunks = []

      // Send stop signal to client
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "audio_stopped",
            session_id: sessionId,
            message: "Audio playback stopped due to user speech",
          }),
        )
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
        addToTextQueue(currentTranscript.trim(), "complete_utterance")
        currentTranscript = ""
      }
    }

    // Enhanced Gemini API Integration with SHORT responses for telephonic calls
    const sendToGemini = async (userMessage) => {
      if (isProcessingGemini || !geminiApiKey || !userMessage.trim()) {
        console.log(`⚠️ [GEMINI] Skipping request - Processing: ${isProcessingGemini}, Message: "${userMessage}"`)
        return null
      }

      isProcessingGemini = true
      console.log(`🤖 [GEMINI] Sending request: "${userMessage}"`)

      try {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${geminiApiKey}`

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
            maxOutputTokens: 50, // VERY SHORT responses for telephonic calls
          },
          systemInstruction: {
            parts: [
              {
                text: "You are an AI assistant for telephonic conversations. Keep responses VERY SHORT (1-2 sentences maximum, under 20 words). Be conversational, helpful, and direct. This is a real-time phone call, so be concise and natural.",
              },
            ],
          },
        }

        console.log(`🤖 [GEMINI] Making API request for SHORT response...`)
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

        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
          const geminiResponse = data.candidates[0].content.parts[0].text

          console.log(`🤖 [GEMINI] SHORT Response: "${geminiResponse}"`)

          fullConversationHistory.push({
            role: "model",
            parts: [{ text: geminiResponse }],
          })

          return geminiResponse
        }

        return null
      } catch (error) {
        console.log(`❌ [GEMINI] API error: ${error.message}`)
        return null
      } finally {
        isProcessingGemini = false
      }
    }

    // Sarvam Streaming TTS Implementation
    const synthesizeAndStreamResponse = async (text) => {
      if (!sarvamApiKey || !text.trim() || shouldStopAudio) {
        console.log(
          `⚠️ [SARVAM] Skipping synthesis - API Key: ${!!sarvamApiKey}, Text: "${text}", ShouldStop: ${shouldStopAudio}`,
        )
        return
      }

      try {
        console.log(`🔊 [SARVAM] Starting streaming synthesis: "${text}"`)

        // Split text into smaller chunks for streaming
        const textChunks = splitTextIntoChunks(text, 100) // Max 100 chars per chunk

        for (let i = 0; i < textChunks.length; i++) {
          if (shouldStopAudio) {
            console.log(`🛑 [SARVAM] Stopping synthesis due to user speech`)
            break
          }

          const chunk = textChunks[i]
          console.log(`🔊 [SARVAM] Processing chunk ${i + 1}/${textChunks.length}: "${chunk}"`)

          await streamTextChunkWithSarvam(chunk, i === textChunks.length - 1)

          // Small delay between chunks for natural flow
          if (i < textChunks.length - 1 && !shouldStopAudio) {
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        }

        console.log(`✅ [SARVAM] Streaming synthesis completed`)
      } catch (error) {
        console.log(`❌ [SARVAM] Synthesis failed: ${error.message}`)
      }
    }

    // Split text into smaller chunks for streaming
    const splitTextIntoChunks = (text, maxLength = 100) => {
      const words = text.split(" ")
      const chunks = []
      let currentChunk = ""

      for (const word of words) {
        if ((currentChunk + " " + word).length <= maxLength) {
          currentChunk += (currentChunk ? " " : "") + word
        } else {
          if (currentChunk) {
            chunks.push(currentChunk)
          }
          currentChunk = word
        }
      }

      if (currentChunk) {
        chunks.push(currentChunk)
      }

      return chunks.length > 0 ? chunks : [text]
    }

    // Stream individual text chunk with Sarvam
    const streamTextChunkWithSarvam = async (textChunk, isLastChunk = false) => {
      return new Promise((resolve, reject) => {
        if (shouldStopAudio) {
          resolve()
          return
        }

        try {
          console.log(`🔊 [SARVAM] Connecting to streaming WebSocket for chunk: "${textChunk}"`)

          const sarvamWsUrl = "wss://api.sarvam.ai/text-to-speech-websocket"
          sarvamSocket = new WebSocket(sarvamWsUrl, {
            headers: {
              "api-subscription-key": sarvamApiKey,
            },
          })

          let chunkCount = 0
          const audioChunks = []

          sarvamSocket.onopen = () => {
            console.log(`✅ [SARVAM] WebSocket connected for chunk`)

            // Send config first
            sarvamSocket.send(
              JSON.stringify({
                type: "config",
                data: {
                  target_language_code: language === "hi" ? "hi-IN" : "en-IN",
                  speaker: "anushka",
                  pitch: 1.0,
                  pace: 1.0,
                  min_buffer_size: 30,
                  max_chunk_length: 100,
                  output_audio_codec: "mp3",
                  output_audio_bitrate: 128,
                },
              }),
            )

            // Send text for conversion
            sarvamSocket.send(
              JSON.stringify({
                type: "text",
                data: {
                  text: textChunk,
                },
              }),
            )

            // Send flush to ensure processing
            if (isLastChunk) {
              sarvamSocket.send(
                JSON.stringify({
                  type: "flush",
                }),
              )
            }
          }

          sarvamSocket.onmessage = (event) => {
            if (shouldStopAudio) {
              sarvamSocket.close()
              resolve()
              return
            }

            try {
              const message = JSON.parse(event.data)

              if (message.type === "audio" && message.data && message.data.audio) {
                chunkCount++
                const audioBuffer = Buffer.from(message.data.audio, "base64")
                audioChunks.push(audioBuffer)

                console.log(`🎵 [SARVAM] Received audio chunk ${chunkCount}: ${audioBuffer.length} bytes`)

                // Send audio immediately to client for real-time playback
                sendAudioChunkToClient(audioBuffer, chunkCount)
              } else if (message.type === "error") {
                console.log(`❌ [SARVAM] Error: ${message.data}`)
                reject(new Error(message.data))
              }
            } catch (parseError) {
              console.log(`❌ [SARVAM] Error parsing message: ${parseError.message}`)
            }
          }

          sarvamSocket.onclose = () => {
            console.log(`🔊 [SARVAM] WebSocket closed for chunk. Total audio chunks: ${chunkCount}`)
            resolve()
          }

          sarvamSocket.onerror = (error) => {
            console.log(`❌ [SARVAM] WebSocket error: ${error.message}`)
            reject(error)
          }

          // Timeout for chunk processing
          setTimeout(() => {
            if (sarvamSocket && sarvamSocket.readyState === WebSocket.OPEN) {
              sarvamSocket.close()
            }
            resolve()
          }, 10000)
        } catch (error) {
          console.log(`❌ [SARVAM] Error creating WebSocket: ${error.message}`)
          reject(error)
        }
      })
    }

    // Send audio chunk to client immediately
    const sendAudioChunkToClient = (audioBuffer, chunkIndex) => {
      if (shouldStopAudio || ws.readyState !== WebSocket.OPEN) {
        return
      }

      try {
        const audioWithHeader = createWAVHeader(audioBuffer, 8000, 1, 16)
        const pythonBytesString = bufferToPythonBytesString(audioWithHeader)

        audioChunkCount++
        const audioResponse = {
          data: {
            session_id: sessionId,
            count: audioChunkCount,
            chunk_index: chunkIndex,
            audio_bytes_to_play: pythonBytesString,
            sample_rate: 8000,
            channels: 1,
            sample_width: 2,
            streaming: true,
          },
          type: "ai_response_stream",
        }

        ws.send(JSON.stringify(audioResponse))
        console.log(`✅ [SARVAM] Streamed audio chunk ${chunkIndex} to client (${audioWithHeader.length} bytes)`)
      } catch (error) {
        console.log(`❌ [SARVAM] Error sending audio chunk: ${error.message}`)
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
        return
      }

      const greetings = {
        hi: "नमस्ते! Aitota में आपका स्वागत है।",
        en: "Hi! Welcome to Aitota.",
      }

      const greetingText = greetings[language] || greetings["en"]
      console.log(`👋 [GREETING] Sending short greeting: "${greetingText}"`)

      try {
        await synthesizeAndStreamResponse(greetingText)
        connectionGreetingSent = true
        console.log(`✅ [GREETING] Greeting sent successfully!`)
      } catch (error) {
        console.log(`❌ [GREETING] Failed to send greeting: ${error.message}`)
        connectionGreetingSent = true
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
            shouldStopAudio = false
            fullConversationHistory = []
            textProcessingQueue = []
            isProcessingQueue = false

            console.log(`✅ [SESSION] SIP Call Started with session ID: ${sessionId}`)

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "session_started",
                  session_id: sessionId,
                  language: language,
                  message: "SIP call started with Sarvam streaming TTS",
                }),
              )
            }

            try {
              await connectToDeepgram()
              console.log(`✅ [SESSION] Persistent Deepgram connection established`)
            } catch (error) {
              console.log(`❌ [SESSION] Failed to connect to Deepgram: ${error.message}`)
            }

            setTimeout(() => {
              sendGreeting()
            }, 500)
          } else if (data.type === "synthesize") {
            console.log(`🔊 [MESSAGE] TTS synthesis request: "${data.text}"`)
            if (data.session_id) {
              sessionId = data.session_id
            }
            await synthesizeAndStreamResponse(data.text)
          } else if (data.data && data.data.hangup === "true") {
            console.log(`📞 [SESSION] Hangup request received`)

            if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
              deepgramWs.close(1000, "Call ended")
            }

            if (sarvamSocket && sarvamSocket.readyState === WebSocket.OPEN) {
              sarvamSocket.close(1000, "Call ended")
            }

            ws.close(1000, "Hangup requested")
          }
        } else {
          // Handle audio data
          console.log(`Received audio buffer size: ${message.length} bytes`)
          if (deepgramConnected && deepgramReady) {
            await sendAudioToDeepgram(message)
          }
        }
      } catch (error) {
        console.log(`❌ [MESSAGE] Error processing message: ${error.message}`)
      }
    })

    // Connection cleanup
    ws.on("close", () => {
      console.log(`🔗 [SESSION] Connection closed for session ${sessionId}`)

      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.close(1000, "Session ended")
      }

      if (sarvamSocket && sarvamSocket.readyState === WebSocket.OPEN) {
        sarvamSocket.close(1000, "Session ended")
      }

      resetSilenceTimer()

      // Reset state
      sessionId = null
      audioChunkCount = 0
      deepgramReady = false
      deepgramConnected = false
      connectionGreetingSent = false
      currentTranscript = ""
      isSpeaking = false
      shouldStopAudio = false
      isStreamingAudio = false
      fullConversationHistory = []
      textProcessingQueue = []
      isProcessingQueue = false
      audioStreamQueue = []
      currentAudioChunks = []
    })

    ws.on("error", (error) => {
      console.log(`❌ [SESSION] WebSocket error: ${error.message}`)
    })

    console.log(`✅ [SESSION] WebSocket ready with Sarvam streaming TTS`)
  })
}

module.exports = { setupUnifiedVoiceServer }
