// unifiedVoiceServer.js
const WebSocket = require('ws');
const { DeepgramClient } = require('./deepgramClient');
const { LMNTStreamingClient } = require('./lmntStreaming');

class UnifiedVoiceSession {
  constructor(ws, options = {}) {
    this.ws = ws;
    this.deepgramClient = null;
    this.lmntClient = null;
    this.sessionId = Math.random().toString(36).substring(7);
    this.language = options.language || 'hi';
    this.voice = options.voice || 'lily';
    this.isProcessing = false;
    
    console.log(`[${this.sessionId}] New voice session created - Language: ${this.language}, Voice: ${this.voice}`);
    
    this.initialize();
  }

  async initialize() {
    try {
      // Initialize Deepgram client
      this.deepgramClient = new DeepgramClient(process.env.DEEPGRAM_API_KEY);
      
      // Set up transcript callback
      this.deepgramClient.onTranscript = (transcript) => {
        this.handleTranscript(transcript);
      };

      // Connect to Deepgram
      await this.deepgramClient.connect({
        language: this.language,
        model: 'nova-2',
        punctuate: true,
        diarize: false,
        tier: 'enhanced',
        interim_results: true
      });

      // Initialize LMNT client
      this.lmntClient = new LMNTStreamingClient(process.env.LMNT_API_KEY);

      console.log(`[${this.sessionId}] Voice session initialized successfully`);
      
      // Send ready signal to client
      this.sendMessage({
        type: 'ready',
        sessionId: this.sessionId,
        message: 'Voice session ready'
      });

    } catch (error) {
      console.error(`[${this.sessionId}] Failed to initialize voice session:`, error);
      this.sendMessage({
        type: 'error',
        error: 'Failed to initialize voice session',
        details: error.message
      });
    }
  }

  handleTranscript(transcript) {
    if (!transcript || !transcript.trim()) return;
    
    console.log(`[${this.sessionId}] Transcript received: "${transcript}"`);
    
    // Send transcript to client
    this.sendMessage({
      type: 'transcript',
      data: transcript,
      language: this.language,
      timestamp: new Date().toISOString()
    });

    // Process transcript for response (you can customize this logic)
    this.processTranscriptForResponse(transcript);
  }

  async processTranscriptForResponse(transcript) {
    if (this.isProcessing) {
      console.log(`[${this.sessionId}] Already processing, skipping transcript: "${transcript}"`);
      return;
    }

    this.isProcessing = true;

    try {
      // Send processing status
      this.sendMessage({
        type: 'processing',
        message: 'Generating response...'
      });

      // Generate response text (customize this based on your needs)
      const responseText = await this.generateResponse(transcript);
      
      if (responseText && responseText.trim()) {
        // Send response text to client
        this.sendMessage({
          type: 'response',
          text: responseText,
          timestamp: new Date().toISOString()
        });

        // Generate and stream audio
        await this.generateAndStreamAudio(responseText);
      }

    } catch (error) {
      console.error(`[${this.sessionId}] Error processing transcript:`, error);
      this.sendMessage({
        type: 'error',
        error: 'Failed to process transcript',
        details: error.message
      });
    } finally {
      this.isProcessing = false;
    }
  }

  async generateResponse(transcript) {
    // Simple echo response for testing - customize this with your AI logic
    // You can integrate with OpenAI, Claude, or any other AI service here
    
    // Example responses based on language
    if (this.language === 'hi') {
      return `आपने कहा: "${transcript}"। मैं आपकी मदद कैसे कर सकता हूं?`;
    } else {
      return `You said: "${transcript}". How can I help you?`;
    }
  }

