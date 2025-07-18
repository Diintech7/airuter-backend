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

// Language detection using OpenAI
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
          content: `You are a language detector. Detect the language of the given text and respond with just the language code (hi for Hindi, en for English, bn for Bengali, te for Telugu, ta for Tamil, mr for Marathi, gu for Gujarati, kn for Kannada, ml for Malayalam, pa for Punjabi, or for Odia, as for Assamese, ur for Urdu). If you're unsure or the text is mixed, respond with the dominant language. Only respond with the language code, nothing else.`,
        },
        {
          role: "user",
          content: text,
        },
      ],
      max_tokens: 10,
      temperature: 0.1,
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

// OpenAI LLM processing
const processWithOpenAI = async (userMessage, conversationHistory, currentLanguage) => {
  const timer = createTimer("OPENAI_PROCESSING");
  
  try {
    if (!API_KEYS.openai || !userMessage.trim()) {
      timer.end();
      return null;
    }

    const systemPrompt = `You are ${DEFAULT_CONFIG.agentName}, a helpful Hindi voice assistant for customer service.

LANGUAGE INSTRUCTIONS:
- Default language: Hindi (hi)
- Current user language: ${currentLanguage || "hi"}
- Always respond in the same language as the user
- Keep responses short and conversational (1-2 sentences max)
- Be helpful and friendly
- Context: ${DEFAULT_CONFIG.contextMemory}

RESPONSE GUIDELINES:
- Maximum 150 characters
- Natural conversational tone
- Direct and helpful responses`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.slice(-6), // Keep last 6 messages for context
      { role: "user", content: userMessage }
    ];

    const requestBody = {
      model: "gpt-4o-mini",
      messages: messages,
      max_tokens: 100,
      temperature: 0.7,
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

    const data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
      const openaiResponse = data.choices[0].message.content.trim();
      console.log(`🤖 [OPENAI] Response: "${openaiResponse}" (${timer.end()}ms)`);
      return openaiResponse;
    }

    timer.end();
    return null;
  } catch (error) {
    console.error(`❌ [OPENAI] Error: ${error.message}`);
    timer.end();
    return null;
  }
};

// Convert audio between formats
const convertAudioFormat = (audioBuffer, fromFormat, toFormat) => {
  // For now, we'll assume the audio is compatible
  // In production, you might need actual audio conversion
  return audioBuffer;
};

