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

// Optimized Sarvam TTS with faster processing
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
      pace: 1.1, // Slightly faster pace
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

    // Optimized chunking for better streaming performance
    const chunkSize = 1280; // Optimized chunk size
    const totalChunks = Math.ceil(audioBuffer.length / chunkSize);
    
    console.log(`📦 [SARVAM] Streaming ${audioBuffer.length} bytes in ${totalChunks} chunks`);

    // Send audio chunks with minimal delay
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, audioBuffer.length);
      const chunk = audioBuffer.slice(start, end);
      
      if (chunk.length >= 160) {
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
        }
        
        // Reduced delay for faster streaming
        if (i < totalChunks - 1) {
          await new Promise(resolve => setTimeout(resolve, 10));
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

// Chunk-based TTS for streaming responses
const streamingTTSProcessor = (language, ws, streamSid) => {
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
      // Process the chunk immediately for low latency
      await synthesizeWithSarvamOptimized(chunk, language, ws, streamSid);
      
      // Process queued chunks
      while (processingQueue.length > 0) {
        const queuedChunk = processingQueue.shift();
        await synthesizeWithSarvamOptimized(queuedChunk, language, ws, streamSid);
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

        // Initialize streaming TTS processor
        streamingTTS = streamingTTSProcessor(detectedLanguage, ws, streamSid);

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
