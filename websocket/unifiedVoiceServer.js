const WebSocket = require('ws');
const { DeepgramClient } = require('./deepgramClient');
const { LMNTStreamingClient } = require('./lmntStreaming');

class UnifiedVoiceHandler {
  constructor(ws, options = {}) {
    this.ws = ws;
    this.deepgramClient = null;
    this.lmntClient = null;
    this.isProcessingAudio = false;
    this.audioQueue = [];
    this.isInitialized = false;
    this.deepgramReady = false;
    this.config = {
      language: options.language || 'hi',
      voice: options.voice || 'lily',
      model: options.model || 'nova-2',
      speed: parseFloat(options.speed) || 1.0,
      autoResponse: options.autoResponse === 'true',
      ...options
    };

    console.log('UnifiedVoiceHandler: Initializing with config:', this.config);
    this.initialize();
  }

  async initialize() {
    try {
      console.log('UnifiedVoiceHandler: Starting initialization...');
      
      // Initialize Deepgram
      await this.initializeDeepgram();
      
      // Initialize LMNT
      await this.initializeLMNT();
      
      this.isInitialized = true;
      this.sendMessage({
        type: 'ready',
        message: 'Voice handler initialized successfully',
        config: this.config,
        features: {
          stt: this.deepgramReady,
          tts: !!this.lmntClient
        }
      });
      console.log('UnifiedVoiceHandler: Initialization complete');
    } catch (error) {
      console.error('UnifiedVoiceHandler: Initialization error:', error);
      this.sendError('Failed to initialize voice handler', error.message);
      this.isInitialized = false;
    }
  }

  async initializeDeepgram() {
    try {
      const deepgramApiKey = process.env.DEEPGRAM_API_KEY || 'b40137a84624ef9677285b9c9feb3d1f3e576417';
      console.log('UnifiedVoiceHandler: Creating Deepgram client...');
      
      this.deepgramClient = new DeepgramClient(deepgramApiKey);
      
      this.deepgramClient.onTranscript = (transcript) => {
        console.log('UnifiedVoiceHandler: Received transcript from Deepgram:', transcript);
        this.handleTranscript(transcript);
      };

      console.log('UnifiedVoiceHandler: Connecting to Deepgram with options:', {
        language: this.config.language,
        model: this.config.model
      });
      
      await this.deepgramClient.connect({
        language: this.config.language,
        model: this.config.model,
        punctuate: true,
        diarize: false,
        tier: 'enhanced',
        interim_results: true,
        sample_rate: 16000,
        channels: 1
      });

      // Wait a bit to ensure connection is fully established
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Check connection state
      if (this.deepgramClient.ws && this.deepgramClient.ws.readyState === WebSocket.OPEN) {
        this.deepgramReady = true;
        console.log('UnifiedVoiceHandler: Deepgram connected and ready');
      } else {
        throw new Error('Deepgram connection not established properly');
      }

    } catch (error) {
      console.error('UnifiedVoiceHandler: Deepgram initialization error:', error);
      this.deepgramReady = false;
      throw error;
    }
  }

  async initializeLMNT() {
    try {
      const lmntApiKey = process.env.LMNT_API_KEY;
      if (lmntApiKey) {
        console.log('UnifiedVoiceHandler: Initializing LMNT client...');
        this.lmntClient = new LMNTStreamingClient(lmntApiKey);
        console.log('UnifiedVoiceHandler: LMNT client initialized');
      } else {
        console.warn('UnifiedVoiceHandler: LMNT API key not found, TTS will not be available');
      }
    } catch (error) {
      console.error('UnifiedVoiceHandler: LMNT initialization error:', error);
      // Don't throw here, TTS is optional
    }
  }

  handleMessage(message) {
    try {
      if (!this.isInitialized) {
        console.warn('UnifiedVoiceHandler: Handler not initialized, queuing message');
        // Queue the message for later processing
        setTimeout(() => this.handleMessage(message), 500);
        return;
      }

      if (Buffer.isBuffer(message)) {
        console.log('UnifiedVoiceHandler: Received binary audio data, size:', message.length);
        this.handleAudioData(message);
        return;
      }

      if (message instanceof ArrayBuffer) {
        console.log('UnifiedVoiceHandler: Received ArrayBuffer audio data, size:', message.byteLength);
        this.handleAudioData(Buffer.from(message));
        return;
      }

      let data;
      if (typeof message === 'string') {
        data = JSON.parse(message);
      } else {
        data = JSON.parse(message.toString());
      }

      console.log('UnifiedVoiceHandler: Received text command:', data.type);
      this.handleTextCommand(data);
      
    } catch (parseError) {
      console.log('UnifiedVoiceHandler: JSON parse failed, treating as audio data');
      this.handleAudioData(message);
    }
  }

