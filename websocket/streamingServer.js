const WebSocket = require('ws');
const { LMNTStreamingClient } = require('./lmntStreaming');

const setupWebSocketServer = (wss) => {
  console.log('WebSocket server initialized');

  wss.on('connection', async (ws) => {
    console.log('New WebSocket connection established');

    ws.on('message', async (message) => {
      console.log('\n=== New Synthesis Request ===');
      try {
        const data = JSON.parse(message);
        console.log('Received message data:', JSON.stringify(data, null, 2));

        if (!process.env.LMNT_API_KEY) {
          console.error('Error: LMNT API key not configured');
          throw new Error('LMNT API key is not configured');
        }

        console.log('Initializing LMNT client...');
        const lmntClient = new LMNTStreamingClient(process.env.LMNT_API_KEY);
        
        const synthesisOptions = {
          voice: data.voice || 'lily',
          language: data.language || 'en',
          speed: data.speed || 1.0,
          format: 'mp3',
          sample_rate: 16000
        };
        
        console.log('Synthesis options:', JSON.stringify(synthesisOptions, null, 2));
        
        console.log('Starting audio synthesis...');
        const audioData = await lmntClient.synthesize(data.text, synthesisOptions);
        
        if (!audioData || audioData.length === 0) {
          console.error('Error: Received empty audio data');
          throw new Error('Received empty audio data from LMNT');
        }

        const audioBuffer = Buffer.from(audioData);
        const chunkSize = 16384;
        const totalChunks = Math.ceil(audioBuffer.length / chunkSize);
        
        console.log(`\nStreaming audio data:`);
        console.log(`Total audio size: ${audioBuffer.length} bytes`);
        console.log(`Chunk size: ${chunkSize} bytes`);
        console.log(`Number of chunks: ${totalChunks}`);
        
        for (let i = 0; i < audioBuffer.length; i += chunkSize) {
          const chunk = audioBuffer.slice(i, i + chunkSize);
          const chunkNumber = Math.floor(i / chunkSize) + 1;
          
          console.log(`Sending chunk ${chunkNumber}/${totalChunks} (${chunk.length} bytes)`);
          
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(chunk);
          } else {
            console.warn('WebSocket connection closed while streaming');
            break;
          }
        }
        
        if (ws.readyState === WebSocket.OPEN) {
          console.log('Streaming complete, sending end signal');
          ws.send(JSON.stringify({ type: 'end' }));
        }

        console.log('=== Request Complete ===\n');

      } catch (error) {
        console.error('Error during processing:', error);
        if (ws.readyState === WebSocket.OPEN) {
          const errorMessage = {
            type: 'error',
            error: error.message,
            details: 'Speech synthesis failed'
          };
          console.error('Sending error to client:', errorMessage);
          ws.send(JSON.stringify(errorMessage));
        }
      }
    });

    ws.on('close', () => {
      console.log('WebSocket connection closed');
    });
  });
};

module.exports = { setupWebSocketServer };