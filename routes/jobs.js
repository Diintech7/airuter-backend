const express = require('express');
const router = express.Router();
const { 
  createJob, 
  getJobs, 
  getRecruiterJobs, 
  updateJob, 
  deleteJob,
  getJobById,
  generateJobDetails,
  toggleJobStatus,
  getJobStats,
  duplicateJob,
  getJobApplicants,
  bulkUpdateJobs
} = require('../controllers/jobController');
const { protect } = require('../middleware/auth');

// Create a new job
router.post('/', protect, createJob);

// Generate job details with OpenAI
router.post('/generate-details', protect, generateJobDetails);

// Get all jobs (with filters)
router.get('/', getJobs);

// Get recruiter's jobs with stats
router.get('/my-jobs', protect, getRecruiterJobs);

// Duplicate a job
router.post('/:id/duplicate', protect, duplicateJob);

// Get job statistics
router.get('/:id/stats', protect, getJobStats);

// Get job applicants
router.get('/:id/applicants', protect, getJobApplicants);

// Bulk update jobs
router.post('/bulk-update', protect, bulkUpdateJobs);

// Toggle job status (active/hidden/closed/draft)
router.patch('/:id/status', protect, toggleJobStatus);

// Get job by ID
router.get('/:id', getJobById);

// Update job
router.patch('/:id', protect, updateJob);

// Delete job
router.delete('/:id', protect, deleteJob);

module.exports = router;