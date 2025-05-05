const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/User');
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, JWT_SECRET } = require('../auth/config');

const AdminProfile = require('../models/AdminProfile');
const { protect } = require('../middleware/auth');
// Passport Google Strategy
// In auth.js, modify the Google Strategy
passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: "https://auriter-backen.onrender.com/api/auth/google/callback"
},
async (accessToken, refreshToken, profile, done) => {
  try {
    console.log("Google profile:", JSON.stringify(profile));
    
    // Make sure we're getting email
    if (!profile.emails || profile.emails.length === 0) {
      return done(new Error('No email found in Google profile'), null);
    }
    
    let user = await User.findOne({ googleId: profile.id });
    
    if (!user) {
      // Create user without role - we'll require role selection after auth
      user = new User({
        googleId: profile.id,
        name: profile.displayName || 'Google User',
        email: profile.emails[0].value,
        password: 'googleAuth', // You might want to handle this differently
        role: 'pendingSelection' // Add a temporary role to pass validation
      });
      
      // Save the user
      await user.save();
    }
    
    return done(null, user);
  } catch (error) {
    console.error("Google auth error:", error);
    return done(error, null);
  }
}
));

// Helper function to generate JWT
const generateToken = (id) => {
return jwt.sign({ id }, JWT_SECRET, {
  expiresIn: '30d'
});
};

// Google OAuth routes
router.get('/google',
passport.authenticate('google', { 
  scope: ['profile', 'email'],
  session: false 
})
);

// In auth.js
router.get('/google/callback',
  (req, res, next) => {
    passport.authenticate('google', { session: false }, async (err, user, info) => {
      if (err) {
        console.error("Passport authentication error:", err);
        return res.status(500).json({ 
          success: false, 
          message: 'Authentication error', 
          error: err.message 
        });
      }
      
      if (!user) {
        return res.status(401).json({ 
          success: false, 
          message: 'Authentication failed' 
        });
      }
      
      const token = generateToken(user._id);
      
      // If the user role is pending selection or doesn't have a proper role yet
      if (user.role === 'pendingSelection' || !['jobSeeker', 'recruiter'].includes(user.role)) {
        // Redirect to role selection page with token
        return res.redirect(`https://auriter-frontend.vercel.app/auth/callback?token=${token}&requiresRole=true`);
      } else {
        // User already has a valid role, complete auth flow
        return res.redirect(`https://auriter-frontend.vercel.app/auth/callback?token=${token}&role=${user.role}`);
      }
    })(req, res, next);
  }
);

// Token validation endpoint
router.get('/validate', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      role: user.role,
      name: user.name // Add the user's name to the response
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({
        success: false,
        message: 'User already exists'
      });
    }

    user = await User.create({
      name,
      email,
      password,
      role: 'jobSeeker'
    });

    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      token,
      requiresRole: true
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

router.post('/set-role', protect, async (req, res) => {
  try {
    const { role, company } = req.body;
    
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    user.role = role;
    
    if (role === 'recruiter' && company) {
      const adminProfile = new AdminProfile({
        user: user._id,
        companyName: company.name,
        position: company.position,
        website: company.website,
        isComplete: true
      });
      await adminProfile.save();
    }

    await user.save();

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

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const token = generateToken(user._id);

    res.json({
      success: true,
      token,
      role: user.role
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});


router.post('/get-token', protect, async (req, res) => {
  try {
    const { roomId, role } = req.body;
    
    // Generate a token with the roomId and role embedded
    const token = jwt.sign({ roomId, role }, JWT_SECRET, {
      expiresIn: '1h' // Token expires in 1 hour
    });

    res.json({
      success: true,
      token
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});



module.exports = router;