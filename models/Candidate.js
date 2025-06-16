// models/Candidate.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const candidateSchema = new mongoose.Schema({
  // Reference to Partner
  partner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Partner',
    required: true
  },
  
  // Reference to User (for authentication)
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Basic Information
  name: {
    type: String,
    required: true,
    trim: true
  },
  
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  
  mobileNumber: {
    type: String,
    required: true,
    validate: {
      validator: function(v) {
        return /^[6-9]\d{9}$/.test(v); // Indian mobile number format
      },
      message: 'Please enter a valid mobile number'
    }
  },
  
  registrationNumber: {
    type: String,
    required: true,
    trim: true
  },
  
  // Password for candidate login
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  
  // Google OAuth ID
  googleId: {
    type: String,
    sparse: true // Allows multiple null values
  },
  
  // Password reset fields
  resetPasswordToken: String,
  resetPasswordExpire: Date,
  
  // First login tracking
  isFirstLogin: {
    type: Boolean,
    default: true
  },
  
  // Personal Details
  dateOfBirth: {
    type: Date
  },
  
  gender: {
    type: String,
    enum: ['Male', 'Female', 'Other'],
  },
  
  // Address Information
  address: {
    street: String,
    city: String,
    state: String,
    pincode: String,
    country: {
      type: String,
      default: 'India'
    }
  },
  
  // Educational Information
  education: [{
    degree: {
      type: String,
      required: true
    },
    institution: String,
    yearOfCompletion: Number,
    percentage: Number,
    specialization: String
  }],
  
  // Course Information (from partner)
  enrolledCourse: {
    courseName: String,
    courseType: String,
    enrollmentDate: {
      type: Date,
      default: Date.now
    },
    completionDate: Date,
    status: {
      type: String,
      enum: ['Enrolled', 'In Progress', 'Completed', 'Dropped'],
      default: 'Enrolled'
    }
  },
  
  // Skills
  skills: [{
    type: String,
    trim: true
  }],
  
  // Experience (if any)
  experience: [{
    company: String,
    position: String,
    duration: String,
    description: String
  }],
  
  // Documents
  documents: [{
    type: {
      type: String,
      enum: ['Resume', 'ID Proof', 'Educational Certificate', 'Photo', 'Other']
    },
    fileName: String,
    fileUrl: String,
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Job Preferences
  jobPreferences: {
    preferredLocation: [String],
    expectedSalary: {
      min: Number,
      max: Number
    },
    jobType: {
      type: String,
      enum: ['Full-time', 'Part-time', 'Contract', 'Internship']
    },
    industry: [String]
  },
  
  // Status and Verification
  isVerified: {
    type: Boolean,
    default: true
  },
  
  verificationStatus: {
    type: String,
    enum: ['Pending', 'Verified', 'Rejected'],
    default: 'Verified'
  },
  
  // Activity tracking
  isActive: {
    type: Boolean,
    default: true
  },
  
  lastActivity: {
    type: Date,
    default: Date.now
  },
  
  // Login method tracking
  lastLoginMethod: {
    type: String,
    enum: ['password', 'google'],
    default: 'password'
  },
  
  // Additional Notes
  notes: String,
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes for better performance
candidateSchema.index({ partner: 1, createdAt: -1 });
candidateSchema.index({ email: 1 });
candidateSchema.index({ registrationNumber: 1 });
candidateSchema.index({ googleId: 1 });
candidateSchema.index({ 'enrolledCourse.status': 1 });
candidateSchema.index({ user: 1 });
candidateSchema.index({ resetPasswordToken: 1 });

// Pre-save middleware to hash password and update timestamps
candidateSchema.pre('save', async function(next) {
  // Hash password if it's modified
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 12);
  }
  
  this.updatedAt = new Date();
  next();
});

// Method to check password
candidateSchema.methods.correctPassword = async function(candidatePassword, userPassword) {
  return await bcrypt.compare(candidatePassword, userPassword);
};

// Method to generate random password
candidateSchema.statics.generatePassword = function() {
  const length = 8;
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%";
  let password = "";
  
  // Ensure at least one character from each type
  password += "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Math.floor(Math.random() * 26)]; // uppercase
  password += "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]; // lowercase
  password += "0123456789"[Math.floor(Math.random() * 10)]; // number
  password += "@#$%"[Math.floor(Math.random() * 4)]; // special char
  
  // Fill remaining length
  for (let i = password.length; i < length; i++) {
    password += charset[Math.floor(Math.random() * charset.length)];
  }
  
  // Shuffle the password
  return password.split('').sort(() => Math.random() - 0.5).join('');
};

// Method to check if candidate can login with Google
candidateSchema.methods.canLoginWithGoogle = function() {
  return this.googleId || this.isVerified;
};

// Virtual for full name display
candidateSchema.virtual('displayName').get(function() {
  return this.name;
});

// Method to get candidate summary
candidateSchema.methods.getSummary = function() {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    mobileNumber: this.mobileNumber,
    registrationNumber: this.registrationNumber,
    courseStatus: this.enrolledCourse.status,
    verificationStatus: this.verificationStatus,
    createdAt: this.createdAt,
    hasGoogleAuth: !!this.googleId
  };
};

// Static method to find candidates by partner
candidateSchema.statics.findByPartner = function(partnerId) {
  return this.find({ partner: partnerId, isActive: true })
    .populate('partner', 'partnerName category')
    .populate('user', 'email role')
    .sort({ createdAt: -1 });
};

// Static method to get candidate statistics
candidateSchema.statics.getPartnerStats = function(partnerId) {
  return this.aggregate([
    { $match: { partner: mongoose.Types.ObjectId(partnerId), isActive: true } },
    {
      $group: {
        _id: '$enrolledCourse.status',
        count: { $sum: 1 }
      }
    }
  ]);
};

// Static method to find candidate by email for Google login
candidateSchema.statics.findByEmailForGoogleAuth = function(email) {
  return this.findOne({
    email: email.toLowerCase(),
    isActive: true,
    isVerified: true
  }).populate('partner', 'partnerName category');
};

module.exports = mongoose.model('Candidate', candidateSchema);