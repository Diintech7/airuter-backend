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
    
    // Extract language from URL parameters
    const url = new URL(req.url, 'http://localhost');
    const language = url.searchParams.get('language') || 'hi';
    
    console.log(`Connection established with language: ${language}`);

    ws.on('message', async (message) => {
      try {
        let data;
        
        // Try to parse as JSON first
        try {
          const messageStr = message.toString();
          data = JSON.parse(messageStr);
          console.log('Received JSON message:', data);
        } catch (parseError) {
          // If not JSON, treat as binary audio data
          if (message instanceof Buffer && message.length > 100) {
            console.log('Received audio data for transcription, size:', message.length);
            
            if (!deepgramClient) {
              console.log('Initializing Deepgram client...');
              deepgramClient = new DeepgramClient(process.env.DEEPGRAM_API_KEY);
              
              deepgramClient.onTranscript = (transcript) => {
                console.log('Transcript received:', transcript);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ 
                    type: 'transcript', 
                    data: transcript,
                    language: language
                  }));
                }
              };

              try {
                await deepgramClient.connect({
                  language: language,
                  model: 'nova-2',
                  punctuate: true,
                  diarize: false,
                  tier: 'enhanced'
                });
                console.log('Deepgram client connected successfully');
              } catch (error) {
                console.error('Failed to connect Deepgram client:', error);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ 
                    type: 'error', 
                    error: 'Failed to initialize transcription service' 
                  }));
                }
                return;
              }
            }
            
            // Send audio to Deepgram
            deepgramClient.sendAudio(message);
            return;
          } else {
            console.error('Received invalid message format');
            return;
          }
        }

        // Handle different message types
        if (data.event === 'start') {
          // Initialize session
          sessionId = data.uuid || generateSessionId();
          messageCount = 0;
          
          console.log('Session started with ID:', sessionId);
          
          // Send connection confirmation in expected format
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ 
              type: 'connected',
              language: language,
              services: ['transcription', 'synthesis'],
              session_id: sessionId
            }));
          }
        } 
        else if (data.event === 'media') {
          // Handle incoming audio media
          if (data.media && data.media.payload) {
            const audioBuffer = Buffer.from(data.media.payload, 'base64');
            console.log('Received media payload, size:', audioBuffer.length);
            
            // Initialize Deepgram if not already done
            if (!deepgramClient) {
              console.log('Initializing Deepgram client for media...');
              deepgramClient = new DeepgramClient(process.env.DEEPGRAM_API_KEY);
              
              deepgramClient.onTranscript = async (transcript) => {
                console.log('Transcript received:', transcript);
                
                if (transcript && transcript.trim()) {
                  // Process the transcript and generate TTS response
                  await handleTranscriptAndRespond(transcript, ws, sessionId);
                }
              };

              try {
                await deepgramClient.connect({
                  language: language,
                  model: 'nova-2',
                  punctuate: true,
                  diarize: false,
                  tier: 'enhanced'
                });
                console.log('Deepgram client connected successfully');
              } catch (error) {
                console.error('Failed to connect Deepgram client:', error);
                return;
              }
            }
            
            // Send audio to Deepgram
            deepgramClient.sendAudio(audioBuffer);
          }
        }
        else if (data.type === 'synthesize' || data.event === 'synthesize') {
          // Handle direct synthesis requests
          const textToSynthesize = data.text || data.message;
          if (textToSynthesize) {
            await handleTranscriptAndRespond(textToSynthesize, ws, sessionId);
          }
        }
        else if (data.type === 'start_recording') {
          // Initialize recording mode
          console.log('Starting recording mode');
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ 
              type: 'recording_ready',
              language: language,
              session_id: sessionId
            }));
          }
        } 
        else {
          console.warn('Unknown message type:', data.type || data.event);
        }
        
      } catch (error) {
        console.error('Error processing message:', error);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            type: 'error', 
            error: error.message,
            session_id: sessionId
          }));
        }
      }
    });

    // Function to handle transcript and generate TTS response
    async function handleTranscriptAndRespond(transcript, ws, sessionId) {
      try {
        console.log('Processing transcript for TTS:', transcript);
        
        // Initialize LMNT client if needed
        if (!lmntClient) {
          if (!process.env.LMNT_API_KEY) {
            console.error('LMNT API key not configured');
            return;
          }
          lmntClient = new LMNTStreamingClient(process.env.LMNT_API_KEY);
        }

        // Generate response text (you can integrate your AI/bot logic here)
        const responseText = await generateBotResponse(transcript);
        
        if (!responseText) {
          console.log('No response generated for transcript');
          return;
        }

        // Synthesize the response
        const synthesisOptions = {
          voice: 'lily',
          language: language,
          speed: 1.0
        };
        
        console.log('Synthesizing response:', responseText);
        const audioData = await lmntClient.synthesize(responseText, synthesisOptions);
        
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
            sample_rate: 8000,  // Adjust based on your audio format
            channels: 1,
            sample_width: 2
          }
        };
        
        console.log('Sending TTS response, audio size:', wavAudio.length);
        
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(response));
        }

      } catch (error) {
        console.error('Error in handleTranscriptAndRespond:', error);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            type: 'error', 
            error: `TTS processing failed: ${error.message}`,
            session_id: sessionId
          }));
        }
      }
    }

    // Function to generate bot response (replace with your logic)
    async function generateBotResponse(transcript) {
      // This is where you'd integrate your chatbot/AI logic
      // For now, returning a simple echo response
      return `I heard you say: ${transcript}. How can I help you?`;
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
      if (deepgramClient) {
        deepgramClient.close();
        deepgramClient = null;
      }
      lmntClient = null;
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    // Send initial connection confirmation
    if (ws.readyState === WebSocket.OPEN) {
      sessionId = generateSessionId();
      ws.send(JSON.stringify({ 
        type: 'connected',
        language: language,
        services: ['transcription', 'synthesis'],
        session_id: sessionId
      }));
    }
  });
};

module.exports = { setupUnifiedVoiceServer };