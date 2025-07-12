const WebSocket = require("ws")
const FormData = require("form-data")
const path = require("path")
const fetch = globalThis.fetch || require("node-fetch")

if (!fetch) {
  console.error("❌ Fetch not available. Please use Node.js 18+ or install node-fetch@2")
  process.exit(1)
}

const createTimer = (label) => {
  const start = process.hrtime.bigint()
  return {
    end: () => {
      const end = process.hrtime.bigint()
      const duration = Number(end - start) / 1000000 // Convert to milliseconds
      console.log(`⏱️ ${label}: ${duration.toFixed(2)}ms`)
      return duration
    },
  }
}

const MIN_CHUNK_SIZE = 320

const setupUnifiedVoiceServer = (wss) => {
  console.log("🚀 Unified Voice WebSocket server initialized")

  wss.on("connection", (ws, req) => {
    console.log("🔗 New unified voice connection established")
    console.log("📡 SIP Connection Details:", {
      timestamp: new Date().toISOString(),
      clientIP: req.socket.remoteAddress,
      userAgent: req.headers["user-agent"],
      origin: req.headers.origin,
    })

    let deepgramWs = null
    let deepgramReady = false
    let deepgramConnected = false
    let reconnectAttempts = 0
    const MAX_RECONNECT_ATTEMPTS = 5
    let reconnectDelay = 1000
    let sessionId = null
    let audioChunkCount = 0
    let connectionGreetingSent = false
    let sipDataReceived = 0
    let currentTranscript = ""
    let emptyAudioCount = 0
    let isSpeaking = false
    let silenceTimeout = null
    const SILENCE_DURATION = 800
    let isProcessingGemini = false
    let fullConversationHistory = []
    let performanceMetrics = {
      deepgramProcessingTimes: [],
      geminiProcessingTimes: [],
      lmntProcessingTimes: [],
      totalResponseTimes: [],
      transferTimes: {
        deepgramToGemini: [],
        geminiToLmnt: [],
        lmntToClient: [],
      },
    }
    const url = new URL(req.url, "http://localhost")
    const language = url.searchParams.get("language") || "en"
    const lmntApiKey = process.env.LMNT_API_KEY

    const vadState = {
      isSpeaking: false,
      silenceCount: 0,
      speechCount: 0,
      lastAudioLevel: 0,
      SILENCE_THRESHOLD: 3,
      SPEECH_THRESHOLD: 2,
      AUDIO_LEVEL_THRESHOLD: 0.008,
    }

    // --- Gemini and TTS logic (unchanged) ---
    // ... existing code ...
    // (Copy all Gemini, TTS, greeting, and performance metric functions from the original file)
    // ... existing code ...

    // --- Deepgram WebSocket connection and streaming ---
    const getDeepgramUrl = (options = {}) => {
      const deepgramUrl = new URL("wss://api.deepgram.com/v1/listen")
      deepgramUrl.searchParams.append("sample_rate", "8000")
      deepgramUrl.searchParams.append("channels", "1")
      deepgramUrl.searchParams.append("interim_results", "true")
      deepgramUrl.searchParams.append("language", options.language || "en")
      deepgramUrl.searchParams.append("model", "nova-2")
      deepgramUrl.searchParams.append("smart_format", "true")
      deepgramUrl.searchParams.append("punctuate", "true")
      deepgramUrl.searchParams.append("diarize", "false")
      deepgramUrl.searchParams.append("encoding", "linear16")
      deepgramUrl.searchParams.append("endpointing", "150")
      return deepgramUrl.toString()
    }

    const connectToDeepgram = async (options = {}) => {
      return new Promise((resolve, reject) => {
        try {
          if (!process.env.DEEPGRAM_API_KEY) {
            const error = "STT API key not configured"
            console.log("❌", error)
            reject(new Error(error))
            return
          }
          const url = getDeepgramUrl(options)
          deepgramWs = new WebSocket(url, ["token", process.env.DEEPGRAM_API_KEY])
          deepgramWs.binaryType = "arraybuffer"
          const connectionTimeout = setTimeout(() => {
            if (deepgramWs) deepgramWs.close()
            reject(new Error("STT connection timeout"))
          }, 10000)
          deepgramWs.onopen = () => {
            clearTimeout(connectionTimeout)
            deepgramReady = true
            deepgramConnected = true
            reconnectAttempts = 0
            reconnectDelay = 1000
            console.log("✅ Deepgram STT connection established")
            resolve()
          }
          deepgramWs.onmessage = async (event) => {
            const deepgramTimer = createTimer("Deepgram Processing")
            try {
              const rawData = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString()
              const data = JSON.parse(rawData)
              if (data.type === "Results") {
                if (data.channel?.alternatives?.[0]?.transcript) {
                  const transcript = data.channel.alternatives[0].transcript
                  const confidence = data.channel.alternatives[0].confidence
                  const is_final = data.is_final
                  if (transcript.trim()) {
                    resetSilenceTimer()
                    if (is_final) {
                      currentTranscript += (currentTranscript ? " " : "") + transcript.trim()
                      console.log("📝 Deepgram Transcript (final):", currentTranscript)
                      startSilenceTimer()
                    } else {
                      const displayTranscript = currentTranscript + (currentTranscript ? " " : "") + transcript.trim()
                      console.log("📝 Deepgram Transcript (interim):", displayTranscript)
                    }
                    emptyAudioCount = 0
                    isSpeaking = true
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(
                        JSON.stringify({
                          type: "transcript",
                          data: transcript,
                          confidence: confidence,
                          is_final: is_final,
                          language: language,
                          accumulated: currentTranscript,
                        }),
                      )
                    }
                  } else if (is_final) {
                    emptyAudioCount++
                    if (isSpeaking && emptyAudioCount >= 500) {
                      console.log(`🔇 Silence detected (500 empty chunks). Starting silence timer.`)
                      isSpeaking = false
                      startSilenceTimer()
                    }
                  }
                }
              } else if (data.type === "SpeechStarted") {
                console.log("🎙️ STT: Speech started detected")
                resetSilenceTimer()
                isSpeaking = true
                emptyAudioCount = 0
              } else if (data.type === "UtteranceEnd") {
                console.log("🎙️ STT: Utterance end detected. Starting silence timer.")
                if (isSpeaking) {
                  isSpeaking = false
                  startSilenceTimer()
                }
              }
              const deepgramDuration = deepgramTimer.end()
              performanceMetrics.deepgramProcessingTimes.push(deepgramDuration)
            } catch (parseError) {
              deepgramTimer.end()
              console.log("❌ Error parsing STT response:", parseError.message)
            }
          }
          deepgramWs.onerror = (error) => {
            clearTimeout(connectionTimeout)
            deepgramReady = false
            deepgramConnected = false
            console.log("❌ Deepgram STT error:", error.message)
            reject(error)
          }
          deepgramWs.onclose = (event) => {
            clearTimeout(connectionTimeout)
            deepgramReady = false
            deepgramConnected = false
            console.log(`🎙️ STT connection closed: ${event.code} - ${event.reason}`)
            if ((event.code === 1006 || event.code === 1011 || (event.reason && event.reason.includes("429"))) && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
              reconnectAttempts++
              const delay = Math.min(reconnectDelay * Math.pow(2, reconnectAttempts - 1), 15000)
              console.log(`⏳ Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)
              setTimeout(() => {
                connectToDeepgram(options).catch((err) => {
                  console.log("❌ STT reconnection failed:", err.message)
                })
              }, delay)
            } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
              console.log("❌ Max STT reconnection attempts reached")
            }
          }
        } catch (error) {
          console.log("❌ Error creating Deepgram connection:", error.message)
          reject(error)
        }
      })
    }

    const closeDeepgram = () => {
      console.log("🎙️ STT: Closing connection")
      deepgramReady = false
      deepgramConnected = false
      if (deepgramWs) {
        try {
          deepgramWs.close(1000, "Client closing")
          console.log("✅ STT: WebSocket closed successfully")
        } catch (error) {
          console.log("⚠️ Error closing STT WebSocket:", error.message)
        }
      }
    }

    // --- Real-time audio streaming ---
    const sendAudioToDeepgram = async (audioData) => {
      if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN || !deepgramReady) {
        console.log("❌ Deepgram not ready - WS state:", deepgramWs?.readyState, "Ready:", deepgramReady)
        return false
      }
      if (!audioData) {
        console.log("❌ sendAudioToDeepgram: Received null/undefined audio data")
        return false
      }
      try {
        let buffer
        if (audioData instanceof Buffer) {
          buffer = audioData
        } else if (audioData instanceof ArrayBuffer) {
          buffer = Buffer.from(audioData)
        } else if (Array.isArray(audioData) || audioData instanceof Uint8Array) {
          buffer = Buffer.from(audioData)
        } else {
          console.log("❌ Invalid audio data type for Deepgram:", typeof audioData)
          return false
        }
        if (buffer.length === 0) {
          console.log("⚠️ Empty audio buffer, skipping Deepgram send")
          return false
        }
        // Chunk and send
        for (let i = 0; i < buffer.length; i += MIN_CHUNK_SIZE) {
          const chunk = buffer.slice(i, i + MIN_CHUNK_SIZE)
          deepgramWs.send(chunk)
        }
        return true
      } catch (error) {
        console.log("❌ Error sending audio to Deepgram:", error.message)
        return false
      }
    }

    // --- VAD and silence detection (unchanged) ---
    // ... existing code ...

    // --- WebSocket message handler ---
    ws.on("message", async (message) => {
      try {
        let isTextMessage = false
        let data = null
        if (typeof message === "string") {
          isTextMessage = true
          // ... existing code ...
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
          // ... existing code for handling text messages (start, synthesize, etc.) ...
          if (data.event === "start" && data.session_id) {
            sessionId = data.session_id
            audioChunkCount = 0
            currentTranscript = ""
            emptyAudioCount = 0
            isSpeaking = false
            fullConversationHistory = []
            performanceMetrics = {
              deepgramProcessingTimes: [],
              geminiProcessingTimes: [],
              lmntProcessingTimes: [],
              totalResponseTimes: [],
              transferTimes: {
                deepgramToGemini: [],
                geminiToLmnt: [],
                lmntToClient: [],
              },
            }
            console.log("✅ SIP Call Started with UUID:", sessionId)
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "session_started",
                  session_id: sessionId,
                  language: language,
                  message: "SIP call started, connecting to STT and sending greeting.",
                }),
              )
            }
            if (!deepgramConnected) {
              try {
                await connectToDeepgram({ language })
                console.log("✅ Deepgram connection established for STT after SIP start.")
              } catch (error) {
                console.log("❌ Failed to initialize Deepgram after SIP start:", error.message)
              }
            } else {
              console.log("✅ Deepgram already connected for STT.")
            }
            setTimeout(() => {
              console.log("👋 Sending initial greeting after SIP start...")
              sendGreeting()
            }, 300)
          } else if (data.type === "synthesize") {
            // ... existing code ...
          } else if (data.type === "start_stt") {
            // ... existing code ...
          } else if (data.type === "stop_stt") {
            closeDeepgram()
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "stt_stopped",
                  session_id: sessionId,
                  message: "Speech-to-text service deactivated",
                }),
              )
            }
          } else if (data.data && data.data.hangup === "true") {
            ws.close(1000, "Hangup requested by Voicebot")
          } else if (data.data && data.data.stream_stop === "true") {
            closeDeepgram()
          } else {
            console.log("❓ Unknown message type or missing required fields:", data.type || data.event, data)
          }
        } else {
          // Handle binary audio data: stream directly to Deepgram
          try {
            if (!message || message.length === 0) {
              console.log("⚠️ Received empty audio message, skipping")
              return
            }
            // PCM conversion (if needed)
            let pcmAudio
            if (message instanceof Buffer) {
              pcmAudio = message
            } else if (message instanceof ArrayBuffer) {
              pcmAudio = Buffer.from(message)
            } else if (Array.isArray(message) || message instanceof Uint8Array) {
              pcmAudio = Buffer.from(message)
            } else {
              pcmAudio = Buffer.from(message)
            }
            // VAD (optional)
            const samples = []
            for (let i = 0; i < pcmAudio.length; i += 2) {
              if (i + 1 < pcmAudio.length) {
                const sample = pcmAudio.readInt16LE(i)
                samples.push(sample)
              }
            }
            let sum = 0
            for (const sample of samples) {
              sum += sample * sample
            }
            const rms = samples.length > 0 ? Math.sqrt(sum / samples.length) : 0
            const audioLevel = rms / 32768.0
            vadState.lastAudioLevel = audioLevel
            const hasSpeech = audioLevel > vadState.AUDIO_LEVEL_THRESHOLD
            if (hasSpeech) {
              vadState.speechCount++
              vadState.silenceCount = 0
              if (vadState.speechCount >= vadState.SPEECH_THRESHOLD && !vadState.isSpeaking) {
                vadState.isSpeaking = true
                console.log(`🎤 Speech detected! Audio level: ${audioLevel.toFixed(4)}`)
              }
            } else {
              vadState.silenceCount++
              vadState.speechCount = 0
              if (vadState.silenceCount >= vadState.SILENCE_THRESHOLD && vadState.isSpeaking) {
                vadState.isSpeaking = false
                console.log(`🔇 Silence detected! Audio level: ${audioLevel.toFixed(4)}`)
              }
            }
            // Only send audio with voice activity to Deepgram
            if (hasSpeech) {
              if (deepgramConnected && deepgramReady) {
                await sendAudioToDeepgram(pcmAudio)
              } else {
                console.log("⚠️ Deepgram not ready, dropping audio chunk")
              }
            } else {
              console.log(`🔇 Silent audio chunk detected: ${pcmAudio.length} bytes, skipping Deepgram`)
            }
          } catch (audioError) {
            console.log("❌ Error processing binary audio:", audioError.message)
          }
        }
      } catch (error) {
        console.log("❌ Error processing message:", error.message)
      }
    })

    ws.on("close", () => {
      console.log("🔗 Unified voice connection closed")
      closeDeepgram()
      resetSilenceTimer()
      sessionId = null
      audioChunkCount = 0
      deepgramReady = false
      deepgramConnected = false
      connectionGreetingSent = false
      sipDataReceived = 0
      currentTranscript = ""
      emptyAudioCount = 0
      isSpeaking = false
      fullConversationHistory = []
      performanceMetrics = {
        deepgramProcessingTimes: [],
        geminiProcessingTimes: [],
        lmntProcessingTimes: [],
        totalResponseTimes: [],
        transferTimes: {
          deepgramToGemini: [],
          geminiToLmnt: [],
          lmntToClient: [],
        },
      }
    })

    ws.on("error", (error) => {
      console.log("❌ WebSocket connection error:", error.message)
    })

    console.log("✅ WebSocket connection confirmed, waiting for SIP 'start' event.")
  })
}

module.exports = { setupUnifiedVoiceServer } 