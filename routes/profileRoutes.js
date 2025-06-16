const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Profile = require('../models/Profile');
const Partner = require('../models/Partner');
const Candidate = require('../models/Candidate');
const AdminProfile = require('../models/AdminProfile');

// Get profile name based on user role
router.get('/profile-name', async (req, res) => {
  try {
    const token = req.cookies.usertoken || req.headers.authorization?.split(' ')[1];
    const candidateToken = req.cookies.candidatetoken || req.headers.authorization?.split(' ')[1];

    if (!token && !candidateToken) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    // Handle candidate case
    if (candidateToken) {
      const candidate = await Candidate.findOne({})
        .populate('partner', 'partnerName')
        .select('name partner');

      if (!candidate) {
        return res.status(404).json({ success: false, message: 'Candidate not found' });
      }

      return res.json({
        success: true,
        name: candidate.name,
        partnerName: candidate.partner?.partnerName || '',
        role: 'candidate'
      });
    }

    // Handle regular user case
    const user = await User.findOne({}).select('role name');

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    let profileName = user.name;
    let companyName = '';

    if (user.role === 'recruiter' || user.role === 'admin') {
      const adminProfile = await AdminProfile.findOne({ user: user._id });
      if (adminProfile) {
        profileName = adminProfile.companyName;
        companyName = adminProfile.companyName;
      }
    } else if (user.role === 'partner') {
      const partner = await Partner.findOne({ user: user._id });
      if (partner) {
        profileName = partner.partnerName;
        companyName = partner.partnerName;
      }
    }

    res.json({
      success: true,
      name: profileName,
      companyName,
      role: user.role
    });

  } catch (error) {
    console.error('Error fetching profile name:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;