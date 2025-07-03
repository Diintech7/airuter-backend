class LMNTStreamingClient {
  constructor(apiKey) {
    if (!apiKey) throw new Error("LMNT API key is required")
    this.apiKey = apiKey
  }

  async synthesize(text, options = {}) {
    const form = new FormData()
    form.append("text", text)
    form.append("voice", options.voice || "lily")
    form.append("conversational", "true")
    form.append("format", "mp3")

    // Handle language parameter properly
    if (options.language && options.language !== "en") {
      // For non-English languages, let LMNT handle the text but use English voice
      console.log(`Processing ${options.language} text with voice: ${options.voice || "lily"}`)
    }

    form.append("sample_rate", "16000")
    form.append("speed", options.speed?.toString() || "1")

    console.log("LMNT Request:", {
      text: text.substring(0, 100) + "...",
      voice: options.voice || "lily",
      language: options.language || "en",
      speed: options.speed || 1,
    })

    const response = await fetch("https://api.lmnt.com/v1/ai/speech/bytes", {
      method: "POST",
      headers: { "X-API-Key": this.apiKey },
      body: form,
    })

    if (!response.ok) {
      const errorText = await response.text()
      let errorData
      try {
        errorData = JSON.parse(errorText)
      } catch {
        errorData = { error: errorText }
      }

      console.error("LMNT API Error:", {
        status: response.status,
        error: errorData.error || "Unknown error",
        requestOptions: options,
      })

      throw new Error(`LMNT API error: ${response.status} - ${errorData.error || "Unknown error"}`)
    }

    const audioBuffer = await response.arrayBuffer()
    console.log(`LMNT synthesis successful: ${audioBuffer.byteLength} bytes`)
    return Buffer.from(audioBuffer)
  }
}

module.exports = { LMNTStreamingClient }
