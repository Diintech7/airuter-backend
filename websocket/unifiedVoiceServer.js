const WebSocket = require('ws');
const { DeepgramClient } = require('./deepgramClient');
const { LMNTStreamingClient } = require('./lmntStreaming');

const setupUnifiedVoiceServer = (wss) => {
  console.log('Unified Voice WebSocket server initialized');

  wss.on('connection', (ws, req) => {
    console.log('New unified voice connection established');
    
    let deepgramClient = null;
    let lmntClient = null;
    let sessionId = null;
    let messageCount = 0;
    let isRecording = false;
    let connectionState = 'disconnected';
    
    // Extract language from URL parameters
    const url = new URL(req.url, 'http://localhost');
    const language = url.searchParams.get('language') || 'hi';
    
    console.log(`Connection established with language: ${language}`);
    console.log('Environment check:', {
      hasDeepgramKey: !!process.env.DEEPGRAM_API_KEY,
      hasLmntKey: !!process.env.LMNT_API_KEY,
      deepgramKeyLength: process.env.DEEPGRAM_API_KEY ? process.env.DEEPGRAM_API_KEY.length : 0
    });

    // Initialize Deepgram client with better error handling
    const initializeDeepgram = async () => {
      try {
        if (!process.env.DEEPGRAM_API_KEY) {
          throw new Error('DEEPGRAM_API_KEY environment variable is not set');
        }

        if (deepgramClient && deepgramClient.isReady()) {
          console.log('Deepgram client already initialized and ready');
          return true;
        }

        console.log('Initializing Deepgram client...');
        deepgramClient = new DeepgramClient(process.env.DEEPGRAM_API_KEY);
        
        // Set up transcript handler
        deepgramClient.onTranscript = (transcript) => {
          console.log('Transcript received from Deepgram:', transcript);
          
          if (transcript && transcript.trim() && ws.readyState === WebSocket.OPEN) {
            // Send transcription result
            const transcriptionResponse = {
              event: 'transcription',
              type: 'transcription',
              text: transcript.trim(),
              transcription: transcript.trim(),
              data: {
                text: transcript.trim(),
                transcription: transcript.trim(),
                transcript: transcript.trim(),
                recognized_text: transcript.trim(),
                session_id: sessionId,
                language: language
              },
              session_id: sessionId,
              language: language,
              timestamp: Date.now()
            };
            
            console.log('Sending transcription response:', transcriptionResponse);
            ws.send(JSON.stringify(transcriptionResponse));
          }
        };

        // Set up error handler
        deepgramClient.onError = (error) => {
          console.error('Deepgram error:', error);
          connectionState = 'error';
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ 
              type: 'error', 
              error: `Transcription error: ${error.message}`,
              session_id: sessionId,
              service: 'deepgram'
            }));
          }
        };

        // Connect to Deepgram with proper configuration
        const deepgramConfig = {
          language: getDeepgramLanguageCode(language),
          model: 'nova-2',
          encoding: 'linear16',
          sample_rate: '16000',
          channels: '1',
          punctuate: true,
          interim_results: false,
          endpointing: 300,
          vad_events: false,
          smart_format: true
        };

        console.log('Connecting to Deepgram with config:', deepgramConfig);
        await deepgramClient.connect(deepgramConfig);
        
        connectionState = 'connected';
        console.log('Deepgram client connected successfully');
        
        return true;
      } catch (error) {
        console.error('Failed to initialize Deepgram client:', error);
        connectionState = 'error';
        
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            type: 'error', 
            error: `Failed to initialize transcription service: ${error.message}`,
            session_id: sessionId,
            service: 'deepgram',
            details: {
              hasApiKey: !!process.env.DEEPGRAM_API_KEY,
              apiKeyLength: process.env.DEEPGRAM_API_KEY ? process.env.DEEPGRAM_API_KEY.length : 0
            }
          }));
        }
        return false;
      }
    };

    // Helper function to get proper Deepgram language code
    function getDeepgramLanguageCode(lang) {
      const languageMap = {
        'hi': 'hi-IN',
        'en': 'en-US',
        'te': 'te-IN',
        'ta': 'ta-IN',
        'bn': 'bn-IN',
        'gu': 'gu-IN',
        'kn': 'kn-IN',
        'ml': 'ml-IN',
        'mr': 'mr-IN',
        'or': 'or-IN',
        'pa': 'pa-IN',
        'ur': 'ur-IN'
      };
      
      return languageMap[lang] || 'en-US';
    }

    ws.on('message', async (message) => {
      try {
        let data;
        
        // Try to parse as JSON first
        try {
          const messageStr = message.toString();
          data = JSON.parse(messageStr);
          console.log('Received JSON message:', {
            event: data.event,
            session_id: data.session_id,
            language: data.language,
            hasAudioData: !!data.audio_data,
            audioDataLength: data.audio_data ? data.audio_data.length : 0
          });
        } catch (parseError) {
          // If not JSON, treat as binary audio data for transcription
          if (message instanceof Buffer && message.length > 100) {
            console.log('Received raw audio data for transcription, size:', message.length);
            
            // Ensure Deepgram is initialized
            if (!deepgramClient || !deepgramClient.isReady()) {
              console.log('Deepgram not ready, attempting to initialize...');
              const initialized = await initializeDeepgram();
              if (!initialized) {
                console.error('Failed to initialize Deepgram for audio processing');
                return;
              }
            }
            
            if (deepgramClient && isRecording) {
              console.log('Sending audio buffer to Deepgram...');
              deepgramClient.sendAudio(message);
            } else {
              console.warn('Received audio but not in recording mode or Deepgram not ready');
            }
            return;
          } else {
            console.error('Received invalid message format, size:', message.length);
            return;
          }
        }

        // Handle different message types
        switch (data.event) {
          case 'start':
            // Initialize session
            sessionId = data.uuid || data.session_id || generateSessionId();
            messageCount = 0;
            
            console.log('Session started with ID:', sessionId);
            
            // Initialize Deepgram
            const deepgramInitialized = await initializeDeepgram();
            
            // Send connection confirmation
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ 
                type: 'connected',
                language: language,
                services: ['transcription', 'synthesis'],
                session_id: sessionId,
                status: 'ready',
                deepgram_status: deepgramInitialized ? 'connected' : 'error',
                environment: {
                  hasDeepgramKey: !!process.env.DEEPGRAM_API_KEY,
                  hasLmntKey: !!process.env.LMNT_API_KEY
                }
              }));
            }
            break;

          case 'transcribe':
            // Handle transcription request with audio data
            console.log('Processing transcribe event...');
            
            if (!sessionId) {
              sessionId = data.session_id || generateSessionId();
            }
            
            if (data.audio_data) {
              try {
                // Decode base64 audio data
                const audioBuffer = Buffer.from(data.audio_data, 'base64');
                console.log('Decoded audio buffer size:', audioBuffer.length);
                
                // Ensure Deepgram is initialized
                if (!deepgramClient || !deepgramClient.isReady()) {
                  console.log('Deepgram not ready, attempting to initialize...');
                  const initialized = await initializeDeepgram();
                  if (!initialized) {
                    console.error('Failed to initialize Deepgram for transcription');
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ 
                        type: 'error', 
                        error: 'Failed to initialize transcription service',
                        session_id: sessionId,
                        service: 'deepgram'
                      }));
                    }
                    return;
                  }
                }
                
                if (audioBuffer.length > 0) {
                  console.log('Sending decoded audio to Deepgram for transcription...');
                  
                  // Send the audio data
                  const sent = deepgramClient.sendAudio(audioBuffer);
                  
                  if (!sent) {
                    console.error('Failed to send audio to Deepgram');
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ 
                        type: 'error', 
                        error: 'Failed to send audio for transcription',
                        session_id: sessionId,
                        service: 'deepgram'
                      }));
                    }
                  } else {
                    // Signal end of this audio segment after a brief delay
                    setTimeout(() => {
                      if (deepgramClient && deepgramClient.isReady()) {
                        deepgramClient.finishAudio();
                      }
                    }, 100);
                  }
                } else {
                  console.error('Empty audio buffer received');
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ 
                      type: 'error', 
                      error: 'Empty audio data received',
                      session_id: sessionId,
                      service: 'validation'
                    }));
                  }
                }
              } catch (error) {
                console.error('Error processing audio data:', error);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ 
                    type: 'error', 
                    error: `Audio processing failed: ${error.message}`,
                    session_id: sessionId,
                    service: 'audio_processing'
                  }));
                }
              }
            } else {
              console.error('No audio_data provided in transcribe event');
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ 
                  type: 'error', 
                  error: 'No audio data provided for transcription',
                  session_id: sessionId,
                  service: 'validation'
                }));
              }
            }
            break;

          case 'start_recording':
            // Start recording mode
            console.log('Starting recording mode');
            isRecording = true;
            
            if (!deepgramClient || !deepgramClient.isReady()) {
              await initializeDeepgram();
            }
            
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ 
                type: 'recording_started',
                language: language,
                session_id: sessionId,
                deepgram_status: connectionState
              }));
            }
            break;

          case 'stop_recording':
            // Stop recording mode
            console.log('Stopping recording mode');
            isRecording = false;
            
            if (deepgramClient && deepgramClient.isReady()) {
              try {
                deepgramClient.finishAudio();
              } catch (error) {
                console.error('Error finishing audio stream:', error);
              }
            }
            
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ 
                type: 'recording_stopped',
                session_id: sessionId
              }));
            }
            break;

          case 'synthesize':
            // Handle direct synthesis requests
            const textToSynthesize = data.text || data.message;
            if (textToSynthesize) {
              await handleTTSRequest(textToSynthesize, ws, sessionId);
            } else {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ 
                  type: 'error', 
                  error: 'No text provided for synthesis',
                  session_id: sessionId,
                  service: 'tts'
                }));
              }
            }
            break;

          case 'media':
            // Handle incoming audio media (for streaming)
            if (data.media && data.media.payload) {
              const audioBuffer = Buffer.from(data.media.payload, 'base64');
              console.log('Received media payload, size:', audioBuffer.length);
              
              if (!deepgramClient || !deepgramClient.isReady()) {
                await initializeDeepgram();
              }
              
              if (deepgramClient && deepgramClient.isReady()) {
                deepgramClient.sendAudio(audioBuffer);
              }
            }
            break;

          default:
            console.warn('Unknown message event:', data.event || data.type);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ 
                type: 'error', 
                error: `Unknown event type: ${data.event || data.type}`,
                session_id: sessionId,
                service: 'validation'
              }));
            }
            break;
        }
        
      } catch (error) {
        console.error('Error processing message:', error);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            type: 'error', 
            error: error.message,
            session_id: sessionId,
            service: 'message_processing'
          }));
        }
      }
    });

    // Function to handle TTS requests
    async function handleTTSRequest(text, ws, sessionId) {
      try {
        console.log('Processing TTS request for text:', text);
        
        // Check if LMNT API key is available
        if (!process.env.LMNT_API_KEY) {
          console.error('LMNT API key not configured');
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ 
              type: 'error', 
              error: 'TTS service not configured - LMNT API key missing',
              session_id: sessionId,
              service: 'tts'
            }));
          }
          return;
        }
        
        // Initialize LMNT client if needed
        if (!lmntClient) {
          try {
            lmntClient = new LMNTStreamingClient(process.env.LMNT_API_KEY);
            console.log('LMNT client initialized successfully');
          } catch (error) {
            console.error('Failed to initialize LMNT client:', error);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ 
                type: 'error', 
                error: `Failed to initialize TTS service: ${error.message}`,
                session_id: sessionId,
                service: 'lmnt'
              }));
            }
            return;
          }
        }

        // Synthesize the text
        const synthesisOptions = {
          voice: 'lily',
          language: language,
          speed: 1.0
        };
        
        console.log('Synthesizing text with options:', synthesisOptions);
        const audioData = await lmntClient.synthesize(text, synthesisOptions);
        
        if (!audioData || audioData.length === 0) {
          throw new Error('Received empty audio data from LMNT');
        }

        // Convert to WAV format with proper headers
        const wavAudio = convertToWAV(audioData);
        const base64Audio = Buffer.from(wavAudio).toString('base64');
        
        messageCount++;
        
        // Send response in the expected format
        const response = {
          data: {
            session_id: sessionId,
            count: messageCount,
            audio_bytes_to_play: base64Audio,
            sample_rate: 8000,
            channels: 1,
            sample_width: 2
          },
          type: 'tts_response',
          session_id: sessionId,
          timestamp: Date.now()
        };
        
        console.log('Sending TTS response, audio size:', wavAudio.length);
        
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(response));
        }

      } catch (error) {
        console.error('Error in handleTTSRequest:', error);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            type: 'error', 
            error: `TTS processing failed: ${error.message}`,
            session_id: sessionId,
            service: 'tts'
          }));
        }
      }
    }

    // Function to convert audio to WAV format
    function convertToWAV(audioBuffer, sampleRate = 8000, channels = 1, sampleWidth = 2) {
      const byteRate = sampleRate * channels * sampleWidth;
      const blockAlign = channels * sampleWidth;
      const dataSize = audioBuffer.length;
      const fileSize = 36 + dataSize;

      const wavBuffer = Buffer.alloc(44 + dataSize);
      let offset = 0;

      // RIFF header
      wavBuffer.write('RIFF', offset); offset += 4;
      wavBuffer.writeUInt32LE(fileSize, offset); offset += 4;
      wavBuffer.write('WAVE', offset); offset += 4;

      // fmt chunk
      wavBuffer.write('fmt ', offset); offset += 4;
      wavBuffer.writeUInt32LE(16, offset); offset += 4; // chunk size
      wavBuffer.writeUInt16LE(1, offset); offset += 2; // audio format (PCM)
      wavBuffer.writeUInt16LE(channels, offset); offset += 2;
      wavBuffer.writeUInt32LE(sampleRate, offset); offset += 4;
      wavBuffer.writeUInt32LE(byteRate, offset); offset += 4;
      wavBuffer.writeUInt16LE(blockAlign, offset); offset += 2;
      wavBuffer.writeUInt16LE(sampleWidth * 8, offset); offset += 2; // bits per sample

      // data chunk
      wavBuffer.write('data', offset); offset += 4;
      wavBuffer.writeUInt32LE(dataSize, offset); offset += 4;
      audioBuffer.copy(wavBuffer, offset);

      return wavBuffer;
    }

    // Generate session ID
    function generateSessionId() {
      return require('crypto').randomUUID();
    }

    ws.on('close', () => {
      console.log('Unified voice connection closed');
      connectionState = 'disconnected';
      
      if (deepgramClient) {
        try {
          deepgramClient.close();
        } catch (error) {
          console.error('Error closing Deepgram client:', error);
        }
        deepgramClient = null;
      }
      
      if (lmntClient) {
        try {
          // Clean up LMNT client if it has a close method
          if (typeof lmntClient.close === 'function') {
            lmntClient.close();
          }
        } catch (error) {
          console.error('Error closing LMNT client:', error);
        }
        lmntClient = null;
      }
      
      isRecording = false;
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      connectionState = 'error';
    });

    // Send initial connection confirmation
    if (ws.readyState === WebSocket.OPEN) {
      sessionId = generateSessionId();
      ws.send(JSON.stringify({ 
        type: 'connected',
        language: language,
        services: ['transcription', 'synthesis'],
        session_id: sessionId,
        status: 'ready',
        environment: {
          hasDeepgramKey: !!process.env.DEEPGRAM_API_KEY,
          hasLmntKey: !!process.env.LMNT_API_KEY,
          nodeEnv: process.env.NODE_ENV || 'development'
        }
      }));
    }
  });
};

module.exports = { setupUnifiedVoiceServer };