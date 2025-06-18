const WebSocket = require('ws');
const { DeepgramClient } = require('./deepgramClient');
const { LMNTStreamingClient } = require('./lmntStreaming');

class UnifiedVoiceWebSocketServer {
  constructor() {
    this.deepgramClients = new Map();
    this.lmntClient = null;
    this.initializeLMNTClient();
  }

  initializeLMNTClient() {
    if (process.env.LMNT_API_KEY) {
      this.lmntClient = new LMNTStreamingClient(process.env.LMNT_API_KEY);
      console.log('LMNT client initialized successfully');
    } else {
      console.error('LMNT API key not found in environment variables');
    }
  }

  setupServer(wss) {
    console.log('Unified Voice WebSocket server initialized');

    wss.on('connection', (ws, req) => {
      console.log('New unified voice connection established');
      
      // Parse connection parameters
      const url = new URL(req.url, 'http://localhost');
      const connectionId = this.generateConnectionId();
      
      // Store connection metadata
      ws.connectionId = connectionId;
      ws.isTranscriptionActive = false;
      ws.language = url.searchParams.get('language') || 'hi';
      ws.voice = url.searchParams.get('voice') || 'lily';
      ws.model = url.searchParams.get('model') || 'nova-2';

      console.log(`Connection ${connectionId} established with params:`, {
        language: ws.language,
        voice: ws.voice,
        model: ws.model
      });

      // Send connection confirmation
      this.sendMessage(ws, {
        type: 'connection',
        status: 'connected',
        connectionId: connectionId,
        services: ['transcription', 'synthesis'],
        config: {
          language: ws.language,
          voice: ws.voice,
          model: ws.model
        }
      });

      ws.on('message', async (message) => {
        try {
          await this.handleMessage(ws, message);
        } catch (error) {
          console.error(`Error handling message for connection ${connectionId}:`, error);
          this.sendError(ws, 'Message processing failed', error.message);
        }
      });

      ws.on('close', () => {
        console.log(`Connection ${connectionId} closed`);
        this.cleanup(connectionId);
      });

      ws.on('error', (error) => {
        console.error(`WebSocket error for connection ${connectionId}:`, error);
        this.cleanup(connectionId);
      });
    });
  }

  async handleMessage(ws, message) {
    try {
      // Check if message is JSON (control message) or binary (audio data)
      if (this.isJsonMessage(message)) {
        const data = JSON.parse(message.toString());
        await this.handleControlMessage(ws, data);
      } else {
        // Binary audio data for transcription
        await this.handleAudioData(ws, message);
      }
    } catch (error) {
      console.error('Error in handleMessage:', error);
      this.sendError(ws, 'Message handling failed', error.message);
    }
  }

  isJsonMessage(message) {
    try {
      const str = message.toString();
      JSON.parse(str);
      return true;
    } catch {
      return false;
    }
  }

  async handleControlMessage(ws, data) {
    console.log(`Control message for ${ws.connectionId}:`, data.type);

    switch (data.type) {
      case 'start_transcription':
        await this.startTranscription(ws, data);
        break;

      case 'stop_transcription':
        await this.stopTranscription(ws);
        break;

      case 'synthesize_speech':
        await this.synthesizeSpeech(ws, data);
        break;

      case 'update_config':
        await this.updateConfig(ws, data);
        break;

      case 'ping':
        this.sendMessage(ws, { type: 'pong', timestamp: Date.now() });
        break;

      default:
        console.warn(`Unknown control message type: ${data.type}`);
        this.sendError(ws, 'Unknown message type', `Type '${data.type}' is not supported`);
    }
  }

  async startTranscription(ws, config = {}) {
    try {
      if (ws.isTranscriptionActive) {
        console.log(`Transcription already active for ${ws.connectionId}`);
        return;
      }

      console.log(`Starting transcription for ${ws.connectionId}`);

      const deepgramClient = new DeepgramClient(process.env.DEEPGRAM_API_KEY);
      
      // Set up transcript callback
      deepgramClient.onTranscript = (transcript) => {
        if (transcript && transcript.trim()) {
          console.log(`Transcript from ${ws.connectionId}:`, transcript);
          this.sendMessage(ws, {
            type: 'transcript',
            data: transcript,
            language: ws.language,
            timestamp: Date.now()
          });
        }
      };

      // Connect to Deepgram
      await deepgramClient.connect({
        language: config.language || ws.language,
        model: config.model || ws.model,
        punctuate: true,
        diarize: false,
        tier: 'enhanced'
      });

      // Store the client
      this.deepgramClients.set(ws.connectionId, deepgramClient);
      ws.isTranscriptionActive = true;

      this.sendMessage(ws, {
        type: 'transcription_started',
        status: 'active',
        config: {
          language: ws.language,
          model: ws.model
        }
      });

      console.log(`Transcription started successfully for ${ws.connectionId}`);

    } catch (error) {
      console.error(`Failed to start transcription for ${ws.connectionId}:`, error);
      this.sendError(ws, 'Transcription start failed', error.message);
    }
  }

