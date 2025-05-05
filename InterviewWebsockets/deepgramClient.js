const WebSocket = require('ws');

class DeepgramClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.ws = null;
    this.onTranscript = null;
    this.onError = null;
  }

  connect(options = {}) {
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = new URL('wss://api.deepgram.com/v1/listen');
        wsUrl.searchParams.append('model', 'nova-2');
        wsUrl.searchParams.append('version', 'latest');
        wsUrl.searchParams.append('sample_rate', '16000');
        wsUrl.searchParams.append('channels', '1');
        wsUrl.searchParams.append('interim_results', 'true');
        wsUrl.searchParams.append('language', options.language || 'en');
        wsUrl.searchParams.append('punctuate', 'true');

        this.ws = new WebSocket(wsUrl.toString(), {
          headers: {
            Authorization: `Token ${this.apiKey}`,
            'Content-Type': 'audio/wav'
          }
        });

        this.ws.binaryType = 'arraybuffer';
        
        this.ws.onopen = () => {
          console.log('Deepgram WebSocket connection opened');
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const data = typeof event.data === 'string' 
              ? JSON.parse(event.data) 
              : null;

            if (data && data.channel?.alternatives?.[0]?.transcript) {
              const transcript = data.channel.alternatives[0].transcript.trim();
              if (transcript && this.onTranscript) {
                this.onTranscript(transcript);
              }
            }
          } catch (parseError) {
            console.error('Error parsing Deepgram message:', parseError);
            if (this.onError) {
              this.onError(parseError);
            }
          }
        };

        this.ws.onerror = (error) => {
          console.error('Deepgram WebSocket error:', error);
          if (this.onError) {
            this.onError(error);
          }
        };

        this.ws.onclose = (event) => {
          console.log('Deepgram WebSocket connection closed:', event.code, event.reason);
        };

      } catch (error) {
        console.error('Deepgram connection error:', error);
        reject(error);
      }
    });
  }

  sendAudio(audioData) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const buffer = audioData instanceof Buffer 
          ? audioData 
          : Buffer.from(audioData);
        this.ws.send(buffer);
      } catch (error) {
        console.error('Error sending audio data:', error);
      }
    }
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

module.exports = { DeepgramClient };