// routes/headerUserInfo.js
const express = require('express');
const { optionalAuth } = require('../middleware/candidateAuth');
const User = require('../models/User');
const Admin = require('../models/Admin');
const Candidate = require('../models/Candidate');

const router = express.Router();

/**
 * @route   GET /api/header/user-info
 * @desc    Get user information for header display (username, email, company info)
 * @access  Private (requires authentication)
 */
router.get('/user-info', optionalAuth, async (req, res) => {
  try {
    if (!req.isAuthenticated) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    const userInfo = {
      id: req.user._id,
      email: req.user.email,
      role: req.userRole,
      username: '',
      displayName: '',
      companyName: '',
      companyLogo: '',
      partnerName: '',
      partnerLogo: '',
      instituteName: '',
      avatarLetter: '',
      themeColor: 'purple' // default
    };

    // Handle different user roles
    switch (req.userRole) {
      case 'admin':
        userInfo.username = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'Administrator';
        userInfo.displayName = userInfo.username;
        userInfo.avatarLetter = 'A';
        userInfo.themeColor = 'red';
        break;

      case 'candidate':
        userInfo.username = req.user.name || req.user.firstName || 'Student';
        userInfo.displayName = userInfo.username;
        userInfo.avatarLetter = 'S';
        userInfo.themeColor = 'yellow';
        
        // Get institute name from populated partner
        if (req.user.partner && req.user.partner.partnerName) {
          userInfo.instituteName = req.user.partner.partnerName;
        }
        break;

      case 'partner':
        // For partners, we need to fetch additional profile data
        try {
          const partnerResponse = await fetch('https://airuter-backend.onrender.com/api/partner/profile', {
            headers: {
              'Authorization': `Bearer ${req.cookies.usertoken || req.headers.authorization?.split(' ')[1]}`
            }
          });
          
          if (partnerResponse.ok) {
            const partnerData = await partnerResponse.json();
            if (partnerData.success && partnerData.partner) {
              userInfo.partnerName = partnerData.partner.partnerName || 'Partner';
              userInfo.partnerLogo = partnerData.partner.logo || '';
              userInfo.displayName = userInfo.partnerName;
              userInfo.avatarLetter = userInfo.partnerName.charAt(0).toUpperCase();
            }
          }
        } catch (error) {
          console.error('Error fetching partner profile:', error);
          userInfo.displayName = 'Partner';
          userInfo.avatarLetter = 'P';
        }
        
        userInfo.username = req.user.name || req.user.firstName || 'Partner';
        userInfo.themeColor = 'blue';
        break;

      case 'recruiter':
        userInfo.username = req.user.name || req.user.firstName || 'Recruiter';
        userInfo.themeColor = 'purple';
        
        // For recruiters, fetch company profile
        try {
          const companyResponse = await fetch('https://airuter-backend.onrender.com/api/company/profile', {
            headers: {
              'Authorization': `Bearer ${req.cookies.usertoken || req.headers.authorization?.split(' ')[1]}`
            }
          });
          
          if (companyResponse.ok) {
            const companyData = await companyResponse.json();
            if (companyData.success && companyData.data) {
              userInfo.companyName = companyData.data.name || 'Company';
              userInfo.companyLogo = companyData.data.logo || '';
              userInfo.displayName = userInfo.companyName;
              userInfo.avatarLetter = userInfo.companyName.charAt(0).toUpperCase();
            }
          }
        } catch (error) {
          console.error('Error fetching company profile:', error);
          userInfo.displayName = userInfo.username;
          userInfo.avatarLetter = userInfo.username.charAt(0).toUpperCase();
        }
        break;

      default:
        userInfo.username = req.user.name || req.user.firstName || 'User';
        userInfo.displayName = userInfo.username;
        userInfo.avatarLetter = userInfo.username.charAt(0).toUpperCase();
        userInfo.themeColor = 'purple';
    }

    // Set default avatar letter if not set
    if (!userInfo.avatarLetter) {
      userInfo.avatarLetter = userInfo.username.charAt(0).toUpperCase() || 'U';
    }

    res.json({
      success: true,
      data: userInfo
    });

  } catch (error) {
    console.error('Error fetching header user info:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route   GET /api/header/user-info-simple
 * @desc    Get simplified user information for header (just username and email)
 * @access  Private (requires authentication)
 */
router.get('/user-info-simple', optionalAuth, async (req, res) => {
  try {
    if (!req.isAuthenticated) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    let username = '';
    let displayName = '';

    // Get username based on role
    switch (req.userRole) {
      case 'admin':
        username = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'Administrator';
        displayName = username;
        break;
      case 'candidate':
        username = req.user.name || req.user.firstName || 'Student';
        displayName = username;
        break;
      case 'partner':
      case 'recruiter':
      default:
        username = req.user.name || req.user.firstName || 'User';
        displayName = username;
    }

    res.json({
      success: true,
      data: {
        id: req.user._id,
        username: username,
        displayName: displayName,
        email: req.user.email,
        role: req.userRole,
        avatarLetter: username.charAt(0).toUpperCase() || 'U'
      }
    });

  } catch (error) {
    console.error('Error fetching simple header user info:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

module.exports = router;