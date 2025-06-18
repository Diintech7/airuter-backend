// unifiedVoiceServer.js
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
    
    // Configuration from query params or defaults
    this.config = {
      language: options.language || 'hi',
      voice: options.voice || 'lily',
      model: options.model || 'nova-2',
      speed: parseFloat(options.speed) || 1.0,
      autoResponse: options.autoResponse === 'true', // Enable auto-response mode
      ...options
    };

    console.log('UnifiedVoiceHandler: Initialized with config:', this.config);
    this.initialize();
  }

  async initialize() {
    try {
      // Initialize Deepgram client
      this.deepgramClient = new DeepgramClient(process.env.DEEPGRAM_API_KEY || 'b40137a84624ef9677285b9c9feb3d1f3e576417');
      
      // Set up transcript callback
      this.deepgramClient.onTranscript = (transcript) => {
        this.handleTranscript(transcript);
      };

      // Connect to Deepgram
      await this.deepgramClient.connect({
        language: this.config.language,
        model: this.config.model,
        punctuate: true,
        diarize: false,
        tier: 'enhanced'
      });

      // Initialize LMNT client
      if (process.env.LMNT_API_KEY) {
        this.lmntClient = new LMNTStreamingClient(process.env.LMNT_API_KEY);
      }

      // Send ready signal to client
      this.sendMessage({
        type: 'ready',
        message: 'Voice handler initialized successfully',
        config: this.config
      });

      console.log('UnifiedVoiceHandler: Initialization complete');

    } catch (error) {
      console.error('UnifiedVoiceHandler: Initialization error:', error);
      this.sendError('Failed to initialize voice handler', error.message);
    }
  }

  handleMessage(message) {
    try {
      // Try to parse as JSON first (text commands)
      const data = JSON.parse(message);
      this.handleTextCommand(data);
    } catch (parseError) {
      // If JSON parsing fails, treat as binary audio data
      this.handleAudioData(message);
    }
  }

  handleTextCommand(data) {
    console.log('UnifiedVoiceHandler: Received command:', data.type);

    switch (data.type) {
      case 'speak':
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
        
      default:
        console.warn('UnifiedVoiceHandler: Unknown command type:', data.type);
    }
  }

  handleAudioData(audioData) {
    if (!this.deepgramClient) {
      console.error('UnifiedVoiceHandler: Deepgram client not initialized');
      return;
    }

    // Send audio data to Deepgram for transcription
    this.deepgramClient.sendAudio(audioData);
  }

  handleTranscript(transcript) {
    console.log('UnifiedVoiceHandler: Transcript received:', transcript);
    
    // Send transcript to client
    this.sendMessage({
      type: 'transcript',
      data: transcript,
      language: this.config.language,
      timestamp: Date.now()
    });

    // Auto-response mode: automatically generate and speak a response
    if (this.config.autoResponse && transcript.trim()) {
      this.generateAutoResponse(transcript);
    }
  }

  async generateAutoResponse(transcript) {
    try {
      // Simple echo response - you can integrate with ChatGPT/Claude here
      const responses = {
        hi: [
          `आपने कहा: ${transcript}`,
          `मैं समझ गया: ${transcript}`,
          `धन्यवाद, आपका संदेश मिला: ${transcript}`
        ],
        en: [
          `You said: ${transcript}`,
          `I understood: ${transcript}`,
          `Thank you, I received: ${transcript}`
        ]
      };

      const responseList = responses[this.config.language] || responses.en;
      const response = responseList[Math.floor(Math.random() * responseList.length)];

      // Send the auto-generated response for TTS
      await this.synthesizeSpeech(response, { isAutoResponse: true });

    } catch (error) {
      console.error('UnifiedVoiceHandler: Auto-response error:', error);
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

      await this.streamAudioData(audioData, options);

    } catch (error) {
      console.error('UnifiedVoiceHandler: Speech synthesis error:', error);
      this.sendError('Speech synthesis failed', error.message);
    }
  }

  async streamAudioData(audioData, options = {}) {
    const audioBuffer = Buffer.from(audioData);
    const chunkSize = options.chunkSize || 16384;
    const totalChunks = Math.ceil(audioBuffer.length / chunkSize);
    
    console.log(`UnifiedVoiceHandler: Streaming ${audioBuffer.length} bytes in ${totalChunks} chunks`);

    for (let i = 0; i < audioBuffer.length; i += chunkSize) {
      if (this.ws.readyState !== WebSocket.OPEN) {
        console.warn('UnifiedVoiceHandler: WebSocket closed during streaming');
        break;
      }

      const chunk = audioBuffer.slice(i, i + chunkSize);
      const chunkNumber = Math.floor(i / chunkSize) + 1;
      
      // Send audio chunk
      this.ws.send(chunk);
      
      // Optional: Add small delay between chunks to prevent overwhelming
      if (options.streamDelay) {
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
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    console.log('UnifiedVoiceHandler: Config updated:', this.config);
    
    this.sendMessage({
      type: 'config_updated',
      config: this.config
    });
  }

  stopCurrentAudio() {
    // Implementation for stopping current audio playback
    this.sendMessage({
      type: 'audio_stopped',
      message: 'Current audio playback stopped'
    });
  }

  clearAudioQueue() {
    this.audioQueue = [];
    this.sendMessage({
      type: 'queue_cleared',
      message: 'Audio queue cleared'
    });
  }

  sendMessage(data) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  sendError(message, details = null) {
    this.sendMessage({
      type: 'error',
      error: message,
      details: details,
      timestamp: Date.now()
    });
  }

  cleanup() {
    console.log('UnifiedVoiceHandler: Cleaning up resources');
    
    if (this.deepgramClient) {
      this.deepgramClient.close();
      this.deepgramClient = null;
    }
    
    this.lmntClient = null;
    this.audioQueue = [];
  }
}

const setupUnifiedVoiceServer = (wss) => {
  console.log('Unified Voice WebSocket server initialized');

  wss.on('connection', (ws, req) => {
    console.log('New unified voice connection established');
    
    // Parse query parameters
    const url = new URL(req.url, 'http://localhost');
    const options = {
      language: url.searchParams.get('language') || 'hi',
      voice: url.searchParams.get('voice') || 'lily',
      model: url.searchParams.get('model') || 'nova-2',
      speed: url.searchParams.get('speed') || '1.0',
      autoResponse: url.searchParams.get('autoResponse') || 'false',
      chunkSize: parseInt(url.searchParams.get('chunkSize')) || 16384,
      streamDelay: parseInt(url.searchParams.get('streamDelay')) || 0
    };

    const voiceHandler = new UnifiedVoiceHandler(ws, options);

    ws.on('message', (message) => {
      voiceHandler.handleMessage(message);
    });

    ws.on('error', (error) => {
      console.error('Unified Voice WebSocket error:', error);
      voiceHandler.sendError('WebSocket error', error.message);
    });

    ws.on('close', () => {
      console.log('Unified voice connection closed');
      voiceHandler.cleanup();
    });
  });
};

module.exports = { setupUnifiedVoiceServer, UnifiedVoiceHandler };
