// routes/partnerManagement.js
const express = require('express');
const router = express.Router();
const { protect, isAdmin } = require('../middleware/auth');
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
router.get('/partners', protect, isAdmin, getAllPartners);

// Get partner statistics - admin only
router.get('/partner-stats', protect, isAdmin, getPartnerStats);

// Get specific partner details - admin only
router.get('/partners/:partnerId', protect, isAdmin, getPartnerDetails);

// Create new partner - admin only
router.post('/partners', protect, isAdmin, createPartner);

// Update partner details - admin only
router.put('/partners/:partnerId', protect, isAdmin, updatePartner);

// Update partner status - admin only
router.put('/partners/:partnerId/status', protect, isAdmin, updatePartnerStatus);

// Convert recruiter to partner - admin only
router.post('/recruiters/:recruiterId/convert-to-partner', protect, isAdmin, convertRecruiterToPartner);

// Convert partner to recruiter - admin only
router.post('/partners/:partnerId/convert-to-recruiter', protect, isAdmin, convertPartnerToRecruiter);

// Delete partner - admin only
router.delete('/partners/:partnerId', protect, isAdmin, deletePartner);

module.exports = router;