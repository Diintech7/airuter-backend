// routes/linkedinRoutes.js

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Profile = require('../models/Profile');
const { LinkedInAPI, transformLinkedInData } = require('../utils/linkedinAPI');

// LinkedIn OAuth configuration
const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const LINKEDIN_REDIRECT_URI = process.env.LINKEDIN_REDIRECT_URI;

// Initialize LinkedIn OAuth
router.get('/auth', (req, res) => {
  const scope = 'r_liteprofile r_emailaddress w_member_social';
  const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${LINKEDIN_CLIENT_ID}&redirect_uri=${LINKEDIN_REDIRECT_URI}&scope=${scope}`;
  res.redirect(authUrl);
});

// LinkedIn OAuth callback
router.get('/callback', async (req, res) => {
  try {
    const { code } = req.query;
    
    // Exchange code for access token
    const tokenResponse = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', null, {
      params: {
        grant_type: 'authorization_code',
        code,
        client_id: LINKEDIN_CLIENT_ID,
        client_secret: LINKEDIN_CLIENT_SECRET,
        redirect_uri: LINKEDIN_REDIRECT_URI
      }
    });

    const { access_token } = tokenResponse.data;
    
    // Store the access token in session or send to client
    req.session.linkedinToken = access_token;
    
    res.redirect('/profile/linkedin/import');
  } catch (error) {
    console.error('LinkedIn OAuth Error:', error);
    res.status(500).json({ message: 'LinkedIn authentication failed' });
  }
});

// Import LinkedIn profile
router.post('/import', auth, async (req, res) => {
  try {
    const accessToken = req.session.linkedinToken;
    if (!accessToken) {
      return res.status(401).json({ message: 'LinkedIn authentication required' });
    }

    const linkedinAPI = new LinkedInAPI(accessToken);
    
    // Fetch profile data from LinkedIn
    const linkedinProfile = await linkedinAPI.getFullProfile();
    const emailData = await linkedinAPI.getEmailAddress();
    
    // Transform LinkedIn data to our profile format
    const profileData = transformLinkedInData({
      ...linkedinProfile,
      email: emailData.elements[0]['handle~'].emailAddress
    });

    // Save to database
    let profile = await Profile.findOne({ user: req.user.id });
    if (profile) {
      profile = await Profile.findOneAndUpdate(
        { user: req.user.id },
        { 
          $set: {
            ...profileData,
            isComplete: true,
            updatedAt: Date.now()
          }
        },
        { new: true }
      );
    } else {
      profile = new Profile({
        ...profileData,
        user: req.user.id,
        isComplete: true
      });
      await profile.save();
    }

    res.json({ success: true, profile });
  } catch (error) {
    console.error('LinkedIn Import Error:', error);
    res.status(500).json({ message: 'LinkedIn import failed', error: error.message });
  }
});

module.exports = router;