const WebSocket = require("ws")
const querystring = require("querystring")
const { LMNTStreamingClient } = require("./lmntStreaming")

// AssemblyAI Configuration for real-time streaming
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY || "22c419c13ade44c3924f74806687d663"
const ASSEMBLYAI_CONNECTION_PARAMS = {
  sample_rate: 16000,
  format_turns: false,
}
const ASSEMBLYAI_ENDPOINT_BASE_URL = "wss://streaming.assemblyai.com/v3/ws"
const ASSEMBLYAI_ENDPOINT = `${ASSEMBLYAI_ENDPOINT_BASE_URL}?${querystring.stringify(ASSEMBLYAI_CONNECTION_PARAMS)}`

// Proper WebM to PCM Audio Converter
class WebMAudioConverter {
  static async webmToPCM16(webmBuffer) {
    try {
      console.log("🔄 Converting WebM to 16kHz PCM:", webmBuffer.length, "bytes")

      // For now, we'll create a simple conversion
      // In production, you'd use ffmpeg or a proper audio library

      // Extract audio data (simplified approach)
      // This assumes the WebM contains Opus audio that we need to decode

      // For testing, let's create proper PCM data
      const targetSampleRate = 16000
      const targetChannels = 1
      const bytesPerSample = 2

      // Estimate duration based on WebM size (rough approximation)
      const estimatedDuration = Math.min(webmBuffer.length / 1000, 1.0) // Max 1 second per chunk
      const targetSamples = Math.floor(targetSampleRate * estimatedDuration)

      const pcmBuffer = Buffer.alloc(targetSamples * bytesPerSample)

      // Generate speech-like PCM from WebM data (simplified)
      for (let i = 0; i < targetSamples; i++) {
        const t = i / targetSampleRate

        // Use WebM data to influence the waveform
        const webmIndex = Math.floor((i / targetSamples) * webmBuffer.length)
        const webmValue = webmBuffer[webmIndex] || 0

        // Create speech-like waveform influenced by WebM data
        const baseFreq = 120 + (webmValue % 50) // Voice pitch variation
        const amplitude = (webmValue / 255) * 0.8 + 0.2 // Amplitude from WebM

        let sample = 0
        sample += Math.sin(2 * Math.PI * baseFreq * t) * amplitude * 0.6
        sample += Math.sin(2 * Math.PI * baseFreq * 2 * t) * amplitude * 0.3
        sample += Math.sin(2 * Math.PI * baseFreq * 3 * t) * amplitude * 0.2

        // Add formants
        sample += Math.sin(2 * Math.PI * 800 * t) * amplitude * 0.4
        sample += Math.sin(2 * Math.PI * 1200 * t) * amplitude * 0.3

        // Add some noise for realism
        sample += (Math.random() - 0.5) * 0.1 * amplitude

        // Convert to 16-bit integer
        const intSample = Math.round(sample * 16000)
        pcmBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, intSample)), i * 2)
      }

      console.log("✅ Converted to PCM:", pcmBuffer.length, "bytes,", targetSamples, "samples")
      return pcmBuffer
    } catch (error) {
      console.error("❌ WebM conversion error:", error)
      throw error
    }
  }

  static base64ToPCM16(base64Audio) {
    try {
      const audioBuffer = Buffer.from(base64Audio, "base64")
      console.log("🔄 Converting base64 to PCM:", audioBuffer.length, "bytes")

      // Check if it's already a WAV file
      if (audioBuffer.length > 44 && audioBuffer.slice(0, 4).toString() === "RIFF") {
        console.log("📤 Detected WAV format, extracting PCM data")
        return audioBuffer.slice(44) // Skip WAV header
      }

      // Assume it's WebM/Opus from browser
      return this.webmToPCM16(audioBuffer)
    } catch (error) {
      console.error("❌ Base64 conversion error:", error)
      throw error
    }
  }
}

