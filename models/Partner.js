// models/Partner.js
const mongoose = require('mongoose');

const partnerSchema = new mongoose.Schema({
  // Reference to User model
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Partner specific information
  partnerName: {
    type: String,
    required: true
  },
  
  category: {
    type: String,
    enum: [
      'Training Institute',
      'Placement Consultancy', 
      'College / University',
      'NGO / Non-Profit',
      'School',
      'Government Organization',
      'Others'
    ],
    required: true
  },
  
  categoryDescription: {
    type: String,
    // Required only when category is 'Others'
    required: function() {
      return this.category === 'Others';
    }
  },
  
  adminContactPerson: {
    type: String,
    required: true
  },
  
  contactNumber: {
    type: String,
    required: true
  },
  
  email: {
    type: String,
    required: true
  },
  
  coursesOffered: [{
    courseName: {
      type: String,
      required: true
    },
    courseType: {
      type: String,
      enum: ['Skill-based', 'Academic', 'Certification', 'Workshop'],
      required: true
    },
    duration: String,
    description: String
  }],
  
  location: {
    address: {
      type: String,
      required: true
    },
    city: {
      type: String,
      required: true
    },
    state: {
      type: String,
      required: true
    },
    pincode: String,
    country: {
      type: String,
      default: 'India'
    }
  },
  
  gstNumber: {
    type: String,
    // Optional for NGOs/Schools
    required: function() {
      return !['NGO / Non-Profit', 'School'].includes(this.category);
    }
  },
  
  panNumber: {
    type: String,
    required: true // Mandatory for all
  },
  
  // Additional business information
  website: String,
  
  establishedYear: Number,
  
  description: String,
  
  logo: String,
  
  // Social media links
  socialLinks: {
    linkedin: String,
    facebook: String,
    twitter: String,
    instagram: String
  },
  
  // Verification status
  isVerified: {
    type: Boolean,
    default: false
  },
  
  verificationDocuments: [{
    type: {
      type: String,
      enum: ['GST Certificate', 'PAN Card', 'Registration Certificate', 'Other']
    },
    documentUrl: String,
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Partnership details
  partnershipStartDate: {
    type: Date,
    default: Date.now
  },
  
  partnershipType: {
    type: String,
    enum: ['Basic', 'Premium', 'Enterprise'],
    default: 'Basic'
  },
  
  // Previous role information (if converted from recruiter)
  previousRole: {
    type: String,
    enum: ['recruiter'],
    default: null
  },
  
  conversionHistory: [{
    fromRole: String,
    toRole: String,
    convertedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin'
    },
    convertedAt: {
      type: Date,
      default: Date.now
    },
    reason: String
  }],
  
  // Status and activity
  isActive: {
    type: Boolean,
    default: true
  },
  
  lastActivity: {
    type: Date,
    default: Date.now
  },
  
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

// Pre-save middleware to update timestamps
partnerSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Method to add conversion history
partnerSchema.methods.addConversionHistory = function(fromRole, toRole, convertedBy, reason) {
  this.conversionHistory.push({
    fromRole,
    toRole,
    convertedBy,
    reason
  });
  this.previousRole = fromRole;
};

// Static method to find partners by category
partnerSchema.statics.findByCategory = function(category) {
  return this.find({ category });
};

// Static method to find verified partners
partnerSchema.statics.findVerified = function() {
  return this.find({ isVerified: true, isActive: true });
};

module.exports = mongoose.model('Partner', partnerSchema);