  async stopTranscription(ws) {
    try {
      const deepgramClient = this.deepgramClients.get(ws.connectionId);
      if (deepgramClient) {
        deepgramClient.close();
        this.deepgramClients.delete(ws.connectionId);
        ws.isTranscriptionActive = false;

        this.sendMessage(ws, {
          type: 'transcription_stopped',
          status: 'inactive'
        });

        console.log(`Transcription stopped for ${ws.connectionId}`);
      }
    } catch (error) {
      console.error(`Error stopping transcription for ${ws.connectionId}:`, error);
      this.sendError(ws, 'Transcription stop failed', error.message);
    }
  }

  async handleAudioData(ws, audioData) {
    if (!ws.isTranscriptionActive) {
      console.warn(`Received audio data but transcription not active for ${ws.connectionId}`);
      return;
    }

    const deepgramClient = this.deepgramClients.get(ws.connectionId);
    if (deepgramClient) {
      deepgramClient.sendAudio(audioData);
      console.log(`Audio data sent to Deepgram for ${ws.connectionId}, size: ${audioData.length} bytes`);
    } else {
      console.error(`No Deepgram client found for ${ws.connectionId}`);
    }
  }

  async synthesizeSpeech(ws, data) {
    try {
      if (!this.lmntClient) {
        throw new Error('LMNT client not initialized');
      }

      if (!data.text || !data.text.trim()) {
        throw new Error('Text is required for speech synthesis');
      }

      console.log(`Starting speech synthesis for ${ws.connectionId}:`, {
        text: data.text.substring(0, 100) + (data.text.length > 100 ? '...' : ''),
        voice: data.voice || ws.voice,
        language: data.language || ws.language
      });

      this.sendMessage(ws, {
        type: 'synthesis_started',
        status: 'processing'
      });

      const synthesisOptions = {
        voice: data.voice || ws.voice,
        language: data.language || ws.language,
        speed: data.speed || 1.0
      };

      console.log(`Synthesis options for ${ws.connectionId}:`, synthesisOptions);

      const audioData = await this.lmntClient.synthesize(data.text, synthesisOptions);

      if (!audioData || audioData.length === 0) {
        throw new Error('Received empty audio data from LMNT');
      }

      await this.streamAudioToClient(ws, audioData);

      console.log(`Speech synthesis completed for ${ws.connectionId}`);

    } catch (error) {
      console.error(`Speech synthesis failed for ${ws.connectionId}:`, error);
      this.sendError(ws, 'Speech synthesis failed', error.message);
    }
  }

  async streamAudioToClient(ws, audioData) {
    const audioBuffer = Buffer.from(audioData);
    const chunkSize = 16384; // 16KB chunks
    const totalChunks = Math.ceil(audioBuffer.length / chunkSize);

    console.log(`Streaming audio to ${ws.connectionId}:`, {
      totalSize: audioBuffer.length,
      chunkSize: chunkSize,
      totalChunks: totalChunks
    });

    this.sendMessage(ws, {
      type: 'audio_stream_start',
      totalSize: audioBuffer.length,
      totalChunks: totalChunks
    });

    for (let i = 0; i < audioBuffer.length; i += chunkSize) {
      if (ws.readyState !== WebSocket.OPEN) {
        console.warn(`Connection ${ws.connectionId} closed during streaming`);
        break;
      }

      const chunk = audioBuffer.slice(i, i + chunkSize);
      const chunkNumber = Math.floor(i / chunkSize) + 1;

      // Send audio chunk as binary data
      ws.send(chunk);

      console.log(`Sent audio chunk ${chunkNumber}/${totalChunks} to ${ws.connectionId} (${chunk.length} bytes)`);

      // Small delay to prevent overwhelming the client
      await this.sleep(10);
    }

    if (ws.readyState === WebSocket.OPEN) {
      this.sendMessage(ws, {
        type: 'audio_stream_end',
        status: 'complete'
      });
      console.log(`Audio streaming completed for ${ws.connectionId}`);
    }
  }

  async updateConfig(ws, data) {
    try {
      if (data.language) ws.language = data.language;
      if (data.voice) ws.voice = data.voice;
      if (data.model) ws.model = data.model;

      this.sendMessage(ws, {
        type: 'config_updated',
        config: {
          language: ws.language,
          voice: ws.voice,
          model: ws.model
        }
      });

      console.log(`Config updated for ${ws.connectionId}:`, {
        language: ws.language,
        voice: ws.voice,
        model: ws.model
      });
    } catch (error) {
      this.sendError(ws, 'Config update failed', error.message);
    }
  }

  sendMessage(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  sendError(ws, title, details) {
    this.sendMessage(ws, {
      type: 'error',
      error: title,
      details: details,
      timestamp: Date.now()
    });
  }

  cleanup(connectionId) {
    const deepgramClient = this.deepgramClients.get(connectionId);
    if (deepgramClient) {
      try {
        deepgramClient.close();
        this.deepgramClients.delete(connectionId);
        console.log(`Cleaned up Deepgram client for ${connectionId}`);
      } catch (error) {
        console.error(`Error cleaning up Deepgram client for ${connectionId}:`, error);
      }
    }
  }

  generateConnectionId() {
    return `voice_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Setup function to be used in server.js
const setupUnifiedVoiceServer = (wss) => {
  const unifiedServer = new UnifiedVoiceWebSocketServer();
  unifiedServer.setupServer(wss);
  return unifiedServer;
};

module.exports = { 
  UnifiedVoiceWebSocketServer, 
  setupUnifiedVoiceServer 
};