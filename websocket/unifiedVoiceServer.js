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
    let audioBuffer = [] // Buffer for audio before Deepgram is connected
    let deepgramConnected = false

    let audioFiles = []
    let audioFileIndex = 0
    const MAX_AUDIO_FILES = 60 // Number of audio chunks to accumulate before sending to Deepgram
    const AUDIO_FILES_DIR = path.join(__dirname, "audio_chunks")

    if (!fs.existsSync(AUDIO_FILES_DIR)) {
      fs.mkdirSync(AUDIO_FILES_DIR, { recursive: true })
    }

    const vadState = {
      isSpeaking: false,
      silenceCount: 0,
      speechCount: 0,
      lastAudioLevel: 0,
      SILENCE_THRESHOLD: 5, // Number of consecutive silent chunks
      SPEECH_THRESHOLD: 3, // Number of consecutive speech chunks
      AUDIO_LEVEL_THRESHOLD: 0.01, // Minimum audio level to consider as speech
    }

    let audioQueue = []
    let isProcessingQueue = false
    let lastSentTime = 0
    const MIN_SEND_INTERVAL = 250 // Minimum 250ms between sends to Deepgram
    const MAX_QUEUE_SIZE = 50 // Maximum queued audio chunks
    const MAX_BUFFER_SIZE = 100 // Maximum buffered audio chunks before Deepgram connects
    let reconnectAttempts = 0
    const MAX_RECONNECT_ATTEMPTS = 5
    let reconnectDelay = 1000 // Start with 1 second

    const lmntApiKey = process.env.LMNT_API_KEY

    let sessionId = null
    let audioChunkCount = 0
    let connectionGreetingSent = false
    let sipDataReceived = 0

    let currentTranscript = ""
    let emptyAudioCount = 0
    const SILENCE_THRESHOLD = 1500 // Number of consecutive empty/non-final Deepgram results to trigger TTS
    let isSpeaking = false // Flag to track if user is actively speaking

    const url = new URL(req.url, "http://localhost")
    const language = url.searchParams.get("language") || "en"

    console.log(`🌐 Connection established with language: ${language}`)
    console.log(`🔑 TTS API Key configured: ${lmntApiKey ? "Yes (" + lmntApiKey.substring(0, 8) + "...)" : "❌ NO"}`)

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
      const audioLevel = rms / 32768.0 // Normalize to 0-1 range

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
        } else {
          console.log(`💾 Audio saved: ${filename} (${audioWithHeader.length} bytes) - SILENT`)
        }

        if (audioFiles.length > MAX_AUDIO_FILES) {
          const oldFile = audioFiles.shift()
          try {
            fs.unlinkSync(oldFile.filepath)
            console.log(`🗑️ Deleted old audio file: ${oldFile.filename}`)
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
            console.log(`⚠️ Failed to remove empty audio file: ${fileInfo.filename}, error: ${error.message}`)
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
            const audioData = fileBuffer.slice(44) // Skip WAV header (44 bytes)
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

        audioFiles = [] // Clear processed files
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
        hi: "नमस्ते! हैलो, Aitota से संपर्क करने के लिए धन्यवाद।",
        en: "Hi! Hello, thank you for contacting Aitota.",
        es: "¡Hola! Gracias por contactar con Aitota.",
        fr: "Bonjour ! Merci de contacter Aitota.",
        de: "Hallo! Danke, dass Sie Aitota kontaktiert haben.",
        it: "Ciao! Grazie per aver contattato Aitota.",
        pt: "Olá! Obrigado por entrar em contato com a Aitota.",
        ja: "こんにちは！Aitota にご連絡いただきありがとうございます。",
        ko: "안녕하세요! Aitota에 연락해 주셔서 감사합니다。",
        zh: "你好！感谢您联系 Aitota。",
        ar: "مرحبًا! شكرًا لتواصلك مع Aitota.",
        ru: "Привет! Спасибо, что обратились в Aitota.",
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
          speed: 1.0,
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
        await new Promise((resolve) => setTimeout(resolve, 50))
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
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
        return false
      }
    }

    const queueAudioData = async (audioData) => {
      if (audioQueue.length >= MAX_QUEUE_SIZE) {
        console.log(
          `⚠️ Audio queue full (${MAX_QUEUE_SIZE} chunks). Sending current queue to Deepgram and skipping new chunk.`,
        )
        await processAudioQueue()
        audioQueue = []
        return
      }

      audioQueue.push(audioData)
      console.log(`🎵 Audio queued: ${audioData.length} bytes, current queue size: ${audioQueue.length}`)

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
          deepgramUrl.searchParams.append("endpointing", "300")

          deepgramWs = new WebSocket(deepgramUrl.toString(), ["token", process.env.DEEPGRAM_API_KEY])

          deepgramWs.binaryType = "arraybuffer"

          const connectionTimeout = setTimeout(() => {
            if (deepgramWs) {
              deepgramWs.close()
            }
            reject(new Error("STT connection timeout"))
          }, 15000)

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
            try {
              const rawData = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString()
              const data = JSON.parse(rawData)

              if (data.type === "Results") {
                if (data.channel?.alternatives?.[0]?.transcript) {
                  const transcript = data.channel.alternatives[0].transcript
                  const confidence = data.channel.alternatives[0].confidence
                  const is_final = data.is_final

                  if (transcript.trim()) {
                    currentTranscript += (currentTranscript ? " " : "") + transcript.trim()
                    emptyAudioCount = 0
                    isSpeaking = true
                    // Display the text from Deepgram in console log
                    console.log("📝 Deepgram Transcript:", currentTranscript)

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
                      console.log(`🔇 Silence detected (${SILENCE_THRESHOLD} empty chunks). Triggering TTS.`)
                      isSpeaking = false
                      await processUserUtterance()
                    }
                  }
                }
              } else if (data.type === "SpeechStarted") {
                console.log("🎙️ STT: Speech started detected")
                isSpeaking = true
                emptyAudioCount = 0
              } else if (data.type === "UtteranceEnd") {
                console.log("🎙️ STT: Utterance end detected. Triggering TTS.")
                if (isSpeaking) {
                  isSpeaking = false
                  await processUserUtterance()
                }
              }
            } catch (parseError) {
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
                const delay = Math.min(reconnectDelay * Math.pow(2, reconnectAttempts - 1), 30000)
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
      console.log("🔊 TTS: Starting synthesis for text:", text.substring(0, 100) + "...")

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
              console.log(`✅ TTS: Audio fetched from URL, size: ${audioBuffer.byteLength} bytes`)
              return Buffer.from(audioBuffer)
            } else if (jsonResponse.audio) {
              const audioBuffer = Buffer.from(jsonResponse.audio, "base64")
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

            console.log(`✅ TTS: Successfully got audio from ${attempt.name}, size: ${audioBuffer.byteLength} bytes`)
            return Buffer.from(audioBuffer)
          }
        } catch (error) {
          console.log(`❌ TTS: ${attempt.name} failed:`, error.message)

          if (attempt === apiAttempts[apiAttempts.length - 1]) {
            throw error
          }
          continue
        }
      }

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

    const processUserUtterance = async () => {
      if (currentTranscript.trim()) {
        console.log("🧠 Processing user utterance:", currentTranscript)
        const responseText = `You said: "${currentTranscript}". How can I help you further?`
        try {
          const synthesisOptions = {
            voice: "lily",
            language: language === "en" ? "en" : "hi",
            speed: 1.0,
          }
          const audioData = await synthesizeWithErrorHandling(responseText, synthesisOptions)

          if (!audioData || audioData.length === 0) {
            throw new Error("Received empty audio data from TTS for response")
          }

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

          console.log("📤 Sending synthesized response audio back to SIP client.")
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(audioResponse))
            console.log("✅ Synthesized response audio sent!")
          }
        } catch (error) {
          console.log("❌ Failed to synthesize and send response audio:", error.message)
        }
      } else {
        console.log("🤷 No transcript to process for TTS response.")
      }
      currentTranscript = ""
      emptyAudioCount = 0
      isSpeaking = false
      console.log("📝 Transcript and state reset for next utterance.")
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
            }, 500)
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
                speed: data.speed || 1.0,
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
                console.log(
                  `⚠️ Audio buffer overflow, removed oldest chunk (before STT connected). Current size: ${audioBuffer.length}`,
                )
              }
            }
          } else {
            console.log("🔇 Skipping silent audio chunk for Deepgram.")
          }
        }
      } catch (error) {
        console.log("❌ Error processing message:", error.message)
      }
    })

    ws.on("close", () => {
      console.log("🔗 Unified voice connection closed")
      console.log("📊 Session statistics:")
      console.log(`   SIP data received: ${sipDataReceived} messages`)
      console.log(`   Audio chunks processed: ${audioChunkCount}`)
      console.log(`   Session ID: ${sessionId || "Not set"}`)

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
    })

    ws.on("error", (error) => {
      console.log("❌ WebSocket connection error:", error.message)
    })

    console.log("✅ WebSocket connection confirmed, waiting for SIP 'start' event.")
  })
}

module.exports = { setupUnifiedVoiceServer }
