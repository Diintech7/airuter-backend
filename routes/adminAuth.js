// routes/adminAuth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');
const User = require('../models/User'); // Add this import
const { optionalAuth, isAdmin } = require('../middleware/auth');

// Admin Registration
router.post('/register', async (req, res) => {
  try {
    const { firstName, lastName, email, username, password, phoneNumber, department, reason } = req.body;

    // Check if admin with email or username already exists
    const existingAdmin = await Admin.findOne({ 
      $or: [{ email }, { username }] 
    });

    if (existingAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Admin with this email or username already exists'
      });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create new admin
    const admin = new Admin({
      firstName,
      lastName,
      email,
      username,
      password: hashedPassword,
      phoneNumber,
      department,
      reason,
      status: 'pending',
      role: 'admin',
      createdAt: new Date()
    });

    await admin.save();

    res.status(201).json({
      success: true,
      message: 'Registration successful. Awaiting approval.'
    });
  } catch (error) {
    console.error('Admin registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during registration'
    });
  }
});

// Admin Login (only for approved admins)
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const admin = await Admin.findOne({ username });
    if (!admin) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    if (admin.status !== 'approved') {
      return res.status(403).json({
        success: false,
        message: 'Your account is pending approval',
        status: admin.status
      });
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Update last login time
    admin.lastLogin = new Date();
    await admin.save();           

    const token = jwt.sign(
      { id: admin._id, role: admin.role },
      process.env.JWT_SECRET,
    );

    // Set cookie with secure options
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });

    res.json({
      success: true,
      token, // Send token in response for backward compatibility
      user: {
        id: admin._id,
        username: admin.username,
        email: admin.email,
        firstName: admin.firstName,
        lastName: admin.lastName,
        role: admin.role
      }
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during login'
    });
  }
});

// Admin logout
router.post('/logout', optionalAuth, (req, res) => {
  res.clearCookie('token');
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

// Get current admin
router.get('/me', optionalAuth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Admin only.'
    });
  }
  
  res.json({
    success: true,
    user: {
      id: req.user._id,
      username: req.user.username,
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      role: req.user.role
    }
  });
});

// Get pending admin registrations (any approved admin can access)
router.get('/pending', optionalAuth, isAdmin, async (req, res) => {
  try {
    const pendingAdmins = await Admin.find({ status: 'pending' })
      .select('-password')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      admins: pendingAdmins
    });
  } catch (error) {
    console.error('Error fetching pending admins:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Approve/Reject admin registration (any approved admin can do this)
router.patch('/approve/:adminId', optionalAuth, isAdmin, async (req, res) => {
  try {
    const { adminId } = req.params;
    const { status, rejectionReason } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be "approved" or "rejected"'
      });
    }

    const admin = await Admin.findById(adminId);
    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
    }

    admin.status = status;
    admin.approvedBy = req.user.id;
    admin.approvedAt = new Date();
    
    if (status === 'rejected') {
      admin.rejectionReason = rejectionReason;
    }

    await admin.save();

    res.json({
      success: true,
      message: `Admin ${status} successfully`
    });
  } catch (error) {
    console.error('Error approving/rejecting admin:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

router.get('/dashboard', optionalAuth, isAdmin, async (req, res) => {
  try {
    console.log("hii")
    // Fetch relevant data for admin dashboard
    const pendingAdmins = await Admin.countDocuments({ status: 'pending' });
    const totalAdmins = await Admin.countDocuments({ status: 'approved' });
    const totalUsers = await User.countDocuments(); // This requires the User model
    console.log("all get")
    // Get recent activities (limited to last 10)
    const recentActivities = await Admin.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .select('firstName lastName status createdAt department')
      .lean();
    console.log("done")
    // Transform activities data
    const activities = recentActivities.map(admin => ({
      id: admin._id,
      type: admin.status,
      message: `${admin.firstName} ${admin.lastName} (${admin.department}) - ${admin.status}`,
      time: admin.createdAt,
      applicant: `${admin.firstName} ${admin.lastName}`
    }));
    console.log("sending")
    res.json({
      success: true,
      stats: {
        pendingAdmins,
        totalAdmins,
        totalUsers
      },
      recentActivities: activities
    });
  } catch (error) {
    console.error('Error fetching admin dashboard data:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard data'
    });
  }
});

module.exports = router;