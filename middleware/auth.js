const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../auth/config');
const User = require('../models/User');
const Admin = require('../models/Admin');
const Candidate = require('../models/Candidate');

// Simple token generation
const generateToken = (id, role = 'user') => {
  return jwt.sign({ id, role }, JWT_SECRET, {
    expiresIn: '30d'
  });
};

// In the protect middleware, update the user fetching logic:
const protect = async (req, res, next) => {
  try {
    let token;
    
    if (req.cookies && req.cookies.usertoken) {
      token = req.cookies.usertoken;
    }
    else if (req.cookies && req.cookies.candidatetoken) {
      token = req.cookies.candidatetoken;
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
    
    if (decoded.role === 'candidate') {
      req.candidate = await Candidate.findById(decoded.id);
      if (!req.candidate) {
        return res.status(401).json({
          success: false,
          message: 'Candidate not found'
        });
      }
    } else {
      req.user = await User.findById(decoded.id);
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'User not found'
        });
      }
    }

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Not authorized to access this route'
    });
  }
};

// Enhanced optional auth middleware that handles candidates
const optionalAuth = async (req, res, next) => {
  try {
    let token;
    
    if (req.cookies && req.cookies.usertoken) {
      token = req.cookies.usertoken;
    }
    else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    } 
    else if (req.headers.authorization?.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      // No token provided, continue without authentication
      req.user = null;
      req.isCandidate = false;
      req.isAdmin = false;
      req.isRegularUser = false;
      req.candidate = null;
      return next();
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    
    if (decoded.role === 'candidate') {
      // Handle candidate authentication
      const candidate = await Candidate.findById(decoded.id)
        .populate('partner', 'partnerName category location')
        .select('-password -resetPasswordToken -resetPasswordExpire');

      if (candidate && candidate.isActive) {
        req.candidate = candidate;
        req.user = candidate; // For compatibility
        req.isCandidate = true;
        req.isAdmin = false;
        req.isRegularUser = false;
      } else {
        req.user = null;
        req.candidate = null;
        req.isCandidate = false;
        req.isAdmin = false;
        req.isRegularUser = false;
      }
    } else if (decoded.role === 'admin') {
      const admin = await Admin.findById(decoded.id);
      if (admin) {
        req.user = admin;
        req.isAdmin = true;
        req.isCandidate = false;
        req.isRegularUser = false;
        req.candidate = null;
      } else {
        req.user = null;
        req.isAdmin = false;
        req.isCandidate = false;
        req.isRegularUser = false;
        req.candidate = null;
      }
    } else {
      // Handle regular users
      const user = await User.findById(decoded.id);
      if (user) {
        req.user = user;
        req.isRegularUser = true;
        req.isCandidate = false;
        req.isAdmin = false;
        req.candidate = null;
      } else {
        req.user = null;
        req.isRegularUser = false;
        req.isCandidate = false;
        req.isAdmin = false;
        req.candidate = null;
      }
    }

    next();
  } catch (error) {
    // If token is invalid, continue without authentication
    req.user = null;
    req.isCandidate = false;
    req.isAdmin = false;
    req.isRegularUser = false;
    req.candidate = null;
    next();
  }
};

// Candidate protect middleware
const protectCandidate = async (req, res, next) => {
  try {
    let token;
    
    if (req.cookies && req.cookies.usertoken) {
      token = req.cookies.usertoken;
    }
    else if (req.headers.authorization?.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided'
      });
    }

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);
    
    if (decoded.role !== 'candidate') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token type'
      });
    }

    // Get candidate from database
    const candidate = await Candidate.findById(decoded.id)
      .populate('partner', 'partnerName category location')
      .select('-password -resetPasswordToken -resetPasswordExpire');

    if (!candidate || !candidate.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token or inactive account'
      });
    }

    req.candidate = candidate;
    req.user = candidate; // For compatibility
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid token'
    });
  }
};

// Admin middleware
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

module.exports = { 
  protect, 
  protectCandidate, 
  isAdmin, 
  generateToken,
  optionalAuth
};



