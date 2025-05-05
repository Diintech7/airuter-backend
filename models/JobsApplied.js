const mongoose = require('mongoose');

const jobsAppliedSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'reviewed', 'shortlisted', 'rejected'],
    default: 'pending'
  },
  appliedDate: {
    type: Date,
    default: Date.now
  },
  coverLetter: String,
  additionalNotes: String,
  resumePath: String
}, { timestamps: true });

module.exports = mongoose.model('JobsApplied', jobsAppliedSchema);