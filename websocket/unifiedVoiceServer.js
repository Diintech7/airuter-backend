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
  console.log("🚀 Unified Voice WebSocket server initialized with Direct Deepgram Connection")

  wss.on("connection", (ws, req) => {
    console.log("🔗 New unified voice connection established")
    console.log("📡 SIP Connection Details:", {
      timestamp: new Date().toISOString(),
      clientIP: req.socket.remoteAddress,
      userAgent: req.headers["user-agent"],
      origin: req.headers.origin,
    })

    // Direct Deepgram connection variables
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
    const sipDataReceived = 0

    // Real-time transcript management
    let currentTranscript = ""
    let isProcessingGemini = false
    let fullConversationHistory = []
    let silenceTimeout = null
    const SILENCE_DURATION = 2000 // 2 seconds of silence
    let isSpeaking = false

    // Audio processing
    let lastAudioSent = 0
    const MIN_CHUNK_SIZE = 320 // Minimum chunk size for Deepgram
    const SEND_INTERVAL = 50 // Send audio every 50ms

    // API Keys
    const lmntApiKey = process.env.LMNT_API_KEY
    const deepgramApiKey = process.env.DEEPGRAM_API_KEY
    const geminiApiKey = process.env.GEMINI_API_KEY

    const url = new URL(req.url, "http://localhost")
    const language = url.searchParams.get("language") || "en"

    console.log(`🌐 Connection established with language: ${language}`)
    console.log(`🔑 API Keys configured:`)
    console.log(`   - Deepgram: ${deepgramApiKey ? "✅ Yes" : "❌ NO"}`)
    console.log(`   - LMNT TTS: ${lmntApiKey ? "✅ Yes" : "❌ NO"}`)
    console.log(`   - Gemini: ${geminiApiKey ? "✅ Yes" : "❌ NO"}`)

    // Direct Deepgram Connection
    const connectToDeepgram = async () => {
      return new Promise((resolve, reject) => {
        try {
          console.log("🎙️ Establishing direct connection to Deepgram...")

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
          deepgramUrl.searchParams.append("language", language === "hi" ? "hi" : "en")
          deepgramUrl.searchParams.append("interim_results", "true")
          deepgramUrl.searchParams.append("smart_format", "true")
          deepgramUrl.searchParams.append("punctuate", "true")
          deepgramUrl.searchParams.append("endpointing", "300")
          deepgramUrl.searchParams.append("vad_turnoff", "700")
          deepgramUrl.searchParams.append("utterance_end_ms", "1000")

          deepgramWs = new WebSocket(deepgramUrl.toString(), ["token", deepgramApiKey])
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
            console.log("✅ Direct Deepgram connection established")
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

            // Auto-reconnect logic
            if (event.code !== 1000 && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
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
      if (data.type === "Results") {
        const channel = data.channel
        if (channel && channel.alternatives && channel.alternatives.length > 0) {
          const transcript = channel.alternatives[0].transcript
          const confidence = channel.alternatives[0].confidence
          const is_final = data.is_final

          if (transcript && transcript.trim()) {
            // Reset silence timer when we get speech
            resetSilenceTimer()

            if (is_final) {
              // Append to current transcript
              currentTranscript += (currentTranscript ? " " : "") + transcript.trim()
              console.log("📝 Final transcript:", currentTranscript)

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
              console.log("📝 Interim transcript:", displayTranscript)

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
        console.log("🎙️ Speech started detected")
        resetSilenceTimer()
        isSpeaking = true
      } else if (data.type === "UtteranceEnd") {
        console.log("🎙️ Utterance end detected")
        if (isSpeaking) {
          isSpeaking = false
          startSilenceTimer()
        }
      }
    }

    // Direct audio streaming to Deepgram
    const sendAudioToDeepgram = async (audioData) => {
      if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN || !deepgramReady) {
        console.log("⚠️ Deepgram not ready, skipping audio chunk")
        return false
      }

      try {
        // Send audio directly without buffering
        const buffer = audioData instanceof Buffer ? audioData : Buffer.from(audioData)

        // Only send if chunk is large enough
        if (buffer.length >= MIN_CHUNK_SIZE) {
          deepgramWs.send(buffer)
          lastAudioSent = Date.now()
          console.log(`🎵 Audio sent to Deepgram: ${buffer.length} bytes`)
          return true
        }
        return false
      } catch (error) {
        console.log("❌ Error sending audio to Deepgram:", error.message)

        // Attempt reconnection on connection errors
        if (error.message.includes("connection") || error.message.includes("CLOSED")) {
          console.log("🔄 Attempting Deepgram reconnection...")
          connectToDeepgram().catch((err) => {
            console.log("❌ Reconnection failed:", err.message)
          })
        }
        return false
      }
    }

    // Silence detection and Gemini integration
    const startSilenceTimer = () => {
      if (silenceTimeout) {
        clearTimeout(silenceTimeout)
      }

      silenceTimeout = setTimeout(() => {
        handleSilenceDetected()
      }, SILENCE_DURATION)
    }

    const resetSilenceTimer = () => {
      if (silenceTimeout) {
        clearTimeout(silenceTimeout)
        silenceTimeout = null
      }
    }

    const handleSilenceDetected = async () => {
      if (currentTranscript.trim() && !isProcessingGemini) {
        console.log("🔕 Silence detected, processing with Gemini...")
        console.log("📝 Processing transcript:", currentTranscript)

        const geminiResponse = await sendToGemini(currentTranscript.trim())

        if (geminiResponse) {
          console.log("🤖 Gemini response:", geminiResponse)
          await synthesizeAndSendResponse(geminiResponse)
        }

        // Reset for next utterance
        currentTranscript = ""
      }
    }

    // Gemini API Integration
    const sendToGemini = async (userMessage) => {
      if (isProcessingGemini || !geminiApiKey || !userMessage.trim()) {
        return null
      }

      isProcessingGemini = true
      console.log("🤖 Sending to Gemini:", userMessage)

      try {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${geminiApiKey}`

        // Add to conversation history
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
            maxOutputTokens: 1024,
          },
        }

        const response = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        })

        if (!response.ok) {
          const errorText = await response.text()
          console.log("❌ Gemini API error:", response.status, errorText)
          return null
        }

        const data = await response.json()

        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
          const geminiResponse = data.candidates[0].content.parts[0].text

          // Add to conversation history
          fullConversationHistory.push({
            role: "model",
            parts: [{ text: geminiResponse }],
          })

          return geminiResponse
        }

        return null
      } catch (error) {
        console.log("❌ Gemini API error:", error.message)
        return null
      } finally {
        isProcessingGemini = false
      }
    }

    // TTS Synthesis and Response
    const synthesizeAndSendResponse = async (text) => {
      if (!lmntApiKey || !text.trim()) {
        return
      }

      try {
        console.log("🔊 Synthesizing response:", text.substring(0, 100) + "...")

        const synthesisOptions = {
          voice: "lily",
          language: language === "en" ? "en" : "hi",
          speed: 1.0,
          format: "wav",
          sample_rate: 8000,
        }

        const audioData = await synthesizeWithLMNT(text, synthesisOptions)

        if (audioData && audioData.length > 0) {
          const audioBuffer = Buffer.from(audioData)
          const audioWithHeader = createWAVHeader(audioBuffer, 8000, 1, 16)
          const pythonBytesString = bufferToPythonBytesString(audioWithHeader)

          audioChunkCount++
          const audioResponse = {
            data: {
              session_id: sessionId,
              count: audioChunkCount,
              audio_bytes_to_play: pythonBytesString,
              sample_rate: 8000,
              channels: 1,
              sample_width: 2,
            },
            type: "ai_response",
          }

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(audioResponse))
            console.log("✅ AI response audio sent!")
          }
        }
      } catch (error) {
        console.log("❌ Failed to synthesize response:", error.message)
      }
    }

    // TTS Synthesis with LMNT
    const synthesizeWithLMNT = async (text, options = {}) => {
      if (!lmntApiKey) {
        throw new Error("LMNT API key not configured")
      }

      const requestOptions = {
        method: "POST",
        headers: {
          "X-API-Key": lmntApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: text,
          voice: options.voice || "lily",
          format: options.format || "wav",
          language: options.language || "en",
          sample_rate: options.sample_rate || 8000,
          speed: options.speed || 1.0,
        }),
      }

      const response = await fetch("https://api.lmnt.com/v1/ai/speech", requestOptions)

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`LMNT API error: ${response.status} - ${errorText}`)
      }

      const contentType = response.headers.get("content-type")

      if (contentType && contentType.includes("application/json")) {
        const jsonResponse = await response.json()
        if (jsonResponse.audio_url) {
          const audioResponse = await fetch(jsonResponse.audio_url)
          const audioBuffer = await audioResponse.arrayBuffer()
          return Buffer.from(audioBuffer)
        } else if (jsonResponse.audio) {
          return Buffer.from(jsonResponse.audio, "base64")
        }
      } else {
        const audioBuffer = await response.arrayBuffer()
        return Buffer.from(audioBuffer)
      }

      throw new Error("Unexpected response format from LMNT")
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
      if (connectionGreetingSent || !lmntApiKey || !sessionId) {
        return
      }

      const greetings = {
        hi: "नमस्ते! हैलो, Aitota से संपर्क करने के लिए धन्यवाद।",
        en: "Hi! Hello, thank you for contacting Aitota.",
      }

      const greetingText = greetings[language] || greetings["en"]
      console.log("👋 Sending greeting:", greetingText)

      try {
        await synthesizeAndSendResponse(greetingText)
        connectionGreetingSent = true
        console.log("✅ Greeting sent successfully!")
      } catch (error) {
        console.log("❌ Failed to send greeting:", error.message)
        connectionGreetingSent = true
      }
    }

    // WebSocket message handling
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
          // Handle control messages
          if (data.event === "start" && data.session_id) {
            sessionId = data.session_id
            audioChunkCount = 0
            currentTranscript = ""
            isSpeaking = false
            fullConversationHistory = []

            console.log("✅ SIP Call Started with UUID:", sessionId)

            // Send session started confirmation
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "session_started",
                  session_id: sessionId,
                  language: language,
                  message: "SIP call started, connecting to Deepgram directly.",
                }),
              )
            }

            // Connect to Deepgram immediately
            try {
              await connectToDeepgram()
              console.log("✅ Direct Deepgram connection established")
            } catch (error) {
              console.log("❌ Failed to connect to Deepgram:", error.message)
            }

            // Send greeting after a short delay
            setTimeout(() => {
              sendGreeting()
            }, 500)
          } else if (data.type === "synthesize") {
            console.log("🔊 TTS synthesis request:", data.text)
            if (data.session_id) {
              sessionId = data.session_id
            }
            await synthesizeAndSendResponse(data.text)
          } else if (data.type === "start_stt") {
            console.log("🎙️ STT start requested")
            if (data.session_id) {
              sessionId = data.session_id
            }
            if (!deepgramConnected) {
              await connectToDeepgram()
            }
          } else if (data.type === "stop_stt") {
            console.log("🎙️ STT stop requested")
            if (deepgramWs) {
              deepgramWs.close()
            }
          } else if (data.data && data.data.hangup === "true") {
            console.log("📞 Hangup request received")
            ws.close(1000, "Hangup requested")
          }
        } else {
          // Handle audio data - send directly to Deepgram
          if (deepgramConnected && deepgramReady) {
            const now = Date.now()
            if (now - lastAudioSent >= SEND_INTERVAL) {
              await sendAudioToDeepgram(message)
            }
          } else {
            console.log("⚠️ Audio received but Deepgram not connected")
          }
        }
      } catch (error) {
        console.log("❌ Error processing message:", error.message)
      }
    })

    // Connection cleanup
    ws.on("close", () => {
      console.log("🔗 Unified voice connection closed")
      console.log("📊 Session statistics:")
      console.log(`   Session ID: ${sessionId || "Not set"}`)
      console.log(`   Audio chunks processed: ${audioChunkCount}`)
      console.log(`   Conversation history: ${fullConversationHistory.length} messages`)

      // Cleanup
      if (deepgramWs) {
        deepgramWs.close()
      }
      resetSilenceTimer()

      // Reset all state
      sessionId = null
      audioChunkCount = 0
      deepgramReady = false
      deepgramConnected = false
      connectionGreetingSent = false
      currentTranscript = ""
      isSpeaking = false
      fullConversationHistory = []
    })

    ws.on("error", (error) => {
      console.log("❌ WebSocket connection error:", error.message)
    })

    console.log("✅ WebSocket connection ready, waiting for SIP 'start' event")
  })
}

module.exports = { setupUnifiedVoiceServer }
