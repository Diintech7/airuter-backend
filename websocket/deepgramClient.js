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
  }

  async connect(options = {}) {
    console.log('DeepgramClient: Connecting with options:', JSON.stringify(options));
    
    try {
      // Create live transcription connection
      this.connection = this.deepgram.listen.live({
        language: options.language || 'en-US',
        model: options.model || 'nova-2',
        encoding: options.encoding || 'linear16',
        sample_rate: parseInt(options.sample_rate) || 16000,
        channels: parseInt(options.channels) || 1,
        punctuate: options.punctuate !== undefined ? options.punctuate : true,
        interim_results: options.interim_results !== undefined ? options.interim_results : false,
        smart_format: options.smart_format !== undefined ? options.smart_format : true,
        endpointing: options.endpointing || 300,
        vad_events: options.vad_events !== undefined ? options.vad_events : false
      });

      // Set up event handlers
      this.connection.on(LiveTranscriptionEvents.Open, () => {
        console.log('DeepgramClient: Connection opened successfully');
        this.isConnected = true;
      });

      this.connection.on(LiveTranscriptionEvents.Transcript, (data) => {
        console.log('DeepgramClient: Received transcript data:', data);
        
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (transcript && transcript.trim() && this.onTranscript) {
          console.log('DeepgramClient: Found transcript:', transcript);
          this.onTranscript(transcript);
        }
      });

      this.connection.on(LiveTranscriptionEvents.Error, (error) => {
        console.error('DeepgramClient: Error event:', error);
        this.isConnected = false;
        if (this.onError) {
          this.onError(error);
        }
      });

      this.connection.on(LiveTranscriptionEvents.Close, (event) => {
        console.log('DeepgramClient: Connection closed:', event);
        this.isConnected = false;
      });

      this.connection.on(LiveTranscriptionEvents.Metadata, (data) => {
        console.log('DeepgramClient: Received metadata:', data);
      });

      console.log('DeepgramClient: Connection setup complete');
      return Promise.resolve();

    } catch (error) {
      console.error('DeepgramClient: Failed to create connection:', error);
      this.isConnected = false;
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
      console.error('DeepgramClient: Cannot send audio - not connected');
      return false;
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
    if (this.connection && this.isConnected) {
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