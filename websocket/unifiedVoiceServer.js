const WebSocket = require("ws")
const FormData = require("form-data")
const fs = require("fs")
const path = require("path")

const fetch = globalThis.fetch || require("node-fetch")

if (!fetch) {
  console.error("❌ Fetch not available. Please use Node.js 18+ or install node-fetch@2")
  process.exit(1)
}

// Performance timing utilities
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
    let audioBuffer = []
    let deepgramConnected = false

    // Reduced audio processing for faster response
    let audioFiles = []
    let audioFileIndex = 0
    const MAX_AUDIO_FILES = 20 // Reduced from 60 for faster processing
    const AUDIO_FILES_DIR = path.join(__dirname, "audio_chunks")

    if (!fs.existsSync(AUDIO_FILES_DIR)) {
      fs.mkdirSync(AUDIO_FILES_DIR, { recursive: true })
    }

    const vadState = {
      isSpeaking: false,
      silenceCount: 0,
      speechCount: 0,
      lastAudioLevel: 0,
      SILENCE_THRESHOLD: 3, // Reduced from 5 for faster detection
      SPEECH_THRESHOLD: 2, // Reduced from 3 for faster detection
      AUDIO_LEVEL_THRESHOLD: 0.008, // Slightly lower threshold
    }

    let audioQueue = []
    let isProcessingQueue = false
    let lastSentTime = 0
    const MIN_SEND_INTERVAL = 100 // Reduced from 250ms for faster processing
    const MAX_QUEUE_SIZE = 20 // Reduced from 50
    const MAX_BUFFER_SIZE = 30 // Reduced from 100
    let reconnectAttempts = 0
    const MAX_RECONNECT_ATTEMPTS = 5
    let reconnectDelay = 1000

    const lmntApiKey = process.env.LMNT_API_KEY

    let sessionId = null
    let audioChunkCount = 0
    let connectionGreetingSent = false
    let sipDataReceived = 0

    let currentTranscript = ""
    let emptyAudioCount = 0
    const SILENCE_THRESHOLD = 500 // Reduced from 1500 for faster response
    let isSpeaking = false

    // Optimized Gemini Integration Variables
    let silenceTimeout = null
    const SILENCE_DURATION = 800 // Reduced from 2000ms to 800ms for faster response
    let isProcessingGemini = false
    let fullConversationHistory = []

    // Performance tracking
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

    console.log(`🌐 Connection established with language: ${language}`)
    console.log(`🔑 TTS API Key configured: ${lmntApiKey ? "Yes (" + lmntApiKey.substring(0, 8) + "...)" : "❌ NO"}`)
    console.log(
      `🤖 Gemini API Key configured: ${process.env.GEMINI_API_KEY ? "Yes (" + process.env.GEMINI_API_KEY.substring(0, 8) + "...)" : "❌ NO"}`,
    )

    // Optimized Gemini API Integration with timing
    const sendToGemini = async (userMessage) => {
      if (isProcessingGemini) {
        console.log("🤖 Gemini is already processing a request, skipping...")
        return null
      }

      if (!process.env.GEMINI_API_KEY) {
        console.log("❌ Gemini API key not configured")
        return null
      }

      if (!userMessage.trim()) {
        console.log("🤖 Empty message, skipping Gemini request")
        return null
      }

      isProcessingGemini = true
      const geminiTimer = createTimer("Gemini API Processing")
      console.log("🤖 Sending to Gemini:", userMessage)

      try {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`

        // Add user message to conversation history
        fullConversationHistory.push({
          role: "user",
          parts: [{ text: userMessage }],
        })

        // Optimized request body for faster response
        const requestBody = {
          contents: fullConversationHistory.slice(-6), // Keep only last 6 messages for faster processing
          generationConfig: {
            temperature: 0.7,
            topK: 20, // Reduced from 40 for faster generation
            topP: 0.9, // Slightly reduced
            maxOutputTokens: 150, // Significantly reduced from 1024 for shorter responses
          },
          safetySettings: [
            {
              category: "HARM_CATEGORY_HARASSMENT",
              threshold: "BLOCK_MEDIUM_AND_ABOVE",
            },
            {
              category: "HARM_CATEGORY_HATE_SPEECH",
              threshold: "BLOCK_MEDIUM_AND_ABOVE",
            },
            {
              category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
              threshold: "BLOCK_MEDIUM_AND_ABOVE",
            },
            {
              category: "HARM_CATEGORY_DANGEROUS_CONTENT",
              threshold: "BLOCK_MEDIUM_AND_ABOVE",
            },
          ],
        }

        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        })

        if (!response.ok) {
          const errorText = await response.text()
          console.log("❌ Gemini API error:", response.status, errorText)
          return null
        }

        const data = await response.json()
        const geminiDuration = geminiTimer.end()
        performanceMetrics.geminiProcessingTimes.push(geminiDuration)

        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
          const geminiResponse = data.candidates[0].content.parts[0].text

          // Truncate response for faster TTS processing
          const truncatedResponse =
            geminiResponse.length > 200 ? geminiResponse.substring(0, 200) + "..." : geminiResponse

          console.log("🤖 Gemini Response:", truncatedResponse)

          // Add Gemini response to conversation history
          fullConversationHistory.push({
            role: "model",
            parts: [{ text: truncatedResponse }],
          })

          return truncatedResponse
        } else {
          console.log("❌ Unexpected Gemini response format:", data)
          return null
        }
      } catch (error) {
        geminiTimer.end()
        console.log("❌ Error calling Gemini API:", error.message)
        return null
      } finally {
        isProcessingGemini = false
      }
    }

    const handleSilenceDetected = async () => {
      if (currentTranscript.trim() && !isProcessingGemini) {
        const totalResponseTimer = createTimer("Total Response Time")
        console.log("🔕 Silence detected, processing response...")
        console.log("📝 Final transcript:", currentTranscript)

        const transferTimer1 = createTimer("Transfer: Deepgram → Gemini")
        transferTimer1.end()
        performanceMetrics.transferTimes.deepgramToGemini.push(0) // Minimal transfer time

        const geminiResponse = await sendToGemini(currentTranscript.trim())

        if (geminiResponse) {
          const transferTimer2 = createTimer("Transfer: Gemini → LMNT")
          console.log("🎯 Gemini Response received:", geminiResponse)

          try {
            const synthesisOptions = {
              voice: "lily",
              language: language === "en" ? "en" : "hi",
              speed: 1.2, // Slightly faster speech for quicker delivery
            }

            const transferDuration2 = transferTimer2.end()
            performanceMetrics.transferTimes.geminiToLmnt.push(transferDuration2)

            const audioData = await synthesizeWithErrorHandling(geminiResponse, synthesisOptions)

            if (audioData && audioData.length > 0) {
              const transferTimer3 = createTimer("Transfer: LMNT → Client")

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
                type: "gemini_response",
              }

              console.log("📤 Sending Gemini response as audio...")
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(audioResponse))
                const transferDuration3 = transferTimer3.end()
                performanceMetrics.transferTimes.lmntToClient.push(transferDuration3)
                console.log("✅ Gemini response audio sent!")
              }
            }
          } catch (error) {
            console.log("❌ Failed to synthesize Gemini response:", error.message)
          }
        }

        const totalDuration = totalResponseTimer.end()
        performanceMetrics.totalResponseTimes.push(totalDuration)

        // Log performance summary
        logPerformanceMetrics()

        // Reset transcript after processing
        currentTranscript = ""
        emptyAudioCount = 0
      }
    }

    const logPerformanceMetrics = () => {
      const avg = (arr) => (arr.length > 0 ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : 0)

      console.log("📊 PERFORMANCE METRICS:")
      console.log(`   🎙️ Deepgram avg: ${avg(performanceMetrics.deepgramProcessingTimes)}ms`)
      console.log(`   🤖 Gemini avg: ${avg(performanceMetrics.geminiProcessingTimes)}ms`)
      console.log(`   🔊 LMNT avg: ${avg(performanceMetrics.lmntProcessingTimes)}ms`)
      console.log(`   ⚡ Total Response avg: ${avg(performanceMetrics.totalResponseTimes)}ms`)
      console.log(`   🔄 Transfer Times:`)
      console.log(`      Deepgram→Gemini: ${avg(performanceMetrics.transferTimes.deepgramToGemini)}ms`)
      console.log(`      Gemini→LMNT: ${avg(performanceMetrics.transferTimes.geminiToLmnt)}ms`)
      console.log(`      LMNT→Client: ${avg(performanceMetrics.transferTimes.lmntToClient)}ms`)
    }

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

    const detectVoiceActivity = (audioBuffer) => {
      if (!audioBuffer || audioBuffer.length === 0) {
        return false
      }

      const samples = []
      for (let i = 0; i < audioBuffer.length; i += 2) {
        if (i + 1 < audioBuffer.length) {
          const sample = audioBuffer.readInt16LE(i)
          samples.push(sample)
        }
      }

      if (samples.length === 0) {
        return false
      }

      let sum = 0
      for (const sample of samples) {
        sum += sample * sample
      }
      const rms = Math.sqrt(sum / samples.length)
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

      return hasSpeech
    }

    const saveAudioChunk = (audioData, hasVoice = false) => {
      try {
        const filename = `audio_chunk_${audioFileIndex.toString().padStart(3, "0")}.wav`
        const filepath = path.join(AUDIO_FILES_DIR, filename)

        const audioBuffer = Buffer.from(audioData)
        const audioWithHeader = createWAVHeader(audioBuffer, 8000, 1, 16)

        fs.writeFileSync(filepath, audioWithHeader)

        const fileInfo = {
          index: audioFileIndex,
          filename: filename,
          filepath: filepath,
          hasVoice: hasVoice,
          timestamp: new Date().toISOString(),
          size: audioWithHeader.length,
        }

        audioFiles.push(fileInfo)
        audioFileIndex++

        if (hasVoice) {
          console.log(`💾 Audio saved: ${filename} (${audioWithHeader.length} bytes) - CONTAINS SPEECH`)
        }

        if (audioFiles.length > MAX_AUDIO_FILES) {
          const oldFile = audioFiles.shift()
          try {
            fs.unlinkSync(oldFile.filepath)
          } catch (error) {
            console.log(`⚠️ Failed to delete old audio file: ${error.message}`)
          }
        }

        return fileInfo
      } catch (error) {
        console.log(`❌ Failed to save audio chunk: ${error.message}`)
        return null
      }
    }

    const removeEmptyAudioFiles = () => {
      const removedFiles = []
      audioFiles = audioFiles.filter((fileInfo) => {
        if (!fileInfo.hasVoice) {
          try {
            fs.unlinkSync(fileInfo.filepath)
            removedFiles.push(fileInfo.filename)
            return false
          } catch (error) {
            return true
          }
        }
        return true
      })

      if (removedFiles.length > 0) {
        console.log(`🧹 Removed ${removedFiles.length} silent audio files`)
      }
    }

    const concatenateAudioFiles = () => {
      return new Promise((resolve, reject) => {
        try {
          if (audioFiles.length === 0) {
            resolve(null)
            return
          }

          const voiceFiles = audioFiles.filter((file) => file.hasVoice)

          if (voiceFiles.length === 0) {
            resolve(null)
            return
          }

          console.log(`🔗 Concatenating ${voiceFiles.length} voice files...`)

          const audioChunks = []
          let totalSize = 0

          for (const fileInfo of voiceFiles) {
            const fileBuffer = fs.readFileSync(fileInfo.filepath)
            const audioData = fileBuffer.slice(44)
            audioChunks.push(audioData)
            totalSize += audioData.length
          }

          const combinedAudio = Buffer.concat(audioChunks)
          const finalAudioWithHeader = createWAVHeader(combinedAudio, 8000, 1, 16)

          const finalFilename = `concatenated_audio_${Date.now()}.wav`
          const finalFilepath = path.join(AUDIO_FILES_DIR, finalFilename)

          fs.writeFileSync(finalFilepath, finalAudioWithHeader)

          console.log(`✅ Audio concatenated: ${finalFilename} (${finalAudioWithHeader.length} bytes)`)

          resolve({
            filepath: finalFilepath,
            filename: finalFilename,
            audioData: combinedAudio,
            totalFiles: voiceFiles.length,
            totalSize: finalAudioWithHeader.length,
          })
        } catch (error) {
          console.log(`❌ Failed to concatenate audio files: ${error.message}`)
          reject(error)
        }
      })
    }

    const processAccumulatedAudio = async () => {
      try {
        removeEmptyAudioFiles()

        const concatenatedAudio = await concatenateAudioFiles()

        if (!concatenatedAudio) {
          console.log("⚠️ No voice audio to process for Deepgram.")
          return
        }

        console.log(`📤 Sending concatenated audio to Deepgram: ${concatenatedAudio.totalSize} bytes`)

        if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN && deepgramReady) {
          deepgramWs.send(concatenatedAudio.audioData)
          console.log("✅ Concatenated audio sent to Deepgram")
        } else {
          console.log("❌ Cannot send to Deepgram - connection not ready")
        }

        audioFiles = []
        audioFileIndex = 0
      } catch (error) {
        console.log(`❌ Failed to process accumulated audio: ${error.message}`)
      }
    }

    const logSipData = (data, type = "UNKNOWN") => {
      const timestamp = new Date().toISOString()
      sipDataReceived++

      console.log(`📞 SIP Data Received [${sipDataReceived}] - ${type} - ${timestamp}`)
      if (typeof data === "string") {
        console.log(`📝 Text Content: ${data.substring(0, 100)}${data.length > 100 ? "..." : ""}`)
      } else if (data instanceof Buffer) {
        console.log(`🎵 Audio Buffer: ${data.length} bytes`)
      }
    }

    const getGreetingMessage = (lang) => {
      const greetings = {
        hi: "नमस्ते! Aitota में आपका स्वागत है।",
        en: "Hi! Welcome to Aitota.",
        es: "¡Hola! Bienvenido a Aitota.",
        fr: "Bonjour ! Bienvenue chez Aitota.",
        de: "Hallo! Willkommen bei Aitota.",
        it: "Ciao! Benvenuto in Aitota.",
        pt: "Olá! Bem-vindo à Aitota.",
        ja: "こんにちは！Aitota へようこそ。",
        ko: "안녕하세요! Aitota에 오신 것을 환영합니다。",
        zh: "你好！欢迎来到 Aitota。",
        ar: "مرحبًا! أهلاً بك في Aitota.",
        ru: "Привет! Добро пожаловать в Aitota.",
      }

      return greetings[lang] || greetings["en"]
    }

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

    const sendGreeting = async () => {
      if (connectionGreetingSent || !lmntApiKey || !sessionId) {
        return
      }

      const greetingText = getGreetingMessage(language)
      console.log("👋 Greeting text:", greetingText)

      try {
        const synthesisOptions = {
          voice: "lily",
          language: language === "en" ? "en" : "hi",
          speed: 1.1,
        }

        const audioData = await synthesizeWithErrorHandling(greetingText, synthesisOptions)

        if (!audioData || audioData.length === 0) {
          throw new Error("Received empty greeting audio data from TTS")
        }

        console.log("✅ Greeting: Successfully received audio data, size:", audioData.length, "bytes")

        const audioBuffer = Buffer.from(audioData)
        const audioWithHeader = createWAVHeader(audioBuffer, 8000, 1, 16)
        const pythonBytesString = bufferToPythonBytesString(audioWithHeader)

        audioChunkCount++

        const greetingResponse = {
          data: {
            session_id: sessionId,
            count: audioChunkCount,
            audio_bytes_to_play: pythonBytesString,
            sample_rate: 8000,
            channels: 1,
            sample_width: 2,
          },
          type: "greeting",
        }

        console.log("✅ ==================== SENDING GREETING AUDIO ====================")
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(greetingResponse))
          console.log("✅ 👋 Connection greeting sent successfully!")
          connectionGreetingSent = true
        } else {
          console.log("❌ WebSocket not open, cannot send greeting")
        }
      } catch (error) {
        console.log("❌ Failed to send greeting:", error.message)
        connectionGreetingSent = true
      }
    }

    const processAudioQueue = async () => {
      if (isProcessingQueue || audioQueue.length === 0) {
        return
      }

      isProcessingQueue = true

      while (audioQueue.length > 0 && deepgramReady && deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        const now = Date.now()
        const timeSinceLastSend = now - lastSentTime

        if (timeSinceLastSend < MIN_SEND_INTERVAL) {
          const waitTime = MIN_SEND_INTERVAL - timeSinceLastSend
          await new Promise((resolve) => setTimeout(resolve, waitTime))
        }

        const audioData = audioQueue.shift()
        const success = await sendAudioToDeepgramThrottled(audioData)

        if (!success) {
          audioQueue.unshift(audioData)
          console.log("⚠️ Failed to send audio to Deepgram, re-queueing and pausing processing.")
          break
        }

        lastSentTime = Date.now()
        await new Promise((resolve) => setTimeout(resolve, 25)) // Reduced delay
      }

      isProcessingQueue = false

      if (audioQueue.length > 0) {
        setTimeout(processAudioQueue, MIN_SEND_INTERVAL)
      }
    }

    const sendAudioToDeepgramThrottled = async (audioData) => {
      if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN || !deepgramReady) {
        return false
      }

      try {
        const buffer = audioData instanceof Buffer ? audioData : Buffer.from(audioData)
        deepgramWs.send(buffer)
        return true
      } catch (error) {
        console.log("❌ Error sending audio to Deepgram:", error.message)
        if (error.message.includes("429") || error.message.includes("rate limit")) {
          console.log("⏳ Rate limit detected, backing off...")
          await new Promise((resolve) => setTimeout(resolve, 1000)) // Reduced backoff time
        }
        return false
      }
    }

    const queueAudioData = async (audioData) => {
      if (audioQueue.length >= MAX_QUEUE_SIZE) {
        console.log(`⚠️ Audio queue full (${MAX_QUEUE_SIZE} chunks). Processing current queue.`)
        await processAudioQueue()
        audioQueue = []
        return
      }

      audioQueue.push(audioData)
      console.log(`🎵 Audio queued: ${audioData.length} bytes, queue size: ${audioQueue.length}`)

      if (!isProcessingQueue) {
        processAudioQueue()
      }
    }

    const connectToDeepgram = async (options = {}) => {
      return new Promise((resolve, reject) => {
        try {
          console.log("🎙️ Connecting to Deepgram STT service...")

          if (!process.env.DEEPGRAM_API_KEY) {
            const error = "STT API key not configured"
            console.log("❌", error)
            reject(new Error(error))
            return
          }

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
          deepgramUrl.searchParams.append("endpointing", "150") // Reduced from 300 for faster detection

          deepgramWs = new WebSocket(deepgramUrl.toString(), ["token", process.env.DEEPGRAM_API_KEY])

          deepgramWs.binaryType = "arraybuffer"

          const connectionTimeout = setTimeout(() => {
            if (deepgramWs) {
              deepgramWs.close()
            }
            reject(new Error("STT connection timeout"))
          }, 10000) // Reduced timeout

          deepgramWs.onopen = () => {
            clearTimeout(connectionTimeout)
            deepgramReady = true
            deepgramConnected = true
            reconnectAttempts = 0
            reconnectDelay = 1000
            console.log("✅ Deepgram STT connection established")

            if (audioQueue.length > 0) {
              console.log(`🎵 Processing ${audioQueue.length} queued audio chunks`)
              processAudioQueue()
            }

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
                    if (isSpeaking && emptyAudioCount >= SILENCE_THRESHOLD) {
                      console.log(`🔇 Silence detected (${SILENCE_THRESHOLD} empty chunks). Starting silence timer.`)
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

            if (error.message && error.message.includes("429")) {
              console.log("⚠️ Rate limit exceeded for STT service")
            }
            reject(error)
          }

          deepgramWs.onclose = (event) => {
            clearTimeout(connectionTimeout)
            deepgramReady = false
            deepgramConnected = false
            console.log(`🎙️ STT connection closed: ${event.code} - ${event.reason}`)

            if (event.code === 1006 || event.code === 1011 || event.reason.includes("429")) {
              console.log("🔄 Attempting to reconnect to STT service...")

              if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++
                const delay = Math.min(reconnectDelay * Math.pow(2, reconnectAttempts - 1), 15000) // Reduced max delay
                console.log(`⏳ Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)

                setTimeout(() => {
                  connectToDeepgram(options).catch((err) => {
                    console.log("❌ STT reconnection failed:", err.message)
                  })
                }, delay)
              } else {
                console.log("❌ Max STT reconnection attempts reached")
              }
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
      audioQueue = []
      isProcessingQueue = false

      resetSilenceTimer()

      if (deepgramWs) {
        try {
          deepgramWs.close(1000, "Client closing")
          console.log("✅ STT: WebSocket closed successfully")
        } catch (error) {
          console.log("⚠️ Error closing STT WebSocket:", error.message)
        }
      }
    }

    const synthesizeWithLMNT = async (text, options = {}) => {
      const lmntTimer = createTimer("LMNT TTS Processing")
      console.log("🔊 TTS: Starting synthesis for text:", text.substring(0, 50) + "...")

      if (!lmntApiKey) {
        const error = "TTS API key not configured in environment variables"
        console.log("❌", error)
        throw new Error(error)
      }

      const synthesisOptions = {
        voice: options.voice || "lily",
        language: options.language || "en",
        speed: options.speed || 1.0,
        format: "wav",
        sample_rate: 8000,
      }

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

          const response = await fetch(attempt.url, requestOptions)

          if (!response.ok) {
            const errorText = await response.text()
            console.log(`❌ TTS: ${attempt.name} failed:`, errorText)
            continue
          }

          const contentType = response.headers.get("content-type")

          if (contentType && contentType.includes("application/json")) {
            const jsonResponse = await response.json()

            if (jsonResponse.audio_url) {
              const audioResponse = await fetch(jsonResponse.audio_url)
              if (!audioResponse.ok) {
                throw new Error(`Failed to fetch audio from URL: ${audioResponse.status}`)
              }
              const audioBuffer = await audioResponse.arrayBuffer()
              const lmntDuration = lmntTimer.end()
              performanceMetrics.lmntProcessingTimes.push(lmntDuration)
              console.log(`✅ TTS: Audio fetched from URL, size: ${audioBuffer.byteLength} bytes`)
              return Buffer.from(audioBuffer)
            } else if (jsonResponse.audio) {
              const audioBuffer = Buffer.from(jsonResponse.audio, "base64")
              const lmntDuration = lmntTimer.end()
              performanceMetrics.lmntProcessingTimes.push(lmntDuration)
              console.log(`✅ TTS: Direct audio from JSON, size: ${audioBuffer.length} bytes`)
              return audioBuffer
            } else {
              throw new Error("Unexpected JSON response format: " + JSON.stringify(jsonResponse))
            }
          } else {
            const audioBuffer = await response.arrayBuffer()

            if (audioBuffer.byteLength === 0) {
              throw new Error("TTS returned empty audio buffer")
            }

            const lmntDuration = lmntTimer.end()
            performanceMetrics.lmntProcessingTimes.push(lmntDuration)
            console.log(`✅ TTS: Successfully got audio from ${attempt.name}, size: ${audioBuffer.byteLength} bytes`)
            return Buffer.from(audioBuffer)
          }
        } catch (error) {
          console.log(`❌ TTS: ${attempt.name} failed:`, error.message)

          if (attempt === apiAttempts[apiAttempts.length - 1]) {
            lmntTimer.end()
            throw error
          }
          continue
        }
      }

      lmntTimer.end()
      throw new Error("All TTS API attempts failed")
    }

    const synthesizeWithErrorHandling = async (text, options = {}) => {
      try {
        const result = await synthesizeWithLMNT(text, options)
        return result
      } catch (error) {
        console.log("❌ Synthesis wrapper failed:", error.message)
        throw error
      }
    }

    const convertToPCM = async (audioBuffer) => {
      try {
        const result = audioBuffer instanceof Buffer ? audioBuffer : Buffer.from(audioBuffer)
        return result
      } catch (error) {
        console.log("⚠️ PCM conversion warning:", error.message)
        return audioBuffer
      }
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

    ws.on("message", async (message) => {
      try {
        let isTextMessage = false
        let data = null

        if (typeof message === "string") {
          isTextMessage = true
          logSipData(message, "TEXT_MESSAGE")
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
              logSipData(messageStr, "JSON_BUFFER")
            } else {
              isTextMessage = false
              logSipData(message, "BINARY_AUDIO")
            }
          } catch (parseError) {
            isTextMessage = false
            logSipData(message, "BINARY_AUDIO")
          }
        }

        if (isTextMessage && data) {
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
            console.log("Source:", data.Source, "Destination:", data.Destination)

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "session_started",
                  session_id: sessionId,
                  language: language,
                  message: "SIP call started, connecting to STT and sending greeting.",
                }),
              )
              console.log("📤 Session started confirmation sent with SIP session ID")
            }

            if (!deepgramConnected) {
              console.log("🎙️ Connecting to Deepgram for STT after SIP start...")
              try {
                await connectToDeepgram({
                  language: language,
                  model: "nova-2",
                  punctuate: true,
                  diarize: false,
                  tier: "enhanced",
                })
                console.log("✅ Deepgram connection established for STT after SIP start.")

                if (audioBuffer.length > 0) {
                  console.log(`🎵 Processing ${audioBuffer.length} buffered audio chunks`)
                  for (const audioData of audioBuffer) {
                    const pcmAudio = await convertToPCM(audioData)
                    queueAudioData(pcmAudio)
                  }
                  audioBuffer = []
                }
              } catch (error) {
                console.log("❌ Failed to initialize Deepgram after SIP start:", error.message)
              }
            } else {
              console.log("✅ Deepgram already connected for STT.")
            }

            setTimeout(() => {
              console.log("👋 Sending initial greeting after SIP start...")
              sendGreeting()
            }, 300) // Reduced delay
          } else if (data.type === "synthesize") {
            console.log("🔊 TTS synthesis request received")
            console.log("📝 Text to synthesize:", data.text)

            if (data.session_id) {
              sessionId = data.session_id
              console.log("🆔 Using SIP-provided session ID for TTS:", sessionId)
            }

            try {
              const synthesisOptions = {
                voice: data.voice || "lily",
                language: data.language || language,
                speed: data.speed || 1.1, // Slightly faster default
              }

              const audioData = await synthesizeWithErrorHandling(data.text, synthesisOptions)

              if (!audioData || audioData.length === 0) {
                throw new Error("Received empty audio data from TTS")
              }

              console.log("✅ TTS: Successfully received audio data, size:", audioData.length, "bytes")

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
              }

              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(audioResponse))
                console.log("✅ Synthesized audio sent with SIP session ID!")
              } else {
                console.log("❌ WebSocket not open, cannot send audio")
              }
            } catch (error) {
              console.log("❌ TTS synthesis failed:", error.message)
            }
          } else if (data.type === "start_stt") {
            console.log("🎙️ STT service start requested (explicitly)")

            if (data.session_id) {
              sessionId = data.session_id
              console.log("🆔 Using SIP-provided session ID:", sessionId)
            }

            if (!deepgramConnected) {
              console.log("🎙️ Connecting to Deepgram for STT...")
              try {
                await connectToDeepgram({
                  language: data.language || language,
                  model: "nova-2",
                  punctuate: true,
                  diarize: false,
                  tier: "enhanced",
                })
                console.log("✅ Deepgram connection established for STT")

                if (audioBuffer.length > 0) {
                  console.log(`🎵 Processing ${audioBuffer.length} buffered audio chunks`)
                  for (const audioData of audioBuffer) {
                    const pcmAudio = await convertToPCM(audioData)
                    queueAudioData(pcmAudio)
                  }
                  audioBuffer = []
                }

                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: "stt_started",
                      session_id: sessionId,
                      message: "Speech-to-text service activated",
                    }),
                  )
                }
              } catch (error) {
                console.log("❌ Failed to initialize Deepgram:", error.message)
              }
            } else {
              console.log("✅ Deepgram already connected")
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "stt_ready",
                    session_id: sessionId,
                    message: "Speech-to-text service already active",
                  }),
                )
              }
            }
          } else if (data.type === "stop_stt") {
            console.log("🎙️ STT service stop requested")
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
            console.log(`📞 Hangup request received for session_id: ${data.data.session_id}`)
            ws.close(1000, "Hangup requested by Voicebot")
          } else if (data.data && data.data.stream_stop === "true") {
            console.log(`🛑 Stream stop request received for session_id: ${data.data.session_id}`)
            closeDeepgram()
          } else {
            console.log("❓ Unknown message type or missing required fields:", data.type || data.event, data)
          }
        } else {
          const pcmAudio = await convertToPCM(message)

          const hasVoice = detectVoiceActivity(pcmAudio)

          saveAudioChunk(pcmAudio, hasVoice)

          if (audioFiles.length >= MAX_AUDIO_FILES) {
            await processAccumulatedAudio()
          }

          if (hasVoice) {
            if (deepgramConnected && deepgramReady) {
              queueAudioData(pcmAudio)
            } else {
              audioBuffer.push(pcmAudio)

              if (audioBuffer.length > MAX_BUFFER_SIZE) {
                audioBuffer.shift()
                console.log(`⚠️ Audio buffer overflow, removed oldest chunk. Current size: ${audioBuffer.length}`)
              }
            }
          }
        }
      } catch (error) {
        console.log("❌ Error processing message:", error.message)
      }
    })

    ws.on("close", () => {
      console.log("🔗 Unified voice connection closed")
      console.log("📊 Final Session Statistics:")
      console.log(`   SIP data received: ${sipDataReceived} messages`)
      console.log(`   Audio chunks processed: ${audioChunkCount}`)
      console.log(`   Session ID: ${sessionId || "Not set"}`)
      console.log(`   Conversation history length: ${fullConversationHistory.length}`)

      // Final performance summary
      logPerformanceMetrics()

      try {
        const files = fs.readdirSync(AUDIO_FILES_DIR)
        for (const file of files) {
          fs.unlinkSync(path.join(AUDIO_FILES_DIR, file))
        }
        console.log(`🧹 Cleaned up ${files.length} audio files`)
      } catch (error) {
        console.log("⚠️ Failed to clean up audio files:", error.message)
      }

      closeDeepgram()
      resetSilenceTimer()

      // Reset all variables
      sessionId = null
      audioChunkCount = 0
      audioBuffer = []
      audioQueue = []
      deepgramReady = false
      deepgramConnected = false
      isProcessingQueue = false
      connectionGreetingSent = false
      sipDataReceived = 0
      currentTranscript = ""
      emptyAudioCount = 0
      isSpeaking = false
      audioFiles = []
      audioFileIndex = 0
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
