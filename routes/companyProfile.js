const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { 
  getCompanyProfile, 
  updateCompanyProfile, 
  createCompanyProfile 
} = require('../controllers/companyProfileController');

// Protect all routes
router.use(protect);

router.get('/', getCompanyProfile);
router.put('/', updateCompanyProfile);
router.post('/', createCompanyProfile);

module.exports = router; 