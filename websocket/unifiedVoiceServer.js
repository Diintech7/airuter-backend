const WebSocket = require("ws")
const FormData = require("form-data")

// Use native fetch (Node.js 18+) or fallback
const fetch = globalThis.fetch || require("node-fetch")

if (!fetch) {
  console.error("❌ Fetch not available. Please use Node.js 18+ or install node-fetch@2")
  process.exit(1)
}

const setupUnifiedVoiceServer = (wss) => {
  console.log("🚀 Unified Voice WebSocket server initialized")

  wss.on("connection", (ws, req) => {
    console.log("🔗 New unified voice connection established")

    // Deepgram client state
    let deepgramWs = null
    let deepgramReady = false
    let audioBuffer = []
    let deepgramConnected = false

    // LMNT client state
    const lmntApiKey = process.env.LMNT_API_KEY

    // Session state
    let sessionId = null
    let audioChunkCount = 0

    // Extract language from URL parameters
    const url = new URL(req.url, "http://localhost")
    const language = url.searchParams.get("language") || "hi"

    console.log(`🌐 Connection established with language: ${language}`)
    console.log(`🔑 LMNT API Key configured: ${lmntApiKey ? "Yes (" + lmntApiKey.substring(0, 8) + "...)" : "❌ NO"}`)

    // Deepgram WebSocket connection function
    const connectToDeepgram = async (options = {}) => {
      return new Promise((resolve, reject) => {
        try {
          console.log("🎙️ Connecting to Deepgram with options:", JSON.stringify(options))
          console.log("🎙️ Deepgram API Key present:", !!process.env.DEEPGRAM_API_KEY)
          console.log(
            "🎙️ Deepgram API Key preview:",
            process.env.DEEPGRAM_API_KEY ? process.env.DEEPGRAM_API_KEY.substring(0, 12) + "..." : "MISSING",
          )

          if (!process.env.DEEPGRAM_API_KEY) {
            const error = "Deepgram API key not configured"
            console.error("❌ Deepgram:", error)
            reject(new Error(error))
            return
          }

          // Build Deepgram WebSocket URL
          const deepgramUrl = new URL("wss://api.deepgram.com/v1/listen")
          deepgramUrl.searchParams.append("sample_rate", "16000")
          deepgramUrl.searchParams.append("channels", "1")
          deepgramUrl.searchParams.append("interim_results", "true")
          deepgramUrl.searchParams.append("language", options.language || "en")
          deepgramUrl.searchParams.append("model", "nova-2")
          deepgramUrl.searchParams.append("smart_format", "true")
          deepgramUrl.searchParams.append("punctuate", "true")
          deepgramUrl.searchParams.append("diarize", "false")

          console.log("🎙️ Deepgram URL:", deepgramUrl.toString())

          deepgramWs = new WebSocket(deepgramUrl.toString(), ["token", process.env.DEEPGRAM_API_KEY])
          deepgramWs.binaryType = "arraybuffer"

          // Add connection timeout
          const connectionTimeout = setTimeout(() => {
            console.error("❌ Deepgram: Connection timeout after 10 seconds")
            if (deepgramWs) {
              deepgramWs.close()
            }
            reject(new Error("Deepgram connection timeout"))
          }, 10000)

          deepgramWs.onopen = () => {
            clearTimeout(connectionTimeout)
            console.log("✅ Deepgram: WebSocket connection established successfully")
            deepgramReady = true
            deepgramConnected = true

            // Process buffered audio
            console.log("🎙️ Deepgram: Processing", audioBuffer.length, "buffered audio chunks")
            audioBuffer.forEach((audioData) => {
              sendAudioToDeepgram(audioData)
            })
            audioBuffer = []

            resolve()
          }

          deepgramWs.onmessage = (event) => {
            try {
              const rawData = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString()
              console.log("🎙️ Deepgram: Raw message received:", rawData.substring(0, 500))

              const data = JSON.parse(rawData)
              console.log("🎙️ Deepgram: Parsed data:", JSON.stringify(data, null, 2))

              // Check for different types of Deepgram responses
              if (data.type === "Results") {
                console.log("🎙️ Deepgram: Received Results message")

                if (data.channel?.alternatives?.[0]?.transcript) {
                  const transcript = data.channel.alternatives[0].transcript
                  const confidence = data.channel.alternatives[0].confidence
                  const is_final = data.is_final

                  console.log("📝 Deepgram: Found transcript:", transcript)
                  console.log("📝 Deepgram: Confidence:", confidence)
                  console.log("📝 Deepgram: Is final:", is_final)

                  if (transcript.trim()) {
                    console.log("📤 Deepgram: Sending transcript to client:", transcript)
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(
                        JSON.stringify({
                          type: "transcript",
                          data: transcript,
                          confidence: confidence,
                          is_final: is_final,
                          language: language,
                        }),
                      )
                    }
                  }
                }
              } else if (data.type === "Metadata") {
                console.log("🎙️ Deepgram: Received Metadata:", JSON.stringify(data, null, 2))
              } else if (data.type === "SpeechStarted") {
                console.log("🎙️ Deepgram: Speech started detected")
              } else if (data.type === "UtteranceEnd") {
                console.log("🎙️ Deepgram: Utterance end detected")
              } else {
                console.log("🎙️ Deepgram: Unknown message type:", data.type)
              }
            } catch (parseError) {
              console.error("❌ Deepgram: Error parsing message:", parseError)
              console.error("❌ Deepgram: Raw data:", event.data)
            }
          }

          deepgramWs.onerror = (error) => {
            clearTimeout(connectionTimeout)
            console.error("❌ Deepgram: WebSocket error:", error)
            deepgramReady = false
            deepgramConnected = false
            reject(error)
          }

          deepgramWs.onclose = (event) => {
            clearTimeout(connectionTimeout)
            console.log(`🎙️ Deepgram: Connection closed with code ${event.code}, reason: ${event.reason}`)
            deepgramReady = false
            deepgramConnected = false

            // Auto-reconnect if connection was lost unexpectedly
            if (event.code !== 1000 && event.code !== 1001) {
              console.log("🔄 Deepgram: Attempting to reconnect in 2 seconds...")
              setTimeout(() => {
                connectToDeepgram(options).catch((err) => {
                  console.error("❌ Deepgram: Reconnection failed:", err)
                })
              }, 2000)
            }
          }
        } catch (error) {
          console.error("❌ Deepgram: Error during setup:", error)
          reject(error)
        }
      })
    }

    // Send audio to Deepgram function
    const sendAudioToDeepgram = (audioData) => {
      if (!deepgramWs) {
        console.error("❌ Deepgram: Cannot send audio - WebSocket not initialized")
        return false
      }

      if (deepgramWs.readyState !== WebSocket.OPEN) {
        console.error("❌ Deepgram: Cannot send audio - WebSocket not open, current state:", deepgramWs.readyState)
        return false
      }

      if (!deepgramReady) {
        console.error("❌ Deepgram: Cannot send audio - Client not ready")
        return false
      }

      try {
        const buffer = audioData instanceof Buffer ? audioData : Buffer.from(audioData)
        console.log("🎵 Deepgram: Sending audio data, size:", buffer.length, "bytes")

        // Log first few bytes for debugging
        const firstBytes = Array.from(buffer.slice(0, 16))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ")
        console.log("🎵 Deepgram: First 16 bytes:", firstBytes)

        deepgramWs.send(buffer)
        return true
      } catch (error) {
        console.error("❌ Deepgram: Error sending audio data:", error)
        return false
      }
    }

    // Close Deepgram connection function
    const closeDeepgram = () => {
      console.log("🎙️ Deepgram: Closing connection")
      deepgramReady = false
      deepgramConnected = false
      if (deepgramWs) {
        try {
          deepgramWs.close(1000, "Client closing")
          console.log("✅ Deepgram: WebSocket closed successfully")
        } catch (error) {
          console.error("❌ Deepgram: Error closing WebSocket:", error)
        }
      }
    }

    // LMNT synthesis function with comprehensive error handling and multiple API approaches
    const synthesizeWithLMNT = async (text, options = {}) => {
      console.log("🔊 ==================== LMNT SYNTHESIS START ====================")
      console.log("🔊 LMNT: Starting synthesis for text:", text.substring(0, 100) + "...")
      console.log("🔊 LMNT: API Key present:", !!lmntApiKey)
      console.log("🔊 LMNT: API Key preview:", lmntApiKey ? lmntApiKey.substring(0, 12) + "..." : "MISSING")

      if (!lmntApiKey) {
        const error = "LMNT API key not configured in environment variables"
        console.error("❌ LMNT:", error)
        throw new Error(error)
      }

      const synthesisOptions = {
        voice: options.voice || "lily",
        language: options.language || "en",
        speed: options.speed || 1.0,
        format: "wav",
        sample_rate: 8000,
      }

      console.log("🔊 LMNT: Final synthesis options:", JSON.stringify(synthesisOptions, null, 2))

      // Try multiple LMNT API approaches
      const apiAttempts = [
        {
          name: "LMNT v1/ai/speech (JSON)",
          url: "https://api.lmnt.com/v1/ai/speech",
          method: "json",
        },
        {
          name: "LMNT v1/ai/speech (FormData)",
          url: "https://api.lmnt.com/v1/ai/speech",
          method: "form",
        },
      ]

      for (const attempt of apiAttempts) {
        try {
          console.log(`🔊 LMNT: Trying ${attempt.name}...`)

          const requestOptions = {
            method: "POST",
            headers: {
              "X-API-Key": lmntApiKey,
            },
          }

          if (attempt.method === "json") {
            requestOptions.headers["Content-Type"] = "application/json"
            requestOptions.body = JSON.stringify({
              text: text,
              voice: synthesisOptions.voice,
              format: synthesisOptions.format,
              language: synthesisOptions.language,
              sample_rate: synthesisOptions.sample_rate,
              speed: synthesisOptions.speed,
            })
          } else if (attempt.method === "form") {
            const form = new FormData()
            form.append("text", text)
            form.append("voice", synthesisOptions.voice)
            form.append("format", synthesisOptions.format)
            form.append("language", synthesisOptions.language)
            form.append("sample_rate", synthesisOptions.sample_rate.toString())
            form.append("speed", synthesisOptions.speed.toString())

            requestOptions.headers = {
              ...requestOptions.headers,
              ...form.getHeaders(),
            }
            requestOptions.body = form
          }

          console.log(`🔊 LMNT: Making ${attempt.method.toUpperCase()} request to:`, attempt.url)

          const response = await fetch(attempt.url, requestOptions)

          console.log(`🔊 LMNT: Response status:`, response.status)

          if (!response.ok) {
            const errorText = await response.text()
            console.error(`❌ LMNT: ${attempt.name} failed with status ${response.status}:`, errorText)
            continue // Try next approach
          }

          const contentType = response.headers.get("content-type")
          console.log(`🔊 LMNT: Response content-type:`, contentType)

          if (contentType && contentType.includes("application/json")) {
            // Handle JSON response
            const jsonResponse = await response.json()
            console.log(`🔊 LMNT: JSON response:`, JSON.stringify(jsonResponse, null, 2))

            if (jsonResponse.audio_url) {
              console.log(`🔊 LMNT: Fetching audio from URL:`, jsonResponse.audio_url)
              const audioResponse = await fetch(jsonResponse.audio_url)
              if (!audioResponse.ok) {
                throw new Error(`Failed to fetch audio from URL: ${audioResponse.status}`)
              }
              const audioBuffer = await audioResponse.arrayBuffer()
              console.log(`✅ LMNT: Downloaded audio buffer, size:`, audioBuffer.byteLength, "bytes")
              return Buffer.from(audioBuffer)
            } else if (jsonResponse.audio) {
              // Direct audio data in JSON
              console.log(`🔊 LMNT: Found direct audio data in JSON response`)
              const audioBuffer = Buffer.from(jsonResponse.audio, "base64")
              console.log(`✅ LMNT: Decoded audio buffer, size:`, audioBuffer.length, "bytes")
              return audioBuffer
            } else {
              throw new Error("Unexpected JSON response format: " + JSON.stringify(jsonResponse))
            }
          } else {
            // Handle binary audio response
            const audioBuffer = await response.arrayBuffer()
            console.log(`✅ LMNT: Received binary audio buffer, size:`, audioBuffer.byteLength, "bytes")

            if (audioBuffer.byteLength === 0) {
              throw new Error("LMNT returned empty audio buffer")
            }

            console.log(`✅ LMNT: Successfully got audio from ${attempt.name}`)
            return Buffer.from(audioBuffer)
          }
        } catch (error) {
          console.error(`❌ LMNT: ${attempt.name} failed:`, error.message)

          // If this is the last attempt, throw the error
          if (attempt === apiAttempts[apiAttempts.length - 1]) {
            throw error
          }

          continue // Try next approach
        }
      }

      throw new Error("All LMNT API attempts failed")
    }

    // Enhanced synthesis wrapper with comprehensive error handling
    const synthesizeWithErrorHandling = async (text, options = {}) => {
      console.log("🔊 ==================== SYNTHESIS WRAPPER START ====================")

      try {
        // Send immediate acknowledgment to client
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "synthesis_started",
              text: text.substring(0, 50) + "...",
              status: "processing",
            }),
          )
        }

        const result = await synthesizeWithLMNT(text, options)

        console.log("✅ Synthesis wrapper: Success, audio size:", result.length)
        return result
      } catch (error) {
        console.error("❌ ==================== SYNTHESIS WRAPPER ERROR ====================")
        console.error("❌ Synthesis wrapper error:", error.message)
        console.error("❌ Full error:", error)
        console.error("❌ Stack:", error.stack)

        // Send error to client
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "synthesis_error",
              error: error.message,
              details: error.stack,
            }),
          )
        }

        throw error
      }
    }

    // Convert browser audio to PCM format
    const convertToPCM = async (audioBuffer) => {
      try {
        // Browser audio is typically already in the right format
        // Just ensure it's a proper buffer
        return audioBuffer instanceof Buffer ? audioBuffer : Buffer.from(audioBuffer)
      } catch (error) {
        console.error("❌ Error converting audio to PCM:", error)
        return audioBuffer
      }
    }

    // Create WAV header for audio data
    const createWAVHeader = (audioBuffer, sampleRate = 8000, channels = 1, bitsPerSample = 16) => {
      const byteRate = (sampleRate * channels * bitsPerSample) / 8
      const blockAlign = (channels * bitsPerSample) / 8
      const dataSize = audioBuffer.length
      const fileSize = 36 + dataSize

      const header = Buffer.alloc(44)
      let offset = 0

      // RIFF header
      header.write("RIFF", offset)
      offset += 4
      header.writeUInt32LE(fileSize, offset)
      offset += 4
      header.write("WAVE", offset)
      offset += 4

      // fmt chunk
      header.write("fmt ", offset)
      offset += 4
      header.writeUInt32LE(16, offset)
      offset += 4
      header.writeUInt16LE(1, offset)
      offset += 2 // audio format (PCM)
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

      // data chunk
      header.write("data", offset)
      offset += 4
      header.writeUInt32LE(dataSize, offset)

      return Buffer.concat([header, audioBuffer])
    }

    // Generate session ID
    const generateSessionId = () => {
      return "session_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9)
    }

    // Handle incoming messages
    ws.on("message", async (message) => {
      try {
        console.log("📨 ==================== MESSAGE RECEIVED ====================")
        console.log("📨 Received message, type:", typeof message, "length:", message.length)

        // Check if message is binary (audio data) or text (JSON commands)
        let isTextMessage = false
        let data = null

        if (typeof message === "string") {
          // Definitely a text message
          isTextMessage = true
          try {
            data = JSON.parse(message)
          } catch (parseError) {
            console.error("❌ Failed to parse string message as JSON:", parseError)
            return
          }
        } else if (message instanceof Buffer) {
          // Could be text or binary - try to parse as JSON first
          try {
            const messageStr = message.toString("utf8")

            // Check if it looks like JSON
            if (messageStr.trim().startsWith("{") && messageStr.trim().endsWith("}")) {
              data = JSON.parse(messageStr)
              isTextMessage = true
              console.log("✅ Successfully parsed buffer as JSON text message")
            } else {
              // Doesn't look like JSON, treat as binary audio
              isTextMessage = false
              console.log("🎵 Buffer doesn't look like JSON, treating as binary audio data")
            }
          } catch (parseError) {
            // Failed to parse as JSON, treat as binary audio data
            isTextMessage = false
            console.log("🎵 Failed to parse buffer as JSON, treating as binary audio data")
          }
        }

        if (isTextMessage && data) {
          console.log("📝 Processing text message")
          console.log("📝 Parsed JSON data:", JSON.stringify(data, null, 2))

          if (data.type === "start" && data.uuid) {
            console.log("🚀 Processing START command")
            // Handle session start
            sessionId = data.uuid
            audioChunkCount = 0
            console.log("✅ Session started with ID:", sessionId)

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "session_started",
                  session_id: sessionId,
                  language: language,
                }),
              )
            }
          } else if (data.type === "synthesize") {
            console.log("🔊 ==================== PROCESSING SYNTHESIZE COMMAND ====================")
            console.log("🔊 Synthesis text:", data.text)

            try {
              const synthesisOptions = {
                voice: data.voice || "lily",
                language: data.language || language,
                speed: data.speed || 1.0,
              }

              const audioData = await synthesizeWithErrorHandling(data.text, synthesisOptions)

              if (!audioData || audioData.length === 0) {
                throw new Error("Received empty audio data from LMNT")
              }

              console.log("✅ LMNT: Successfully received audio data, size:", audioData.length, "bytes")

              // Convert audio to the required JSON format
              const audioBuffer = Buffer.from(audioData)

              // Create WAV header and convert to base64
              const audioWithHeader = createWAVHeader(audioBuffer, 8000, 1, 16)
              const base64AudioWithHeader = audioWithHeader.toString("base64")

              // Increment chunk count
              audioChunkCount++

              // Send audio in the required JSON format
              const audioResponse = {
                data: {
                  session_id: sessionId || generateSessionId(),
                  count: audioChunkCount,
                  audio_bytes_to_play: base64AudioWithHeader,
                  sample_rate: 8000,
                  channels: 1,
                  sample_width: 2,
                },
              }

              console.log("✅ ==================== SENDING AUDIO RESPONSE ====================")
              console.log("✅ Sending audio response with session_id:", audioResponse.data.session_id)
              console.log("✅ Count:", audioResponse.data.count)
              console.log("✅ Audio size:", base64AudioWithHeader.length, "characters (base64)")

              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(audioResponse))
                console.log("✅ Audio sent in JSON format successfully")
              } else {
                console.error("❌ WebSocket not open, cannot send audio response")
              }
            } catch (error) {
              console.error("❌ ==================== SYNTHESIS ERROR ====================")
              console.error("❌ Synthesis error:", error.message)

              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "error",
                    error: `Speech synthesis failed: ${error.message}`,
                  }),
                )
              }
            }
          }
        } else {
          console.log("🎵 Processing binary message (audio data), size:", message.length)

          // This is audio data for transcription
          console.log("🎙️ Received audio data for transcription, size:", message.length)

          // Initialize Deepgram if not already connected
          if (!deepgramConnected) {
            console.log("🎙️ Initializing Deepgram connection...")
            try {
              await connectToDeepgram({
                language: language,
                model: "nova-2",
                punctuate: true,
                diarize: false,
                tier: "enhanced",
              })
              console.log("✅ Deepgram connection established")
            } catch (error) {
              console.error("❌ Failed to connect to Deepgram:", error)
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "error",
                    error: "Failed to initialize transcription service: " + error.message,
                  }),
                )
              }
              return
            }
          }

          // Convert browser audio to PCM format
          const pcmAudio = await convertToPCM(message)

          if (deepgramReady && deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
            // Send audio directly if Deepgram is ready
            const success = sendAudioToDeepgram(pcmAudio)
            if (!success) {
              console.log("🎙️ Failed to send audio, buffering...")
              audioBuffer.push(pcmAudio)
            }
          } else {
            // Buffer audio until Deepgram is ready
            console.log("🎙️ Buffering audio data until Deepgram is ready...")
            audioBuffer.push(pcmAudio)
          }
        }
      } catch (error) {
        console.error("❌ ==================== MESSAGE PROCESSING ERROR ====================")
        console.error("❌ Error processing message:", error.message)
        console.error("❌ Full error:", error)

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "error",
              error: error.message,
            }),
          )
        }
      }
    })

    // Handle connection close
    ws.on("close", () => {
      console.log("🔗 Unified voice connection closed")

      // Clean up Deepgram connection
      closeDeepgram()

      // Reset state
      sessionId = null
      audioChunkCount = 0
      audioBuffer = []
      deepgramReady = false
      deepgramConnected = false
    })

    // Handle connection errors
    ws.on("error", (error) => {
      console.error("❌ WebSocket error:", error)
    })

    // Send connection confirmation
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "connected",
          language: language,
          services: ["transcription", "synthesis"],
          lmnt_configured: !!lmntApiKey,
        }),
      )
    }
  })
}

module.exports = { setupUnifiedVoiceServer }
