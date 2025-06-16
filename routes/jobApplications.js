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
const { optionalAuth } = require('../middleware/auth');

// Update all routes to use optionalAuth instead of protect
router.post('/generate-content', optionalAuth, generateApplicationText);
router.get('/company', optionalAuth, getAllCompanyApplications);
router.get('/search', optionalAuth, searchApplications);
router.get('/job/:jobId', optionalAuth, getApplicationsByJob);
router.get('/my-applications', optionalAuth, getUserApplications);
router.post('/:jobId', optionalAuth, submitApplication);
router.patch('/:applicationId/status', optionalAuth, updateApplicationStatus);
router.get('/:applicationId', optionalAuth, getApplicationById);
router.get('/:applicationId/analysis', optionalAuth, getApplicationAnalysis);
router.get('/:applicationId/resume', optionalAuth, getApplicationResume);

module.exports = router;