// Sarvam TTS with C-Zentrix compatible streaming
const synthesizeWithSarvam = async (text, language, ws, streamSid) => {
  const timer = createTimer("SARVAM_TTS_TOTAL");
  try {
    if (!API_KEYS.sarvam || !text.trim()) {
      timer.end();
      return;
    }

    const validVoice = getValidSarvamVoice(DEFAULT_CONFIG.voiceSelection);
    const sarvamLanguage = getSarvamLanguage(language);
    console.log(`🎵 [SARVAM] Starting TTS: "${text}" (${sarvamLanguage}, ${validVoice})`);

    const requestBody = {
      inputs: [text],
      target_language_code: sarvamLanguage,
      speaker: validVoice,
      pitch: 0,
      pace: 1.0,
      loudness: 1.0,
      speech_sample_rate: 8000, // Match C-Zentrix requirement
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
    console.log("🟢 [SARVAM] API response received");

    if (!responseData.audios || responseData.audios.length === 0) {
      console.error("❌ [SARVAM] No audio data received");
      timer.end();
      throw new Error("Sarvam TTS: No audio data received");
    }

    const audioBase64 = responseData.audios[0];
    const audioBuffer = Buffer.from(audioBase64, "base64");

    // Split into chunks as per C-Zentrix requirements (160-8000 bytes)
    const chunkSize = 1600; // Optimal chunk size for 8kHz audio
    const totalChunks = Math.ceil(audioBuffer.length / chunkSize);
    
    console.log(`📦 [SARVAM] Splitting ${audioBuffer.length} bytes into ${totalChunks} chunks`);

    // Send audio chunks to C-Zentrix
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, audioBuffer.length);
      const chunk = audioBuffer.slice(start, end);
      
      if (chunk.length >= 160) { // C-Zentrix minimum chunk size
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
          console.log(`📤 [SARVAM->CZ] Sent chunk ${i + 1}/${totalChunks} (${chunk.length} bytes)`);
        }
        
        // Small delay to prevent overwhelming the stream
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }

    console.log(`✅ [SARVAM] TTS completed: ${totalChunks} chunks, ${audioBuffer.length} bytes (${timer.end()}ms)`);
  } catch (error) {
    console.error(`❌ [SARVAM] Error: ${error.message}`);
    timer.end();
    throw error;
  }
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

    // Deepgram WebSocket connection
    let deepgramWs = null;
    let deepgramReady = false;
    let deepgramAudioBufferQueue = [];

    // Connect to Deepgram
    const connectToDeepgram = async () => {
      const timer = createTimer("DEEPGRAM_CONNECTION");
      try {
        if (!API_KEYS.deepgram) {
          throw new Error("Deepgram API key not available");
        }

        console.log("🔌 [DEEPGRAM] Connecting to Deepgram...");
        const deepgramLanguage = getDeepgramLanguage(currentLanguage);
        const deepgramUrl = new URL("wss://api.deepgram.com/v1/listen");
        deepgramUrl.searchParams.append("sample_rate", "8000");
        deepgramUrl.searchParams.append("channels", "1");
        deepgramUrl.searchParams.append("encoding", "linear16");
        deepgramUrl.searchParams.append("model", "nova-2");
        deepgramUrl.searchParams.append("language", deepgramLanguage);
        deepgramUrl.searchParams.append("interim_results", "true");
        deepgramUrl.searchParams.append("smart_format", "true");
        deepgramUrl.searchParams.append("endpointing", "300");

        deepgramWs = new WebSocket(deepgramUrl.toString(), {
          headers: { Authorization: `Token ${API_KEYS.deepgram}` },
        });

        deepgramWs.onopen = () => {
          deepgramReady = true;
          console.log(`✅ [DEEPGRAM] Connected (${timer.end()}ms)`);
          
          // Send buffered audio
          if (deepgramAudioBufferQueue.length > 0) {
            console.log(`⏩ [DEEPGRAM] Sending ${deepgramAudioBufferQueue.length} buffered chunks`);
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
          const confidence = channel.alternatives[0].confidence;
          const is_final = data.is_final;
          
          if (transcript && transcript.trim()) {
            console.log(`📝 [DEEPGRAM] Transcript: "${transcript}" (final: ${is_final})`);
            
            if (is_final) {
              userUtteranceBuffer += (userUtteranceBuffer ? " " : "") + transcript.trim();
              await processUserUtterance(userUtteranceBuffer);
              userUtteranceBuffer = "";
            }
          }
        }
      } else if (data.type === "UtteranceEnd") {
        console.log("🔚 [DEEPGRAM] Utterance ended");
        if (userUtteranceBuffer.trim()) {
          await processUserUtterance(userUtteranceBuffer);
          userUtteranceBuffer = "";
        }
      }
    };

    // Process user utterance
    const processUserUtterance = async (text) => {
      if (!text.trim() || isProcessing || text === lastProcessedText) {
        return;
      }

      isProcessing = true;
      lastProcessedText = text;
      const timer = createTimer("USER_UTTERANCE_PROCESSING");

      try {
        console.log(`🎤 [USER] Processing: "${text}"`);

        // Step 1: Detect language
        const newDetectedLanguage = await detectLanguage(text);
        if (newDetectedLanguage !== detectedLanguage) {
          detectedLanguage = newDetectedLanguage;
          console.log(`🔄 [LANGUAGE] Changed to: ${detectedLanguage}`);
        }

        // Step 2: Process with OpenAI
        const response = await processWithOpenAI(text, conversationHistory, detectedLanguage);
        
        if (response) {
          console.log(`🤖 [RESPONSE] Generated: "${response}"`);
          
          // Update conversation history
          conversationHistory.push(
            { role: "user", content: text },
            { role: "assistant", content: response }
          );

          // Keep only last 10 messages
          if (conversationHistory.length > 10) {
            conversationHistory = conversationHistory.slice(-10);
          }

          // Step 3: Synthesize with Sarvam
          await synthesizeWithSarvam(response, detectedLanguage, ws, streamSid);
        }

        console.log(`✅ [PROCESSING] Completed in ${timer.end()}ms`);
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
      await synthesizeWithSarvam(DEFAULT_CONFIG.firstMessage, currentLanguage, ws, streamSid);
    };

    // WebSocket message handling
    ws.on("message", async (message) => {
      try {
        const data = JSON.parse(message.toString());
        console.log(`📨 [C-ZENTRIX] Received:`, data.event || data.type);

        switch (data.event) {
          case "connected":
            console.log(`🔗 [C-ZENTRIX] Connected - Protocol: ${data.protocol} v${data.version}`);
            break;

          case "start":
            streamSid = data.streamSid || data.start?.streamSid;
            callSid = data.start?.callSid;
            accountSid = data.start?.accountSid;
            sequenceNumber = parseInt(data.sequenceNumber) || 0;
            
            console.log(`🎯 [C-ZENTRIX] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
            
            // Connect to Deepgram and send greeting
            await connectToDeepgram();
            await sendInitialGreeting();
            break;

          case "media":
            if (data.media && data.media.payload) {
              const audioBuffer = Buffer.from(data.media.payload, "base64");
              console.log(`🎧 [C-ZENTRIX] Media chunk ${data.media.chunk}: ${audioBuffer.length} bytes`);
              
              // Send to Deepgram
              if (deepgramWs && deepgramReady && deepgramWs.readyState === WebSocket.OPEN) {
                deepgramWs.send(audioBuffer);
              } else {
                deepgramAudioBufferQueue.push(audioBuffer);
              }
            }
            break;

          case "stop":
            console.log(`📞 [C-ZENTRIX] Stream stopped - CallSid: ${data.stop?.callSid}`);
            if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
              deepgramWs.close();
            }
            break;

          case "dtmf":
            console.log(`📞 [C-ZENTRIX] DTMF: ${data.dtmf?.digit}`);
            break;

          case "vad":
            console.log(`🎙️ [C-ZENTRIX] VAD: ${data.vad?.value}`);
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
      console.log(`🔗 [C-ZENTRIX] Connection closed - StreamSid: ${streamSid}`);
      
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
    });

    ws.on("error", (error) => {
      console.error(`❌ [C-ZENTRIX] WebSocket error: ${error.message}`);
    });
  });
};

module.exports = { setupUnifiedVoiceServer };
