const express = require('express');
const router = express.Router();
const { analyzeResume } = require('../controllers/resumeController');
const { protect } = require('../middleware/auth');
const { analyzeApplicationResume } = require('../controllers/applicationResumeController');

// Remove the fileUpload middleware here since it's already applied globally
router.post('/analyze-pdf', analyzeResume);
router.post('/analyze', protect, analyzeApplicationResume);

module.exports = router;