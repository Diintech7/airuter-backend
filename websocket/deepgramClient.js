const WebSocket = require('ws');

class DeepgramClient {
  constructor(apiKey) {
    console.log('DeepgramClient: Initializing with API key');
    this.apiKey = apiKey;
    this.ws = null;
    this.onTranscript = null;
    this.onError = null;
    this.keepAliveInterval = null;
    this.isConnected = false;
  }

  connect(options = {}) {
    console.log('DeepgramClient: Connecting with options:', JSON.stringify(options));
    return new Promise((resolve, reject) => {
      try {
        // Build URL with query parameters - FIXED FORMAT
        const wsUrl = new URL('wss://api.deepgram.com/v1/listen');
        
        // Add query parameters in the correct format
        const params = {
          encoding: options.encoding || 'linear16',
          sample_rate: options.sample_rate || '16000',
          channels: options.channels || '1',
          language: options.language || 'en-US',
          model: options.model || 'nova-2',
          punctuate: options.punctuate !== undefined ? options.punctuate.toString() : 'true',
          interim_results: options.interim_results !== undefined ? options.interim_results.toString() : 'false',
          smart_format: options.smart_format !== undefined ? options.smart_format.toString() : 'true'
        };

        // Add endpointing if specified
        if (options.endpointing !== undefined) {
          params.endpointing = options.endpointing.toString();
        }

        // Add VAD events if specified
        if (options.vad_events !== undefined) {
          params.vad_events = options.vad_events.toString();
        }

        // Build query string
        Object.keys(params).forEach(key => {
          wsUrl.searchParams.append(key, params[key]);
        });

        console.log('DeepgramClient: Connecting to URL:', wsUrl.toString());
        
        // FIXED: Use proper authentication format for Deepgram
        // Deepgram expects the API key in the Authorization header as "Token YOUR_API_KEY"
        const wsOptions = {
          headers: {
            'Authorization': `Token ${this.apiKey}`,
            'User-Agent': 'DeepgramNodeClient/1.0.0'
          }
        };
        
        console.log('DeepgramClient: Using headers:', {
          'Authorization': `Token ${this.apiKey.substring(0, 10)}...`,
          'User-Agent': 'DeepgramNodeClient/1.0.0'
        });
        
        this.ws = new WebSocket(wsUrl.toString(), wsOptions);
        this.ws.binaryType = 'arraybuffer';
        
        this.ws.onopen = () => {
          console.log('DeepgramClient: WebSocket connection established successfully');
          this.isConnected = true;
          
          // Start keep-alive mechanism
          this.startKeepAlive();
          
          resolve();
        };

        this.ws.onmessage = (event) => {
          console.log('DeepgramClient: Received message from Deepgram');
          try {
            // Parse the JSON response
            const data = JSON.parse(event.data);
            console.log('DeepgramClient: Parsed data:', JSON.stringify(data, null, 2));
            
            // Handle different message types
            if (data.type === 'Results') {
              // Standard transcription result
              const transcript = data.channel?.alternatives?.[0]?.transcript;
              if (transcript && transcript.trim() && this.onTranscript) {
                console.log('DeepgramClient: Found transcript:', transcript);
                this.onTranscript(transcript);
              }
            } else if (data.type === 'Metadata') {
              // Metadata message - connection successful
              console.log('DeepgramClient: Received metadata (connection confirmed):', data);
            } else if (data.type === 'Error') {
              // Error message
              console.error('DeepgramClient: Received error from Deepgram:', data);
              if (this.onError) {
                this.onError(new Error(data.description || 'Unknown Deepgram error'));
              }
            } else {
              console.log('DeepgramClient: Unknown message type:', data.type);
            }
            
          } catch (parseError) {
            console.error('DeepgramClient: Error parsing Deepgram message:', parseError);
            console.error('DeepgramClient: Raw message:', event.data);
          }
        };

        this.ws.onerror = (error) => {
          console.error('DeepgramClient: WebSocket error:', error);
          console.error('DeepgramClient: WebSocket readyState:', this.ws?.readyState);
          this.isConnected = false;
          if (this.onError) {
            this.onError(new Error(`WebSocket connection failed: ${error.message || 'Unknown error'}`));
          }
          reject(error);
        };

        this.ws.onclose = (event) => {
          console.log(`DeepgramClient: Connection closed with code ${event.code}, reason: ${event.reason}`);
          this.isConnected = false;
          this.stopKeepAlive();
          
          // If connection closed unexpectedly, trigger error
          if (event.code !== 1000 && this.onError) {
            this.onError(new Error(`Connection closed unexpectedly: ${event.code} - ${event.reason}`));
          }
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
      return false;
    }
    
    if (this.ws.readyState !== WebSocket.OPEN) {
      console.error('DeepgramClient: Cannot send audio - WebSocket not open, current state:', this.ws.readyState);
      return false;
    }
    
    try {
      // Ensure we're sending binary data
      const buffer = audioData instanceof Buffer ? audioData : Buffer.from(audioData);
      console.log('DeepgramClient: Sending audio data, size:', buffer.length, 'bytes');
      this.ws.send(buffer);
      return true;
    } catch (error) {
      console.error('DeepgramClient: Error sending audio data:', error);
      return false;
    }
  }

  // Send a text message (for control messages like keepalive)
  sendMessage(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('DeepgramClient: Cannot send message - WebSocket not ready');
      return false;
    }
    
    try {
      const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
      console.log('DeepgramClient: Sending text message:', messageStr);
      this.ws.send(messageStr);
      return true;
    } catch (error) {
      console.error('DeepgramClient: Error sending message:', error);
      return false;
    }
  }

  // Signal end of audio stream
  finishAudio() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('DeepgramClient: Cannot finish audio - WebSocket not ready');
      return;
    }
    
    try {
      // Send close stream message
      const closeMessage = JSON.stringify({ type: 'CloseStream' });
      console.log('DeepgramClient: Sending close stream message');
      this.ws.send(closeMessage);
    } catch (error) {
      console.error('DeepgramClient: Error finishing audio stream:', error);
    }
  }

  // Keep-alive mechanism - FIXED TIMING
  startKeepAlive() {
    // Send keep-alive every 5 seconds (more frequent to prevent timeout)
    this.keepAliveInterval = setInterval(() => {
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          const keepAliveMessage = JSON.stringify({ type: 'KeepAlive' });
          console.log('DeepgramClient: Sending keep-alive message');
          this.ws.send(keepAliveMessage);
        } catch (error) {
          console.error('DeepgramClient: Error sending keep-alive:', error);
        }
      }
    }, 5000); // Changed from 8000 to 5000
  }

  stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
      console.log('DeepgramClient: Keep-alive stopped');
    }
  }

  close() {
    console.log('DeepgramClient: Closing connection');
    this.isConnected = false;
    this.stopKeepAlive();
    
    if (this.ws) {
      try {
        // Send close stream message first
        if (this.ws.readyState === WebSocket.OPEN) {
          this.finishAudio();
          
          // Wait a bit before closing the connection
          setTimeout(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.close(1000, 'Normal closure');
            }
          }, 100);
        }
        
        console.log('DeepgramClient: WebSocket closed successfully');
      } catch (error) {
        console.error('DeepgramClient: Error closing WebSocket:', error);
      }
    } else {
      console.log('DeepgramClient: No WebSocket to close');
    }
  }

  // Check if the connection is ready
  isReady() {
    return this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

module.exports = { DeepgramClient };