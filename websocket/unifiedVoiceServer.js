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

// Split text into sentences
const splitIntoSentences = (text) => {
  return text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
};

// Utility function to convert Buffer to Python bytes string for SIP
const bufferToPythonBytesString = (buffer) => {
  let result = "b'";
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte >= 32 && byte <= 126 && byte !== 92 && byte !== 39) {
      result += String.fromCharCode(byte);
    } else {
      result += "\\x" + byte.toString(16).padStart(2, "0");
    }
  }
  result += "'";
  return result;
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

// Sarvam TTS with chunked audio streaming (20ms-100ms chunks)
const synthesizeWithSarvam = async (text, language, ws, sessionId) => {
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
      speech_sample_rate: 22050,
      enable_preprocessing: false,
      model: "bulbul:v1",
    };

    const apiTimer = createTimer("SARVAM_API_CALL");
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
      return;
    }

    const responseData = await response.json();
    apiTimer.end();

    if (!responseData.audios || responseData.audios.length === 0) {
      console.error("❌ [SARVAM] No audio data received");
      timer.end();
      return;
    }

    const audioBase64 = responseData.audios[0];
    const audioBuffer = Buffer.from(audioBase64, "base64");
    
    // Split audio into chunks between 160 bytes (20ms) and 8000 bytes (100ms)
    const chunkSize = 1600; // ~20ms worth of audio data for 22050 Hz
    const totalChunks = Math.ceil(audioBuffer.length / chunkSize);
    
    console.log(`📦 [SARVAM] Splitting ${audioBuffer.length} bytes into ${totalChunks} chunks`);

    // Send audio in chunks
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, audioBuffer.length);
      const chunk = audioBuffer.slice(start, end);
      
      // Ensure chunk is within the required size range
      if (chunk.length >= 160 && chunk.length <= 8000) {
        const pythonBytesString = bufferToPythonBytesString(chunk);
        
        const audioResponse = {
          data: {
            session_id: sessionId,
            count: i + 1,
            audio_bytes_to_play: pythonBytesString,
            sample_rate: 22050,
            channels: 1,
            sample_width: 2,
            is_streaming: true,
            format: "mp3",
            chunk_info: {
              chunk_number: i + 1,
              total_chunks: totalChunks,
              chunk_size: chunk.length,
            },
          },
          type: "ai_response",
        };

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(audioResponse));
          console.log(`📤 [SARVAM] Sent chunk ${i + 1}/${totalChunks} (${chunk.length} bytes)`);
          
          // Small delay between chunks to simulate streaming
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
    }

    // Send completion signal
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "ai_response_complete",
        session_id: sessionId,
        total_chunks: totalChunks,
        total_audio_bytes: audioBuffer.length,
      }));
    }

    console.log(`✅ [SARVAM] TTS completed: ${totalChunks} chunks, ${audioBuffer.length} bytes (${timer.end()}ms)`);
  } catch (error) {
    console.error(`❌ [SARVAM] Error: ${error.message}`);
    timer.end();
  }
};

