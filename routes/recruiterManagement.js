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

// Get all recruiters - admin only
router.get('/recruiters', protect, isAdmin, getAllRecruiters);

// Get specific recruiter with details - admin only
router.get('/recruiters/:recruiterId', protect, isAdmin, getRecruiterDetails);

// Get detailed recruiter company information - admin only
router.get('/recruiters/:recruiterId/company', protect, isAdmin, getRecruiterCompanyDetails);

// Get jobs posted by a recruiter - admin only
router.get('/recruiters/:recruiterId/jobs', protect, isAdmin, getRecruiterJobs);

// Get applications for a recruiter's jobs - admin only
router.get('/recruiters/:recruiterId/applications', protect, isAdmin, getRecruiterApplications);

// Add a new recruiter - admin only
router.post('/recruiters', protect, isAdmin, createRecruiter);

// Update recruiter details - admin only
router.put('/recruiters/:recruiterId', protect, isAdmin, updateRecruiter);

// Update recruiter status - admin only
router.put('/recruiters/:recruiterId/status', protect, isAdmin, updateRecruiterStatus);
// Delete recruiter - admin only
router.delete('/recruiters/:recruiterId', protect, isAdmin, deleteRecruiter);

router.get('/recruiter-stats', protect, isAdmin, async (req, res) => {
  try {
    

    const totalRecruiters = await User.countDocuments({ role: 'recruiter' });
    
    // Get recent recruiters with their admin profiles
    const recentRecruitersUsers = await User.find({ role: 'recruiter' })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('name email createdAt');
    
    // Get company info from AdminProfile for each recruiter
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

router.post('/recruiters/login-as-recruiter', protect, isAdmin, async (req, res) => {
  try {
    const { recruiterId } = req.body;
    console.log(recruiterId)
    
    // Find the recruiter
    const recruiter = await User.findOne({
      _id: recruiterId,
      role: 'recruiter'
    }).select('-password');
    console.log(recruiter)
    if (!recruiter) {
      return res.status(404).json({
        success: false,
        message: 'Recruiter not found'
      });
    }
    console.log("hii")
    
    // Generate a token for the recruiter
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
    console.error('Error logging in as recruiter:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while logging in as recruiter'
    });
  }
});

module.exports = router;