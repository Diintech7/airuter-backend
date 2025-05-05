const express = require('express');
const router = express.Router();
const { 
  submitApplication,
  getApplicationsByJob,
  getUserApplications,
  updateApplicationStatus,
  getAllCompanyApplications,
  searchApplications,
  getApplicationAnalysis,
  generateApplicationText,
  getApplicationById,
  getApplicationResume
} = require('../controllers/jobApplicationController');
const { protect } = require('../middleware/auth');

// Debugging middleware
router.use((req, res, next) => {
  console.log('Job Applications Route Debug:');
  console.log('Path:', req.path);
  console.log('Method:', req.method);
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  next();
});
router.post('/generate-content', protect, (req, res, next) => {
  console.log('Generate Content Request:', {
    body: req.body,
    headers: req.headers,
    user: req.user
  });
  next();
}, generateApplicationText);
// Get all applications for the company
router.get('/company', protect, getAllCompanyApplications);

// Search and filter applications
router.get('/search', protect, searchApplications);

// Get applications for a specific job
router.get('/job/:jobId', protect, getApplicationsByJob);

// Get user's applications
router.get('/my-applications', protect, getUserApplications);

// Submit new application
router.post('/:jobId', protect, submitApplication);

// Update application status
router.patch('/:applicationId/status', protect, updateApplicationStatus);

// Get a single application
router.get('/:applicationId', protect, getApplicationById);

// Get application analysis
router.get('/:applicationId/analysis', protect, getApplicationAnalysis);

// Get application resume
router.get('/:applicationId/resume', protect, getApplicationResume);

module.exports = router;