const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../auth/config');
const User = require('../models/User');
const Admin = require('../models/Admin');
const protect = async (req, res, next) => {
  try {
    let token;
    if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    } 
    else if (req.headers.authorization?.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized to access this route'
      });
    }
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role === 'admin') {
      req.user = await Admin.findById(decoded.id);
    } else {
      req.user = await User.findById(decoded.id);
    }
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Not authorized to access this route'
    });
  }
};
const isAdmin = async (req, res, next) => {
  if (req.user && req.user.role === 'admin' && req.user.status === 'approved') {
    next();
  } else {
    res.status(403).json({
      success: false,
      message: 'Access denied. Admin only.'
    });
  }
};
module.exports = { protect, isAdmin };