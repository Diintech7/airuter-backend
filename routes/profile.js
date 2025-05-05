const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const Profile = require('../models/Profile');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parseResume } = require('../utils/resumeParser');
const User = require('../models/User');

// Serve static files from uploads directory
router.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)){
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    // Sanitize filename
    const originalname = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'resume-' + uniqueSuffix + path.extname(originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];
  
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only PDF and Word documents are allowed.'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
}).single('resume');

// Update the route handler to use async/await
router.post('/resume', protect, async (req, res) => {
  try {
    if (!req.files || !req.files.resume) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    const file = req.files.resume;

    // Validate file type
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid file type. Only PDF and Word documents are allowed.'
      });
    }

    // Generate unique filename
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const filename = 'resume-' + uniqueSuffix + path.extname(file.name);
    const uploadPath = path.join(__dirname, '../uploads', filename);

    // Move file to uploads directory
    await file.mv(uploadPath);

    try {
      // Parse resume
      const parsedData = await parseResume(uploadPath);
      
      // Store the relative path to the resume
      const relativePath = `/uploads/${filename}`;
      
      const profileData = {
        ...parsedData,
        user: req.user.id,
        isComplete: true,
        updatedAt: Date.now(),
        resumePath: relativePath // Save the resume path
      };

      let profile = await Profile.findOne({ user: req.user.id });
      
      if (profile) {
        profile = await Profile.findOneAndUpdate(
          { user: req.user.id },
          { $set: profileData },
          { new: true }
        );
      } else {
        profile = new Profile(profileData);
        await profile.save();
      }

      // No longer deleting the file - keeping it and its path in the database
      
      res.json({
        success: true,
        profile
      });
    } catch (error) {
      // Clean up uploaded file only on error
      fs.unlink(uploadPath, (err) => {
        if (err) console.error('Error deleting file:', err);
      });
      throw error;
    }
  } catch (error) {
    console.error('Resume upload/parsing error:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Resume upload failed'
    });
  }
});


// Get profile data with populated fields
router.get('/', protect, async (req, res) => {
  try {
    const profile = await Profile.findOne({ user: req.user.id });
    res.json(profile || null); // Return null if no profile exists
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update profile
router.put('/', protect, async (req, res) => {
  try {
    const profileData = {
      ...req.body,
      user: req.user.id,
      updatedAt: Date.now()
    };

    const profile = await Profile.findOneAndUpdate(
      { user: req.user.id },
      { $set: profileData },
      { new: true, upsert: true }
    );

    res.json(profile);
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});


// Get profile status
router.get('/status', protect, async (req, res) => {
  try {
    const profile = await Profile.findOne({ user: req.user.id });
    res.json({
      isComplete: profile ? profile.isComplete : false
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

router.get('/role', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json({
      success: true,
      role: user.role
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Update the create profile route in profile.js
router.post('/create', protect, async (req, res) => {
  try {
    let profileData = {
      user: req.user.id,
      isComplete: req.body.isComplete || false,
      updatedAt: Date.now()
    };

    // Only include required fields if not skipping
    if (!req.body.isComplete) {
      // This is a skip case, only set minimal required fields
      profileData = {
        ...profileData,
        firstName: '',
        lastName: '',
        email: ''
      };
    } else {
      // Include all profile fields for complete profile
      profileData = {
        ...profileData,
        firstName: req.body.firstName,
        lastName: req.body.lastName,
        email: req.body.email,
        phone: req.body.phone,
        location: req.body.location,
        title: req.body.title,
        summary: req.body.summary,
        yearsOfExperience: req.body.yearsOfExperience,
        education: req.body.education,
        experience: req.body.experience,
        skills: req.body.skills,
        languages: req.body.languages,
        certifications: req.body.certifications,
        achievements: req.body.achievements
      };
    }

    let profile = await Profile.findOne({ user: req.user.id });
    if (profile) {
      profile = await Profile.findOneAndUpdate(
        { user: req.user.id },
        { $set: profileData },
        { new: true }
      );
    } else {
      profile = new Profile(profileData);
      await profile.save();
    }

    res.json({ success: true, profile });
  } catch (error) {
    console.error('Profile creation error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;