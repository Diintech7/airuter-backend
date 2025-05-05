const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { scheduleMockInterview } = require('../controllers/interviewController');

// Route to schedule a mock interview
router.post('/schedule', protect, scheduleMockInterview);

// Export the router
module.exports = router;