const WebSocket = require("ws");

// Load API keys from environment variables
const API_KEYS = {
  deepgram: process.env.DEEPGRAM_API_KEY,
  elevenlabs: process.env.ELEVENLABS_API_KEY,
  openai: process.env.OPENAI_API_KEY,
};

// Validate API keys
if (!API_KEYS.deepgram || !API_KEYS.elevenlabs || !API_KEYS.openai) {
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

// Language mappings for Deepgram
const getDeepgramLanguage = (detectedLang, defaultLang = "hi") => {
  const lang = detectedLang?.toLowerCase() || defaultLang;
  if (lang === "hi") return "hi";
  if (lang === "en") return "en-IN";
  return lang;
};

// ElevenLabs voice configuration for WebSocket streaming
const ELEVENLABS_CONFIG = {
  // Popular multilingual voices from ElevenLabs
  voices: {
    "male-professional": "21m00Tcm4TlvDq8ikWAM", // Rachel (English)
    "female-professional": "AZnzlk1XvdvUeBnXmlld", // Domi (English)
    "male-friendly": "29vD33N1CtxCmqQRPOHJ", // Drew (English)
    "female-friendly": "21m00Tcm4TlvDq8ikWAM", // Rachel (English)
    "multilingual-male": "onwK4e9ZLuTAKqWW03F9", // Daniel (Multilingual)
    "multilingual-female": "Xb7hH8MSUJpSbSDYk0k2", // Alice (Multilingual)
    neutral: "21m00Tcm4TlvDq8ikWAM",
    default: "21m00Tcm4TlvDq8ikWAM",
  },
  
  // Model configuration optimized for WebSocket streaming
  model: "eleven_turbo_v2", // Fastest model for real-time streaming
  
  // Voice settings optimized for real-time WebSocket streaming
  voiceSettings: {
    stability: 0.4,        // Lower for faster response
    similarity_boost: 0.7, // Balanced for speed and quality
    style: 0.1,            // Minimal style for faster processing
    use_speaker_boost: false // Disable for faster processing
  },
  
  // WebSocket streaming configuration
  streamingConfig: {
    chunk_length_schedule: [50, 80, 120, 160, 200], // Optimized for ultra-low latency
    enable_ssml_parsing: false, // Disable for faster processing
    optimize_streaming_latency: 3, // Maximum optimization
    output_format: "pcm_16000"
  }
};

const getElevenLabsVoice = (voiceSelection = "multilingual-female") => {
  return ELEVENLABS_CONFIG.voices[voiceSelection] || ELEVENLABS_CONFIG.voices.default;
};

// Basic configuration
const DEFAULT_CONFIG = {
  agentName: "Voice Assistant",
  language: "hi",
  voiceSelection: "multilingual-female",
  firstMessage: "नमस्ते! मैं आपकी सहायता के लिए यहाँ हूँ।",
  personality: "friendly",
  category: "customer service",
  contextMemory: "customer service conversation in Hindi",
};

// Optimized OpenAI streaming with phrase-based chunking
const processWithOpenAIStreaming = async (userMessage, conversationHistory, onPhrase, onComplete) => {
  const timer = createTimer("OPENAI_STREAMING");
  
  try {
    const systemPrompt = `You are ${DEFAULT_CONFIG.agentName}, a helpful voice assistant.
Language: ${DEFAULT_CONFIG.language}
Rules: Respond in Hindi, be conversational, keep responses under 150 chars.`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.slice(-6),
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
        max_tokens: 50,
        temperature: 0.3,
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
  const trimmed = buffer.trim();
  
  // Complete sentences
  if (/[.!?।]$/.test(trimmed)) return true;
  
  // Meaningful phrases with natural breaks
  if (trimmed.length >= 8 && /[,;।]\s*$/.test(trimmed)) return true;
  
  // Longer phrases (prevent too much buffering)
  if (trimmed.length >= 25 && /\s/.test(trimmed)) return true;
  
  return false;
};

// Enhanced TTS processor with ElevenLabs streaming
class OptimizedElevenLabsTTSProcessor {
  constructor(language, ws, streamSid) {
    this.language = language;
    this.ws = ws;
    this.streamSid = streamSid;
    this.queue = [];
    this.isProcessing = false;
    this.voice = getElevenLabsVoice(DEFAULT_CONFIG.voiceSelection);
    
    // Sentence-based processing settings optimized for WebSocket
    this.sentenceBuffer = "";
    this.processingTimeout = 50; // Even faster processing for WebSocket streaming
    this.sentenceTimer = null;
    
    // Audio streaming stats
    this.totalChunks = 0;
    this.totalAudioBytes = 0;
    
    console.log(`🎵 [ELEVENLABS-WS] Initialized with voice: ${this.voice} (WebSocket streaming)`);
  }

  addPhrase(phrase) {
    if (!phrase.trim()) return;
    
    this.sentenceBuffer += (this.sentenceBuffer ? " " : "") + phrase.trim();
    
    if (this.hasCompleteSentence(this.sentenceBuffer)) {
      this.processCompleteSentences();
    } else {
      this.scheduleProcessing();
    }
  }

  hasCompleteSentence(text) {
    return /[.!?।॥]/.test(text);
  }

  extractCompleteSentences(text) {
    const sentences = text.split(/([.!?।॥])/).filter(s => s.trim());
    
    let completeSentences = "";
    let remainingText = "";
    
    for (let i = 0; i < sentences.length; i += 2) {
      const sentence = sentences[i];
      const punctuation = sentences[i + 1];
      
      if (punctuation) {
        completeSentences += sentence + punctuation + " ";
      } else {
        remainingText = sentence;
      }
    }
    
    return {
      complete: completeSentences.trim(),
      remaining: remainingText.trim()
    };
  }

  processCompleteSentences() {
    if (this.sentenceTimer) {
      clearTimeout(this.sentenceTimer);
      this.sentenceTimer = null;
    }

    const { complete, remaining } = this.extractCompleteSentences(this.sentenceBuffer);
    
    if (complete) {
      this.queue.push(complete);
      this.sentenceBuffer = remaining;
      this.processQueue();
    }
  }

  scheduleProcessing() {
    if (this.sentenceTimer) clearTimeout(this.sentenceTimer);
    
    this.sentenceTimer = setTimeout(() => {
      if (this.sentenceBuffer.trim()) {
        this.queue.push(this.sentenceBuffer.trim());
        this.sentenceBuffer = "";
        this.processQueue();
      }
    }, this.processingTimeout);
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    const textToProcess = this.queue.shift();

    try {
      await this.synthesizeAndStreamWithElevenLabs(textToProcess);
    } catch (error) {
      console.error(`❌ [ELEVENLABS-TTS] Error: ${error.message}`);
    } finally {
      this.isProcessing = false;
      
      if (this.queue.length > 0) {
        setTimeout(() => this.processQueue(), 10);
      }
    }
  }

  async synthesizeAndStreamWithElevenLabs(text) {
    const timer = createTimer("ELEVENLABS_TTS_WS");
    
    try {
      console.log(`🎵 [ELEVENLABS-WS] Synthesizing: "${text}"`);

      // Use WebSocket for real-time streaming
      await this.streamWithWebSocket(text, timer);
      
      console.log(`✅ [ELEVENLABS-WS] Complete synthesis in ${timer.end()}ms`);
      
    } catch (error) {
      console.error(`❌ [ELEVENLABS-WS] Synthesis error: ${error.message}`);
      throw error;
    }
  }

  async streamWithWebSocket(text, timer) {
    return new Promise((resolve, reject) => {
      // ElevenLabs WebSocket URL
      const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${this.voice}/stream-input?model_id=${ELEVENLABS_CONFIG.model}&output_format=pcm_16000`;
      
      const elevenLabsWs = new WebSocket(wsUrl, {
        headers: {
          "xi-api-key": API_KEYS.elevenlabs,
        },
      });

      let chunkIndex = 0;
      let totalBytes = 0;
      let isFirstChunk = true;
      let audioBuffer = Buffer.alloc(0);
      
      // Target chunk size for SIP (20ms of 8kHz audio)
      const TARGET_CHUNK_SIZE = (8000 * 2 * 20) / 1000; // 320 bytes

      elevenLabsWs.onopen = () => {
        console.log(`🔗 [ELEVENLABS-WS] Connected for text: "${text}"`);
        
        // Send initial configuration
        const config = {
          text: text,
          voice_settings: ELEVENLABS_CONFIG.voiceSettings,
          generation_config: {
            chunk_length_schedule: [120, 160, 250, 290] // Optimized for low latency
          }
        };

        elevenLabsWs.send(JSON.stringify(config));
        
        // Send EOS (End of Stream) signal
        elevenLabsWs.send(JSON.stringify({ text: "" }));
      };

      elevenLabsWs.onmessage = async (event) => {
        try {
          if (typeof event.data === 'string') {
            const response = JSON.parse(event.data);
            
            if (response.error) {
              console.error(`❌ [ELEVENLABS-WS] Error: ${response.error}`);
              reject(new Error(response.error));
              return;
            }
            
            if (response.audio) {
              // Decode base64 audio
              const audioChunk = Buffer.from(response.audio, 'base64');
              
              if (isFirstChunk) {
                console.log(`⚡ [ELEVENLABS-WS] First audio chunk (${timer.checkpoint('first_audio')}ms)`);
                isFirstChunk = false;
              }
              
              // Accumulate audio data
              audioBuffer = Buffer.concat([audioBuffer, audioChunk]);
              totalBytes += audioChunk.length;
              
              // Process and send chunks when we have enough data
              await this.processAccumulatedAudio(audioBuffer, chunkIndex, TARGET_CHUNK_SIZE);
              
              // Keep only unprocessed audio
              const processedSize = Math.floor(audioBuffer.length / (TARGET_CHUNK_SIZE * 2)) * (TARGET_CHUNK_SIZE * 2);
              audioBuffer = audioBuffer.slice(processedSize);
              chunkIndex += Math.floor(processedSize / (TARGET_CHUNK_SIZE * 2));
            }
            
            if (response.isFinal) {
              // Process any remaining audio
              if (audioBuffer.length > 0) {
                await this.processAndSendFinalChunk(audioBuffer, chunkIndex);
              }
              
              console.log(`📊 [ELEVENLABS-WS] Stream complete: ${chunkIndex} chunks, ${totalBytes} bytes`);
              elevenLabsWs.close();
              resolve();
            }
            
          } else {
            console.log(`❓ [ELEVENLABS-WS] Received binary data: ${event.data.byteLength} bytes`);
          }
          
        } catch (error) {
          console.error(`❌ [ELEVENLABS-WS] Message processing error: ${error.message}`);
          reject(error);
        }
      };

      elevenLabsWs.onerror = (error) => {
        console.error(`❌ [ELEVENLABS-WS] WebSocket error:`, error);
        reject(error);
      };

      elevenLabsWs.onclose = (event) => {
        console.log(`🔌 [ELEVENLABS-WS] Connection closed: ${event.code} - ${event.reason}`);
        if (event.code !== 1000) {
          reject(new Error(`WebSocket closed unexpectedly: ${event.code}`));
        }
      };

      // Timeout handling
      setTimeout(() => {
        if (elevenLabsWs.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
          reject(new Error("WebSocket timeout"));
        }
      }, 10000); // 10 second timeout
    });
  }

  async processAccumulatedAudio(audioBuffer, startIndex, targetChunkSize) {
    const sourceChunkSize = targetChunkSize * 2; // 16kHz to 8kHz ratio
    let chunkIndex = startIndex;
    
    while (audioBuffer.length >= sourceChunkSize) {
      const chunk = audioBuffer.slice(0, sourceChunkSize);
      await this.processAndSendAudioChunk(chunk, chunkIndex);
      chunkIndex++;
      audioBuffer = audioBuffer.slice(sourceChunkSize);
    }
  }

  async processAndSendFinalChunk(audioBuffer, chunkIndex) {
    if (audioBuffer.length > 0) {
      await this.processAndSendAudioChunk(audioBuffer, chunkIndex);
    }
  }

  // This method is now handled by the WebSocket implementation above

  async processAndSendAudioChunk(audioData, chunkIndex) {
    try {
      // Downsample from 16kHz to 8kHz for SIP compatibility
      const downsampledAudio = this.downsampleAudio(audioData, 16000, 8000);
      
      if (downsampledAudio.length === 0) return;
      
      const durationMs = (downsampledAudio.length / (8000 * 2)) * 1000;
      
      console.log(`📤 [ELEVENLABS-SIP] Chunk ${chunkIndex + 1}: ${downsampledAudio.length} bytes (${durationMs.toFixed(1)}ms)`);
      
      // Send to SIP
      const mediaMessage = {
        event: "media",
        streamSid: this.streamSid,
        media: {
          payload: downsampledAudio.toString("base64")
        }
      };

      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(mediaMessage));
      }
      
      // Calculate delay based on chunk duration
      const delayMs = Math.max(durationMs - 5, 10); // 5ms buffer for processing
      
      // Wait before sending next chunk (real-time streaming)
      await new Promise(resolve => setTimeout(resolve, delayMs));
      
    } catch (error) {
      console.error(`❌ [ELEVENLABS-CHUNK] Error processing chunk ${chunkIndex}: ${error.message}`);
    }
  }

  downsampleAudio(audioBuffer, sourceRate, targetRate) {
    if (sourceRate === targetRate) return audioBuffer;
    
    const ratio = targetRate / sourceRate;
    const sourceLength = audioBuffer.length / 2; // 16-bit samples
    const targetLength = Math.floor(sourceLength * ratio);
    
    if (targetLength === 0) return Buffer.alloc(0);
    
    const result = Buffer.alloc(targetLength * 2);
    
    for (let i = 0; i < targetLength; i++) {
      const sourceIndex = Math.floor(i / ratio);
      const sourceByteIndex = sourceIndex * 2;
      
      if (sourceByteIndex + 1 < audioBuffer.length) {
        // Copy 16-bit sample (little-endian)
        result[i * 2] = audioBuffer[sourceByteIndex];
        result[i * 2 + 1] = audioBuffer[sourceByteIndex + 1];
      }
    }
    
    return result;
  }

  complete() {
    if (this.sentenceBuffer.trim()) {
      this.queue.push(this.sentenceBuffer.trim());
      this.sentenceBuffer = "";
    }
    
    if (this.queue.length > 0) {
      this.processQueue();
    }
    
    console.log(`📊 [ELEVENLABS-STATS] Total: ${this.totalChunks} chunks, ${this.totalAudioBytes} bytes`);
  }

  getStats() {
    return {
      totalChunks: this.totalChunks,
      totalAudioBytes: this.totalAudioBytes,
      avgBytesPerChunk: this.totalChunks > 0 ? Math.round(this.totalAudioBytes / this.totalChunks) : 0
    };
  }
}

// Main WebSocket server setup
const setupUnifiedVoiceServer = (wss) => {
  console.log("🚀 [ELEVENLABS-OPTIMIZED] Voice Server started");

  wss.on("connection", (ws, req) => {
    console.log("🔗 [CONNECTION] New WebSocket connection with ElevenLabs");

    // Session state
    let streamSid = null;
    let conversationHistory = [];
    let isProcessing = false;
    let userUtteranceBuffer = "";
    let lastProcessedText = "";
    let optimizedTTS = null;

    // Deepgram WebSocket connection
    let deepgramWs = null;
    let deepgramReady = false;
    let deepgramAudioQueue = [];

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
        deepgramUrl.searchParams.append("endpointing", "300");

        deepgramWs = new WebSocket(deepgramUrl.toString(), {
          headers: { Authorization: `Token ${API_KEYS.deepgram}` },
        });

        deepgramWs.onopen = () => {
          deepgramReady = true;
          console.log("✅ [DEEPGRAM] Connected");
          
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

    const processUserUtterance = async (text) => {
      if (!text.trim() || isProcessing || text === lastProcessedText) return;

      isProcessing = true;
      lastProcessedText = text;
      const timer = createTimer("UTTERANCE_PROCESSING");

      try {
        console.log(`🎤 [USER] Processing: "${text}"`);

        optimizedTTS = new OptimizedElevenLabsTTSProcessor(DEFAULT_CONFIG.language, ws, streamSid);

        const response = await processWithOpenAIStreaming(
          text,
          conversationHistory,
          (phrase) => {
            console.log(`📤 [PHRASE] "${phrase}"`);
            optimizedTTS.addPhrase(phrase);
          },
          (fullResponse) => {
            console.log(`✅ [COMPLETE] "${fullResponse}"`);
            optimizedTTS.complete();
            
            const stats = optimizedTTS.getStats();
            console.log(`📊 [TTS-STATS] ${stats.totalChunks} chunks, ${stats.avgBytesPerChunk} avg bytes/chunk`);
            
            conversationHistory.push(
              { role: "user", content: text },
              { role: "assistant", content: fullResponse }
            );

            if (conversationHistory.length > 10) {
              conversationHistory = conversationHistory.slice(-10);
            }
          }
        );

        console.log(`⚡ [TOTAL] Processing time: ${timer.end()}ms`);

      } catch (error) {
        console.error(`❌ [PROCESSING] Error: ${error.message}`);
      } finally {
        isProcessing = false;
      }
    };

    const sendInitialGreeting = async () => {
      console.log("👋 [GREETING] Sending initial greeting with ElevenLabs WebSocket");
      const tts = new OptimizedElevenLabsTTSProcessor(DEFAULT_CONFIG.language, ws, streamSid);
      await tts.synthesizeAndStreamWithElevenLabs(DEFAULT_CONFIG.firstMessage);
    };

    // WebSocket message handling
    ws.on("message", async (message) => {
      try {
        const data = JSON.parse(message.toString());

        switch (data.event) {
          case "connected":
            console.log(`🔗 [ELEVENLABS-OPTIMIZED] Connected - Protocol: ${data.protocol}`);
            break;

          case "start":
            streamSid = data.streamSid || data.start?.streamSid;
            console.log(`🎯 [ELEVENLABS-OPTIMIZED] Stream started - StreamSid: ${streamSid}`);
            
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
            console.log(`📞 [ELEVENLABS-OPTIMIZED] Stream stopped`);
            if (deepgramWs?.readyState === WebSocket.OPEN) {
              deepgramWs.close();
            }
            break;

          default:
            console.log(`❓ [ELEVENLABS-OPTIMIZED] Unknown event: ${data.event}`);
        }
      } catch (error) {
        console.error(`❌ [ELEVENLABS-OPTIMIZED] Message error: ${error.message}`);
      }
    });

    // Connection cleanup
    ws.on("close", () => {
      console.log("🔗 [ELEVENLABS-OPTIMIZED] Connection closed");
      
      if (deepgramWs?.readyState === WebSocket.OPEN) {
        deepgramWs.close();
      }

      streamSid = null;
      conversationHistory = [];
      isProcessing = false;
      userUtteranceBuffer = "";
      lastProcessedText = "";
      deepgramReady = false;
      deepgramAudioQueue = [];
      optimizedTTS = null;
    });

    ws.on("error", (error) => {
      console.error(`❌ [ELEVENLABS-OPTIMIZED] WebSocket error: ${error.message}`);
    });
  });
};

module.exports = { setupUnifiedVoiceServer };
