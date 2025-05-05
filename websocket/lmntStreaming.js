class LMNTStreamingClient {
  constructor(apiKey) {
    if (!apiKey) throw new Error('LMNT API key is required');
    this.apiKey = apiKey;
  }

  async synthesize(text, options = {}) {
    const form = new FormData();
    form.append("text", text);
    form.append("voice", options.voice || 'lily');
    form.append("conversational", "true");
    form.append("format", "mp3");
    form.append("language", options.language || 'hi');
    form.append("sample_rate", "16000");
    form.append("speed", options.speed?.toString() || "1");

    const response = await fetch('https://api.lmnt.com/v1/ai/speech/bytes', {
      method: 'POST',
      headers: { 'X-API-Key': this.apiKey },
      body: form
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { error: errorText };
      }
      throw new Error(`LMNT API error: ${response.status} - ${errorData.error || 'Unknown error'}`);
    }

    const audioBuffer = await response.arrayBuffer();
    return Buffer.from(audioBuffer);
  }
}

module.exports = { LMNTStreamingClient };