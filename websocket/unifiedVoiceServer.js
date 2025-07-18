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
  hi: "hi-IN", en: "en-IN", bn: "bn-IN", te: "te-IN", ta: "ta-IN",
  mr: "mr-IN", gu: "gu-IN", kn: "kn-IN", ml: "ml-IN", pa: "pa-IN",
  or: "or-IN", as: "as-IN", ur: "ur-IN",
};

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
  firstMessage: "नमस्ते! मैं आपकी सहायता के लिए यहाँ हूँ।",
  personality: "friendly",
  category: "customer service",
  contextMemory: "customer service conversation in Hindi",
};

// Optimized language detection with caching
const languageCache = new Map();
const detectLanguage = async (text) => {
  const cacheKey = text.substring(0, 50); // Cache based on first 50 chars
  if (languageCache.has(cacheKey)) {
    return languageCache.get(cacheKey);
  }

  const timer = createTimer("LANGUAGE_DETECTION");
  
  try {
    if (!API_KEYS.openai || !text.trim()) {
      return "hi";
    }

    const requestBody = {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Detect language, respond with code only: hi, en, bn, te, ta, mr, gu, kn, ml, pa, or, as, ur`,
        },
        { role: "user", content: text.substring(0, 100) }, // Limit text for faster processing
      ],
      max_tokens: 3,
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
      console.error(`❌ [LANGUAGE_DETECT] Error: ${response.status}`);
      return "hi";
    }

    const data = await response.json();
    const detectedLang = data.choices?.[0]?.message?.content?.trim()?.toLowerCase() || "hi";
    
    // Cache the result
    languageCache.set(cacheKey, detectedLang);
    
    console.log(`🔍 [LANGUAGE_DETECT] ${detectedLang} (${timer.end()}ms)`);
    return detectedLang;
  } catch (error) {
    console.error(`❌ [LANGUAGE_DETECT] Error: ${error.message}`);
    return "hi";
  }
};

// Optimized OpenAI streaming with phrase-based chunking
const processWithOpenAIStreaming = async (userMessage, conversationHistory, currentLanguage, onPhrase, onComplete) => {
  const timer = createTimer("OPENAI_STREAMING");
  
  try {
    const systemPrompt = `You are ${DEFAULT_CONFIG.agentName}, a helpful voice assistant.
Language: ${currentLanguage}
Rules: Respond in user's language, be conversational, keep responses under 150 chars.`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.slice(-6), // Keep more context for better responses
      { role: "user", content: userMessage }
    ];

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEYS.openai}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        max_tokens: 100,
        temperature: 0.7,
        stream: true,
      }),
    });

    if (!response.ok) {
      console.error(`❌ [OPENAI] Error: ${response.status}`);
      return null;
    }

    let fullResponse = "";
    let phraseBuffer = "";
    let isFirstPhrase = true;

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
            if (phraseBuffer.trim()) {
              onPhrase(phraseBuffer.trim());
              fullResponse += phraseBuffer;
            }
            break;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            
            if (content) {
              phraseBuffer += content;
              
              // Phrase-based chunking: send when we have meaningful phrases
              if (shouldSendPhrase(phraseBuffer)) {
                const phrase = phraseBuffer.trim();
                if (phrase.length > 0) {
                  if (isFirstPhrase) {
                    console.log(`⚡ [OPENAI] First phrase (${timer.checkpoint('first_phrase')}ms)`);
                    isFirstPhrase = false;
                  }
                  onPhrase(phrase);
                  fullResponse += phrase;
                  phraseBuffer = "";
                }
              }
            }
          } catch (e) {
            // Skip malformed JSON
          }
        }
      }
    }

    console.log(`🤖 [OPENAI] Complete: "${fullResponse}" (${timer.end()}ms)`);
    onComplete(fullResponse);
    return fullResponse;

  } catch (error) {
    console.error(`❌ [OPENAI] Error: ${error.message}`);
    return null;
  }
};

