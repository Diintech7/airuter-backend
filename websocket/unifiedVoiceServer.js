// unifiedVoiceServer.js - FIXED VERSION
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
    
    // Configuration from query params or defaults
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
      
      // Initialize Deepgram client
      const deepgramApiKey = process.env.DEEPGRAM_API_KEY || 'b40137a84624ef9677285b9c9feb3d1f3e576417';
      console.log('UnifiedVoiceHandler: Creating Deepgram client...');
      
      this.deepgramClient = new DeepgramClient(deepgramApiKey);
      
      // Set up transcript callback BEFORE connecting
      this.deepgramClient.onTranscript = (transcript) => {
        console.log('UnifiedVoiceHandler: Received transcript from Deepgram:', transcript);
        this.handleTranscript(transcript);
      };

      // Connect to Deepgram with proper options
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

      console.log('UnifiedVoiceHandler: Deepgram connected successfully');

      // Initialize LMNT client
      const lmntApiKey = process.env.LMNT_API_KEY;
      if (lmntApiKey) {
        console.log('UnifiedVoiceHandler: Initializing LMNT client...');
        this.lmntClient = new LMNTStreamingClient(lmntApiKey);
        console.log('UnifiedVoiceHandler: LMNT client initialized');
      } else {
        console.warn('UnifiedVoiceHandler: LMNT API key not found, TTS will not be available');
      }

      this.isInitialized = true;

      // Send ready signal to client
      this.sendMessage({
        type: 'ready',
        message: 'Voice handler initialized successfully',
        config: this.config,
        features: {
          stt: true,
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

  handleMessage(message) {
    try {
      if (!this.isInitialized) {
        console.warn('UnifiedVoiceHandler: Handler not initialized, ignoring message');
        return;
      }

      // Check if message is a Buffer (binary audio data)
      if (Buffer.isBuffer(message)) {
        console.log('UnifiedVoiceHandler: Received binary audio data, size:', message.length);
        this.handleAudioData(message);
        return;
      }

      // Check if message is ArrayBuffer (from frontend)
      if (message instanceof ArrayBuffer) {
        console.log('UnifiedVoiceHandler: Received ArrayBuffer audio data, size:', message.byteLength);
        this.handleAudioData(Buffer.from(message));
        return;
      }

      // Try to parse as JSON (text commands)
      let data;
      if (typeof message === 'string') {
        data = JSON.parse(message);
      } else {
        // Convert buffer to string and parse
        data = JSON.parse(message.toString());
      }
      
      console.log('UnifiedVoiceHandler: Received text command:', data.type);
      this.handleTextCommand(data);
      
    } catch (parseError) {
      // If JSON parsing fails, treat as binary audio data
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
        
      default:
        console.warn('UnifiedVoiceHandler: Unknown command type:', data.type);
        this.sendError('Unknown command', `Command type '${data.type}' not recognized`);
    }
  }

  handleAudioData(audioData) {
    if (!this.deepgramClient) {
      console.error('UnifiedVoiceHandler: Deepgram client not initialized');
      this.sendError('STT not available', 'Deepgram client not initialized');
      return;
    }

    if (!this.isInitialized) {
      console.error('UnifiedVoiceHandler: Handler not fully initialized');
      return;
    }

    try {
      // Ensure audioData is a Buffer
      const buffer = Buffer.isBuffer(audioData) ? audioData : Buffer.from(audioData);
      
      console.log('UnifiedVoiceHandler: Sending audio to Deepgram, size:', buffer.length);
      
      // Send audio data to Deepgram for transcription
      this.deepgramClient.sendAudio(buffer);
      
    } catch (error) {
      console.error('UnifiedVoiceHandler: Error processing audio data:', error);
      this.sendError('Audio processing failed', error.message);
    }
  }

  handleTranscript(transcript) {
    console.log('UnifiedVoiceHandler: Processing transcript:', transcript);
    
    // Validate transcript
    if (!transcript || typeof transcript !== 'string' || transcript.trim().length === 0) {
      console.log('UnifiedVoiceHandler: Empty or invalid transcript, skipping');
      return;
    }

    const cleanTranscript = transcript.trim();
    
    // Send transcript to client
    this.sendMessage({
      type: 'transcript',
      data: cleanTranscript,
      language: this.config.language,
      timestamp: Date.now()
    });

    console.log('UnifiedVoiceHandler: Transcript sent to client:', cleanTranscript);

    // Auto-response mode: automatically generate and speak a response
    if (this.config.autoResponse && cleanTranscript) {
      console.log('UnifiedVoiceHandler: Auto-response enabled, generating response...');
      this.generateAutoResponse(cleanTranscript);
    }
  }

  async generateAutoResponse(transcript) {
    try {
      console.log('UnifiedVoiceHandler: Generating auto-response for:', transcript);
      
      // Simple echo response - you can integrate with ChatGPT/Claude here
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

      // Send the auto-generated response for TTS
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

      // Merge options with config
      const synthesisOptions = {
        voice: options.voice || this.config.voice,
        language: options.language || this.config.language,
        speed: options.speed || this.config.speed,
        format: 'mp3',
        sample_rate: 16000
      };

      console.log('UnifiedVoiceHandler: Synthesis options:', synthesisOptions);

      // Send synthesis start notification
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
    const chunkSize = options.chunkSize || 8192; // Smaller chunks for better streaming
    const totalChunks = Math.ceil(audioBuffer.length / chunkSize);
    
    console.log(`UnifiedVoiceHandler: Streaming ${audioBuffer.length} bytes in ${totalChunks} chunks`);

    try {
      for (let i = 0; i < audioBuffer.length; i += chunkSize) {
        if (this.ws.readyState !== WebSocket.OPEN) {
          console.warn('UnifiedVoiceHandler: WebSocket closed during streaming');
          break;
        }

        const chunk = audioBuffer.slice(i, i + chunkSize);
        const chunkNumber = Math.floor(i / chunkSize) + 1;
        
        // Send audio chunk as binary data
        this.ws.send(chunk);
        
        console.log(`UnifiedVoiceHandler: Sent chunk ${chunkNumber}/${totalChunks}, size: ${chunk.length}`);
        
        // Optional: Add small delay between chunks to prevent overwhelming
        if (options.streamDelay && options.streamDelay > 0) {
          await new Promise(resolve => setTimeout(resolve, options.streamDelay));
        }
      }

      // Send end-of-stream signal
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
    
    this.config = { ...this.config, ...newConfig };
    
    console.log('UnifiedVoiceHandler: Config updated:', this.config);
    
    this.sendMessage({
      type: 'config_updated',
      config: this.config
    });

    // If language changed and Deepgram is connected, we might need to reconnect
    // For now, just log it - in production you might want to reconnect Deepgram
    if (newConfig.language && newConfig.language !== this.config.language) {
      console.log('UnifiedVoiceHandler: Language changed, consider reconnecting Deepgram for optimal results');
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
    if (this.ws.readyState === WebSocket.OPEN) {
      try {
        const message = JSON.stringify(data);
        this.ws.send(message);
        console.log('UnifiedVoiceHandler: Sent message:', data.type);
      } catch (error) {
        console.error('UnifiedVoiceHandler: Error sending message:', error);
      }
    } else {
      console.warn('UnifiedVoiceHandler: Cannot send message, WebSocket not open');
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
}

const setupUnifiedVoiceServer = (wss) => {
  console.log('Setting up Unified Voice WebSocket server...');

  wss.on('connection', (ws, req) => {
    console.log('New unified voice connection established from:', req.socket.remoteAddress);
    
    // Parse query parameters
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
      voiceHandler.sendError('WebSocket error', error.message);
    });

    ws.on('close', (code, reason) => {
      console.log(`UnifiedVoiceServer: Connection closed with code ${code}, reason: ${reason}`);
      voiceHandler.cleanup();
    });

    // Send initial ping to test connection
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        voiceHandler.sendMessage({
          type: 'connection_established',
          message: 'Voice server connection established',
          timestamp: Date.now()
        });
      }
    }, 1000);
  });

  console.log('Unified Voice WebSocket server setup complete');
};

module.exports = { setupUnifiedVoiceServer, UnifiedVoiceHandler };