// routes/partnerManagement.js
const express = require('express');
const router = express.Router();
const { optionalAuth, isAdmin } = require('../middleware/auth');
const {
  getAllPartners,
  getPartnerDetails,
  createPartner,
  updatePartner,
  convertRecruiterToPartner,
  convertPartnerToRecruiter,
  deletePartner,
  updatePartnerStatus,
  getPartnerStats
} = require('../controllers/partnerController');

// Get all partners - admin only
router.get('/partners', optionalAuth, isAdmin, getAllPartners);

// Get partner statistics - admin only
router.get('/partner-stats', optionalAuth, isAdmin, getPartnerStats);

// Get specific partner details - admin only
router.get('/partners/:partnerId', optionalAuth, isAdmin, getPartnerDetails);

// Create new partner - admin only
router.post('/partners', optionalAuth, isAdmin, createPartner);

// Update partner details - admin only
router.put('/partners/:partnerId', optionalAuth, isAdmin, updatePartner);

// Update partner status - admin only
router.put('/partners/:partnerId/status', optionalAuth, isAdmin, updatePartnerStatus);

// Convert recruiter to partner - admin only
router.post('/recruiters/:recruiterId/convert-to-partner', optionalAuth, isAdmin, convertRecruiterToPartner);

// Convert partner to recruiter - admin only
router.post('/partners/:partnerId/convert-to-recruiter', optionalAuth, isAdmin, convertPartnerToRecruiter);

// Delete partner - admin only
router.delete('/partners/:partnerId', optionalAuth, isAdmin, deletePartner);

module.exports = router;