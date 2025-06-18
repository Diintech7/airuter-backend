const WebSocket = require('ws');
const { DeepgramClient } = require('./deepgramClient');
const { LMNTStreamingClient } = require('./lmntStreaming');

const setupUnifiedVoiceServer = (wss) => {
  console.log('Unified Voice WebSocket server initialized');

  wss.on('connection', (ws, req) => {
    console.log('New unified voice connection established');
    
    let deepgramClient = null;
    let lmntClient = null;
    
    // Extract language from URL parameters
    const url = new URL(req.url, 'http://localhost');
    const language = url.searchParams.get('language') || 'hi';
    
    console.log(`Connection established with language: ${language}`);

    ws.on('message', async (message) => {
      try {
        // Check if message is JSON (text commands) or binary (audio data)
        if (message instanceof Buffer && message.length > 100) {
          // This is likely audio data for transcription
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
          
        } else {
          // This is a text message (JSON command)
          let data;
          try {
            data = JSON.parse(message.toString());
          } catch (parseError) {
            console.error('Failed to parse message as JSON:', parseError);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ 
                type: 'error', 
                error: 'Invalid message format' 
              }));
            }
            return;
          }

          console.log('Received command:', data.type);

          if (data.type === 'synthesize') {
            // Handle text-to-speech synthesis
            console.log('Processing synthesis request for text:', data.text);
            
            if (!lmntClient) {
              if (!process.env.LMNT_API_KEY) {
                console.error('LMNT API key not configured');
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ 
                    type: 'error', 
                    error: 'Speech synthesis service not configured' 
                  }));
                }
                return;
              }
              lmntClient = new LMNTStreamingClient(process.env.LMNT_API_KEY);
            }

            try {
              const synthesisOptions = {
                voice: data.voice || 'lily',
                language: data.language || language,
                speed: data.speed || 1.0
              };
              
              console.log('Synthesis options:', synthesisOptions);
              
              const audioData = await lmntClient.synthesize(data.text, synthesisOptions);
              
              if (!audioData || audioData.length === 0) {
                throw new Error('Received empty audio data from LMNT');
              }

              // Stream audio data in chunks
              const audioBuffer = Buffer.from(audioData);
              const chunkSize = 16384;
              const totalChunks = Math.ceil(audioBuffer.length / chunkSize);
              
              console.log(`Streaming ${totalChunks} chunks of audio data`);
              
              // Send start signal
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ 
                  type: 'audio_start',
                  totalSize: audioBuffer.length,
                  chunks: totalChunks
                }));
              }
              
              // Stream chunks
              for (let i = 0; i < audioBuffer.length; i += chunkSize) {
                const chunk = audioBuffer.slice(i, i + chunkSize);
                
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(chunk);
                } else {
                  console.warn('WebSocket closed during streaming');
                  break;
                }
              }
              
              // Send end signal
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'audio_end' }));
                console.log('Audio streaming completed');
              }

            } catch (error) {
              console.error('Synthesis error:', error);
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ 
                  type: 'error', 
                  error: `Speech synthesis failed: ${error.message}` 
                }));
              }
            }
          } else if (data.type === 'start_recording') {
            // Initialize Deepgram for recording
            console.log('Starting recording mode');
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ 
                type: 'recording_ready',
                language: language
              }));
            }
          } else {
            console.warn('Unknown command type:', data.type);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ 
                type: 'error', 
                error: 'Unknown command type' 
              }));
            }
          }
        }
        
      } catch (error) {
        console.error('Error processing message:', error);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            type: 'error', 
            error: error.message 
          }));
        }
      }
    });

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

    // Send connection confirmation
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ 
        type: 'connected',
        language: language,
        services: ['transcription', 'synthesis']
      }));
    }
  });
};

module.exports = { setupUnifiedVoiceServer };