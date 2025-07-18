// Optimized Sarvam TTS with SIP-friendly chunking (20ms-100ms packets)
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

// Alternative implementation with configurable chunk sizes
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
