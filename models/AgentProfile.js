const mongoose = require("mongoose")

const agentSchema = new mongoose.Schema({
  // Tenant Information
  tenantId: { type: String, required: true, index: true },

  // Personal Information
  agentName: { type: String, required: true },
  description: { type: String, required: true },
  category: { type: String },
  personality: {
    type: String,
    enum: ["formal", "informal", "friendly", "flirty", "disciplined"],
    default: "formal",
  },
  language: { type: String, default: "en" },

  // System Information
  firstMessage: { type: String, required: true },
  systemPrompt: { type: String, required: true },
  sttSelection: {
    type: String,
    enum: ["deepgram", "whisper", "google", "azure", "aws"],
    default: "deepgram",
  },
  ttsSelection: {
    type: String,
    enum: ["sarvam", "elevenlabs", "openai", "google", "azure", "aws"],
    default: "sarvam",
  },
  llmSelection: {
    type: String,
    enum: ["openai", "anthropic", "google", "azure"],
    default: "openai",
  },
  voiceSelection: {
    type: String,
    enum: [
      "default",
      "male-professional",
      "female-professional", 
      "male-friendly",
      "female-friendly",
      "neutral",
      "abhilash",
      "anushka",
      "meera",
      "pavithra",
      "maitreyi",
      "arvind",
      "amol",
      "amartya",
      "diya",
      "neel",
      "misha",
      "vian",
      "arjun",
      "maya",
      "manisha",
      "vidya",
      "arya",
      "karun",
      "hitesh"
    ],
    default: "default",
  },
  contextMemory: { type: String },
  brandInfo: { type: String },

  // Telephony
  didNumber: { type: String },
  serviceProvider: {
    type: String,
    enum: ["twilio", "vonage", "plivo", "bandwidth", "other"],
  },

  // Audio storage - Properly configured for bytes storage
  audioFile: { type: String }, // File path (legacy support)
  audioBytes: { 
    type: Buffer,
    validate: {
      validator: function(v) {
        return !v || Buffer.isBuffer(v)
      },
      message: 'audioBytes must be a Buffer'
    }
  },
  audioMetadata: {
    format: { type: String, default: "mp3" },
    sampleRate: { type: Number, default: 22050 },
    channels: { type: Number, default: 1 },
    size: { type: Number },
    generatedAt: { type: Date },
    language: { type: String, default: "en" },
    speaker: { type: String },
    provider: { type: String, default: "sarvam" },
  },

  // Timestamps
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

// Compound index for tenant + agent name uniqueness
agentSchema.index({ tenantId: 1, agentName: 1 }, { unique: true })

// Update the updatedAt field before saving
agentSchema.pre("save", function (next) {
  this.updatedAt = Date.now()
  
  // Validate audioBytes if present
  if (this.audioBytes && !Buffer.isBuffer(this.audioBytes)) {
    return next(new Error('audioBytes must be a Buffer'))
  }
  
  // Update audioMetadata size if audioBytes is present
  if (this.audioBytes && Buffer.isBuffer(this.audioBytes)) {
    if (!this.audioMetadata) {
      this.audioMetadata = {}
    }
    this.audioMetadata.size = this.audioBytes.length
  }
  
  next()
})

// Method to get audio as base64
agentSchema.methods.getAudioBase64 = function() {
  if (this.audioBytes && Buffer.isBuffer(this.audioBytes)) {
    return this.audioBytes.toString('base64')
  }
  return null
}

// Method to set audio from base64
agentSchema.methods.setAudioFromBase64 = function(base64String) {
  if (base64String && typeof base64String === 'string') {
    this.audioBytes = Buffer.from(base64String, 'base64')
    if (!this.audioMetadata) {
      this.audioMetadata = {}
    }
    this.audioMetadata.size = this.audioBytes.length
  }
}

module.exports = mongoose.model("Agent", agentSchema)
