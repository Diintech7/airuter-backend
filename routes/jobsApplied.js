// routes/jobsApplied.js - Enhanced version for candidates
const express = require('express');
const router = express.Router();
const { 
  getMyApplications,
  getApplicationDetails
} = require('../controllers/jobsAppliedController');

// Import both auth middlewares to handle different user types
const { protect } = require('../middleware/candidateAuth');
const { optionalAuth } = require('../middleware/auth');

// Enhanced middleware that works for both regular users and candidates
const protectJobsRoute = async (req, res, next) => {
  try {
    let token;
    
    // Check for token in multiple places
    if (req.cookies && req.cookies.usertoken) {
      token = req.cookies.usertoken;
    } else if (req.cookies && req.cookies.candidatetoken) {
      token = req.cookies.candidatetoken;
    } else if (req.headers.authorization?.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No authentication token found'
      });
    }

    // Try the enhanced auth first (handles candidates, users, admins)
    try {
      await protect(req, res, next);
    } catch (error) {
      // If enhanced auth fails, try basic auth
      await optionalAuth(req, res, next);
      
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'Authentication failed'
        });
      }
    }
  } catch (error) {
    console.error('Authentication error in jobs route:', error);
    return res.status(401).json({
      success: false,
      message: 'Authentication failed',
      error: error.message
    });
  }
};

// Get all applications for the logged-in user (works for candidates and regular users)
router.get('/my-applications', protectJobsRoute, getMyApplications);

// Get specific application details
router.get('/application/:id', protectJobsRoute, getApplicationDetails);

module.exports = router;