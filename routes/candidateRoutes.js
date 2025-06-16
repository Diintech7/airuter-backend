// routes/candidateRoutes.js
const express = require('express');
const router = express.Router();
const Candidate = require('../models/Candidate');
const Partner = require('../models/Partner');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { sendCandidateCredentials } = require('../services/emailServices');

// Middleware to check if user is a partner
const isPartner = (req, res, next) => {
  if (req.user.role !== 'partner') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Partner role required.'
    });
  }
  next();
};

// PUT /api/candidates/:id/toggle-status - Toggle candidate active status
router.put('/:id/toggle-status', protect, isPartner, async (req, res) => {
  try {
    const partner = await Partner.findOne({ user: req.user.id });
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner profile not found'
      });
    }

    const candidate = await Candidate.findOne({
      _id: req.params.id,
      partner: partner._id
    });

    if (!candidate) {
      return res.status(404).json({
        success: false,
        message: 'Candidate not found'
      });
    }

    // Toggle the active status
    const newStatus = req.body.isActive !== undefined ? req.body.isActive : !candidate.isActive;
    
    candidate.isActive = newStatus;
    candidate.updatedAt = new Date();
    await candidate.save();

    // Also update the associated user account status
    await User.findByIdAndUpdate(candidate.user, { 
      isActive: newStatus,
      updatedAt: new Date()
    });

    // Populate references for response
    await candidate.populate([
      { path: 'partner', select: 'partnerName category' },
      { path: 'user', select: 'email role isActive' }
    ]);

    res.json({
      success: true,
      message: `Candidate ${newStatus ? 'enabled' : 'disabled'} successfully`,
      data: {
        ...candidate.toObject(),
        password: undefined // Don't send password
      }
    });

  } catch (error) {
    console.error('Error toggling candidate status:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating candidate status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /api/candidates - Get all candidates for a partner
router.get('/', protect, isPartner, async (req, res) => {
  try {
    // Find the partner profile for the authenticated user
    const partner = await Partner.findOne({ user: req.user.id });
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner profile not found'
      });
    }

    // Get pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Get filter parameters
    const { search, status, course, active } = req.query;
    
    // Build query
    let query = { partner: partner._id };
    
    // Handle active filter - if not specified, show all
    if (active !== undefined) {
      query.isActive = active === 'true';
    }
    
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { registrationNumber: { $regex: search, $options: 'i' } }
      ];
    }
    
    if (status) {
      query['enrolledCourse.status'] = status;
    }
    
    if (course) {
      query['enrolledCourse.courseName'] = { $regex: course, $options: 'i' };
    }

    // Get candidates with pagination
    const candidates = await Candidate.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('partner', 'partnerName category')
      .populate('user', 'email role isActive');

    // Get total count for pagination
    const totalCandidates = await Candidate.countDocuments(query);
    const totalPages = Math.ceil(totalCandidates / limit);

    // Get statistics for all candidates (not filtered by active status)
    const stats = await Candidate.aggregate([
      { $match: { partner: partner._id } },
      {
        $group: {
          _id: '$enrolledCourse.status',
          count: { $sum: 1 }
        }
      }
    ]);

    // Get active/inactive counts
    const activeStats = await Candidate.aggregate([
      { $match: { partner: partner._id } },
      {
        $group: {
          _id: '$isActive',
          count: { $sum: 1 }
        }
      }
    ]);

    const statusStats = {
      total: totalCandidates,
      enrolled: 0,
      inProgress: 0,
      completed: 0,
      dropped: 0,
      active: 0,
      inactive: 0
    };

    stats.forEach(stat => {
      switch(stat._id) {
        case 'Enrolled':
          statusStats.enrolled = stat.count;
          break;
        case 'In Progress':
          statusStats.inProgress = stat.count;
          break;
        case 'Completed':
          statusStats.completed = stat.count;
          break;
        case 'Dropped':
          statusStats.dropped = stat.count;
          break;
      }
    });

    activeStats.forEach(stat => {
      if (stat._id === true) {
        statusStats.active = stat.count;
      } else {
        statusStats.inactive = stat.count;
      }
    });

    res.json({
      success: true,
      data: candidates,
      pagination: {
        currentPage: page,
        totalPages,
        totalCandidates,
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
      stats: statusStats
    });

  } catch (error) {
    console.error('Error fetching candidates:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching candidates',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// POST /api/candidates - Add new candidate
router.post('/', protect, isPartner, async (req, res) => {
  try {
    // Find the partner profile for the authenticated user
    const partner = await Partner.findOne({ user: req.user.id });
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner profile not found'
      });
    }

    const {
      name,
      email,
      mobileNumber,
      registrationNumber,
      gender,
      enrolledCourse,
      skills,
      notes
    } = req.body;

    // Check if user with same email already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    // Check if candidate with same registration number already exists
    const existingCandidate = await Candidate.findOne({ registrationNumber });
    if (existingCandidate) {
      return res.status(400).json({
        success: false,
        message: 'Candidate with this registration number already exists'
      });
    }

    // Generate random password
    const generatedPassword = Candidate.generatePassword();

    // Create user account for candidate
    const user = new User({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: generatedPassword,
      role: 'candidate',
      isActive: true
    });

    await user.save();

    // Create candidate profile
    const candidate = new Candidate({
      user: user._id,
      partner: partner._id,
      name: name.trim(),
      email: email.toLowerCase().trim(),
      mobileNumber,
      registrationNumber: registrationNumber.trim(),
      gender,
      password: generatedPassword,
      enrolledCourse: {
        ...enrolledCourse,
        enrollmentDate: new Date()
      },
      notes,
      isActive: true // New candidates are active by default
    });

    await candidate.save();

    // Populate references
    await candidate.populate([
      { path: 'partner', select: 'partnerName category' },
      { path: 'user', select: 'email role isActive' }
    ]);

    // Send credentials email to candidate
    try {
      const emailResult = await sendCandidateCredentials(
        {
          name: candidate.name,
          email: candidate.email,
          enrolledCourse: candidate.enrolledCourse
        },
        generatedPassword,
        partner.partnerName
      );

      if (!emailResult.success) {
        console.error('Failed to send credentials email:', emailResult.error);
        // Don't fail the request, just log the error
      }
    } catch (emailError) {
      console.error('Error sending credentials email:', emailError);
      // Continue with the response even if email fails
    }

    res.status(201).json({
      success: true,
      message: 'Candidate added successfully and credentials sent via email',
      data: {
        ...candidate.toObject(),
        // Don't send password in response for security
        password: undefined
      }
    });

  } catch (error) {
    console.error('Error adding candidate:', error);
    
    // Clean up user if candidate creation fails
    if (error.name === 'ValidationError' && req.body.email) {
      try {
        await User.findOneAndDelete({ email: req.body.email.toLowerCase() });
      } catch (cleanupError) {
        console.error('Error cleaning up user:', cleanupError);
      }
    }
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error adding candidate',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /api/candidates/:id - Get single candidate
router.get('/:id', protect, isPartner, async (req, res) => {
  try {
    const partner = await Partner.findOne({ user: req.user.id });
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner profile not found'
      });
    }

    const candidate = await Candidate.findOne({
      _id: req.params.id,
      partner: partner._id
    }).populate([
      { path: 'partner', select: 'partnerName category' },
      { path: 'user', select: 'email role isActive' }
    ]);

    if (!candidate) {
      return res.status(404).json({
        success: false,
        message: 'Candidate not found'
      });
    }

    res.json({
      success: true,
      data: {
        ...candidate.toObject(),
        password: undefined // Don't send password
      }
    });

  } catch (error) {
    console.error('Error fetching candidate:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching candidate details',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// PUT /api/candidates/:id - Update candidate
router.put('/:id', protect, isPartner, async (req, res) => {
  try {
    const partner = await Partner.findOne({ user: req.user.id });
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner profile not found'
      });
    }

    const candidate = await Candidate.findOne({
      _id: req.params.id,
      partner: partner._id
    });

    if (!candidate) {
      return res.status(404).json({
        success: false,
        message: 'Candidate not found'
      });
    }

    // Update candidate fields
    const allowedFields = [
      'name', 'email', 'mobileNumber', 'registrationNumber',
      'dateOfBirth', 'gender', 'address', 'education',
      'enrolledCourse', 'skills', 'experience', 'jobPreferences', 'notes'
    ];

    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        candidate[field] = req.body[field];
      }
    });

    // If email is being updated, update the user record too
    if (req.body.email && req.body.email !== candidate.email) {
      await User.findByIdAndUpdate(candidate.user, {
        email: req.body.email.toLowerCase().trim(),
        name: req.body.name || candidate.name
      });
    }

    await candidate.save();
    await candidate.populate([
      { path: 'partner', select: 'partnerName category' },
      { path: 'user', select: 'email role isActive' }
    ]);

    res.json({
      success: true,
      message: 'Candidate updated successfully',
      data: {
        ...candidate.toObject(),
        password: undefined
      }
    });

  } catch (error) {
    console.error('Error updating candidate:', error);
    
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error updating candidate',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// DELETE /api/candidates/:id - Soft delete candidate
router.delete('/:id', protect, isPartner, async (req, res) => {
  try {
    const partner = await Partner.findOne({ user: req.user.id });
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner profile not found'
      });
    }

    const candidate = await Candidate.findOne({
      _id: req.params.id,
      partner: partner._id
    });

    if (!candidate) {
      return res.status(404).json({
        success: false,
        message: 'Candidate not found'
      });
    }

    // Soft delete candidate
    candidate.isActive = false;
    await candidate.save();

    // Also deactivate the user account
    await User.findByIdAndUpdate(candidate.user, { isActive: false });

    res.json({
      success: true,
      message: 'Candidate deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting candidate:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting candidate',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// POST /api/candidates/:id/resend-credentials - Resend credentials email
router.post('/:id/resend-credentials', protect, isPartner, async (req, res) => {
  try {
    const partner = await Partner.findOne({ user: req.user.id });
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner profile not found'
      });
    }

    const candidate = await Candidate.findOne({
      _id: req.params.id,
      partner: partner._id
    });

    if (!candidate) {
      return res.status(404).json({
        success: false,
        message: 'Candidate not found'
      });
    }

    // Check if candidate is active
    if (!candidate.isActive) {
      return res.status(400).json({
        success: false,
        message: 'Cannot resend credentials for inactive candidate'
      });
    }

    // Generate new password
    const newPassword = Candidate.generatePassword();
    
    // Update candidate password
    candidate.password = newPassword;
    candidate.isFirstLogin = true;
    await candidate.save();

    // Update user password
    const user = await User.findById(candidate.user);
    user.password = newPassword;
    await user.save();

    // Send new credentials email
    const emailResult = await sendCandidateCredentials(
      {
        name: candidate.name,
        email: candidate.email,
        enrolledCourse: candidate.enrolledCourse
      },
      newPassword,
      partner.partnerName
    );

    if (emailResult.success) {
      res.json({
        success: true,
        message: 'New credentials sent successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to send credentials email'
      });
    }

  } catch (error) {
    console.error('Error resending credentials:', error);
    res.status(500).json({
      success: false,
      message: 'Error resending credentials',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /api/candidates/stats/overview - Get partner candidate statistics
router.get('/stats/overview', protect, isPartner, async (req, res) => {
  try {
    const partner = await Partner.findOne({ user: req.user.id });
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner profile not found'
      });
    }

    const stats = await Candidate.aggregate([
      { $match: { partner: partner._id } },
      {
        $facet: {
          statusStats: [
            {
              $group: {
                _id: '$enrolledCourse.status',
                count: { $sum: 1 }
              }
            }
          ],
          verificationStats: [
            {
              $group: {
                _id: '$verificationStatus',
                count: { $sum: 1 }
              }
            }
          ],
          activeStats: [
            {
              $group: {
                _id: '$isActive',
                count: { $sum: 1 }
              }
            }
          ],
          monthlyEnrollments: [
            {
              $group: {
                _id: {
                  year: { $year: '$createdAt' },
                  month: { $month: '$createdAt' }
                },
                count: { $sum: 1 }
              }
            },
            { $sort: { '_id.year': -1, '_id.month': -1 } },
            { $limit: 12 }
          ]
        }
      }
    ]);
    
    res.json({
      success: true,
      data: stats[0]
    });
  } catch (error) {
    console.error('Error fetching candidate stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching statistics',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;