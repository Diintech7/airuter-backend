const WebSocket = require("ws")
const { SarvamStreamingClient } = require("./sarvamStreaming")

const setupWebSocketServer = (wss) => {
  console.log("WebSocket server initialized with Sarvam AI")

  wss.on("connection", async (ws) => {
    console.log("New WebSocket connection established")

    ws.on("message", async (message) => {
      console.log("\n=== New Synthesis Request ===")
      try {
        const data = JSON.parse(message)
        console.log("Received message data:", JSON.stringify(data, null, 2))

        if (!process.env.SARVAM_API_KEY) {
          console.error("Error: Sarvam AI API key not configured")
          throw new Error("Sarvam AI API key is not configured")
        }

        console.log("Initializing Sarvam AI client...")
        const sarvamClient = new SarvamStreamingClient(process.env.SARVAM_API_KEY)

        // Sarvam AI voice options
        const supportedSpeakers = ["meera", "aditi", "kabir", "raghav", "arjun"]
        const requestedSpeaker = data.speaker || "meera"
        const speaker = supportedSpeakers.includes(requestedSpeaker) ? requestedSpeaker : "meera"

        if (speaker !== requestedSpeaker) {
          console.warn(`Requested speaker "${requestedSpeaker}" not supported, using "${speaker}" instead`)
        }

        const synthesisOptions = {
          language_code: data.language_code || "en-IN",
          speaker: speaker,
          pitch: data.pitch || 0,
          pace: data.pace || 1.0,
          loudness: data.loudness || 1.0,
          speech_sample_rate: data.speech_sample_rate || 22050,
          enable_preprocessing: data.enable_preprocessing || true,
          model: data.model || "bulbul:v1"
        }

        console.log("Final synthesis options:", JSON.stringify(synthesisOptions, null, 2))

        console.log("Starting audio synthesis with Sarvam AI...")
        const audioData = await sarvamClient.synthesize(data.text, synthesisOptions)

        if (!audioData || audioData.length === 0) {
          console.error("Error: Received empty audio data")
          throw new Error("Received empty audio data from Sarvam AI")
        }

        const audioBuffer = Buffer.from(audioData)
        const chunkSize = 16384
        const totalChunks = Math.ceil(audioBuffer.length / chunkSize)

        console.log(`\nStreaming audio data:`)
        console.log(`Total audio size: ${audioBuffer.length} bytes`)
        console.log(`Chunk size: ${chunkSize} bytes`)
        console.log(`Number of chunks: ${totalChunks}`)

        for (let i = 0; i < audioBuffer.length; i += chunkSize) {
          const chunk = audioBuffer.slice(i, i + chunkSize)
          const chunkNumber = Math.floor(i / chunkSize) + 1

          console.log(`Sending chunk ${chunkNumber}/${totalChunks} (${chunk.length} bytes)`)

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(chunk)
          } else {
            console.warn("WebSocket connection closed while streaming")
            break
          }
        }

        if (ws.readyState === WebSocket.OPEN) {
          console.log("Streaming complete, sending end signal")
          ws.send(JSON.stringify({ type: "end" }))
        }

        console.log("=== Request Complete ===\n")
      } catch (error) {
        console.error("Error during processing:", error)
        if (ws.readyState === WebSocket.OPEN) {
          const errorMessage = {
            type: "error",
            error: error.message,
            details: "Speech synthesis failed with Sarvam AI",
          }
          console.error("Sending error to client:", errorMessage)
          ws.send(JSON.stringify(errorMessage))
        }
      }
    })

    ws.on("close", () => {
      console.log("WebSocket connection closed")
    })
  })
}

module.exports = { setupWebSocketServer }