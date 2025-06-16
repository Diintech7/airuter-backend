// routes/recruiterManagement.js
const express = require('express');
const router = express.Router();
const { protect, isAdmin } = require('../middleware/auth');
const AdminProfile = require('../models/AdminProfile');
const User = require('../models/User'); 
const jwt = require('jsonwebtoken');
const {
  getAllRecruiters,
  getRecruiterDetails,
  createRecruiter,
  updateRecruiter,
  updateRecruiterStatus,
  deleteRecruiter,
  getRecruiterCompanyDetails,
  getRecruiterJobs,
  getRecruiterApplications
} = require('../controllers/recruiterController');

// Get all recruiters and partners - admin only
router.get('/recruiters', protect, isAdmin, getAllRecruiters);

// Get specific recruiter/partner with details - admin only
router.get('/recruiters/:recruiterId', protect, isAdmin, getRecruiterDetails);

// Get detailed recruiter/partner company information - admin only
router.get('/recruiters/:recruiterId/company', protect, isAdmin, getRecruiterCompanyDetails);

// Get jobs posted by a recruiter/partner - admin only
router.get('/recruiters/:recruiterId/jobs', protect, isAdmin, getRecruiterJobs);

// Get applications for a recruiter's/partner's jobs - admin only
router.get('/recruiters/:recruiterId/applications', protect, isAdmin, getRecruiterApplications);

// Add a new recruiter/partner - admin only
router.post('/recruiters', protect, isAdmin, createRecruiter);

// Update recruiter/partner details - admin only
router.put('/recruiters/:recruiterId', protect, isAdmin, updateRecruiter);

// Update recruiter/partner status - admin only
router.put('/recruiters/:recruiterId/status', protect, isAdmin, updateRecruiterStatus);

// Delete recruiter/partner - admin only
router.delete('/recruiters/:recruiterId', protect, isAdmin, deleteRecruiter);

// Get recruiter and partner statistics
router.get('/recruiter-stats', protect, isAdmin, async (req, res) => {
  try {
    // Count total recruiters and partners
    const totalRecruiters = await User.countDocuments({ 
      role: { $in: ['recruiter', 'partner'] }
    });
    
    // Count by role
    const recruiterCount = await User.countDocuments({ role: 'recruiter' });
    const partnerCount = await User.countDocuments({ role: 'partner' });
    
    // Get recent recruiters and partners with their admin profiles
    const recentRecruitersUsers = await User.find({ 
      role: { $in: ['recruiter', 'partner'] }
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('name email role createdAt');
    
    // Get company info from AdminProfile for each user
    const recentRecruiters = await Promise.all(
      recentRecruitersUsers.map(async (user) => {
        const adminProfile = await AdminProfile.findOne({ user: user._id });
        return {
          ...user._doc,
          company: adminProfile ? {
            name: adminProfile.companyName,
            position: adminProfile.position
          } : null
        };
      })
    );
    
    res.json({
      success: true,
      stats: {
        totalRecruiters,
        recruiterCount,
        partnerCount,
        recentRecruiters
      }
    });
  } catch (error) {
    console.error('Error fetching recruiter stats:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching statistics'
    });
  }
});

// Login as recruiter/partner functionality
router.post('/recruiters/login-as-recruiter', protect, isAdmin, async (req, res) => {
  try {
    const { recruiterId } = req.body;
    console.log('Login as user ID:', recruiterId);
    
    // Find the recruiter or partner
    const recruiter = await User.findOne({
      _id: recruiterId,
      role: { $in: ['recruiter', 'partner'] }
    }).select('-password');
    
    console.log('Found user:', recruiter);
    
    if (!recruiter) {
      return res.status(404).json({
        success: false,
        message: 'Recruiter/Partner not found'
      });
    }
    
    console.log('Generating token for user');
    
    // Generate a token for the recruiter/partner
    const token = jwt.sign(
      { id: recruiter._id, role: recruiter.role },
      process.env.JWT_SECRET,
    );
    
    res.json({
      success: true,
      token,
      user: {
        id: recruiter._id,
        name: recruiter.name,
        email: recruiter.email,
        role: recruiter.role,
        company: recruiter.company
      }
    });
  } catch (error) {
    console.error('Error logging in as recruiter/partner:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while logging in as user'
    });
  }
});

module.exports = router;