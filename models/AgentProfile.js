const mongoose = require('mongoose');

const AgentProfileSchema = new mongoose.Schema({
  // Personal Information
  agentName: { type: String, required: true },
  description: { type: String },
  category: { type: String },
  personality: { type: String, enum: ['Formal', 'Informal', 'Friendly', 'Flirty'], default: 'Formal' },

  // System Information
  firstMessage: { type: String, required: true },
  firstMessageAudioPath: { type: String }, // Path to generated audio file
  systemPrompt: { type: String },
  sttSelection: { type: String }, // e.g., 'Deepgram', 'Google', etc.
  ttsSelection: { type: String }, // e.g., 'Sarvam', 'LMNT', etc.
  voiceSelection: { type: String }, // e.g., 'anushka', 'abhilash', etc.
  contextMemory: { type: String }, // Extra info about the brand

  // Telephony
  didNumber: { type: String },
  serviceProvider: { type: String },

  // API Keys (encrypted or protected in production)
  apiKeys: {
    sarvam: { type: String },
    deepgram: { type: String },
    openai: { type: String },
    lmnt: { type: String },
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('AgentProfile', AgentProfileSchema); 