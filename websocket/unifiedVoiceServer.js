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

// Ultra-optimized OpenAI streaming with aggressive phrase chunking
const processWithOpenAIStreaming = async (userMessage, conversationHistory, onPhrase, onComplete) => {
  const timer = createTimer("OPENAI_STREAMING");
  
  try {
    const systemPrompt = `You are ${DEFAULT_CONFIG.agentName}, a helpful voice assistant.
Language: ${DEFAULT_CONFIG.language}
Rules: Respond in Hindi, be conversational, keep responses under 100 chars, use short sentences.`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.slice(-4), // Reduced context for faster processing
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
        max_tokens: 60, // Reduced for faster responses
        temperature: 0.5, // Reduced for faster generation
        stream: true,
        presence_penalty: 0.1,
        frequency_penalty: 0.1,
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
              
              // More aggressive phrase chunking for faster TTS start
              if (shouldSendPhraseAggressive(phraseBuffer)) {
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

// More aggressive phrase detection for ultra-low latency
const shouldSendPhraseAggressive = (buffer) => {
  const trimmed = buffer.trim();
  
  // Send immediately on complete sentences
  if (/[.!?।]$/.test(trimmed)) return true;
  
  // Send on commas and shorter phrases (reduced threshold)
  if (trimmed.length >= 5 && /[,;।]\s*$/.test(trimmed)) return true;
  
  // Send on longer phrases (reduced threshold)
  if (trimmed.length >= 15 && /\s/.test(trimmed)) return true;
  
  // Send on word boundaries for very short responses
  if (trimmed.length >= 8 && /\s\S+$/.test(trimmed)) return true;
  
  return false;
};

// Ultra-optimized TTS processor with parallel processing and streaming
class UltraOptimizedSarvamTTSProcessor {
  constructor(language, ws, streamSid) {
    this.language = language;
    this.ws = ws;
    this.streamSid = streamSid;
    this.processingQueue = [];
    this.activeProcesses = new Set();
    this.sarvamLanguage = getSarvamLanguage(language);
    this.voice = getValidSarvamVoice(DEFAULT_CONFIG.voiceSelection);
    
    // Ultra-aggressive settings for minimum latency
    this.maxParallelProcesses = 3; // Allow multiple parallel TTS requests
    this.minPhraseLength = 3; // Process very short phrases
    this.maxProcessingDelay = 50; // Reduced processing delay
    
    // Audio streaming stats
    this.totalChunks = 0;
    this.totalAudioBytes = 0;
    this.firstAudioTime = null;
  }

  addPhrase(phrase) {
    if (!phrase.trim() || phrase.length < this.minPhraseLength) return;
    
    console.log(`📝 [TTS-QUEUE] Adding phrase: "${phrase}"`);
    
    // Add to queue and process immediately if we have capacity
    this.processingQueue.push({
      text: phrase.trim(),
      timestamp: Date.now(),
      id: `phrase_${this.totalChunks++}`
    });
    
    this.processNextInQueue();
  }

  async processNextInQueue() {
    // Check if we can start a new process
    if (this.activeProcesses.size >= this.maxParallelProcesses || this.processingQueue.length === 0) {
      return;
    }

    const phraseData = this.processingQueue.shift();
    if (!phraseData) return;

    const processId = `proc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.activeProcesses.add(processId);

    try {
      await this.synthesizeAndStreamUltraFast(phraseData.text, phraseData.id);
    } catch (error) {
      console.error(`❌ [TTS-ULTRA] Error processing phrase: ${error.message}`);
    } finally {
      this.activeProcesses.delete(processId);
      
      // Start next process if queue has items
      if (this.processingQueue.length > 0) {
        setTimeout(() => this.processNextInQueue(), 10);
      }
    }
  }

  async synthesizeAndStreamUltraFast(text, phraseId) {
    const timer = createTimer("ULTRA_FAST_TTS");
    
    try {
      console.log(`🚀 [TTS-ULTRA] Processing "${text}" (${phraseId})`);

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
          loudness: 1.0,
          speech_sample_rate: 8000,
          enable_preprocessing: false, // OPTIMIZATION: Disable preprocessing for speed
          model: "bulbul:v1",
        }),
      });

      if (!response.ok) {
        throw new Error(`Sarvam API error: ${response.status} - ${response.statusText}`);
      }

      const responseData = await response.json();
      const audioBase64 = responseData.audios?.[0];
      
      if (!audioBase64) {
        throw new Error("No audio data received from Sarvam API");
      }

      const synthesisTime = timer.end();
      console.log(`⚡ [TTS-ULTRA] Synthesis "${text}" completed in ${synthesisTime}ms`);
      
      // Track first audio timing
      if (!this.firstAudioTime) {
        this.firstAudioTime = synthesisTime;
        console.log(`🎯 [TTS-ULTRA] FIRST AUDIO: ${synthesisTime}ms`);
      }
      
      // Stream with ultra-optimized chunking
      await this.streamAudioUltraOptimized(audioBase64, phraseId);
      
    } catch (error) {
      console.error(`❌ [TTS-ULTRA] Synthesis error: ${error.message}`);
      throw error;
    }
  }

  async streamAudioUltraOptimized(audioBase64, phraseId) {
    const audioBuffer = Buffer.from(audioBase64, "base64");
    
    // Ultra-optimized SIP streaming with minimal delays
    const SAMPLE_RATE = 8000;
    const BYTES_PER_SAMPLE = 2;
    const BYTES_PER_MS = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;
    
    // Smaller chunk sizes for faster streaming
    const MIN_CHUNK_SIZE = Math.floor(15 * BYTES_PER_MS);   // 240 bytes (15ms)
    const OPTIMAL_CHUNK_SIZE = Math.floor(25 * BYTES_PER_MS); // 400 bytes (25ms)
    
    const alignToSample = (size) => Math.floor(size / 2) * 2;
    const minChunk = alignToSample(MIN_CHUNK_SIZE);
    const optimalChunk = alignToSample(OPTIMAL_CHUNK_SIZE);
    
    console.log(`📦 [TTS-ULTRA] Streaming ${audioBuffer.length} bytes (${phraseId})`);
    
    let position = 0;
    let chunkIndex = 0;
    
    while (position < audioBuffer.length) {
      const remaining = audioBuffer.length - position;
      const chunkSize = Math.min(remaining >= optimalChunk ? optimalChunk : remaining, remaining);
      
      if (chunkSize < minChunk && remaining > minChunk) {
        position += chunkSize;
        continue;
      }
      
      const chunk = audioBuffer.slice(position, position + chunkSize);
      
      if (chunk.length >= minChunk) {
        const durationMs = (chunk.length / BYTES_PER_MS).toFixed(1);
        
        // Send to SIP immediately
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
        
        // OPTIMIZATION: Minimal delay between chunks
        const chunkDurationMs = Math.floor(chunk.length / BYTES_PER_MS);
        const networkBufferMs = 1; // Reduced from 2-3ms to 1ms
        const delayMs = Math.max(chunkDurationMs - networkBufferMs, 5); // Reduced minimum delay
        
        if (position + chunkSize < audioBuffer.length) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        
        chunkIndex++;
      }
      
      position += chunkSize;
    }
    
    console.log(`✅ [TTS-ULTRA] Streamed ${chunkIndex} chunks (${phraseId})`);
    this.totalAudioBytes += audioBuffer.length;
  }

  complete() {
    console.log(`📊 [TTS-ULTRA] Completing - ${this.processingQueue.length} items in queue, ${this.activeProcesses.size} active`);
    
    // Force process remaining queue with higher concurrency
    this.maxParallelProcesses = 5; // Increase for final processing
    
    while (this.processingQueue.length > 0 && this.activeProcesses.size < this.maxParallelProcesses) {
      this.processNextInQueue();
    }
    
    // Log final stats
    console.log(`📊 [TTS-ULTRA-STATS] First audio: ${this.firstAudioTime}ms, Total: ${this.totalChunks} chunks, ${this.totalAudioBytes} bytes`);
  }

  getStats() {
    return {
      totalChunks: this.totalChunks,
      totalAudioBytes: this.totalAudioBytes,
      avgBytesPerChunk: this.totalChunks > 0 ? Math.round(this.totalAudioBytes / this.totalChunks) : 0,
      firstAudioTime: this.firstAudioTime,
      activeProcesses: this.activeProcesses.size,
      queueLength: this.processingQueue.length
    };
  }
}

// Main WebSocket server setup
const setupUnifiedVoiceServer = (wss) => {
  console.log("🚀 [ULTRA-OPTIMIZED] Voice Server started");

  wss.on("connection", (ws, req) => {
    console.log("🔗 [CONNECTION] New ultra-optimized WebSocket connection");

    // Session state
    let streamSid = null;
    let conversationHistory = [];
    let isProcessing = false;
    let userUtteranceBuffer = "";
    let lastProcessedText = "";
    let ultraOptimizedTTS = null;

    // Deepgram WebSocket connection
    let deepgramWs = null;
    let deepgramReady = false;
    let deepgramAudioQueue = [];

    // Ultra-optimized Deepgram connection
    const connectToDeepgram = async () => {
      try {
        console.log("🔌 [DEEPGRAM] Connecting...");
        const deepgramLanguage = getDeepgramLanguage(DEFAULT_CONFIG.language);
        
        const deepgramUrl = new URL("wss://api.deepgram.com/v1/listen");
        deepgramUrl.searchParams.append("sample_rate", "8000");
        deepgramUrl.searchParams.append("channels", "1");
        deepgramUrl.searchParams.append("encoding", "linear16");
        deepgramUrl.searchParams.append("model", "nova-2");
        deepgramUrl.searchParams.append("language", deepgramLanguage);
        deepgramUrl.searchParams.append("interim_results", "true");
        deepgramUrl.searchParams.append("smart_format", "true");
        deepgramUrl.searchParams.append("endpointing", "200"); // Even faster endpointing

        deepgramWs = new WebSocket(deepgramUrl.toString(), {
          headers: { Authorization: `Token ${API_KEYS.deepgram}` },
        });

        deepgramWs.onopen = () => {
          deepgramReady = true;
          console.log("✅ [DEEPGRAM] Connected with ultra-fast settings");
          
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

    // Ultra-optimized utterance processing
    const processUserUtterance = async (text) => {
      if (!text.trim() || isProcessing || text === lastProcessedText) return;

      isProcessing = true;
      lastProcessedText = text;
      const timer = createTimer("ULTRA_UTTERANCE_PROCESSING");

      try {
        console.log(`🎤 [USER] Processing: "${text}"`);

        // Initialize ultra-optimized TTS processor
        ultraOptimizedTTS = new UltraOptimizedSarvamTTSProcessor(DEFAULT_CONFIG.language, ws, streamSid);

        // Process with ultra-aggressive OpenAI streaming
        const response = await processWithOpenAIStreaming(
          text,
          conversationHistory,
          (phrase) => {
            // Handle phrase chunks with parallel TTS processing
            console.log(`📤 [PHRASE] "${phrase}"`);
            ultraOptimizedTTS.addPhrase(phrase);
          },
          (fullResponse) => {
            // Handle completion
            console.log(`✅ [COMPLETE] "${fullResponse}"`);
            ultraOptimizedTTS.complete();
            
            // Log ultra-optimized stats
            const stats = ultraOptimizedTTS.getStats();
            console.log(`📊 [ULTRA-STATS] First audio: ${stats.firstAudioTime}ms, ${stats.totalChunks} chunks, Active: ${stats.activeProcesses}, Queue: ${stats.queueLength}`);
            
            // Update conversation history
            conversationHistory.push(
              { role: "user", content: text },
              { role: "assistant", content: fullResponse }
            );

            // Keep last 8 messages for context (reduced from 10)
            if (conversationHistory.length > 8) {
              conversationHistory = conversationHistory.slice(-8);
            }
          }
        );

        console.log(`⚡ [ULTRA-TOTAL] Processing time: ${timer.end()}ms`);

      } catch (error) {
        console.error(`❌ [ULTRA-PROCESSING] Error: ${error.message}`);
      } finally {
        isProcessing = false;
      }
    };

    // Ultra-optimized initial greeting
    const sendInitialGreeting = async () => {
      console.log("👋 [GREETING] Sending ultra-optimized initial greeting");
      const tts = new UltraOptimizedSarvamTTSProcessor(DEFAULT_CONFIG.language, ws, streamSid);
      await tts.synthesizeAndStreamUltraFast(DEFAULT_CONFIG.firstMessage, "greeting");
    };

    // WebSocket message handling
    ws.on("message", async (message) => {
      try {
        const data = JSON.parse(message.toString());

        switch (data.event) {
          case "connected":
            console.log(`🔗 [ULTRA-OPTIMIZED] Connected - Protocol: ${data.protocol}`);
            break;

          case "start":
            streamSid = data.streamSid || data.start?.streamSid;
            console.log(`🎯 [ULTRA-OPTIMIZED] Stream started - StreamSid: ${streamSid}`);
            
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
            console.log(`📞 [ULTRA-OPTIMIZED] Stream stopped`);
            if (deepgramWs?.readyState === WebSocket.OPEN) {
              deepgramWs.close();
            }
            break;

          default:
            console.log(`❓ [ULTRA-OPTIMIZED] Unknown event: ${data.event}`);
        }
      } catch (error) {
        console.error(`❌ [ULTRA-OPTIMIZED] Message error: ${error.message}`);
      }
    });

    // Connection cleanup
    ws.on("close", () => {
      console.log("🔗 [ULTRA-OPTIMIZED] Connection closed");
      
      if (deepgramWs?.readyState === WebSocket.OPEN) {
        deepgramWs.close();
      }

      // Reset state
      streamSid = null;
      conversationHistory = [];
      isProcessing = false;
      userUtteranceBuffer = "";
      lastProcessedText = "";
      deepgramReady = false;
      deepgramAudioQueue = [];
      ultraOptimizedTTS = null;
    });

    ws.on("error", (error) => {
      console.error(`❌ [ULTRA-OPTIMIZED] WebSocket error: ${error.message}`);
    });
  });
};

module.exports = { setupUnifiedVoiceServer };
