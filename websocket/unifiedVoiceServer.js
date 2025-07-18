const WebSocket = require("ws");

// Load API keys from environment variables
const API_KEYS = {
  deepgram: process.env.DEEPGRAM_API_KEY,
  sarvam: process.env.SARVAM_API_KEY,
  openai: process.env.OPENAI_API_KEY,
};

// Validate API keys
if (!API_KEYS.deepgram || !API_KEYS.sarvam || !API_KEYS.openai) {
  console.error("❌ Missing required API keys in environment variables");
  console.error("Required: DEEPGRAM_API_KEY, SARVAM_API_KEY, OPENAI_API_KEY");
  process.exit(1);
}

const fetch = globalThis.fetch || require("node-fetch");

// Performance timing helper
const createTimer = (label) => {
  const start = Date.now();
  return {
    start,
    end: () => Date.now() - start,
    checkpoint: (checkpointName) => Date.now() - start,
  };
};

// Language mappings
const LANGUAGE_MAPPING = {
  hi: "hi-IN",
  en: "en-IN",
  bn: "bn-IN",
  te: "te-IN",
  ta: "ta-IN",
  mr: "mr-IN",
  gu: "gu-IN",
  kn: "kn-IN",
  ml: "ml-IN",
  pa: "pa-IN",
  or: "or-IN",
  as: "as-IN",
  ur: "ur-IN",
};

// Get language codes for different services
const getSarvamLanguage = (detectedLang, defaultLang = "hi") => {
  const lang = detectedLang?.toLowerCase() || defaultLang;
  return LANGUAGE_MAPPING[lang] || "hi-IN";
};

const getDeepgramLanguage = (detectedLang, defaultLang = "hi") => {
  const lang = detectedLang?.toLowerCase() || defaultLang;
  if (lang === "hi") return "hi";
  if (lang === "en") return "en-IN";
  return lang;
};

// Valid Sarvam voice options
const VALID_SARVAM_VOICES = ["meera", "pavithra", "arvind", "amol", "maya"];

const getValidSarvamVoice = (voiceSelection = "pavithra") => {
  if (VALID_SARVAM_VOICES.includes(voiceSelection)) {
    return voiceSelection;
  }
  
  const voiceMapping = {
    "male-professional": "arvind",
    "female-professional": "pavithra",
    "male-friendly": "amol",
    "female-friendly": "maya",
    neutral: "pavithra",
    default: "pavithra",
  };
  
  return voiceMapping[voiceSelection] || "pavithra";
};

// Basic configuration
const DEFAULT_CONFIG = {
  agentName: "हिंदी सहायक",
  language: "hi",
  voiceSelection: "pavithra",
  firstMessage: "नमस्ते! मैं आपकी सहायता के लिए यहाँ हूँ। आप कैसे हैं?",
  personality: "friendly",
  category: "customer service",
  contextMemory: "customer service conversation in Hindi",
};

