const express = require('express');
const router = express.Router();
const {
  scheduleInterview,
  getInterviewDetails,
  getInterviewQuestions,
  submitResponse,
  analyzeResponses,
  saveRecording,
  getInterviewRecordingsByApplicant,
  getInterviewAnalysis, // Add this new import
  getInterviewByApplicationId,
  getInterviewRecordingsByRoomId,
} = require('../controllers/interviewController');

// Existing routes...
router.post('/schedule', scheduleInterview);
router.get('/details/:roomId', getInterviewDetails);
router.get('/questions/:roomId', getInterviewQuestions);
router.post('/response/:roomId', submitResponse);
router.post('/analyze', analyzeResponses);
router.post('/save-recording', saveRecording);
router.get('/recordings/email/:email', getInterviewRecordingsByApplicant);

// Add the new route for getting analysis by room ID
router.get('/analysis/:roomId', getInterviewAnalysis);
router.get('/recordings/applicant/:id', getInterviewRecordingsByApplicant);

// Add this new route
router.get('/application/:applicationId', getInterviewByApplicationId);

// Add this new route
router.get('/recordings/room/:roomId', getInterviewRecordingsByRoomId);

module.exports = router;