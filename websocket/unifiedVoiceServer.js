const WebSocket = require('ws');
// const { DeepgramClient } = require('./deepgramClient'); // Comment out for now
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

    // Skip Deepgram initialization for now
    const initializeDeepgram = async () => {
      console.log('Deepgram initialization skipped for testing');
      return false; // Return false to indicate Deepgram is not available
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
          console.error('Received invalid message format, size:', message.length);
          return;
        }

        // Handle different message types
        switch (data.event) {
          case 'start':
            // Initialize session
            sessionId = data.uuid || data.session_id || generateSessionId();
            messageCount = 0;
            
            console.log('Session started with ID:', sessionId);
            
            // Skip Deepgram initialization
            const deepgramInitialized = false;
            
            // Send connection confirmation
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ 
                type: 'connected',
                language: language,
                services: ['synthesis'], // Only synthesis for now
                session_id: sessionId,
                status: 'ready',
                deepgram_status: 'disabled_for_testing',
                environment: {
                  hasDeepgramKey: !!process.env.DEEPGRAM_API_KEY,
                  hasLmntKey: !!process.env.LMNT_API_KEY
                }
              }));
            }
            break;

          case 'transcribe':
            // Handle transcription request - return mock response for testing
            console.log('Processing transcribe event (mock response)...');
            
            if (!sessionId) {
              sessionId = data.session_id || generateSessionId();
            }
            
            // Send mock transcription response
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                const mockTranscriptionResponse = {
                  event: 'transcription',
                  type: 'transcription',
                  text: 'Mock transcription: Hello, this is a test transcription',
                  transcription: 'Mock transcription: Hello, this is a test transcription',
                  data: {
                    text: 'Mock transcription: Hello, this is a test transcription',
                    transcription: 'Mock transcription: Hello, this is a test transcription',
                    transcript: 'Mock transcription: Hello, this is a test transcription',
                    recognized_text: 'Mock transcription: Hello, this is a test transcription',
                    session_id: sessionId,
                    language: language
                  },
                  session_id: sessionId,
                  language: language,
                  timestamp: Date.now()
                };
                
                console.log('Sending mock transcription response:', mockTranscriptionResponse);
                ws.send(JSON.stringify(mockTranscriptionResponse));
              }
            }, 1000); // 1 second delay to simulate processing
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
      
      if (lmntClient) {
        try {
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
        services: ['synthesis'], // Only synthesis for now
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