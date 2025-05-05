const mongoose = require('mongoose');

const interviewSchema = new mongoose.Schema({
  roomId: {
    type: String,
    required: true,
    unique: true,
  },
  date: {
    type: String,
    required: true,
  },
  time: {
    type: String,
    required: true,
  },
  document: {
    type: String,
    required: true,
  },
  jobTitle: {
    type: String,
    required: true,
  },
  applicantEmail: {
    type: String,
    required: true,
  },
  applicantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // Assuming the applicant is stored in a User model
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  screenRecordingUrl: {
    type: String,
    default: null
  },
  recordedAt: {
    type: Date,
    default: null
  },
  // New fields for storing analysis data
  analysis: {
    overallScores: {
      selfIntroduction: {
        type: Number,
        min: 1,
        max: 10
      },
      projectExplanation: {
        type: Number,
        min: 1,
        max: 10
      },
      englishCommunication: {
        type: Number,
        min: 1,
        max: 10
      }
    },
    feedback: {
      selfIntroduction: {
        strengths: String,
        areasOfImprovement: String
      },
      projectExplanation: {
        strengths: String,
        areasOfImprovement: String
      },
      englishCommunication: {
        strengths: String,
        areasOfImprovement: String
      }
    },
    focusAreas: [String],
    analyzedAt: {
      type: Date,
      default: null
    }
  }
});

const Interview = mongoose.model('Interview', interviewSchema);

module.exports = Interview;
