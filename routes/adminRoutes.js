// routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const { protect, isAdmin } = require('../middleware/auth');
const { getDashboardStats } = require('../controllers/adminController');

// Admin dashboard statistics
router.get('/dashboard/stats', protect, isAdmin, getDashboardStats);


module.exports = router;