  handleTextCommand(data) {
    console.log('UnifiedVoiceHandler: Processing command:', data.type);
    switch (data.type) {
      case 'speak':
        if (!data.text || data.text.trim().length === 0) {
          this.sendError('Invalid text', 'Text cannot be empty');
          return;
        }
        this.synthesizeSpeech(data.text, data.options || {});
        break;
        
      case 'config':
        this.updateConfig(data.config || {});
        break;
        
      case 'stop_audio':
        this.stopCurrentAudio();
        break;
        
      case 'clear_queue':
        this.clearAudioQueue();
        break;
        
      case 'ping':
        this.sendMessage({ type: 'pong', timestamp: Date.now() });
        break;
        
      case 'reconnect_deepgram':
        this.reconnectDeepgram();
        break;
        
      default:
        console.warn('UnifiedVoiceHandler: Unknown command type:', data.type);
        this.sendError('Unknown command', `Command type '${data.type}' not recognized`);
    }
  }

  async reconnectDeepgram() {
    try {
      console.log('UnifiedVoiceHandler: Reconnecting Deepgram...');
      
      if (this.deepgramClient) {
        this.deepgramClient.close();
      }
      
      this.deepgramReady = false;
      await this.initializeDeepgram();
      
      this.sendMessage({
        type: 'deepgram_reconnected',
        message: 'Deepgram reconnected successfully'
      });
      
    } catch (error) {
      console.error('UnifiedVoiceHandler: Deepgram reconnection failed:', error);
      this.sendError('Deepgram reconnection failed', error.message);
    }
  }

  handleAudioData(audioData) {
    if (!this.deepgramClient) {
      console.error('UnifiedVoiceHandler: Deepgram client not initialized');
      this.sendError('STT not available', 'Deepgram client not initialized');
      return;
    }

    if (!this.deepgramReady) {
      console.error('UnifiedVoiceHandler: Deepgram not ready');
      this.sendError('STT not ready', 'Deepgram connection not established');
      return;
    }

    // Check connection state before sending
    if (!this.deepgramClient.ws || this.deepgramClient.ws.readyState !== WebSocket.OPEN) {
      console.error('UnifiedVoiceHandler: Deepgram WebSocket not open, attempting reconnection');
      this.reconnectDeepgram();
      return;
    }

    try {
      const buffer = Buffer.isBuffer(audioData) ? audioData : Buffer.from(audioData);
      
      console.log('UnifiedVoiceHandler: Sending audio to Deepgram, size:', buffer.length);
      this.deepgramClient.sendAudio(buffer);
      
    } catch (error) {
      console.error('UnifiedVoiceHandler: Error processing audio data:', error);
      this.sendError('Audio processing failed', error.message);
      
      // Try to reconnect on error
      this.reconnectDeepgram();
    }
  }

  handleTranscript(transcript) {
    console.log('UnifiedVoiceHandler: Processing transcript:', transcript);
    if (!transcript || typeof transcript !== 'string' || transcript.trim().length === 0) {
      console.log('UnifiedVoiceHandler: Empty or invalid transcript, skipping');
      return;
    }

    const cleanTranscript = transcript.trim();
    this.sendMessage({
      type: 'transcript',
      data: cleanTranscript,
      language: this.config.language,
      timestamp: Date.now()
    });

    console.log('UnifiedVoiceHandler: Transcript sent to client:', cleanTranscript);
    if (this.config.autoResponse && cleanTranscript) {
      console.log('UnifiedVoiceHandler: Auto-response enabled, generating response...');
      this.generateAutoResponse(cleanTranscript);
    }
  }

