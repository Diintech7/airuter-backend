const WebSocket = require('ws');

class DeepgramClient {
  constructor(apiKey) {
    console.log('DeepgramClient: Initializing with API key');
    this.apiKey = apiKey;
    this.ws = null;
    this.onTranscript = null;
  }

  connect(options = {}) {
    console.log('DeepgramClient: Connecting with options:', JSON.stringify(options));
    return new Promise((resolve, reject) => {
      try {
        // Build URL with query parameters matching the desired format
        const wsUrl = new URL('wss://api.deepgram.com/v1/listen');
        wsUrl.searchParams.append('sample_rate', '16000');
        wsUrl.searchParams.append('channels', '1');
        wsUrl.searchParams.append('interim_results', 'true');
        wsUrl.searchParams.append('language', options.language || 'hi');
        wsUrl.searchParams.append('model', 'nova-2');

        console.log('DeepgramClient: Connecting to URL:', wsUrl.toString());
        
        // Connect with token in WebSocket protocol array
        this.ws = new WebSocket(wsUrl.toString(), ['token', this.apiKey]);

        this.ws.binaryType = 'arraybuffer';
        
        this.ws.onopen = () => {
          console.log('DeepgramClient: WebSocket connection established successfully');
          resolve();
        };

        this.ws.onmessage = (event) => {
          console.log('DeepgramClient: Received message from Deepgram');
          try {
            // Check if event.data is a string or needs conversion
            const rawData = typeof event.data === 'string' ? event.data : 
                          Buffer.from(event.data).toString();
            console.log('DeepgramClient: Raw message data:', rawData);
            
            const data = JSON.parse(rawData);
            console.log('DeepgramClient: Parsed data:', JSON.stringify(data));
            
            if (data.channel?.alternatives?.[0]?.transcript) {
              const transcript = data.channel.alternatives[0].transcript;
              console.log('DeepgramClient: Found transcript:', transcript);
              if (transcript.trim() && this.onTranscript) {
                console.log('DeepgramClient: Calling onTranscript with:', transcript);
                this.onTranscript(transcript);
              } else {
                console.log('DeepgramClient: Transcript empty or onTranscript not set');
              }
            } else {
              console.log('DeepgramClient: No transcript in response');
            }
          } catch (parseError) {
            console.error('DeepgramClient: Error parsing Deepgram message:', parseError);
            console.error('DeepgramClient: Raw message type:', typeof event.data);
            // If it's binary data, log its size
            if (event.data instanceof ArrayBuffer) {
              console.error('DeepgramClient: Binary data size:', event.data.byteLength);
            }
          }
        };

        this.ws.onerror = (error) => {
          console.error('DeepgramClient: WebSocket error:', error);
          reject(error);
        };

        this.ws.onclose = (event) => {
          console.log(`DeepgramClient: Connection closed with code ${event.code}, reason: ${event.reason}`);
        };

      } catch (error) {
        console.error('DeepgramClient: Error during setup:', error);
        reject(error);
      }
    });
  }

  sendAudio(audioData) {
    if (!this.ws) {
      console.error('DeepgramClient: Cannot send audio - WebSocket not initialized');
      return;
    }
    
    if (this.ws.readyState !== WebSocket.OPEN) {
      console.error('DeepgramClient: Cannot send audio - WebSocket not open, current state:', this.ws.readyState);
      return;
    }
    
    try {
      const buffer = audioData instanceof Buffer ? audioData : Buffer.from(audioData);
      console.log('DeepgramClient: Sending audio data, size:', buffer.length, 'bytes');
      this.ws.send(buffer);
    } catch (error) {
      console.error('DeepgramClient: Error sending audio data:', error);
    }
  }

  close() {
    console.log('DeepgramClient: Closing connection');
    if (this.ws) {
      try {
        this.ws.close();
        console.log('DeepgramClient: WebSocket closed successfully');
      } catch (error) {
        console.error('DeepgramClient: Error closing WebSocket:', error);
      }
    } else {
      console.log('DeepgramClient: No WebSocket to close');
    }
  }
}

module.exports = { DeepgramClient };