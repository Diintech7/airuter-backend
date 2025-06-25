const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

class DeepgramClient {
  constructor(apiKey) {
    console.log('DeepgramClient: Initializing with official Deepgram SDK');
    this.apiKey = apiKey;
    this.deepgram = createClient(apiKey);
    this.connection = null;
    this.onTranscript = null;
    this.onError = null;
    this.isConnected = false;
    this.connectionTimeout = null;
  }

  async connect(options = {}) {
    console.log('DeepgramClient: Connecting with options:', JSON.stringify(options));
    
    try {
      // Clear any existing connection
      if (this.connection) {
        this.close();
      }

      // Simplified options for better compatibility
      const connectionOptions = {
        language: options.language || 'en-US',
        model: 'nova-2', // Use stable model
        encoding: 'linear16',
        sample_rate: 16000, // Use number instead of string
        channels: 1, // Use number instead of string
        punctuate: true,
        interim_results: false,
        smart_format: true
      };

      console.log('DeepgramClient: Creating connection with simplified options:', connectionOptions);

      // Create live transcription connection
      this.connection = this.deepgram.listen.live(connectionOptions);

      // Set up connection timeout
      this.connectionTimeout = setTimeout(() => {
        if (!this.isConnected) {
          console.error('DeepgramClient: Connection timeout after 10 seconds');
          if (this.onError) {
            this.onError(new Error('Connection timeout'));
          }
        }
      }, 10000);

      // Set up event handlers
      this.connection.on(LiveTranscriptionEvents.Open, () => {
        console.log('DeepgramClient: Connection opened successfully');
        this.isConnected = true;
        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
          this.connectionTimeout = null;
        }
      });

      this.connection.on(LiveTranscriptionEvents.Transcript, (data) => {
        console.log('DeepgramClient: Received transcript data:', JSON.stringify(data, null, 2));
        
        try {
          const transcript = data.channel?.alternatives?.[0]?.transcript;
          if (transcript && transcript.trim() && this.onTranscript) {
            console.log('DeepgramClient: Found transcript:', transcript);
            this.onTranscript(transcript);
          }
        } catch (error) {
          console.error('DeepgramClient: Error processing transcript:', error);
        }
      });

      this.connection.on(LiveTranscriptionEvents.Error, (error) => {
        console.error('DeepgramClient: Error event:', error);
        this.isConnected = false;
        
        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
          this.connectionTimeout = null;
        }
        
        if (this.onError) {
          // Provide more specific error message
          const errorMessage = error.message || error.type || 'Unknown Deepgram error';
          this.onError(new Error(`Deepgram connection failed: ${errorMessage}`));
        }
      });

      this.connection.on(LiveTranscriptionEvents.Close, (event) => {
        console.log('DeepgramClient: Connection closed:', event);
        this.isConnected = false;
        
        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
          this.connectionTimeout = null;
        }
      });

      this.connection.on(LiveTranscriptionEvents.Metadata, (data) => {
        console.log('DeepgramClient: Received metadata (connection confirmed):', data);
      });

      console.log('DeepgramClient: Connection setup complete, waiting for open event...');
      return Promise.resolve();

    } catch (error) {
      console.error('DeepgramClient: Failed to create connection:', error);
      this.isConnected = false;
      
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }
      
      if (this.onError) {
        this.onError(error);
      }
      throw error;
    }
  }

  sendAudio(audioData) {
    if (!this.connection) {
      console.error('DeepgramClient: Cannot send audio - connection not initialized');
      return false;
    }
    
    if (!this.isConnected) {
      console.warn('DeepgramClient: Sending audio while not fully connected (may still work)');
    }
    
    try {
      const buffer = audioData instanceof Buffer ? audioData : Buffer.from(audioData);
      console.log('DeepgramClient: Sending audio data, size:', buffer.length, 'bytes');
      this.connection.send(buffer);
      return true;
    } catch (error) {
      console.error('DeepgramClient: Error sending audio data:', error);
      return false;
    }
  }

  finishAudio() {
    if (this.connection) {
      try {
        console.log('DeepgramClient: Finishing audio stream');
        this.connection.finish();
      } catch (error) {
        console.error('DeepgramClient: Error finishing audio stream:', error);
      }
    }
  }

  close() {
    console.log('DeepgramClient: Closing connection');
    this.isConnected = false;
    
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    
    if (this.connection) {
      try {
        this.connection.finish();
        console.log('DeepgramClient: Connection closed successfully');
      } catch (error) {
        console.error('DeepgramClient: Error closing connection:', error);
      }
      this.connection = null;
    }
  }

  isReady() {
    return this.isConnected && this.connection;
  }
}

module.exports = { DeepgramClient };