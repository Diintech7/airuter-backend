// routes/recruiterManagement.js
const express = require('express');
const router = express.Router();
const { optionalAuth, isAdmin } = require('../middleware/auth');
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
router.get('/recruiters', optionalAuth, isAdmin, getAllRecruiters);

// Get specific recruiter/partner with details - admin only
router.get('/recruiters/:recruiterId', optionalAuth, isAdmin, getRecruiterDetails);

// Get detailed recruiter/partner company information - admin only
router.get('/recruiters/:recruiterId/company', optionalAuth, isAdmin, getRecruiterCompanyDetails);

// Get jobs posted by a recruiter/partner - admin only
router.get('/recruiters/:recruiterId/jobs', optionalAuth, isAdmin, getRecruiterJobs);

// Get applications for a recruiter's/partner's jobs - admin only
router.get('/recruiters/:recruiterId/applications', optionalAuth, isAdmin, getRecruiterApplications);

// Add a new recruiter/partner - admin only
router.post('/recruiters', optionalAuth, isAdmin, createRecruiter);

// Update recruiter/partner details - admin only
router.put('/recruiters/:recruiterId', optionalAuth, isAdmin, updateRecruiter);

// Update recruiter/partner status - admin only
router.put('/recruiters/:recruiterId/status', optionalAuth, isAdmin, updateRecruiterStatus);

// Delete recruiter/partner - admin only
router.delete('/recruiters/:recruiterId', optionalAuth, isAdmin, deleteRecruiter);

// Get recruiter and partner statistics
router.get('/recruiter-stats', optionalAuth, isAdmin, async (req, res) => {
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

// Fixed Login as recruiter/partner functionality
router.post('/recruiters/login-as-recruiter', optionalAuth, isAdmin, async (req, res) => {
  try {
    const { recruiterId } = req.body;
    console.log('Login as recruiter ID:', recruiterId);
    
    // Find the recruiter or partner
    const recruiter = await User.findOne({
      _id: recruiterId,
      role: { $in: ['recruiter', 'partner'] }
    }).select('-password');
    
    console.log('Found recruiter:', recruiter);
    
    if (!recruiter) {
      return res.status(404).json({
        success: false,
        message: 'Recruiter/Partner not found'
      });
    }
    
    console.log('Generating token for recruiter with role:', recruiter.role);
    
    // Generate a token with proper role and permissions
    const tokenPayload = {
      id: recruiter._id,
      role: recruiter.role,
      email: recruiter.email,
      // Add role-specific permissions
      permissions: recruiter.role === 'partner' ? ['partner', 'recruiter'] : ['recruiter']
    };
    
    const token = jwt.sign(
      tokenPayload,
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    // Get company information if available
    let companyInfo = null;
    if (recruiter.company) {
      companyInfo = recruiter.company;
    } else {
      // Try to get from AdminProfile
      const adminProfile = await AdminProfile.findOne({ user: recruiter._id });
      if (adminProfile) {
        companyInfo = {
          name: adminProfile.companyName,
          position: adminProfile.position,
          website: adminProfile.website
        };
      }
    }
    
    const userResponse = {
      id: recruiter._id,
      name: recruiter.name,
      email: recruiter.email,
      role: recruiter.role,
      permissions: tokenPayload.permissions,
      company: companyInfo,
      isActive: recruiter.isActive
    };
    
    console.log('Sending response with user data:', userResponse);
    
    res.json({
      success: true,
      token,
      user: userResponse,
      dashboardRoute: recruiter.role === 'partner' ? '/partner/overview' : '/dashboard'
    });
  } catch (error) {
    console.error('Error logging in as recruiter/partner:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while logging in as user'
    });
  }
});

// Add user impersonation route for admin
router.post('/users/:userId/impersonate', optionalAuth, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    console.log('Admin impersonating user ID:', userId);
    
    // Find the user
    const user = await User.findById(userId).select('-password');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    console.log('Found user for impersonation:', user);
    
    // Generate token with proper role and permissions
    const permissions = [];
    if (user.role === 'recruiter') {
      permissions.push('recruiter');
    } else if (user.role === 'partner') {
      permissions.push('partner', 'recruiter'); // Partners get both permissions
    }
    
    const tokenPayload = {
      id: user._id,
      role: user.role,
      email: user.email,
      permissions: permissions
    };
    
    const token = jwt.sign(
      tokenPayload,
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    // Get company information
    let companyInfo = user.company || null;
    if (!companyInfo) {
      const adminProfile = await AdminProfile.findOne({ user: user._id });
      if (adminProfile) {
        companyInfo = {
          name: adminProfile.companyName,
          position: adminProfile.position,
          website: adminProfile.website
        };
      }
    }
    
    const userResponse = {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      permissions: permissions,
      company: companyInfo,
      isActive: user.isActive
    };
    
    res.json({
      success: true,
      token,
      user: userResponse,
      dashboardRoute: user.role === 'partner' ? '/partner/overview' : '/dashboard'
    });
  } catch (error) {
    console.error('Error during user impersonation:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while impersonating user'
    });
  }
});

module.exports = router;
