const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  content: String,
  isUser: Boolean,
  timestamp: {
    type: Date,
    default: Date.now
  },
  language: {
    type: String,
    default: 'en'
  },
  audioFile: {
    id: String,
    url: String,
    filename: String
  }
});

const chatSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true
  },
  messages: [{
    content: String,
    isUser: Boolean,
    timestamp: {
      type: Date,
      default: Date.now
    },
    language: {
      type: String,
      default: 'en'
    },
    audioFile: {
      id: String,
      url: String,
      filename: String,
      downloadUrl: String
    }
  }],
  isVoiceInteraction: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Chat', chatSchema);