// Smart phrase detection for better chunking
const shouldSendPhrase = (buffer) => {
  // Send phrase if we have:
  // 1. Complete sentence (ends with punctuation)
  // 2. Meaningful phrase (8+ chars with space)
  // 3. Natural break points
  
  const trimmed = buffer.trim();
  
  // Complete sentences
  if (/[.!?।]$/.test(trimmed)) return true;
  
  // Meaningful phrases with natural breaks
  if (trimmed.length >= 8 && /[,;।]\s*$/.test(trimmed)) return true;
  
  // Longer phrases (prevent too much buffering)
  if (trimmed.length >= 25 && /\s/.test(trimmed)) return true;
  
  return false;
};

// Ultra-optimized Sarvam TTS with intelligent batching
class OptimizedTTSProcessor {
  constructor(language, ws, streamSid) {
    this.language = language;
    this.ws = ws;
    this.streamSid = streamSid;
    this.queue = [];
    this.isProcessing = false;
    this.sarvamLanguage = getSarvamLanguage(language);
    this.voice = getValidSarvamVoice(DEFAULT_CONFIG.voiceSelection);
    
    // TTS optimization settings
    this.maxBatchSize = 3; // Process up to 3 phrases in batch
    this.processingTimeout = 150; // Max wait time before processing
    this.batchTimer = null;
  }

  addPhrase(phrase) {
    if (!phrase.trim()) return;
    
    this.queue.push(phrase.trim());
    
    // Process immediately if it's a complete sentence or queue is full
    if (this.shouldProcessImmediately(phrase) || this.queue.length >= this.maxBatchSize) {
      this.processQueue();
    } else {
      // Set timer for batch processing
      this.scheduleBatchProcessing();
    }
  }

  shouldProcessImmediately(phrase) {
    // Process immediately for complete sentences or urgent phrases
    return /[.!?।]$/.test(phrase.trim()) || phrase.length > 30;
  }

  scheduleBatchProcessing() {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    
    this.batchTimer = setTimeout(() => {
      if (this.queue.length > 0) {
        this.processQueue();
      }
    }, this.processingTimeout);
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    const phrasesToProcess = this.queue.splice(0, this.maxBatchSize);
    const batchText = phrasesToProcess.join(' ');

    try {
      await this.synthesizeOptimized(batchText);
    } catch (error) {
      console.error(`❌ [TTS_BATCH] Error: ${error.message}`);
    } finally {
      this.isProcessing = false;
      
      // Process remaining queue
      if (this.queue.length > 0) {
        setTimeout(() => this.processQueue(), 10);
      }
    }
  }

  async synthesizeOptimized(text) {
    const timer = createTimer("SARVAM_TTS_OPTIMIZED");
    
    try {
      console.log(`🎵 [SARVAM] TTS Batch: "${text}" (${this.sarvamLanguage})`);

      const response = await fetch("https://api.sarvam.ai/text-to-speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "API-Subscription-Key": API_KEYS.sarvam,
        },
        body: JSON.stringify({
          inputs: [text],
          target_language_code: this.sarvamLanguage,
          speaker: this.voice,
          pitch: 0,
          pace: 1.15, // Slightly faster pace
          loudness: 1.0,
          speech_sample_rate: 8000,
          enable_preprocessing: false,
          model: "bulbul:v1",
        }),
      });

      if (!response.ok) {
        throw new Error(`Sarvam API error: ${response.status}`);
      }

      const responseData = await response.json();
      const audioBase64 = responseData.audios?.[0];
      
      if (!audioBase64) {
        throw new Error("No audio data received");
      }

