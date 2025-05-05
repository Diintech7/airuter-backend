const express = require('express');
const router = express.Router();
const Chat = require('../models/Chat');
const { protect } = require('../middleware/auth');
const OpenAI = require('openai');
const { LMNTStreamingClient } = require('../websocket/lmntStreaming');

const fs = require('fs');
const path = require('path');
// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Save recording endpoint
router.post('/save-recording', async (req, res) => {
  try {
    if (!req.files || !req.files.audio) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const audioFile = req.files.audio;
    const userId = req.body.userId;
    
    // Create directory if it doesn't exist
    const uploadDir = path.join(__dirname, '../uploads/recordings');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Generate unique filename
    const filename = `recording_${userId}_${Date.now()}.webm`;
    const filepath = path.join(uploadDir, filename);

    // Save file
    await audioFile.mv(filepath);

    // Update chat document with recording information
    const chat = await Chat.findOne({ userId });
    if (chat) {
      chat.messages[chat.messages.length - 1].audioFile = filename;
      await chat.save();
    }

    res.json({ 
      success: true, 
      filename,
      message: 'Recording saved successfully' 
    });
    
  } catch (error) {
    console.error('Error saving recording:', error);
    res.status(500).json({ 
      error: 'Failed to save recording',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get chat history
router.get('/history', protect, async (req, res) => {
  try {
    const chats = await Chat.find({ 
      userId: req.user.id,
      isVoiceInteraction: false
    })
    .sort({ updatedAt: -1 })
    .limit(10);
    res.json(chats);
  } catch (error) {
    console.error('Error fetching chat history:', error);
    res.status(500).json({ message: error.message });
  }
});

// Text-to-speech synthesis endpoint
router.post('/synthesize', async (req, res) => {
  try {
    const {
      text,
      voice = 'lily',
      model = 'aurora',
      format = 'mp3',
      language = 'en',
      sample_rate = 16000,
      speed = 1.0
    } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    if (!process.env.LMNT_API_KEY) {
      console.error('LMNT API key is missing from environment variables');
      return res.status(500).json({ error: 'LMNT API key not configured' });
    }

    console.log('Initializing LMNT client...');
    const lmntClient = new LMNTStreamingClient(process.env.LMNT_API_KEY);

    console.log('Connecting to LMNT service...');
    await lmntClient.connect({
      voice,
      model,
      format,
      language,
      sample_rate,
      speed
    });

    console.log('Synthesizing text...');
    const audioBuffer = await lmntClient.synthesize(text);

    console.log('Synthesis complete, sending response...');
    lmntClient.close();

    // Set appropriate headers
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length,
      'Cache-Control': 'no-cache'
    });

    // Send the audio data
    res.send(audioBuffer);

  } catch (error) {
    console.error('Text-to-speech synthesis error:', error);
    res.status(500).json({ 
      error: 'Failed to synthesize speech',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Process regular chat message
router.post('/message', protect, async (req, res) => {
  try {
    const { message, language = 'en', isVoiceInteraction = false } = req.body;
    const userId = req.user.id;

    let chat = await Chat.findOne({ userId, isVoiceInteraction });
    if (!chat) {
      chat = new Chat({ userId, messages: [], isVoiceInteraction });
    }

    chat.messages.push({
      content: message,
      isUser: true,
      timestamp: new Date(),
      language
    });

    // Get AI response using OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: language === 'hi' ? 'आप एक सहायक सहायक हैं।' : 'You are a helpful assistant.' },
        { role: "user", content: message }
      ],
      temperature: 0.6,
      max_tokens: 500
    });

    const aiResponse = completion.choices[0].message.content;

    chat.messages.push({
      content: aiResponse,
      isUser: false,
      timestamp: new Date(),
      language
    });

    await chat.save();

    res.json({
      message: aiResponse,
      chatHistory: chat.messages
    });
  } catch (error) {
    console.error('Error processing message:', error);
    res.status(500).json({ message: error.message });
  }
});

// Delete chat history
router.delete('/history/:userId', async (req, res) => {
  try {
    await Chat.deleteMany({ userId: req.params.userId });
    res.json({ message: 'Chat history deleted successfully' });
  } catch (error) {
    console.error('Error deleting chat history:', error);
    res.status(500).json({ message: error.message });
  }
});

const languageConfig = {
  'en': {
    systemPrompt: 'You are a helpful assistant. Respond in English.',
    defaultVoice: 'lily'
  },
  'hi': {
    systemPrompt: 'आप एक सहायक सहायक हैं। हिंदी में जवाब दें।',
    defaultVoice: 'lily'
  }
};

// Process voice message
router.post('/voice-message', protect, async (req, res) => {
  try {
    const { message, language = 'en' } = req.body;
    const userId = req.user.id;

    let chat = await Chat.findOne({ 
      userId, 
      isVoiceInteraction: true 
    });
    
    if (!chat) {
      chat = new Chat({ 
        userId, 
        messages: [], 
        isVoiceInteraction: true 
      });
    }

    chat.messages.push({
      content: message,
      isUser: true,
      timestamp: new Date(),
      language
    });

    // Get AI response using OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: language === 'hi' ? 'आप एक सहायक सहायक हैं।' : 'You are a helpful assistant.' },
        { role: "user", content: message }
      ],
      temperature: 0.6,
      max_tokens: 500
    });

    const aiResponse = completion.choices[0].message.content;

    chat.messages.push({
      content: aiResponse,
      isUser: false,
      timestamp: new Date(),
      language
    });

    await chat.save();

    res.json({
      message: aiResponse,
      chatHistory: chat.messages
    });
  } catch (error) {
    console.error('Error processing voice message:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get voice chat history
router.get('/voice-history', protect, async (req, res) => {
  try {
    const chats = await Chat.find({ 
      userId: req.user.id,
      isVoiceInteraction: true 
    })
    .sort({ updatedAt: -1 })
    .limit(10);
    res.json(chats);
  } catch (error) {
    console.error('Error fetching voice chat history:', error);
    res.status(500).json({ message: error.message });
  }
});

// Add transcription endpoint for handling audio file uploads
router.post('/transcribe', async (req, res) => {
  try {
    console.log('=== Starting Transcription ===');
    if (!req.files || !req.files.audio) {
      console.error('No audio file found in request');
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const audioFile = req.files.audio;
    console.log('Audio File Details:', {
      name: audioFile.name,
      size: audioFile.size,
      mimetype: audioFile.mimetype
    });
    
    // Save the file temporarily to disk
    const tempFilePath = path.join(__dirname, '../uploads/temp', `${Date.now()}_${audioFile.name}`);
    const tempDir = path.dirname(tempFilePath);
    
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    await audioFile.mv(tempFilePath);
    
    // Use OpenAI's API for transcription
    try {
      console.log('Starting OpenAI transcription request');
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempFilePath),
        model: "whisper-1",
      });

      // Clean up temp file
      fs.unlinkSync(tempFilePath);

      console.log('Transcription completed successfully');
      res.json({ transcript: transcription.text });
    } catch (openaiError) {
      console.error('OpenAI API transcription error:', openaiError);

      // Clean up temp file in case of error
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }

      // Handle rate limiting specifically
      if (openaiError.status === 429) {
        return res.status(429).json({
          success: false,
          message: 'Transcription service temporarily unavailable. Please try again in a few minutes.',
          retryAfter: 60
        });
      }

      // Provide fallback response if API fails
      return res.status(503).json({ 
        error: 'Transcription service temporarily unavailable',
        details: 'Please try again later'
      });
    }
    
  } catch (error) {
    console.error('Transcription error:', error);
    res.status(500).json({ 
      error: 'Failed to transcribe audio',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

module.exports = router;