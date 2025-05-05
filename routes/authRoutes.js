const express = require('express');
const router = express.Router();
const { getToken } = require('../controllers/authController');

router.post('/get-token', getToken);

module.exports = router;