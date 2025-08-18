const WebSocket = require('ws');
const { DeepgramClient } = require('./deepgramClient');

const setupDeepgramServer = (wss) => {
  wss.on('connection', (ws, req) => {
    let deepgramClient = null;
    const url = new URL(req.url, 'http://localhost');
    const language = url.searchParams.get('language') || 'hi';

    ws.on('message', async (message) => {
      try {
        if (!deepgramClient) {
          deepgramClient = new DeepgramClient('01f47e676cb12c10160c4c215ee658643b5a028b');
          
          deepgramClient.onTranscript = (transcript, detectedLanguage, confidence) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ 
                type: 'transcript', 
                data: transcript,
                language: detectedLanguage,
                confidence: confidence
              }));
            }
          };

          await deepgramClient.connect({
            language: language,
            model: 'nova-2',
            punctuate: true,
            diarize: false,
            tier: 'enhanced'
          });
        }
        deepgramClient.sendAudio(message);
      } catch (error) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            type: 'error', 
            error: error.message 
          }));
        }
      }
    });

    ws.on('close', () => {
      if (deepgramClient) {
        deepgramClient.close();
        deepgramClient = null;
      }
    });
  });
};

module.exports = { setupDeepgramServer };

// VoiceInteraction.js (Frontend)
const startRecording = async () => {
  try {
    await connectWebSockets();
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        channelCount: 1,
        sampleRate: 48000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      } 
    });
    
    streamRef.current = stream;
    
    const recorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm'
    });
    
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0 && transcriptWsRef.current?.readyState === WebSocket.OPEN) {
        transcriptWsRef.current.send(event.data);
      }
    };

    recorder.onstop = () => {
      stopMediaTracks();
    };

    setMediaRecorder(recorder);
    setIsRecording(true);
    setError(null);
    audioStreamRef.current.reset();
    recorder.start(250);
  } catch (err) {
    setError('Failed to start recording. Please check microphone permissions.');
  }
};

const connectWebSockets = async () => {
  try {
    if (transcriptWsRef.current) transcriptWsRef.current.close();
    if (speechWsRef.current) speechWsRef.current.close();

    setError(null);
    setIsSpeaking(false);
    audioQueueRef.current = [];
    isPlayingRef.current = false;

    transcriptWsRef.current = new WebSocket(
      `wss://auriter-backen.onrender.com/ws/transcribe?language=${language}&model=nova-2`
    );
    speechWsRef.current = new WebSocket(`wss://auriter-backen.onrender.com/ws/speech`);

    await Promise.all([
      new Promise((resolve, reject) => {
        transcriptWsRef.current.onopen = resolve;
        transcriptWsRef.current.onerror = reject;
      }),
      new Promise((resolve, reject) => {
        speechWsRef.current.onopen = resolve;
        speechWsRef.current.onerror = reject;
      })
    ]);

    transcriptWsRef.current.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'transcript' && data.data.trim()) {
          setConversationHistory(prev => [
            ...prev, 
            { type: 'user', text: data.data }
          ]);
          await processTranscript(data.data);
        }
      } catch (error) {
        console.error('Transcript WebSocket Message Error:', error);
      }
    };

    setupSpeechWebSocketHandlers();
  } catch (error) {
    setError('Failed to connect WebSockets');
  }

};
