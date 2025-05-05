// models/Short.js
const mongoose = require('mongoose');

const ShortSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  youtubeLink: {
    type: String,
    required: true,
    trim: true
  },
  youtubeId: {
    type: String,
    trim: true
  },
  metrics: {
    views: {
      type: Number,
      default: 0
    },
    likes: {
      type: Number,
      default: 0
    },
    comments: {
      type: Number,
      default: 0
    },
    shares: {
      type: Number,
      default: 0
    }
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  active: {
    type: Boolean,
    default: true
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

// Helper method to extract YouTube video ID from URL
ShortSchema.pre('save', function(next) {
  if (this.isModified('youtubeLink')) {
    // Extract YouTube ID from various YouTube URL formats
    const url = this.youtubeLink;
    let videoId = '';

    // Match patterns for various YouTube URL formats
    // This improved regex handles query parameters better
    const watchMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&?#\s]+)/);
    
    if (watchMatch && watchMatch[1]) {
      videoId = watchMatch[1];
    }
    
    if (!videoId) {
      // Fallback for other formats
      const fallbackMatch = url.match(/[?&]v=([^&?#\s]+)/);
      if (fallbackMatch && fallbackMatch[1]) {
        videoId = fallbackMatch[1];
      }
    }
    
    this.youtubeId = videoId;
  }
  
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Short', ShortSchema);