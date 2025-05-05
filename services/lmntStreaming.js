const WebSocket = require('ws');

class LMNTStreamingClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.ws = null;
    this.connected = false;
  }

  connect(options = {}) {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket('wss://api.lmnt.com/v1/ai/speech/stream');

        this.ws.onopen = () => {
          console.log('Connected to LMNT WebSocket server');
          
          const config = {
            'X-API-Key': this.apiKey,
            voice: options.voice || 'lily',
            format: options.format || 'mp3',
            sample_rate: options.sample_rate || 16000,
            speed: options.speed || 1.0,
            return_extras: true,
            conversational: options.conversational || true
          };

          this.ws.send(JSON.stringify(config));
          this.connected = true;
          resolve();
        };

        this.ws.onerror = (error) => {
          console.error('LMNT WebSocket connection error:', error);
          this.connected = false;
          reject(error);
        };

        this.ws.onclose = () => {
          console.log('LMNT WebSocket connection closed');
          this.connected = false;
        };
      } catch (error) {
        console.error('Error establishing LMNT WebSocket connection:', error);
        reject(error);
      }
    });
  }

  async synthesize(text, onAudioData, onExtras) {
    if (!this.ws || !this.connected) {
      throw new Error('WebSocket connection not established');
    }

    return new Promise((resolve, reject) => {
      try {
        // Set up message handler
        this.ws.onmessage = (event) => {
          if (typeof event.data === 'string') {
            try {
              const extras = JSON.parse(event.data);
              if (extras.error) {
                reject(new Error(extras.error));
                return;
              }
              if (onExtras) onExtras(extras);
              if (extras.buffer_empty) {
                resolve();
              }
            } catch (e) {
              console.error('Error parsing extras:', e);
            }
          } else {
            onAudioData(event.data);
          }
        };

        // Split text into smaller chunks for more responsive streaming
        const chunks = this.splitTextIntoChunks(text);
        
        // Send text chunks
        chunks.forEach((chunk) => {
          this.ws.send(JSON.stringify({ text: chunk }));
        });

        // Force flush after each chunk
        this.ws.send(JSON.stringify({ flush: true }));

      } catch (error) {
        reject(error);
      }
    });
  }

  splitTextIntoChunks(text, maxChunkLength = 100) {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const chunks = [];
    let currentChunk = '';

    sentences.forEach(sentence => {
      if (currentChunk.length + sentence.length <= maxChunkLength) {
        currentChunk += sentence;
      } else {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = sentence;
      }
    });

    if (currentChunk) chunks.push(currentChunk);
    return chunks;
  }

  close() {
    if (this.ws && this.connected) {
      try {
        this.ws.send(JSON.stringify({ eof: true }));
        this.ws.close();
      } catch (error) {
        console.error('Error closing LMNT WebSocket connection:', error);
      }
    }
    this.connected = false;
  }
}

module.exports = { LMNTStreamingClient };