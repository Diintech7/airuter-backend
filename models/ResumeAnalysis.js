// models/ResumeAnalysis.js
const mongoose = require('mongoose');

const resumeAnalysisSchema = new mongoose.Schema({
  application: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'JobApplication',
    required: true
  },
  feedback: [{
    category: {
      type: String,
      required: true
    },
    score: {
      type: Number,
      required: true,
      min: 0,
      max: 100
    },
    message: {
      type: String,
      required: true
    }
  }],
  keyFindings: [{
    type: String
  }],
  suggestions: [{
    type: String
  }],
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('ResumeAnalysis', resumeAnalysisSchema);