      await this.streamAudioOptimized(audioBase64);
      console.log(`✅ [SARVAM] TTS completed in ${timer.end()}ms`);

    } catch (error) {
      console.error(`❌ [SARVAM] Error: ${error.message}`);
      throw error;
    }
  }

  async streamAudioOptimized(audioBase64) {
    const audioBuffer = Buffer.from(audioBase64, "base64");
    
    // Optimized chunking for SIP: 160-800 bytes chunks for <20ms intervals
    const optimalChunkSize = 640; // 40ms of audio at 8kHz
    const minChunkSize = 160;     // 20ms minimum
    
    const totalChunks = Math.ceil(audioBuffer.length / optimalChunkSize);
    console.log(`📦 [SARVAM] Streaming ${audioBuffer.length} bytes in ${totalChunks} chunks`);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * optimalChunkSize;
      const end = Math.min(start + optimalChunkSize, audioBuffer.length);
      const chunk = audioBuffer.slice(start, end);
      
      if (chunk.length >= minChunkSize) {
        const mediaMessage = {
          event: "media",
          streamSid: this.streamSid,
          media: {
            payload: chunk.toString("base64")
          }
        };

        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify(mediaMessage));
        }
        
        // Optimal delay for SIP streaming (15ms for smooth playback)
        if (i < totalChunks - 1) {
          await new Promise(resolve => setTimeout(resolve, 15));
        }
      }
    }
  }

  complete() {
    // Force process any remaining queue
    if (this.queue.length > 0) {
      this.processQueue();
    }
  }
}