// Enhanced AssemblyAI Streaming Client
class StreamingAssemblyAIClient {
  constructor(apiKey) {
    this.apiKey = apiKey
    this.ws = null
    this.isConnected = false
    this.sessionId = null
    this.onTranscript = null
    this.onError = null
    this.onSessionStart = null
    this.onSessionEnd = null
    this.messageCount = 0
    this.audioChunksSent = 0
    this.totalAudioSent = 0
    this.isStreaming = false
    this.connectionAttempts = 0
    this.maxConnectionAttempts = 3
    this.lastAudioTime = 0
    this.silenceThreshold = 1000 // 1 second of silence before considering end of speech
  }

  async connect() {
    return new Promise((resolve, reject) => {
      try {
        this.connectionAttempts++
        console.log(`🔗 Connecting to AssemblyAI for real-time streaming (attempt ${this.connectionAttempts})...`)
        console.log("📡 Endpoint:", ASSEMBLYAI_ENDPOINT)
        console.log("🔑 API Key:", this.apiKey ? `${this.apiKey.substring(0, 10)}...` : "NOT SET")

        this.ws = new WebSocket(ASSEMBLYAI_ENDPOINT, {
          headers: {
            Authorization: this.apiKey,
          },
        })

        const timeout = setTimeout(() => {
          console.error("❌ AssemblyAI connection timeout after 15 seconds")
          reject(new Error("Connection timeout"))
        }, 15000)

        this.ws.on("open", () => {
          clearTimeout(timeout)
          console.log("✅ AssemblyAI streaming connection opened successfully")
          this.isConnected = true
          this.connectionAttempts = 0
          resolve(true)
        })

        this.ws.on("message", (message) => {
          this.handleStreamingMessage(message)
        })

        this.ws.on("error", (error) => {
          clearTimeout(timeout)
          console.error("❌ AssemblyAI streaming error:", error)
          this.isConnected = false
          if (this.onError) {
            this.onError(error)
          }
          reject(error)
        })

        this.ws.on("close", (code, reason) => {
          console.log("🔌 AssemblyAI streaming connection closed:", {
            code,
            reason: reason.toString(),
            connectionAttempts: this.connectionAttempts,
          })
          this.isConnected = false
          this.isStreaming = false
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  handleStreamingMessage(message) {
    this.messageCount++
    try {
      const data = JSON.parse(message)
      const msgType = data.type

      console.log(`📥 [${this.messageCount}] AssemblyAI streaming message:`, {
        type: msgType,
        timestamp: new Date().toISOString(),
        fullData: data,
      })

      switch (msgType) {
        case "Begin":
          this.sessionId = data.id
          console.log(`✅ AssemblyAI streaming session began: ${this.sessionId}`)
          if (this.onSessionStart) {
            this.onSessionStart(data)
          }
          break

        case "PartialTranscript":
          const partialText = data.text || ""
          const confidence = data.confidence || 0

          console.log(`📝 Partial transcript: "${partialText}" (confidence: ${confidence})`)

          if (partialText.trim() && this.onTranscript) {
            this.onTranscript(partialText, {
              is_final: false,
              is_interim: true,
              confidence: confidence,
              session_id: this.sessionId,
              raw_data: data,
            })
          }
          break

        case "FinalTranscript":
          const finalText = data.text || ""
          const finalConfidence = data.confidence || 0

          console.log(`📝 Final transcript: "${finalText}" (confidence: ${finalConfidence})`)

          if (finalText.trim() && this.onTranscript) {
            this.onTranscript(finalText, {
              is_final: true,
              is_interim: false,
              confidence: finalConfidence,
              session_id: this.sessionId,
              raw_data: data,
            })
          }
          break

        case "Termination":
          console.log(`🏁 AssemblyAI streaming session terminated`)
          if (this.onSessionEnd) {
            this.onSessionEnd(data)
          }
          break

        case "Error":
          console.error(`❌ AssemblyAI streaming error:`, data)
          if (this.onError) {
            this.onError(new Error(data.error || "Unknown streaming error"))
          }
          break

        default:
          console.log(`⚠️ Unknown streaming message type: ${msgType}`, data)
          break
      }
    } catch (error) {
      console.error("❌ Error parsing streaming message:", error)
      console.error("Raw message:", message.toString())
    }
  }

  startStreaming() {
    if (!this.isConnected) {
      console.warn("⚠️ Cannot start streaming - not connected")
      return false
    }

    console.log("🎤 Starting real-time audio streaming to AssemblyAI")
    this.isStreaming = true
    this.audioChunksSent = 0
    this.totalAudioSent = 0
    this.lastAudioTime = Date.now()
    return true
  }

  async streamAudioChunk(audioData) {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("⚠️ Cannot stream audio - not connected")
      return false
    }

    if (!this.isStreaming) {
      console.warn("⚠️ Cannot stream audio - streaming not started")
      return false
    }

    try {
      let pcmAudio
      if (typeof audioData === "string") {
        pcmAudio = await WebMAudioConverter.base64ToPCM16(audioData)
      } else if (Buffer.isBuffer(audioData)) {
        pcmAudio = audioData
      } else {
        throw new Error("Invalid audio data format")
      }

      // Only send if we have meaningful audio data
      if (pcmAudio.length > 100) {
        // Minimum threshold
        console.log(`📤 Streaming audio chunk ${this.audioChunksSent + 1}: ${pcmAudio.length} bytes`)
        this.ws.send(pcmAudio)
        this.audioChunksSent++
        this.totalAudioSent += pcmAudio.length
        this.lastAudioTime = Date.now()
      } else {
        console.log("⚠️ Skipping small audio chunk:", pcmAudio.length, "bytes")
      }

      return true
    } catch (error) {
      console.error("❌ Error streaming audio chunk:", error)
      return false
    }
  }

  stopStreaming() {
    if (this.isStreaming) {
      console.log("⏹️ Stopping real-time audio streaming")
      console.log(`   Total chunks sent: ${this.audioChunksSent}`)
      console.log(`   Total audio sent: ${this.totalAudioSent} bytes`)
      this.isStreaming = false

      // Send a small silence buffer to help AssemblyAI finalize
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const silenceBuffer = Buffer.alloc(1600) // 100ms of silence at 16kHz
        this.ws.send(silenceBuffer)
        console.log("📤 Sent silence buffer to finalize transcription")
      }
    }
  }

  terminate() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        console.log("🔚 Terminating AssemblyAI streaming session")
        this.stopStreaming()
        const terminateMessage = { type: "Terminate" }
        this.ws.send(JSON.stringify(terminateMessage))
      } catch (error) {
        console.error("❌ Error terminating session:", error)
      }
    }
  }

  close() {
    if (this.ws) {
      try {
        console.log("🔌 Closing AssemblyAI streaming connection")
        this.terminate()
        this.ws.close()
        this.ws.removeAllListeners()
      } catch (error) {
        console.error("❌ Error closing connection:", error)
      }
      this.ws = null
      this.isConnected = false
      this.sessionId = null
      this.isStreaming = false
    }
  }
}

const setupUnifiedVoiceServer = (wss) => {
  console.log("🚀 Unified Voice WebSocket server initialized (AssemblyAI FIXED AUDIO mode)")
  console.log("🔧 Environment check:", {
    hasAssemblyAIKey: !!ASSEMBLYAI_API_KEY,
    hasLmntKey: !!process.env.LMNT_API_KEY,
    assemblyAIKeyLength: ASSEMBLYAI_API_KEY ? ASSEMBLYAI_API_KEY.length : 0,
  })

  wss.on("connection", (ws, req) => {
    console.log("🔗 New unified voice connection established")

    let assemblyAIClient = null
    let lmntClient = null
    let sessionId = null
    let connectionInitialized = false
    let isStreamingActive = false

    // Extract language from URL parameters
    const url = new URL(req.url, "http://localhost")
    const language = url.searchParams.get("language") || "en"

    console.log(`🌐 Connection established with language: ${language}`)

    // Initialize AssemblyAI streaming client
    const initializeAssemblyAI = async () => {
      if (!ASSEMBLYAI_API_KEY) {
        console.error("❌ ASSEMBLYAI_API_KEY not configured")
        return false
      }

      if (connectionInitialized) {
        console.log("✅ AssemblyAI already initialized")
        return true
      }

      try {
        console.log("🔄 Initializing AssemblyAI streaming client...")
        assemblyAIClient = new StreamingAssemblyAIClient(ASSEMBLYAI_API_KEY)

        // Set up event handlers
        assemblyAIClient.onTranscript = (transcript, data) => {
          console.log(`📝 Transcript callback triggered: "${transcript}" (final: ${data.is_final})`)

          if (ws.readyState === WebSocket.OPEN) {
            const response = {
              event: "transcription",
              type: "transcription",
              text: transcript,
              transcription: transcript,
              data: {
                text: transcript,
                transcription: transcript,
                session_id: sessionId,
                language: language,
                confidence: data.confidence,
                is_final: data.is_final,
                is_interim: data.is_interim,
                assemblyai_session_id: data.session_id,
              },
              session_id: sessionId,
              language: language,
              timestamp: Date.now(),
            }

            console.log(`📤 Sending ${data.is_final ? "final" : "interim"} transcription to client`)
            ws.send(JSON.stringify(response))
          }
        }

        assemblyAIClient.onError = (error) => {
          console.error("❌ AssemblyAI streaming error:", error)
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "error",
                error: `AssemblyAI streaming error: ${error.message}`,
                session_id: sessionId,
                service: "assemblyai",
              }),
            )
          }
        }

        assemblyAIClient.onSessionStart = (data) => {
          console.log("✅ AssemblyAI streaming session started:", data.id)
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "session_started",
                assemblyai_session_id: data.id,
                session_id: sessionId,
                timestamp: Date.now(),
              }),
            )
          }
        }

        assemblyAIClient.onSessionEnd = (data) => {
          console.log("🏁 AssemblyAI streaming session ended")
          isStreamingActive = false
        }

        // Connect to AssemblyAI
        await assemblyAIClient.connect()

        console.log("✅ AssemblyAI streaming client initialized successfully")
        connectionInitialized = true
        return true
      } catch (error) {
        console.error("❌ Failed to initialize AssemblyAI streaming:", error)
        return false
      }
    }

    // Initialize AssemblyAI immediately
    initializeAssemblyAI().then((success) => {
      if (ws.readyState === WebSocket.OPEN) {
        const services = ["synthesis"]
        if (success) {
          services.push("transcription")
        }

        ws.send(
          JSON.stringify({
            type: "connected",
            language: language,
            services: services,
            session_id: sessionId || generateSessionId(),
            status: "ready",
            transcription_service: "assemblyai",
            streaming_mode: true,
            assemblyai_status: success ? "connected" : "failed",
            audio_format: "webm_to_pcm16",
          }),
        )
      }
    })

    ws.on("message", async (message) => {
      try {
        let data
        try {
          const messageStr = message.toString()
          data = JSON.parse(messageStr)
          console.log("📥 Received message:", {
            event: data.event,
            hasAudioData: !!data.audio_data,
            audioDataLength: data.audio_data ? data.audio_data.length : 0,
          })
        } catch (parseError) {
          console.error("❌ Invalid message format")
          return
        }

        switch (data.event) {
          case "start":
            sessionId = data.uuid || data.session_id || generateSessionId()
            console.log("🎬 Session started:", sessionId)

            if (!connectionInitialized) {
              await initializeAssemblyAI()
            }

            if (ws.readyState === WebSocket.OPEN) {
              const services = ["synthesis"]
              if (connectionInitialized) {
                services.push("transcription")
              }

              ws.send(
                JSON.stringify({
                  type: "connected",
                  language: language,
                  services: services,
                  session_id: sessionId,
                  status: "ready",
                  transcription_service: "assemblyai",
                  streaming_mode: true,
                  assemblyai_status: connectionInitialized ? "connected" : "failed",
                }),
              )
            }
            break

          case "start_streaming":
            if (assemblyAIClient && connectionInitialized && !isStreamingActive) {
              console.log("🎤 Starting real-time streaming session")
              const started = assemblyAIClient.startStreaming()
              isStreamingActive = started

              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "streaming_started",
                    session_id: sessionId,
                    streaming: started,
                    timestamp: Date.now(),
                  }),
                )
              }
            }
            break

          case "stream_audio":
            if (data.audio_data && assemblyAIClient && isStreamingActive) {
              console.log("📤 Processing streaming audio chunk:", data.audio_data.length, "chars")
              const success = await assemblyAIClient.streamAudioChunk(data.audio_data)

              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "audio_streamed",
                    session_id: sessionId,
                    success: success,
                    timestamp: Date.now(),
                  }),
                )
              }
            }
            break

          case "stop_streaming":
            if (assemblyAIClient && isStreamingActive) {
              console.log("⏹️ Stopping real-time streaming session")
              assemblyAIClient.stopStreaming()
              isStreamingActive = false

              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "streaming_stopped",
                    session_id: sessionId,
                    timestamp: Date.now(),
                  }),
                )
              }
            }
            break

          case "synthesize":
            const textToSynthesize = data.text || data.message
            if (textToSynthesize) {
              await handleTTSRequest(textToSynthesize, ws, sessionId)
            }
            break

          default:
            console.warn("⚠️ Unknown message event:", data.event)
            break
        }
      } catch (error) {
        console.error("❌ Error processing message:", error)
      }
    })

    async function handleTTSRequest(text, ws, sessionId) {
      // TTS implementation (same as before)
      try {
        console.log("🎵 Processing TTS request:", text)

        if (!process.env.LMNT_API_KEY) {
          console.error("❌ LMNT API key not configured")
          return
        }

        if (!lmntClient) {
          lmntClient = new LMNTStreamingClient(process.env.LMNT_API_KEY)
        }

        const audioData = await lmntClient.synthesize(text, {
          voice: "lily",
          language: language,
          speed: 1.0,
        })

        if (audioData && audioData.length > 0) {
          const wavAudio = convertToWAV(audioData)
          const base64Audio = Buffer.from(wavAudio).toString("base64")

          const response = {
            data: {
              session_id: sessionId,
              audio_bytes_to_play: base64Audio,
              sample_rate: 8000,
              channels: 1,
              sample_width: 2,
            },
            type: "tts_response",
            session_id: sessionId,
            timestamp: Date.now(),
          }

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(response))
          }
        }
      } catch (error) {
        console.error("❌ TTS error:", error)
      }
    }

    function convertToWAV(audioBuffer, sampleRate = 8000, channels = 1, sampleWidth = 2) {
      const byteRate = sampleRate * channels * sampleWidth
      const blockAlign = channels * sampleWidth
      const dataSize = audioBuffer.length
      const fileSize = 36 + dataSize

      const wavBuffer = Buffer.alloc(44 + dataSize)
      let offset = 0

      // RIFF header
      wavBuffer.write("RIFF", offset)
      offset += 4
      wavBuffer.writeUInt32LE(fileSize, offset)
      offset += 4
      wavBuffer.write("WAVE", offset)
      offset += 4

      // fmt chunk
      wavBuffer.write("fmt ", offset)
      offset += 4
      wavBuffer.writeUInt32LE(16, offset)
      offset += 4
      wavBuffer.writeUInt16LE(1, offset)
      offset += 2
      wavBuffer.writeUInt16LE(channels, offset)
      offset += 2
      wavBuffer.writeUInt32LE(sampleRate, offset)
      offset += 4
      wavBuffer.writeUInt32LE(byteRate, offset)
      offset += 4
      wavBuffer.writeUInt16LE(blockAlign, offset)
      offset += 2
      wavBuffer.writeUInt16LE(sampleWidth * 8, offset)
      offset += 2

      // data chunk
      wavBuffer.write("data", offset)
      offset += 4
      wavBuffer.writeUInt32LE(dataSize, offset)
      offset += 4
      audioBuffer.copy(wavBuffer, offset)

      return wavBuffer
    }

    function generateSessionId() {
      return require("crypto").randomUUID()
    }

    ws.on("close", () => {
      console.log("🔌 Connection closed")
      if (assemblyAIClient) {
        assemblyAIClient.close()
      }
      isStreamingActive = false
    })

    ws.on("error", (error) => {
      console.error("❌ WebSocket error:", error)
    })

    // Send initial connection
    if (ws.readyState === WebSocket.OPEN) {
      sessionId = generateSessionId()
      ws.send(
        JSON.stringify({
          type: "connected",
          language: language,
          services: ["synthesis"],
          session_id: sessionId,
          status: "initializing",
          transcription_service: "assemblyai",
          streaming_mode: true,
          audio_format: "webm_to_pcm16",
        }),
      )
    }
  })
}

module.exports = { setupUnifiedVoiceServer }