// Main WebSocket server setup
const setupUnifiedVoiceServer  = (wss) => {
  console.log("🚀 [SERVER] Streamlined Voice Server started");

  wss.on("connection", (ws, req) => {
    console.log("🔗 [CONNECTION] New WebSocket connection");

    // Session state
    let sessionId = null;
    let currentLanguage = "hi";
    let detectedLanguage = "hi";
    let conversationHistory = [];
    let isProcessing = false;
    let userUtteranceBuffer = "";
    let lastProcessedText = "";

    // Deepgram WebSocket connection
    let deepgramWs = null;
    let deepgramReady = false;

    // Send initial greeting
    const sendInitialGreeting = async () => {
      console.log("👋 [GREETING] Sending initial greeting");
      
      // Send greeting text first
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "greeting_text",
          text: DEFAULT_CONFIG.firstMessage,
          language: currentLanguage,
          timestamp: new Date().toISOString(),
        }));
      }

      // Generate and send greeting audio
      await synthesizeWithSarvam(DEFAULT_CONFIG.firstMessage, currentLanguage, ws, sessionId);
    };

    // Connect to Deepgram
    const connectToDeepgram = async () => {
      const timer = createTimer("DEEPGRAM_CONNECTION");
      
      try {
        if (!API_KEYS.deepgram) {
          throw new Error("Deepgram API key not available");
        }

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

    // Process user utterance
    const processUserUtterance = async (text) => {
      if (!text.trim() || isProcessing || text === lastProcessedText) {
        return;
      }

      isProcessing = true;
      lastProcessedText = text;
      const timer = createTimer("USER_UTTERANCE_PROCESSING");

      try {
        // Step 1: Detect language
        const newDetectedLanguage = await detectLanguage(text);
        if (newDetectedLanguage !== detectedLanguage) {
          detectedLanguage = newDetectedLanguage;
          console.log(`🔄 [LANGUAGE] Changed to: ${detectedLanguage}`);
        }

        // Step 2: Process with OpenAI
        const response = await processWithOpenAI(text, conversationHistory, detectedLanguage);
        
        if (response) {
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
          await synthesizeWithSarvam(response, detectedLanguage, ws, sessionId);
        }

        console.log(`✅ [PROCESSING] Completed in ${timer.end()}ms`);
      } catch (error) {
        console.error(`❌ [PROCESSING] Error: ${error.message}`);
        timer.end();
      } finally {
        isProcessing = false;
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
            if (is_final) {
              console.log(`🎤 [TRANSCRIPT] Final: "${transcript}" (confidence: ${confidence})`);
              
              // Add to buffer and process
              userUtteranceBuffer += (userUtteranceBuffer ? " " : "") + transcript.trim();
              await processUserUtterance(userUtteranceBuffer);
              userUtteranceBuffer = "";
            } else {
              // Send interim results to client
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: "transcript_interim",
                  data: transcript,
                  confidence: confidence,
                  is_final: false,
                  language: currentLanguage,
                }));
              }
            }
          }
        }
      } else if (data.type === "SpeechStarted") {
        console.log("🎙️ [DEEPGRAM] Speech started");
      } else if (data.type === "UtteranceEnd") {
        console.log("🔚 [DEEPGRAM] Utterance ended");
        if (userUtteranceBuffer.trim()) {
          await processUserUtterance(userUtteranceBuffer);
          userUtteranceBuffer = "";
        }
      }
    };

    // Send audio to Deepgram
    const sendAudioToDeepgram = (audioData) => {
      if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN || !deepgramReady) {
        return false;
      }

      try {
        const buffer = audioData instanceof Buffer ? audioData : Buffer.from(audioData);
        if (buffer.length >= 320) {
          deepgramWs.send(buffer);
          return true;
        }
        return false;
      } catch (error) {
        console.error("❌ [DEEPGRAM] Send error:", error.message);
        return false;
      }
    };

    // WebSocket message handling
    ws.on("message", async (message) => {
      const messageTimer = createTimer("MESSAGE_PROCESSING");

      try {
        let isTextMessage = false;
        let data = null;

        // Check if message is text/JSON
        if (typeof message === "string") {
          isTextMessage = true;
          try {
            data = JSON.parse(message);
          } catch (parseError) {
            console.error("❌ Failed to parse JSON:", parseError.message);
            messageTimer.end();
            return;
          }
        } else if (message instanceof Buffer) {
          try {
            const messageStr = message.toString("utf8");
            if (messageStr.trim().startsWith("{") && messageStr.trim().endsWith("}")) {
              data = JSON.parse(messageStr);
              isTextMessage = true;
            } else {
              isTextMessage = false;
            }
          } catch (parseError) {
            isTextMessage = false;
          }
        }

        if (isTextMessage && data) {
          console.log(`📨 [MESSAGE] Received:`, data);

          // Handle different message types
          if (data.event === "start" && data.session_id) {
            sessionId = data.session_id;
            console.log(`🎯 [SESSION] Started: ${sessionId}`);

            // Send session confirmation
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "session_started",
                session_id: sessionId,
                agent_name: DEFAULT_CONFIG.agentName,
                language: currentLanguage,
                timestamp: new Date().toISOString(),
              }));
            }

            // Connect to Deepgram and send greeting
            await connectToDeepgram();
            await sendInitialGreeting();

          } else if (data.type === "synthesize") {
            // Direct synthesis request
            if (data.session_id) {
              sessionId = data.session_id;
            }
            await synthesizeWithSarvam(data.text, data.language || currentLanguage, ws, sessionId);

          } else if (data.data && data.data.hangup === "true") {
            console.log(`📞 [SESSION] Hangup for session ${sessionId}`);
            
            if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
              deepgramWs.close(1000, "Call ended");
            }
            
            ws.close(1000, "Hangup requested");
          }
        } else {
          // This is audio data - send to Deepgram
          sendAudioToDeepgram(message);
        }

        messageTimer.end();
      } catch (error) {
        console.error(`❌ [MESSAGE] Processing error: ${error.message}`);
        messageTimer.end();
      }
    });

    // Connection cleanup
    ws.on("close", () => {
      console.log(`🔗 [SESSION] Connection closed for session ${sessionId}`);
      
      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.close(1000, "Session ended");
      }

      // Reset all state
      sessionId = null;
      currentLanguage = "hi";
      detectedLanguage = "hi";
      conversationHistory = [];
      isProcessing = false;
      userUtteranceBuffer = "";
      lastProcessedText = "";
      deepgramReady = false;
    });

    ws.on("error", (error) => {
      console.error(`❌ [SESSION] WebSocket error: ${error.message}`);
    });
  });
};

module.exports = { setupUnifiedVoiceServer  };

// Example usage:
// const WebSocket = require('ws');
// const wss = new WebSocket.Server({ port: 8080 });
// setupUnifiedVoiceServer (wss);
// console.log('🚀 Server running on ws://localhost:8080');
