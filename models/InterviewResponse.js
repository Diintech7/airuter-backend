const mongoose = require('mongoose');

const interviewResponseSchema = new mongoose.Schema({
  roomId: {
    type: String,
    required: true
  },
  question: {
    type: String,
    required: true
  },
  response: {
    type: String,
    required: true
  },
  score: {
    type: Number,
    min: 0,
    max: 100,
    default: null
  },
  feedback: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Create a compound index to ensure uniqueness of roomId + question
interviewResponseSchema.index({ roomId: 1, question: 1 }, { unique: true });

const InterviewResponse = mongoose.model('InterviewResponse', interviewResponseSchema);

module.exports = InterviewResponse;