// Language detection using OpenAI (optimized)
const detectLanguage = async (text) => {
  const timer = createTimer("LANGUAGE_DETECTION");
  
  try {
    if (!API_KEYS.openai || !text.trim()) {
      timer.end();
      return "hi";
    }

    const requestBody = {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Detect language and respond with just the code: hi, en, bn, te, ta, mr, gu, kn, ml, pa, or, as, ur. Default: hi`,
        },
        {
          role: "user",
          content: text,
        },
      ],
      max_tokens: 5,
      temperature: 0,
    };

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEYS.openai}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      console.error(`❌ [LANGUAGE_DETECT] OpenAI API error: ${response.status}`);
      timer.end();
      return "hi";
    }

    const data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
      const detectedLang = data.choices[0].message.content.trim().toLowerCase();
      console.log(`🔍 [LANGUAGE_DETECT] Detected: ${detectedLang} (${timer.end()}ms)`);
      return detectedLang;
    }

    timer.end();
    return "hi";
  } catch (error) {
    console.error(`❌ [LANGUAGE_DETECT] Error: ${error.message}`);
    timer.end();
    return "hi";
  }
};

// OpenAI LLM processing with streaming
const processWithOpenAIStreaming = async (userMessage, conversationHistory, currentLanguage, onChunk, onComplete) => {
  const timer = createTimer("OPENAI_STREAMING");
  
  try {
    if (!API_KEYS.openai || !userMessage.trim()) {
      timer.end();
      return null;
    }

    const systemPrompt = `You are ${DEFAULT_CONFIG.agentName}, a helpful Hindi voice assistant.

LANGUAGE: ${currentLanguage || "hi"}
RULES:
- Respond in user's language
- Keep responses very short (max 100 chars)
- Be conversational and helpful
- Context: ${DEFAULT_CONFIG.contextMemory}`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.slice(-4), // Reduced context for faster processing
      { role: "user", content: userMessage }
    ];

    const requestBody = {
      model: "gpt-4o-mini",
      messages: messages,
      max_tokens: 80, // Reduced for faster response
      temperature: 0.7,
      stream: true, // Enable streaming
    };

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEYS.openai}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      console.error(`❌ [OPENAI] API error: ${response.status}`);
      timer.end();
      return null;
    }

    let fullResponse = "";
    let wordBuffer = "";
    let isFirstChunk = true;

    // Process the streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(line => line.trim());

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          
          if (data === '[DONE]') {
            // Send any remaining words in buffer
            if (wordBuffer.trim()) {
              onChunk(wordBuffer.trim());
              fullResponse += wordBuffer;
            }
            break;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            
            if (content) {
              wordBuffer += content;
              
              // Check if we have complete words (space or punctuation)
              if (content.includes(' ') || content.includes('.') || content.includes(',') || content.includes('!') || content.includes('?')) {
                const words = wordBuffer.split(/(\s+|[,.!?])/);
                
                // Send complete words, keep the last incomplete word in buffer
                if (words.length > 1) {
                  const completeText = words.slice(0, -1).join('');
                  if (completeText.trim()) {
                    if (isFirstChunk) {
                      console.log(`⚡ [OPENAI] First chunk received (${timer.checkpoint('first_chunk')}ms)`);
                      isFirstChunk = false;
                    }
                    onChunk(completeText);
                    fullResponse += completeText;
                  }
                  wordBuffer = words[words.length - 1] || '';
                }
              }
            }
          } catch (e) {
            // Skip malformed JSON
          }
        }
      }
    }

    console.log(`🤖 [OPENAI] Streaming completed: "${fullResponse}" (${timer.end()}ms)`);
    onComplete(fullResponse);
    return fullResponse;

  } catch (error) {
    console.error(`❌ [OPENAI] Error: ${error.message}`);
    timer.end();
    return null;
  }
};

// SIP-optimized Sarvam TTS implementation
const synthesizeWithSarvamOptimized = async (text, language, ws, streamSid) => {
  const timer = createTimer("SARVAM_TTS_OPTIMIZED");
  try {
    if (!API_KEYS.sarvam || !text.trim()) {
      timer.end();
      return;
    }

    const validVoice = getValidSarvamVoice(DEFAULT_CONFIG.voiceSelection);
    const sarvamLanguage = getSarvamLanguage(language);
    console.log(`🎵 [SARVAM] TTS: "${text}" (${sarvamLanguage}, ${validVoice})`);

    const requestBody = {
      inputs: [text],
      target_language_code: sarvamLanguage,
      speaker: validVoice,
      pitch: 0,
      pace: 1.1,
      loudness: 1.0,
      speech_sample_rate: 8000,
      enable_preprocessing: false,
      model: "bulbul:v1",
    };

    const response = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "API-Subscription-Key": API_KEYS.sarvam,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ [SARVAM] API error: ${response.status}`, errorText);
      timer.end();
      throw new Error(`Sarvam API error: ${response.status} - ${errorText}`);
    }

    const responseData = await response.json();

    if (!responseData.audios || responseData.audios.length === 0) {
      console.error("❌ [SARVAM] No audio data received");
      timer.end();
      throw new Error("Sarvam TTS: No audio data received");
    }

    const audioBase64 = responseData.audios[0];
    const audioBuffer = Buffer.from(audioBase64, "base64");

    // SIP-optimized chunking
    // At 8kHz sampling rate, 16-bit PCM:
    // 20ms = 160 bytes (minimum SIP packet size)
    // 100ms = 800 bytes (maximum for low latency)
    const CHUNK_SIZE_20MS = 160;  // 20ms of audio at 8kHz
    const CHUNK_SIZE_40MS = 320;  // 40ms of audio at 8kHz
    const CHUNK_SIZE_60MS = 480;  // 60ms of audio at 8kHz
    const CHUNK_SIZE_80MS = 640;  // 80ms of audio at 8kHz
    const CHUNK_SIZE_100MS = 800; // 100ms of audio at 8kHz

    // Use 40ms chunks for optimal balance between latency and efficiency
    const chunkSize = CHUNK_SIZE_40MS;
    const totalChunks = Math.ceil(audioBuffer.length / chunkSize);
    
    console.log(`📦 [SARVAM] Streaming ${audioBuffer.length} bytes in ${totalChunks} chunks (${chunkSize} bytes = 40ms each)`);

    // Send audio chunks with precise timing for SIP
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, audioBuffer.length);
      let chunk = audioBuffer.slice(start, end);
      
      // Pad the last chunk if it's smaller than minimum SIP packet size
      if (chunk.length < CHUNK_SIZE_20MS && i === totalChunks - 1) {
        const paddingSize = CHUNK_SIZE_20MS - chunk.length;
        const padding = Buffer.alloc(paddingSize, 0); // Silent padding
        chunk = Buffer.concat([chunk, padding]);
        console.log(`🔧 [SARVAM] Last chunk padded from ${chunk.length - paddingSize} to ${chunk.length} bytes`);
      }
      
      // Only send chunks that meet minimum SIP requirements
      if (chunk.length >= CHUNK_SIZE_20MS) {
        const base64Payload = chunk.toString("base64");
        
        const mediaMessage = {
          event: "media",
          streamSid: streamSid,
          media: {
            payload: base64Payload
          }
        };

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(mediaMessage));
          console.log(`📤 [SARVAM] Sent chunk ${i + 1}/${totalChunks} (${chunk.length} bytes)`);
        }
        
        // Timing delay to match real-time audio playback
        // 40ms chunks should be sent every 40ms for real-time streaming
        if (i < totalChunks - 1) {
          await new Promise(resolve => setTimeout(resolve, 40)); // 40ms delay for 40ms chunks
        }
      } else {
        console.log(`⚠️ [SARVAM] Skipping chunk ${i + 1} (${chunk.length} bytes - too small)`);
      }
    }

    console.log(`✅ [SARVAM] TTS completed in ${timer.end()}ms`);
  } catch (error) {
    console.error(`❌ [SARVAM] Error: ${error.message}`);
    timer.end();
    throw error;
  }
};

