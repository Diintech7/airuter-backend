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
  console.log("🚀 Unified Voice WebSocket server initialized with Sarvam TTS and OpenAI")

  wss.on("connection", (ws, req) => {
    console.log("🔗 New unified voice connection established")
    console.log("📡 SIP Connection Details:", {
      timestamp: new Date().toISOString(),
      clientIP: req.socket.remoteAddress,
      userAgent: req.headers["user-agent"],
      origin: req.headers.origin,
    })

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
    let isProcessingAI = false
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
    let shouldStopAudio = false

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
      console.log(`📝 [QUEUE] Added to text processing queue: "${queueItem.text}"`)

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
          console.log(`⚡ [QUEUE] Processing: "${queueItem.text}"`)

          if (queueItem.text && queueItem.text.length > 0) {
            // Send to OpenAI
            console.log(`🤖 [OPENAI] Sending text to OpenAI: "${queueItem.text}"`)
            const aiResponse = await sendToOpenAI(queueItem.text)

            if (aiResponse) {
              console.log(`✅ [OPENAI] Received response: "${aiResponse}"`)

              // Send to Sarvam for voice synthesis
              console.log(`🔊 [SARVAM] Sending to voice synthesis: "${aiResponse}"`)
              await synthesizeAndSendResponse(aiResponse)
              console.log(`✅ [SARVAM] Voice response sent successfully`)
            } else {
              console.log(`❌ [OPENAI] No response received for: "${queueItem.text}"`)
            }
          }

          queueItem.processed = true
        } catch (error) {
          console.log(`❌ [QUEUE] Error processing item:`, error.message)
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
          deepgramUrl.searchParams.append("language", "en-IN")
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
            console.log(`📝 [DEEPGRAM] Transcript: "${transcript}" (Final: ${is_final})`)

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

        shouldStopAudio = true
        stopCurrentAudioStream()

        resetSilenceTimer()
        isSpeaking = true

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "speech_started",
              timestamp: data.timestamp,
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
          shouldStopAudio = false
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
      if (currentTranscript.trim() && !isProcessingAI) {
        console.log(`🔕 [SILENCE] Processing complete utterance: "${currentTranscript}"`)
        addToTextQueue(currentTranscript.trim(), "complete_utterance")
        currentTranscript = ""
      }
    }

    // OpenAI API Integration with SHORT responses for telephonic calls
    const sendToOpenAI = async (userMessage) => {
      if (isProcessingAI || !openaiApiKey || !userMessage.trim()) {
        console.log(`⚠️ [OPENAI] Skipping request - Processing: ${isProcessingAI}, Message: "${userMessage}"`)
        return null
      }

      isProcessingAI = true
      console.log(`🤖 [OPENAI] Sending request: "${userMessage}"`)

      try {
        const apiUrl = "https://api.openai.com/v1/chat/completions"

        fullConversationHistory.push({
          role: "user",
          content: userMessage,
        })

        const requestBody = {
          model: "gpt-3.5-turbo",
          messages: [
            {
              role: "system",
              content:
                "You are an AI assistant for telephonic conversations. Keep responses VERY SHORT (1-2 sentences maximum, under 15 words). Be conversational, helpful, and direct. This is a real-time phone call, so be concise and natural.",
            },
            ...fullConversationHistory,
          ],
          max_tokens: 30, // Very short responses
          temperature: 0.7,
        }

        console.log(`🤖 [OPENAI] Making API request for SHORT response...`)
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openaiApiKey}`,
          },
          body: JSON.stringify(requestBody),
        })

        if (!response.ok) {
          const errorText = await response.text()
          console.log(`❌ [OPENAI] API error: ${response.status} - ${errorText}`)
          return null
        }

        const data = await response.json()

        if (data.choices && data.choices[0] && data.choices[0].message) {
          const aiResponse = data.choices[0].message.content

          console.log(`🤖 [OPENAI] SHORT Response: "${aiResponse}"`)

          fullConversationHistory.push({
            role: "assistant",
            content: aiResponse,
          })

          return aiResponse
        }

        return null
      } catch (error) {
        console.log(`❌ [OPENAI] API error: ${error.message}`)
        return null
      } finally {
        isProcessingAI = false
      }
    }

    // Enhanced Sarvam TTS Synthesis with HTTP API fallback
    const synthesizeAndSendResponse = async (text) => {
      if (!sarvamApiKey || !text.trim() || shouldStopAudio) {
        console.log(
          `⚠️ [SARVAM] Skipping synthesis - API Key: ${!!sarvamApiKey}, Text: "${text}", ShouldStop: ${shouldStopAudio}`,
        )
        return
      }

      try {
        console.log(`🔊 [SARVAM] Starting synthesis: "${text}"`)

        // Try HTTP API first (more reliable)
        await synthesizeWithSarvamHTTP(text)

        console.log(`✅ [SARVAM] Synthesis completed`)
      } catch (error) {
        console.log(`❌ [SARVAM] Synthesis failed: ${error.message}`)

        // Fallback to simple TTS if Sarvam fails
        await synthesizeWithFallbackTTS(text)
      }
    }

    // HTTP-based Sarvam TTS (more reliable than WebSocket)
    const synthesizeWithSarvamHTTP = async (text) => {
      try {
        console.log(`🔊 [SARVAM] Using HTTP API for: "${text}"`)

        const response = await fetch("https://api.sarvam.ai/text-to-speech", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "API-Subscription-Key": sarvamApiKey,
          },
          body: JSON.stringify({
            inputs: [text],
            target_language_code: language === "hi" ? "hi-IN" : "en-IN",
            speaker: "anushka",
            pitch: 1.0,
            pace: 1.0,
            loudness: 1.0,
            speech_sample_rate: 22050,
            enable_preprocessing: true,
            model: "bulbul:v1",
          }),
        })

        if (!response.ok) {
          const errorText = await response.text()
          console.log(`❌ [SARVAM] HTTP API error: ${response.status} - ${errorText}`)
          throw new Error(`Sarvam HTTP API error: ${response.status} - ${errorText}`)
        }

        const data = await response.json()
        console.log(`✅ [SARVAM] HTTP API response received`)

        if (data.audios && data.audios.length > 0) {
          const audioBase64 = data.audios[0]
          const audioBuffer = Buffer.from(audioBase64, "base64")

          console.log(`🎵 [SARVAM] Audio received: ${audioBuffer.length} bytes`)

          // Send audio to client
          sendCompleteAudioToClient(audioBuffer)
        } else {
          throw new Error("No audio data in response")
        }
      } catch (error) {
        console.log(`❌ [SARVAM] HTTP API failed: ${error.message}`)
        throw error
      }
    }

    // Fallback TTS using a simple text-to-speech service
    const synthesizeWithFallbackTTS = async (text) => {
      try {
        console.log(`🔊 [FALLBACK] Using fallback TTS for: "${text}"`)

        // Use a simple TTS service or generate a simple audio response
        const simpleResponse = `I heard you say: ${text}`

        // For now, we'll create a simple beep or use browser's speech synthesis
        // In a real implementation, you could use another TTS service like Google TTS

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "fallback_response",
              session_id: sessionId,
              message: simpleResponse,
              text: text,
            }),
          )
        }

        console.log(`✅ [FALLBACK] Fallback response sent`)
      } catch (error) {
        console.log(`❌ [FALLBACK] Fallback TTS failed: ${error.message}`)
      }
    }

    // Send complete audio to client (for HTTP API response)
    const sendCompleteAudioToClient = (audioBuffer) => {
      if (shouldStopAudio || ws.readyState !== WebSocket.OPEN) {
        return
      }

      try {
        // Convert to WAV format for better compatibility
        const audioWithHeader = createWAVHeader(audioBuffer, 22050, 1, 16)
        const base64Audio = audioWithHeader.toString("base64")

        audioChunkCount++
        const audioResponse = {
          data: {
            session_id: sessionId,
            count: audioChunkCount,
            audio_data: base64Audio,
            format: "wav",
            sample_rate: 22050,
            channels: 1,
            sample_width: 2,
            complete: true,
          },
          type: "ai_response_complete",
        }

        ws.send(JSON.stringify(audioResponse))
        console.log(`✅ [SARVAM] Complete audio sent to client (${audioWithHeader.length} bytes)`)
      } catch (error) {
        console.log(`❌ [SARVAM] Error sending complete audio: ${error.message}`)
      }
    }

    // Improved Sarvam WebSocket with proper authentication
    const streamTextWithSarvam = async (text) => {
      return new Promise((resolve, reject) => {
        if (shouldStopAudio) {
          resolve()
          return
        }

        try {
          console.log(`🔊 [SARVAM] Connecting to streaming WebSocket for: "${text}"`)

          // Use proper WebSocket URL and headers
          const sarvamWsUrl = "wss://api.sarvam.ai/text-to-speech-websocket"
          sarvamSocket = new WebSocket(sarvamWsUrl, {
            headers: {
              "API-Subscription-Key": sarvamApiKey,
              "User-Agent": "SarvamVoiceServer/1.0",
              Origin: "https://api.sarvam.ai",
            },
          })

          let chunkCount = 0
          let connectionEstablished = false

          sarvamSocket.onopen = () => {
            console.log(`✅ [SARVAM] WebSocket connected successfully`)
            connectionEstablished = true

            // Send config with proper format
            const configMessage = {
              type: "config",
              data: {
                target_language_code: language === "hi" ? "hi-IN" : "en-IN",
                speaker: "anushka",
                pitch: 1.0,
                pace: 1.0,
                loudness: 1.0,
                min_buffer_size: 50,
                max_chunk_length: 200,
                output_audio_codec: "mp3",
                output_audio_bitrate: 128,
                model: "bulbul:v1",
              },
            }

            console.log(`🔊 [SARVAM] Sending config`)
            sarvamSocket.send(JSON.stringify(configMessage))

            // Wait a bit before sending text
            setTimeout(() => {
              const textMessage = {
                type: "text",
                data: {
                  text: text,
                },
              }

              console.log(`🔊 [SARVAM] Sending text`)
              sarvamSocket.send(JSON.stringify(textMessage))

              // Send flush after text
              setTimeout(() => {
                const flushMessage = { type: "flush" }
                console.log(`🔊 [SARVAM] Sending flush`)
                sarvamSocket.send(JSON.stringify(flushMessage))
              }, 100)
            }, 200)
          }

          sarvamSocket.onmessage = (event) => {
            if (shouldStopAudio) {
              sarvamSocket.close()
              resolve()
              return
            }

            try {
              const message = JSON.parse(event.data)
              console.log(`📨 [SARVAM] Received message type: ${message.type}`)

              if (message.type === "audio" && message.data && message.data.audio) {
                chunkCount++
                const audioBuffer = Buffer.from(message.data.audio, "base64")

                console.log(`🎵 [SARVAM] Received audio chunk ${chunkCount}: ${audioBuffer.length} bytes`)
                sendAudioChunkToClient(audioBuffer, chunkCount)
              } else if (message.type === "error") {
                console.log(`❌ [SARVAM] Error: ${JSON.stringify(message)}`)
                reject(new Error(JSON.stringify(message)))
              } else if (message.type === "done" || message.type === "end") {
                console.log(`✅ [SARVAM] Synthesis completed. Total chunks: ${chunkCount}`)
                sarvamSocket.close()
                resolve()
              }
            } catch (parseError) {
              console.log(`❌ [SARVAM] Error parsing message: ${parseError.message}`)
            }
          }

          sarvamSocket.onclose = (event) => {
            console.log(`🔊 [SARVAM] WebSocket closed: ${event.code} - ${event.reason}`)
            if (connectionEstablished && chunkCount === 0) {
              console.log(`⚠️ [SARVAM] No audio received, trying HTTP API fallback`)
              synthesizeWithSarvamHTTP(text).then(resolve).catch(reject)
            } else {
              resolve()
            }
          }

          sarvamSocket.onerror = (error) => {
            console.log(`❌ [SARVAM] WebSocket error: ${error.message}`)

            if (error.message.includes("403")) {
              console.log(`🔑 [SARVAM] Authentication failed - check API key`)
              console.log(
                `🔑 [SARVAM] API Key format: ${sarvamApiKey ? sarvamApiKey.substring(0, 10) + "..." : "NOT SET"}`,
              )
            }

            // Try HTTP API as fallback
            console.log(`🔄 [SARVAM] Trying HTTP API fallback`)
            synthesizeWithSarvamHTTP(text).then(resolve).catch(reject)
          }

          // Timeout for WebSocket connection
          setTimeout(() => {
            if (sarvamSocket && sarvamSocket.readyState === WebSocket.CONNECTING) {
              console.log(`⏰ [SARVAM] WebSocket connection timeout`)
              sarvamSocket.close()
              synthesizeWithSarvamHTTP(text).then(resolve).catch(reject)
            }
          }, 10000)
        } catch (error) {
          console.log(`❌ [SARVAM] Error creating WebSocket: ${error.message}`)
          synthesizeWithSarvamHTTP(text).then(resolve).catch(reject)
        }
      })
    }

    // Send audio chunk to client with proper format
    const sendAudioChunkToClient = (audioBuffer, chunkIndex) => {
      if (shouldStopAudio || ws.readyState !== WebSocket.OPEN) {
        return
      }

      try {
        // Convert MP3 to WAV format for better compatibility
        const audioWithHeader = createWAVHeader(audioBuffer, 22050, 1, 16) // MP3 is typically 22050Hz
        const base64Audio = audioWithHeader.toString("base64")

        audioChunkCount++
        const audioResponse = {
          data: {
            session_id: sessionId,
            count: audioChunkCount,
            chunk_index: chunkIndex,
            audio_data: base64Audio,
            format: "wav",
            sample_rate: 22050,
            channels: 1,
            sample_width: 2,
            streaming: true,
          },
          type: "ai_response_stream",
        }

        ws.send(JSON.stringify(audioResponse))
        console.log(`✅ [SARVAM] Sent audio chunk ${chunkIndex} to client (${audioWithHeader.length} bytes)`)
      } catch (error) {
        console.log(`❌ [SARVAM] Error sending audio chunk: ${error.message}`)
      }
    }

    // Utility functions
    const createWAVHeader = (audioBuffer, sampleRate = 22050, channels = 1, bitsPerSample = 16) => {
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
                  message: "SIP call started with Sarvam streaming TTS and OpenAI",
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
            }, 1000)
          } else if (data.type === "synthesize") {
            console.log(`🔊 [MESSAGE] TTS synthesis request: "${data.text}"`)
            if (data.session_id) {
              sessionId = data.session_id
            }
            await synthesizeAndSendResponse(data.text)
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
    })

    ws.on("error", (error) => {
      console.log(`❌ [SESSION] WebSocket error: ${error.message}`)
    })

    console.log(`✅ [SESSION] WebSocket ready with Sarvam streaming TTS and OpenAI`)
  })
}

module.exports = { setupUnifiedVoiceServer }
