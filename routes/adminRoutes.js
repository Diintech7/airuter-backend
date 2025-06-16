// routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const { optionalAuth, isAdmin } = require('../middleware/auth');
const { getDashboardStats } = require('../controllers/adminController');

// Admin dashboard statistics
router.get('/dashboard/stats',  getDashboardStats);


module.exports = router;