  async generateAutoResponse(transcript) {
    try {
      console.log('UnifiedVoiceHandler: Generating auto-response for:', transcript);
      const responses = {
        hi: [
          `आपने कहा: ${transcript}`,
          `मैं समझ गया: ${transcript}`,
          `धन्यवाद, आपका संदेश मिला: ${transcript}`,
          `आपका संदेश प्राप्त हुआ: ${transcript}`
        ],
        en: [
          `You said: ${transcript}`,
          `I understood: ${transcript}`,
          `Thank you, I received: ${transcript}`,
          `I heard you say: ${transcript}`
        ]
      };

      const responseList = responses[this.config.language] || responses.en;
      const response = responseList[Math.floor(Math.random() * responseList.length)];

      console.log('UnifiedVoiceHandler: Generated auto-response:', response);
      await this.synthesizeSpeech(response, { isAutoResponse: true });

    } catch (error) {
      console.error('UnifiedVoiceHandler: Auto-response error:', error);
      this.sendError('Auto-response failed', error.message);
    }
  }

  async synthesizeSpeech(text, options = {}) {
    if (!this.lmntClient) {
      this.sendError('TTS not available', 'LMNT client not initialized');
      return;
    }

    if (!text || text.trim().length === 0) {
      this.sendError('Invalid text', 'Text cannot be empty');
      return;
    }

    try {
      console.log('UnifiedVoiceHandler: Starting speech synthesis for:', text);
      const synthesisOptions = {
        voice: options.voice || this.config.voice,
        language: options.language || this.config.language,
        speed: options.speed || this.config.speed,
        format: 'mp3',
        sample_rate: 16000
      };

      console.log('UnifiedVoiceHandler: Synthesis options:', synthesisOptions);
      this.sendMessage({
        type: 'synthesis_start',
        text: text,
        options: synthesisOptions,
        isAutoResponse: options.isAutoResponse || false
      });

      const audioData = await this.lmntClient.synthesize(text, synthesisOptions);
      
      if (!audioData || audioData.length === 0) {
        throw new Error('Received empty audio data from LMNT');
      }

      console.log('UnifiedVoiceHandler: Received audio data from LMNT, size:', audioData.length);

      await this.streamAudioData(audioData, options);

    } catch (error) {
      console.error('UnifiedVoiceHandler: Speech synthesis error:', error);
      this.sendError('Speech synthesis failed', error.message);
    }
  }

  async streamAudioData(audioData, options = {}) {
    const audioBuffer = Buffer.from(audioData);
    const chunkSize = options.chunkSize || 8192;
    const totalChunks = Math.ceil(audioBuffer.length / chunkSize);
    
    console.log(`UnifiedVoiceHandler: Streaming ${audioBuffer.length} bytes in ${totalChunks} chunks`);

    try {
      this.sendMessage({
        type: 'audio_start',
        totalBytes: audioBuffer.length,
        totalChunks: totalChunks,
        isAutoResponse: options.isAutoResponse || false
      });

      for (let i = 0; i < audioBuffer.length; i += chunkSize) {
        if (this.ws.readyState !== WebSocket.OPEN) {
          console.warn('UnifiedVoiceHandler: WebSocket closed during streaming');
          break;
        }

        const chunk = audioBuffer.slice(i, i + chunkSize);
        const chunkNumber = Math.floor(i / chunkSize) + 1;
        
        // Send as binary data
        this.ws.send(chunk);
        
        console.log(`UnifiedVoiceHandler: Sent chunk ${chunkNumber}/${totalChunks}, size: ${chunk.length}`);
        
        if (options.streamDelay && options.streamDelay > 0) {
          await new Promise(resolve => setTimeout(resolve, options.streamDelay));
        }
      }

      this.sendMessage({
        type: 'audio_end',
        totalBytes: audioBuffer.length,
        totalChunks: totalChunks,
        isAutoResponse: options.isAutoResponse || false
      });

      console.log('UnifiedVoiceHandler: Audio streaming complete');
      
    } catch (error) {
      console.error('UnifiedVoiceHandler: Error during audio streaming:', error);
      this.sendError('Audio streaming failed', error.message);
    }
  }

  updateConfig(newConfig) {
    console.log('UnifiedVoiceHandler: Updating config from:', this.config, 'to:', newConfig);
    
    const oldLanguage = this.config.language;
    this.config = { ...this.config, ...newConfig };
    
    console.log('UnifiedVoiceHandler: Config updated:', this.config);
    
    this.sendMessage({
      type: 'config_updated',
      config: this.config
    });

    // If language changed, reconnect Deepgram
    if (newConfig.language && newConfig.language !== oldLanguage) {
      console.log('UnifiedVoiceHandler: Language changed, reconnecting Deepgram...');
      this.reconnectDeepgram();
    }
  }