  async generateAndStreamAudio(text) {
    try {
      console.log(`[${this.sessionId}] Generating audio for: "${text}"`);
      
      // Send audio generation start signal
      this.sendMessage({
        type: 'audio_start',
        message: 'Generating audio...'
      });

      const audioData = await this.lmntClient.synthesize(text, {
        voice: this.voice,
        language: this.language,
        speed: 1.0
      });

      if (!audioData || audioData.length === 0) {
        throw new Error('Empty audio data received');
      }

      // Stream audio in chunks
      const audioBuffer = Buffer.from(audioData);
      const chunkSize = 16384; // 16KB chunks
      const totalChunks = Math.ceil(audioBuffer.length / chunkSize);

      console.log(`[${this.sessionId}] Streaming ${audioBuffer.length} bytes in ${totalChunks} chunks`);

      for (let i = 0; i < audioBuffer.length; i += chunkSize) {
        const chunk = audioBuffer.slice(i, i + chunkSize);
        const chunkNumber = Math.floor(i / chunkSize) + 1;

        if (this.ws.readyState === WebSocket.OPEN) {
          // Send audio chunk as binary data
          this.ws.send(chunk);
          console.log(`[${this.sessionId}] Sent audio chunk ${chunkNumber}/${totalChunks}`);
        } else {
          console.warn(`[${this.sessionId}] WebSocket closed while streaming audio`);
          break;
        }
      }

      // Send audio end signal
      this.sendMessage({
        type: 'audio_end',
        message: 'Audio streaming complete'
      });

      console.log(`[${this.sessionId}] Audio streaming completed`);

    } catch (error) {
      console.error(`[${this.sessionId}] Error generating audio:`, error);
      this.sendMessage({
        type: 'error',
        error: 'Failed to generate audio',
        details: error.message
      });
    }
  }

  handleAudioData(audioData) {
    if (!this.deepgramClient) {
      console.error(`[${this.sessionId}] Deepgram client not initialized`);
      return;
    }

    try {
      this.deepgramClient.sendAudio(audioData);
    } catch (error) {
      console.error(`[${this.sessionId}] Error sending audio to Deepgram:`, error);
    }
  }

  handleTextMessage(message) {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'config':
          this.updateConfig(data);
          break;
        case 'text_to_speech':
          this.generateAndStreamAudio(data.text);
          break;
        case 'ping':
          this.sendMessage({ type: 'pong', timestamp: new Date().toISOString() });
          break;
        default:
          console.log(`[${this.sessionId}] Unknown message type: ${data.type}`);
      }
    } catch (error) {
      console.error(`[${this.sessionId}] Error handling text message:`, error);
    }
  }

  updateConfig(config) {
    if (config.language && config.language !== this.language) {
      this.language = config.language;
      console.log(`[${this.sessionId}] Language updated to: ${this.language}`);
    }
    
    if (config.voice && config.voice !== this.voice) {
      this.voice = config.voice;
      console.log(`[${this.sessionId}] Voice updated to: ${this.voice}`);
    }

    this.sendMessage({
      type: 'config_updated',
      language: this.language,
      voice: this.voice
    });
  }

  sendMessage(message) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  cleanup() {
    console.log(`[${this.sessionId}] Cleaning up voice session`);
    
    if (this.deepgramClient) {
      this.deepgramClient.close();
      this.deepgramClient = null;
    }
    
    this.lmntClient = null;
    this.isProcessing = false;
  }
}

const setupUnifiedVoiceServer = (wss) => {
  console.log('Unified Voice WebSocket server initialized');

  wss.on('connection', (ws, req) => {
    console.log('New unified voice connection established');
    
    // Parse query parameters
    const url = new URL(req.url, 'http://localhost');
    const language = url.searchParams.get('language') || 'hi';
    const voice = url.searchParams.get('voice') || 'lily';
    
    // Create voice session
    const voiceSession = new UnifiedVoiceSession(ws, { language, voice });

    ws.on('message', (message) => {
      try {
        // Check if message is binary (audio data) or text
        if (message instanceof Buffer) {
          // Handle audio data
          voiceSession.handleAudioData(message);
        } else {
          // Handle text message
          voiceSession.handleTextMessage(message.toString());
        }
      } catch (error) {
        console.error('Error handling message:', error);
        voiceSession.sendMessage({
          type: 'error',
          error: 'Message handling failed',
          details: error.message
        });
      }
    });

    ws.on('close', () => {
      console.log('Unified voice connection closed');
      voiceSession.cleanup();
    });

    ws.on('error', (error) => {
      console.error('Unified voice WebSocket error:', error);
      voiceSession.cleanup();
    });
  });
};

module.exports = { setupUnifiedVoiceServer, UnifiedVoiceSession };