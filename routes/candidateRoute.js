const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const Candidate = require('../models/Candidate');
const Job = require('../models/Job');
const { protectCandidate, generateToken } = require('../middleware/auth');

const router = express.Router();

// Initialize Google OAuth client
let googleClient;
try {
  if (process.env.GOOGLE_CLIENT_ID) {
    googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    console.log('Google OAuth client initialized successfully');
  } else {
    console.error('GOOGLE_CLIENT_ID not found in environment variables');
  }
} catch (error) {
  console.error('Error initializing Google OAuth client:', error);
}

// ================================
// Authentication Routes
// ================================

// Google OAuth Login
router.post('/google-login', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Google token is required'
      });
    }

    if (!googleClient) {
      return res.status(500).json({
        success: false,
        message: 'Google authentication not configured'
      });
    }

    // Verify Google token
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const email = payload.email;
    const googleId = payload.sub;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email not provided by Google'
      });
    }

    // Find candidate
    const candidate = await Candidate.findOne({
      email: email.toLowerCase(),
      isActive: true
    }).populate('partner', 'partnerName category location');

    if (!candidate) {
      return res.status(401).json({
        success: false,
        message: 'No account found with this email. Please contact your institute.'
      });
    }

    if (!candidate.isVerified) {
      return res.status(401).json({
        success: false,
        message: 'Your account is not yet verified. Please contact your institute.'
      });
    }

    // Update candidate
    if (!candidate.googleId) candidate.googleId = googleId;
    candidate.lastActivity = new Date();
    candidate.lastLoginMethod = 'google';
    const wasFirstLogin = candidate.isFirstLogin;
    if (candidate.isFirstLogin) candidate.isFirstLogin = false;
    await candidate.save();

    // Generate token
    const jwtToken = generateToken(candidate._id, 'candidate');

    res.status(200).json({
      success: true,
      message: 'Google login successful',
      token: jwtToken,
      candidate: {
        id: candidate._id,
        name: candidate.name,
        email: candidate.email,
        registrationNumber: candidate.registrationNumber,
        partner: candidate.partner ? {
          id: candidate.partner._id,
          name: candidate.partner.partnerName,
          category: candidate.partner.category
        } : null,
        isVerified: candidate.isVerified,
        wasFirstLogin,
        role: 'candidate'
      }
    });

  } catch (error) {
    console.error('Google login error:', error);
    
    let errorMessage = 'Google authentication failed. Please try again.';
    if (error.message.includes('Token used too early')) {
      errorMessage = 'Google token is not yet valid. Please try again.';
    } else if (error.message.includes('Token used too late')) {
      errorMessage = 'Google token has expired. Please try again.';
    } else if (error.message.includes('Invalid token')) {
      errorMessage = 'Invalid Google token. Please try again.';
    }

    res.status(500).json({
      success: false,
      message: errorMessage
    });
  }
});

// Password Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    // Find candidate
    const candidate = await Candidate.findOne({
      email: email.toLowerCase(),
      isActive: true
    }).populate('partner', 'partnerName category location');

    if (!candidate) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Check password
    const isPasswordCorrect = await candidate.correctPassword(password, candidate.password);
    if (!isPasswordCorrect) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    if (!candidate.isVerified) {
      return res.status(401).json({
        success: false,
        message: 'Your account is not yet verified. Please contact your institute.'
      });
    }

    // Update candidate
    candidate.lastActivity = new Date();
    candidate.lastLoginMethod = 'password';
    const wasFirstLogin = candidate.isFirstLogin;
    if (candidate.isFirstLogin) candidate.isFirstLogin = false;
    await candidate.save();

    // Generate token
    const token = generateToken(candidate._id, 'candidate');

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      candidate: {
        id: candidate._id,
        name: candidate.name,
        email: candidate.email,
        registrationNumber: candidate.registrationNumber,
        partner: candidate.partner ? {
          id: candidate.partner._id,
          name: candidate.partner.partnerName,
          category: candidate.partner.category
        } : null,
        isVerified: candidate.isVerified,
        wasFirstLogin,
        role: 'candidate'
      }
    });

  } catch (error) {
    console.error('Candidate login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.'
    });
  }
});

// Validate Token
router.get('/validate', protectCandidate, (req, res) => {
  res.status(200).json({
    success: true,
    candidate: {
      id: req.candidate._id,
      name: req.candidate.name,
      email: req.candidate.email,
      registrationNumber: req.candidate.registrationNumber,
      partner: req.candidate.partner ? {
        id: req.candidate.partner._id,
        name: req.candidate.partner.partnerName,
        category: req.candidate.partner.category
      } : null,
      isVerified: req.candidate.isVerified,
      role: 'candidate'
    }
  });
});

