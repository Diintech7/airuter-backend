// routes/jobsApplied.js
const express = require('express');
const router = express.Router();
const { 
  getMyApplications,
  getApplicationDetails
} = require('../controllers/jobsAppliedController');
const { protect } = require('../middleware/auth');

// Get all applications for the logged-in user
router.get('/my-applications', protect, getMyApplications);

// Get specific application details
router.get('/application/:id', protect, getApplicationDetails);

module.exports = router;