// Configurable Sarvam TTS implementation
const synthesizeWithSarvamConfigurable = async (text, language, ws, streamSid, chunkDurationMs = 40) => {
  const timer = createTimer("SARVAM_TTS_CONFIGURABLE");
  try {
    if (!API_KEYS.sarvam || !text.trim()) {
      timer.end();
      return;
    }

    const validVoice = getValidSarvamVoice(DEFAULT_CONFIG.voiceSelection);
    const sarvamLanguage = getSarvamLanguage(language);
    console.log(`🎵 [SARVAM] TTS: "${text}" (${sarvamLanguage}, ${validVoice}) - ${chunkDurationMs}ms chunks`);

    const requestBody = {
      inputs: [text],
      target_language_code: sarvamLanguage,
      speaker: validVoice,
      pitch: 0,
      pace: 1.1,
      loudness: 1.0,
      speech_sample_rate: 8000,
      enable_preprocessing: false,
      model: "bulbul:v1",
    };

    const response = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "API-Subscription-Key": API_KEYS.sarvam,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ [SARVAM] API error: ${response.status}`, errorText);
      timer.end();
      throw new Error(`Sarvam API error: ${response.status} - ${errorText}`);
    }

    const responseData = await response.json();

    if (!responseData.audios || responseData.audios.length === 0) {
      console.error("❌ [SARVAM] No audio data received");
      timer.end();
      throw new Error("Sarvam TTS: No audio data received");
    }

    const audioBase64 = responseData.audios[0];
    const audioBuffer = Buffer.from(audioBase64, "base64");

    // Calculate chunk size based on desired duration
    // Formula: (sample_rate * duration_in_seconds * bytes_per_sample)
    // For 8kHz, 16-bit PCM: 8000 * (duration_ms/1000) * 2
    const bytesPerMs = 8000 * 2 / 1000; // 16 bytes per millisecond
    const desiredChunkSize = Math.floor(chunkDurationMs * bytesPerMs);
    
    // Ensure chunk size is within SIP-friendly range (160-800 bytes)
    const minChunkSize = 160;  // 20ms
    const maxChunkSize = 800;  // 100ms
    const chunkSize = Math.max(minChunkSize, Math.min(desiredChunkSize, maxChunkSize));
    
    const totalChunks = Math.ceil(audioBuffer.length / chunkSize);
    const actualDurationMs = chunkSize / bytesPerMs;
    
    console.log(`📦 [SARVAM] Streaming ${audioBuffer.length} bytes in ${totalChunks} chunks (${chunkSize} bytes = ${actualDurationMs.toFixed(1)}ms each)`);

    // Send audio chunks with precise timing
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, audioBuffer.length);
      let chunk = audioBuffer.slice(start, end);
      
      // Handle the last chunk
      if (i === totalChunks - 1 && chunk.length < minChunkSize) {
        // Pad with silence if too small
        const paddingSize = minChunkSize - chunk.length;
        const padding = Buffer.alloc(paddingSize, 0);
        chunk = Buffer.concat([chunk, padding]);
        console.log(`🔧 [SARVAM] Last chunk padded to ${chunk.length} bytes`);
      }
      
      if (chunk.length >= minChunkSize) {
        const base64Payload = chunk.toString("base64");
        
        const mediaMessage = {
          event: "media",
          streamSid: streamSid,
          media: {
            payload: base64Payload
          }
        };

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(mediaMessage));
          console.log(`📤 [SARVAM] Sent chunk ${i + 1}/${totalChunks} (${chunk.length} bytes)`);
        }
        
        // Wait for the duration of the audio chunk before sending the next one
        if (i < totalChunks - 1) {
          await new Promise(resolve => setTimeout(resolve, actualDurationMs));
        }
      }
    }

    console.log(`✅ [SARVAM] TTS completed in ${timer.end()}ms`);
  } catch (error) {
    console.error(`❌ [SARVAM] Error: ${error.message}`);
    timer.end();
    throw error;
  }
};

// Enhanced streaming TTS processor with SIP-optimized chunking
const streamingTTSProcessor = (language, ws, streamSid, chunkDurationMs = 40) => {
  let textBuffer = "";
  let isProcessing = false;
  let processingQueue = [];

  const processChunk = async (chunk) => {
    if (isProcessing) {
      processingQueue.push(chunk);
      return;
    }

    isProcessing = true;
    
    try {
      // Process the chunk with configurable chunk duration
      await synthesizeWithSarvamConfigurable(chunk, language, ws, streamSid, chunkDurationMs);
      
      // Process queued chunks
      while (processingQueue.length > 0) {
        const queuedChunk = processingQueue.shift();
        await synthesizeWithSarvamConfigurable(queuedChunk, language, ws, streamSid, chunkDurationMs);
      }
    } catch (error) {
      console.error(`❌ [STREAMING_TTS] Error: ${error.message}`);
    } finally {
      isProcessing = false;
    }
  };

  return {
    addChunk: (chunk) => {
      processChunk(chunk);
    },
    complete: () => {
      // Final processing if needed
      console.log(`🏁 [STREAMING_TTS] Processing complete`);
    }
  };
};

// Main WebSocket server setup
const setupUnifiedVoiceServer = (wss) => {
  console.log("🚀 [C-ZENTRIX] Voice Server started");

  wss.on("connection", (ws, req) => {
    console.log("🔗 [CONNECTION] New C-Zentrix WebSocket connection");

    // Session state
    let streamSid = null;
    let callSid = null;
    let accountSid = null;
    let currentLanguage = "hi";
    let detectedLanguage = "hi";
    let conversationHistory = [];
    let isProcessing = false;
    let userUtteranceBuffer = "";
    let lastProcessedText = "";
    let sequenceNumber = 0;
    let streamingTTS = null;

    // Deepgram WebSocket connection
    let deepgramWs = null;
    let deepgramReady = false;
    let deepgramAudioBufferQueue = [];

    // Connect to Deepgram with optimized settings
    const connectToDeepgram = async () => {
      const timer = createTimer("DEEPGRAM_CONNECTION");
      try {
        if (!API_KEYS.deepgram) {
          throw new Error("Deepgram API key not available");
        }

        console.log("🔌 [DEEPGRAM] Connecting...");
        const deepgramLanguage = getDeepgramLanguage(currentLanguage);
        const deepgramUrl = new URL("wss://api.deepgram.com/v1/listen");
        deepgramUrl.searchParams.append("sample_rate", "8000");
        deepgramUrl.searchParams.append("channels", "1");
        deepgramUrl.searchParams.append("encoding", "linear16");
        deepgramUrl.searchParams.append("model", "nova-2");
        deepgramUrl.searchParams.append("language", deepgramLanguage);
        deepgramUrl.searchParams.append("interim_results", "true");
        deepgramUrl.searchParams.append("smart_format", "true");
        deepgramUrl.searchParams.append("endpointing", "300"); // Faster endpointing

        deepgramWs = new WebSocket(deepgramUrl.toString(), {
          headers: { Authorization: `Token ${API_KEYS.deepgram}` },
        });

        deepgramWs.onopen = () => {
          deepgramReady = true;
          console.log(`✅ [DEEPGRAM] Connected (${timer.end()}ms)`);
          
          // Send buffered audio
          if (deepgramAudioBufferQueue.length > 0) {
            for (const buffer of deepgramAudioBufferQueue) {
              deepgramWs.send(buffer);
            }
            deepgramAudioBufferQueue = [];
          }
        };

        deepgramWs.onmessage = async (event) => {
          try {
            const data = JSON.parse(event.data);
            await handleDeepgramResponse(data);
          } catch (error) {
            console.error("❌ [DEEPGRAM] Parse error:", error.message);
          }
        };

        deepgramWs.onerror = (error) => {
          console.error("❌ [DEEPGRAM] Connection error:", error);
          deepgramReady = false;
        };

        deepgramWs.onclose = () => {
          console.log("🔌 [DEEPGRAM] Connection closed");
          deepgramReady = false;
        };
      } catch (error) {
        console.error("❌ [DEEPGRAM] Setup error:", error.message);
        timer.end();
      }
    };

    // Handle Deepgram responses
    const handleDeepgramResponse = async (data) => {
      if (data.type === "Results") {
        const channel = data.channel;
        if (channel && channel.alternatives && channel.alternatives.length > 0) {
          const transcript = channel.alternatives[0].transcript;
          const is_final = data.is_final;
          
          if (transcript && transcript.trim()) {
            if (is_final) {
              userUtteranceBuffer += (userUtteranceBuffer ? " " : "") + transcript.trim();
              await processUserUtterance(userUtteranceBuffer);
              userUtteranceBuffer = "";
            }
          }
        }
      } else if (data.type === "UtteranceEnd") {
        if (userUtteranceBuffer.trim()) {
          await processUserUtterance(userUtteranceBuffer);
          userUtteranceBuffer = "";
        }
      }
    };

    // Process user utterance with streaming
    const processUserUtterance = async (text) => {
      if (!text.trim() || isProcessing || text === lastProcessedText) {
        return;
      }

      isProcessing = true;
      lastProcessedText = text;
      const timer = createTimer("UTTERANCE_PROCESSING");

      try {
        console.log(`🎤 [USER] Processing: "${text}"`);

        // Initialize streaming TTS processor with 40ms chunks
        streamingTTS = streamingTTSProcessor(detectedLanguage, ws, streamSid, 40);

        // Detect language (parallel processing)
        const languagePromise = detectLanguage(text);

        // Process with OpenAI streaming
        const responsePromise = processWithOpenAIStreaming(
          text, 
          conversationHistory, 
          detectedLanguage,
          (chunk) => {
            // Handle streaming chunks
            console.log(`📤 [STREAMING] Chunk: "${chunk}"`);
            streamingTTS.addChunk(chunk);
          },
          (fullResponse) => {
            // Handle completion
            console.log(`✅ [STREAMING] Complete: "${fullResponse}"`);
            streamingTTS.complete();
            
            // Update conversation history
            conversationHistory.push(
              { role: "user", content: text },
              { role: "assistant", content: fullResponse }
            );

            // Keep only last 8 messages for memory efficiency
            if (conversationHistory.length > 8) {
              conversationHistory = conversationHistory.slice(-8);
            }
          }
        );

        // Wait for both language detection and response
        const [newDetectedLanguage, response] = await Promise.all([languagePromise, responsePromise]);

        if (newDetectedLanguage !== detectedLanguage) {
          detectedLanguage = newDetectedLanguage;
          console.log(`🔄 [LANGUAGE] Changed to: ${detectedLanguage}`);
        }

        console.log(`⚡ [PROCESSING] Total time: ${timer.end()}ms`);
      } catch (error) {
        console.error(`❌ [PROCESSING] Error: ${error.message}`);
        timer.end();
      } finally {
        isProcessing = false;
      }
    };

    // Send initial greeting
    const sendInitialGreeting = async () => {
      console.log("👋 [GREETING] Sending initial greeting");
      await synthesizeWithSarvamOptimized(DEFAULT_CONFIG.firstMessage, currentLanguage, ws, streamSid);
    };

    // WebSocket message handling
    ws.on("message", async (message) => {
      try {
        const data = JSON.parse(message.toString());

        switch (data.event) {
          case "connected":
            console.log(`🔗 [C-ZENTRIX] Connected - Protocol: ${data.protocol} v${data.version}`);
            break;

          case "start":
            streamSid = data.streamSid || data.start?.streamSid;
            callSid = data.start?.callSid;
            accountSid = data.start?.accountSid;
            sequenceNumber = parseInt(data.sequenceNumber) || 0;
            
            console.log(`🎯 [C-ZENTRIX] Stream started - StreamSid: ${streamSid}`);
            
            // Connect to Deepgram and send greeting
            await connectToDeepgram();
            await sendInitialGreeting();
            break;

          case "media":
            if (data.media && data.media.payload) {
              const audioBuffer = Buffer.from(data.media.payload, "base64");
              
              // Send to Deepgram
              if (deepgramWs && deepgramReady && deepgramWs.readyState === WebSocket.OPEN) {
                deepgramWs.send(audioBuffer);
              } else {
                deepgramAudioBufferQueue.push(audioBuffer);
              }
            }
            break;

          case "stop":
            console.log(`📞 [C-ZENTRIX] Stream stopped`);
            if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
              deepgramWs.close();
            }
            break;

          case "dtmf":
            console.log(`📞 [C-ZENTRIX] DTMF: ${data.dtmf?.digit}`);
            break;

          default:
            console.log(`❓ [C-ZENTRIX] Unknown event: ${data.event}`);
        }
      } catch (error) {
        console.error(`❌ [C-ZENTRIX] Message processing error: ${error.message}`);
      }
    });

    // Connection cleanup
    ws.on("close", () => {
      console.log(`🔗 [C-ZENTRIX] Connection closed`);
      
      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.close();
      }

      // Reset state
      streamSid = null;
      callSid = null;
      accountSid = null;
      currentLanguage = "hi";
      detectedLanguage = "hi";
      conversationHistory = [];
      isProcessing = false;
      userUtteranceBuffer = "";
      lastProcessedText = "";
      deepgramReady = false;
      deepgramAudioBufferQueue = [];
      streamingTTS = null;
    });

    ws.on("error", (error) => {
      console.error(`❌ [C-ZENTRIX] WebSocket error: ${error.message}`);
    });
  });
};

module.exports = { setupUnifiedVoiceServer };