// Logout
router.post('/logout', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Logged out successfully'
  });
});

// ================================
// Profile Routes
// ================================

// Get Profile
router.get('/profile', protectCandidate, (req, res) => {
  const candidate = req.candidate.toObject();
  delete candidate.password;
  delete candidate.resetPasswordToken;
  delete candidate.resetPasswordExpire;

  res.status(200).json({
    success: true,
    candidate
  });
});

// Update Profile
router.put('/profile', protectCandidate, async (req, res) => {
  try {
    const allowedUpdates = [
      'name', 'mobileNumber', 'dateOfBirth', 'gender', 'address',
      'skills', 'experience', 'jobPreferences'
    ];
    
    const updates = {};
    Object.keys(req.body).forEach(key => {
      if (allowedUpdates.includes(key)) {
        updates[key] = req.body[key];
      }
    });

    const candidate = await Candidate.findByIdAndUpdate(
      req.candidate._id,
      updates,
      { new: true, runValidators: true }
    ).populate('partner', 'partnerName category location');

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      candidate
    });

  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating profile'
    });
  }
});

// ================================
// Job Access Routes
// ================================

// Get Job Access Information
router.get('/job-access', protectCandidate, async (req, res) => {
  try {
    let jobAccess = {
      publicJobs: true,
      privateJobsCount: 0,
      hasPartnerAccess: false
    };

    if (req.candidate.partner?._id) {
      // Count private jobs accessible to this partner
      const privateJobsCount = await Job.countDocuments({
        visibility: 'private',
        status: 'active',
        'partnerAccess': {
          $elemMatch: {
            'partnerId': req.candidate.partner._id,
            'access': 'granted'
          }
        }
      });

      jobAccess.privateJobsCount = privateJobsCount;
      jobAccess.hasPartnerAccess = privateJobsCount > 0;
    }

    res.status(200).json({
      success: true,
      jobAccess
    });

  } catch (error) {
    console.error('Job access error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching job access information'
    });
  }
});

// Get Available Jobs for Candidate
router.get('/jobs', protectCandidate, async (req, res) => {
  try {
    const { page = 1, limit = 10, search, location, jobType } = req.query;
    
    // Build query for public jobs
    let publicJobQuery = {
      visibility: 'public',
      status: 'active'
    };

    // Build query for private jobs (if candidate has partner)
    let privateJobQuery = null;
    if (req.candidate.partner?._id) {
      privateJobQuery = {
        visibility: 'private',
        status: 'active',
        'partnerAccess': {
          $elemMatch: {
            'partnerId': req.candidate.partner._id,
            'access': 'granted'
          }
        }
      };
    }

    // Add search filters if provided
    if (search) {
      const searchRegex = { $regex: search, $options: 'i' };
      const searchConditions = {
        $or: [
          { title: searchRegex },
          { company: searchRegex },
          { description: searchRegex }
        ]
      };
      publicJobQuery = { ...publicJobQuery, ...searchConditions };
      if (privateJobQuery) {
        privateJobQuery = { ...privateJobQuery, ...searchConditions };
      }
    }

    if (location) {
      publicJobQuery.location = { $regex: location, $options: 'i' };
      if (privateJobQuery) {
        privateJobQuery.location = { $regex: location, $options: 'i' };
      }
    }

    if (jobType) {
      publicJobQuery.jobType = jobType;
      if (privateJobQuery) {
        privateJobQuery.jobType = jobType;
      }
    }

    // Combine queries
    const queries = [publicJobQuery];
    if (privateJobQuery) {
      queries.push(privateJobQuery);
    }

    const jobs = await Job.find({
      $or: queries
    })
    .select('title company location salary jobType description requirements postedDate')
    .sort({ postedDate: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit);

    const total = await Job.countDocuments({
      $or: queries
    });

    res.status(200).json({
      success: true,
      jobs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Jobs fetch error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching jobs'
    });
  }
});

// ================================
// Password Management Routes
// ================================

// Change Password
router.put('/change-password', protectCandidate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required'
      });
    }

    // Get candidate with password
    const candidate = await Candidate.findById(req.candidate._id);

    // Check current password
    const isCurrentPasswordCorrect = await candidate.correctPassword(currentPassword, candidate.password);
    if (!isCurrentPasswordCorrect) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Update password
    candidate.password = newPassword;
    await candidate.save();

    res.status(200).json({
      success: true,
      message: 'Password updated successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating password'
    });
  }
});

module.exports = router;