  stopCurrentAudio() {
    console.log('UnifiedVoiceHandler: Stopping current audio playback');
    this.sendMessage({
      type: 'audio_stopped',
      message: 'Current audio playback stopped'
    });
  }

  clearAudioQueue() {
    this.audioQueue = [];
    console.log('UnifiedVoiceHandler: Audio queue cleared');
    this.sendMessage({
      type: 'queue_cleared',
      message: 'Audio queue cleared'
    });
  }

  sendMessage(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const message = JSON.stringify(data);
        this.ws.send(message);
        console.log('UnifiedVoiceHandler: Sent message:', data.type);
      } catch (error) {
        console.error('UnifiedVoiceHandler: Error sending message:', error);
      }
    } else {
      console.warn('UnifiedVoiceHandler: Cannot send message, WebSocket not open', 
        this.ws ? this.ws.readyState : 'null');
    }
  }

  sendError(message, details = null) {
    console.error('UnifiedVoiceHandler: Sending error:', message, details);
    this.sendMessage({
      type: 'error',
      error: message,
      details: details,
      timestamp: Date.now()
    });
  }

  cleanup() {
    console.log('UnifiedVoiceHandler: Cleaning up resources');
    
    this.isInitialized = false;
    this.deepgramReady = false;
    
    if (this.deepgramClient) {
      try {
        this.deepgramClient.close();
        console.log('UnifiedVoiceHandler: Deepgram client closed');
      } catch (error) {
        console.error('UnifiedVoiceHandler: Error closing Deepgram client:', error);
      }
      this.deepgramClient = null;
    }
    
    this.lmntClient = null;
    this.audioQueue = [];
    
    console.log('UnifiedVoiceHandler: Cleanup complete');
  }

  // Health check method
  getStatus() {
    return {
      initialized: this.isInitialized,
      deepgramReady: this.deepgramReady,
      deepgramState: this.deepgramClient?.ws?.readyState || null,
      lmntAvailable: !!this.lmntClient,
      config: this.config
    };
  }
}

const setupUnifiedVoiceServer = (wss) => {
  console.log('Setting up Unified Voice WebSocket server...');

  wss.on('connection', (ws, req) => {
    console.log('New unified voice connection established from:', req.socket.remoteAddress);
    const url = new URL(req.url, 'http://localhost');
    const options = {
      language: url.searchParams.get('language') || 'hi',
      voice: url.searchParams.get('voice') || 'lily',
      model: url.searchParams.get('model') || 'nova-2',
      speed: url.searchParams.get('speed') || '1.0',
      autoResponse: url.searchParams.get('autoResponse') || 'false',
      chunkSize: parseInt(url.searchParams.get('chunkSize')) || 8192,
      streamDelay: parseInt(url.searchParams.get('streamDelay')) || 0
    };

    console.log('UnifiedVoiceServer: Connection options:', options);

    const voiceHandler = new UnifiedVoiceHandler(ws, options);

    ws.on('message', (message) => {
      try {
        voiceHandler.handleMessage(message);
      } catch (error) {
        console.error('UnifiedVoiceServer: Error handling message:', error);
        voiceHandler.sendError('Message processing failed', error.message);
      }
    });

    ws.on('error', (error) => {
      console.error('UnifiedVoiceServer: WebSocket error:', error);
      if (voiceHandler) {
        voiceHandler.sendError('WebSocket error', error.message);
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`UnifiedVoiceServer: Connection closed with code ${code}, reason: ${reason}`);
      if (voiceHandler) {
        voiceHandler.cleanup();
      }
    });

    // Send connection established message after initialization
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'connection_established',
          message: 'Voice server connection established',
          timestamp: Date.now()
        }));
      }
    }, 1000);

    // Health check endpoint via WebSocket
    ws.on('message', (message) => {
      try {
        if (typeof message === 'string') {
          const data = JSON.parse(message);
          if (data.type === 'health_check') {
            ws.send(JSON.stringify({
              type: 'health_status',
              status: voiceHandler.getStatus(),
              timestamp: Date.now()
            }));
          }
        }
      } catch (error) {
        // Ignore parsing errors for binary data
      }
    });
  });

  console.log('Unified Voice WebSocket server setup complete');
};

module.exports = { setupUnifiedVoiceServer, UnifiedVoiceHandler };