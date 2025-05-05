const WebSocket = require('ws');
const { LMNTStreamingClient } = require('./lmntStreaming');

const setupWebSocketServer = (wss) => {
  console.log('WebSocket server initialized for speech synthesis');

  wss.on('connection', async (ws) => {
    console.log('New speech synthesis WebSocket connection established');

    ws.on('message', async (message) => {
      console.log('Speech synthesis request received');
      try {
        const data = JSON.parse(message);
        
        if (!process.env.LMNT_API_KEY) {
          throw new Error('LMNT API key is not configured');
        }

        const lmntClient = new LMNTStreamingClient(process.env.LMNT_API_KEY);
        
        const synthesisOptions = {
          voice: data.voice || 'lily',
          language: data.language || 'en',
          speed: data.speed || 1.0
        };
        
        console.log('Synthesizing speech with options:', synthesisOptions);
        
        const audioData = await lmntClient.synthesize(data.text, synthesisOptions);
        
        if (!audioData || audioData.length === 0) {
          throw new Error('No audio data generated');
        }

        // Stream audio in chunks
        const chunkSize = 16384;
        for (let i = 0; i < audioData.length; i += chunkSize) {
          const chunk = audioData.slice(i, i + chunkSize);
          
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(chunk);
          } else {
            console.warn('WebSocket closed during streaming');
            break;
          }
        }

        // Send end signal
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'end' }));
        }

      } catch (error) {
        console.error('Speech synthesis error:', error);
        
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'error',
            message: error.message
          }));
        }
      }
    });

    ws.on('close', () => {
      console.log('Speech synthesis WebSocket closed');
    });
  });
};

module.exports = { setupWebSocketServer };