const { DeepgramClient } = require('./deepgramClient');

const setupDeepgramServer = (wss) => {
  wss.on('connection', (ws, req) => {
    let deepgramClient = null;
    const url = new URL(req.url, 'http://localhost');
    const language = url.searchParams.get('language') || 'en';

    // Set up transcript and error handling
    const sendTranscriptToClient = (transcript) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ 
          type: 'transcript', 
          data: transcript  // Changed from 'transcript' to 'data' to match frontend expectation
        }));
      }
    };

    const sendErrorToClient = (error) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ 
          type: 'error', 
          error: error.message 
        }));
      }
    };

    ws.on('message', async (message) => {
      try {
        if (!deepgramClient) {
          deepgramClient = new DeepgramClient(process.env.DEEPGRAM_API_KEY);
          deepgramClient.onTranscript = sendTranscriptToClient;
          deepgramClient.onError = sendErrorToClient;
          await deepgramClient.connect({ language });
        }
        
        // Convert message to buffer if it's not already
        const audioBuffer = message instanceof Buffer 
          ? message 
          : Buffer.from(message);
        
        deepgramClient.sendAudio(audioBuffer);
      } catch (error) {
        sendErrorToClient(error);
      }
    });

    ws.on('close', () => {
      if (deepgramClient) {
        deepgramClient.close();
      }
    });
  });
};

module.exports = { setupDeepgramServer };