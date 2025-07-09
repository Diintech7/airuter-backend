class SarvamStreamingClient {
    constructor(apiKey) {
      if (!apiKey) throw new Error("Sarvam AI API key is required")
      this.apiKey = apiKey
      this.baseURL = "https://api.sarvam.ai"
    }
  
    async synthesize(text, options = {}) {
      const requestBody = {
        inputs: [text],
        target_language_code: options.language_code || "en-IN",
        speaker: options.speaker || "meera",
        pitch: options.pitch || 0,
        pace: options.pace || 1.0,
        loudness: options.loudness || 1.0,
        speech_sample_rate: options.speech_sample_rate || 22050,
        enable_preprocessing: options.enable_preprocessing || true,
        model: options.model || "bulbul:v1"
      }
  
      console.log("Sarvam AI Request:", {
        text: text.substring(0, 100) + "...",
        language_code: options.language_code || "en-IN",
        speaker: options.speaker || "meera",
        model: options.model || "bulbul:v1",
        pace: options.pace || 1.0,
      })
  
      const response = await fetch(`${this.baseURL}/text-to-speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "API-Subscription-Key": this.apiKey,
        },
        body: JSON.stringify(requestBody),
      })
  
      if (!response.ok) {
        const errorText = await response.text()
        let errorData
        try {
          errorData = JSON.parse(errorText)
        } catch {
          errorData = { error: errorText }
        }
  
        console.error("Sarvam AI API Error:", {
          status: response.status,
          error: errorData.error || "Unknown error",
          requestOptions: options,
        })
  
        throw new Error(`Sarvam AI API error: ${response.status} - ${errorData.error || "Unknown error"}`)
      }
  
      const responseData = await response.json()
      
      if (!responseData.audios || responseData.audios.length === 0) {
        throw new Error("No audio data received from Sarvam AI")
      }
  
      // Convert base64 audio to buffer
      const audioBase64 = responseData.audios[0]
      const audioBuffer = Buffer.from(audioBase64, 'base64')
      
      console.log(`Sarvam AI synthesis successful: ${audioBuffer.byteLength} bytes`)
      return audioBuffer
    }
  
    async transcribe(audioFile, options = {}) {
      const formData = new FormData()
      formData.append('file', audioFile)
      formData.append('model', options.model || 'saarika:v2.5')
      formData.append('language_code', options.language_code || 'hi-IN')
  
      console.log("Sarvam AI Transcription Request:", {
        model: options.model || 'saarika:v2.5',
        language_code: options.language_code || 'hi-IN',
        fileSize: audioFile.size
      })
  
      const response = await fetch(`${this.baseURL}/speech-to-text`, {
        method: "POST",
        headers: {
          "API-Subscription-Key": this.apiKey,
        },
        body: formData,
      })
  
      if (!response.ok) {
        const errorText = await response.text()
        let errorData
        try {
          errorData = JSON.parse(errorText)
        } catch {
          errorData = { error: errorText }
        }
  
        console.error("Sarvam AI Transcription Error:", {
          status: response.status,
          error: errorData.error || "Unknown error",
        })
  
        throw new Error(`Sarvam AI transcription error: ${response.status} - ${errorData.error || "Unknown error"}`)
      }
  
      const responseData = await response.json()
      console.log("Sarvam AI transcription successful:", responseData.transcript)
      return responseData.transcript
    }
  }
  
  module.exports = { SarvamStreamingClient }