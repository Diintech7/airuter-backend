// models/Job.js (Updated)
const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  company: {
    type: String,
    required: true,
    trim: true
  },
  logo: {
    type: String,
    default: ''
  },
  description: {
    type: String,
    required: true
  },
  requirements: {
    type: [String],
    required: true
  },
  responsibilities: {
    type: [String],
    required: true
  },
  location: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    required: true,
    enum: ['full-time', 'part-time', 'contract', 'internship', 'remote']
  },
  experience: {
    min: {
      type: Number,
      required: true
    },
    max: {
      type: Number,
      required: true
    }
  },
  salary: {
    min: {
      type: Number,
      required: true
    },
    max: {
      type: Number,
      required: true
    },
    currency: {
      type: String,
      default: 'INR'
    }
  },
  skills: {
    type: [String],
    required: true
  },
  benefits: {
    type: [String],
    default: []
  },
  recruiter: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'closed', 'draft', 'hidden'],
    default: 'active'
  },
  visibility: {
    type: String,
    enum: ['public', 'private'],
    default: 'public'
  },
  // Partner access control for private jobs
  partnerAccess: [{
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Partner',
      required: true
    },
    access: {
      type: String,
      enum: ['granted', 'revoked'],
      default: 'granted'
    },
    grantedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: true
    },
    grantedAt: {
      type: Date,
      default: Date.now
    },
    revokedAt: {
      type: Date
    }
  }],
  applicationDeadline: {
    type: Date,
    required: true
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

// Index for better performance on partner access queries
jobSchema.index({ 'partnerAccess.partnerId': 1, 'partnerAccess.access': 1 });
jobSchema.index({ visibility: 1, status: 1 });

// Method to check if partner has access to this job
jobSchema.methods.hasPartnerAccess = function(partnerId) {
  if (this.visibility === 'public') {
    return true;
  }
  
  if (this.visibility === 'private') {
    const partnerAccess = this.partnerAccess.find(
      pa => pa.partnerId.toString() === partnerId.toString() && pa.access === 'granted'
    );
    return !!partnerAccess;
  }
  
  return false;
};

// Static method to find jobs accessible by partner
jobSchema.statics.findAccessibleByPartner = function(partnerId) {
  return this.find({
    $or: [
      { visibility: 'public' },
      {
        visibility: 'private',
        'partnerAccess.partnerId': partnerId,
        'partnerAccess.access': 'granted'
      }
    ],
    status: 'active'
  });
};

jobSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Job', jobSchema);