// Main WebSocket server setup
const setupUnifiedVoiceServer = (wss) => {
  console.log("🚀 [OPTIMIZED] Voice Server started");

  wss.on("connection", (ws, req) => {
    console.log("🔗 [CONNECTION] New optimized WebSocket connection");

    // Session state
    let streamSid = null;
    let currentLanguage = "hi";
    let detectedLanguage = "hi";
    let conversationHistory = [];
    let isProcessing = false;
    let userUtteranceBuffer = "";
    let lastProcessedText = "";
    let optimizedTTS = null;

    // Deepgram WebSocket connection
    let deepgramWs = null;
    let deepgramReady = false;
    let deepgramAudioQueue = [];

    // Optimized Deepgram connection
    const connectToDeepgram = async () => {
      try {
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
          console.log("✅ [DEEPGRAM] Connected");
          
          // Send buffered audio
          deepgramAudioQueue.forEach(buffer => deepgramWs.send(buffer));
          deepgramAudioQueue = [];
        };

        deepgramWs.onmessage = async (event) => {
          const data = JSON.parse(event.data);
          await handleDeepgramResponse(data);
        };

        deepgramWs.onerror = (error) => {
          console.error("❌ [DEEPGRAM] Error:", error);
          deepgramReady = false;
        };

        deepgramWs.onclose = () => {
          console.log("🔌 [DEEPGRAM] Connection closed");
          deepgramReady = false;
        };

      } catch (error) {
        console.error("❌ [DEEPGRAM] Setup error:", error.message);
      }
    };

    // Handle Deepgram responses
    const handleDeepgramResponse = async (data) => {
      if (data.type === "Results") {
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        const is_final = data.is_final;
        
        if (transcript?.trim()) {
          if (is_final) {
            userUtteranceBuffer += (userUtteranceBuffer ? " " : "") + transcript.trim();
            await processUserUtterance(userUtteranceBuffer);
            userUtteranceBuffer = "";
          }
        }
      } else if (data.type === "UtteranceEnd") {
        if (userUtteranceBuffer.trim()) {
          await processUserUtterance(userUtteranceBuffer);
          userUtteranceBuffer = "";
        }
      }
    };

    // Optimized utterance processing
    const processUserUtterance = async (text) => {
      if (!text.trim() || isProcessing || text === lastProcessedText) return;

      isProcessing = true;
      lastProcessedText = text;
      const timer = createTimer("UTTERANCE_PROCESSING");

      try {
        console.log(`🎤 [USER] Processing: "${text}"`);

        // Initialize optimized TTS processor
        optimizedTTS = new OptimizedTTSProcessor(detectedLanguage, ws, streamSid);

        // Process language detection and OpenAI in parallel
        const languagePromise = detectLanguage(text);
        
        const responsePromise = processWithOpenAIStreaming(
          text,
          conversationHistory,
          detectedLanguage,
          (phrase) => {
            // Handle phrase chunks
            console.log(`📤 [PHRASE] "${phrase}"`);
            optimizedTTS.addPhrase(phrase);
          },
          (fullResponse) => {
            // Handle completion
            console.log(`✅ [COMPLETE] "${fullResponse}"`);
            optimizedTTS.complete();
            
            // Update conversation history
            conversationHistory.push(
              { role: "user", content: text },
              { role: "assistant", content: fullResponse }
            );

            // Keep last 10 messages for context
            if (conversationHistory.length > 10) {
              conversationHistory = conversationHistory.slice(-10);
            }
          }
        );

        // Wait for both operations
        const [newLanguage, response] = await Promise.all([languagePromise, responsePromise]);

        if (newLanguage !== detectedLanguage) {
          detectedLanguage = newLanguage;
          console.log(`🔄 [LANGUAGE] Changed to: ${detectedLanguage}`);
        }

        console.log(`⚡ [TOTAL] Processing time: ${timer.end()}ms`);

      } catch (error) {
        console.error(`❌ [PROCESSING] Error: ${error.message}`);
      } finally {
        isProcessing = false;
      }
    };

    // Optimized initial greeting
    const sendInitialGreeting = async () => {
      console.log("👋 [GREETING] Sending initial greeting");
      const tts = new OptimizedTTSProcessor(currentLanguage, ws, streamSid);
      await tts.synthesizeOptimized(DEFAULT_CONFIG.firstMessage);
    };

    // WebSocket message handling
    ws.on("message", async (message) => {
      try {
        const data = JSON.parse(message.toString());

        switch (data.event) {
          case "connected":
            console.log(`🔗 [OPTIMIZED] Connected - Protocol: ${data.protocol}`);
            break;

          case "start":
            streamSid = data.streamSid || data.start?.streamSid;
            console.log(`🎯 [OPTIMIZED] Stream started - StreamSid: ${streamSid}`);
            
            await connectToDeepgram();
            await sendInitialGreeting();
            break;

          case "media":
            if (data.media?.payload) {
              const audioBuffer = Buffer.from(data.media.payload, "base64");
              
              if (deepgramWs && deepgramReady && deepgramWs.readyState === WebSocket.OPEN) {
                deepgramWs.send(audioBuffer);
              } else {
                deepgramAudioQueue.push(audioBuffer);
              }
            }
            break;

          case "stop":
            console.log(`📞 [OPTIMIZED] Stream stopped`);
            if (deepgramWs?.readyState === WebSocket.OPEN) {
              deepgramWs.close();
            }
            break;

          default:
            console.log(`❓ [OPTIMIZED] Unknown event: ${data.event}`);
        }
      } catch (error) {
        console.error(`❌ [OPTIMIZED] Message error: ${error.message}`);
      }
    });

    // Connection cleanup
    ws.on("close", () => {
      console.log("🔗 [OPTIMIZED] Connection closed");
      
      if (deepgramWs?.readyState === WebSocket.OPEN) {
        deepgramWs.close();
      }

      // Reset state
      streamSid = null;
      currentLanguage = "hi";
      detectedLanguage = "hi";
      conversationHistory = [];
      isProcessing = false;
      userUtteranceBuffer = "";
      lastProcessedText = "";
      deepgramReady = false;
      deepgramAudioQueue = [];
      optimizedTTS = null;
    });

    ws.on("error", (error) => {
      console.error(`❌ [OPTIMIZED] WebSocket error: ${error.message}`);
    });
  });
};

module.exports = { setupUnifiedVoiceServer };
