const mongoose = require('mongoose');

const profileSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  firstName: { type: String, required: function() { return this.isComplete; } },
  lastName: { type: String, required: function() { return this.isComplete; } },
  email: { type: String, required: function() { return this.isComplete; } },
  phone: { type: String },
  location: { type: String },
  title: { type: String },
  summary: { type: String },
  yearsOfExperience: { type: Number },
  education: [{
    degree: String,
    institution: String,
    yearOfCompletion: Number,
    field: String
  }],
  experience: [{
    company: String,
    position: String,
    startDate: Date,
    endDate: Date,
    description: String
  }],
  skills: [String],
  languages: [String],
  certifications: [String],
  achievements: [String],
  resumePath: { type: String }, // Added field to store resume file path
  isComplete: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Profile', profileSchema);