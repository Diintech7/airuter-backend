const AdminProfile = require('../models/AdminProfile');
const User = require('../models/User');

exports.getCompanyProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (user.role !== 'recruiter') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Recruiter only route.'
      });
    }
    const profile = await AdminProfile.findOne({ user: req.user.id });
    if (!profile) {
      return res.status(404).json({
        success: false,
        message: 'Company profile not found'
      });
    }

    res.json({
      success: true,
      data: {
        name: profile.companyName,
        industry: profile.industry,
        size: profile.companySize,
        location: profile.location,
        website: profile.website,
        position: profile.position,
        description: profile.description,
        contactEmail: profile.contactEmail,
        contactPhone: profile.contactPhone,
        logo: profile.logo,
        socialLinks: {
          linkedin: profile.socialLinks.linkedin,
          twitter: profile.socialLinks.twitter,
          facebook: profile.socialLinks.facebook
        },
        isComplete: profile.isComplete
      }
    });

  } catch (error) {
    console.error('Error in getCompanyProfile:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

exports.updateCompanyProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (user.role !== 'recruiter') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Recruiter only route.'
      });
    }

    const {
      name,
      industry,
      size,
      location,
      website,
      position,
      description,
      contactEmail,
      contactPhone,
      logo,
      socialLinks
    } = req.body;
    let profile = await AdminProfile.findOne({ user: req.user.id });
    
    if (!profile) {
      return res.status(404).json({
        success: false,
        message: 'Company profile not found'
      });
    }
    
    profile.companyName = name || profile.companyName;
    profile.industry = industry || profile.industry;
    profile.companySize = size || profile.companySize;
    profile.location = location || profile.location;
    profile.website = website || profile.website;
    profile.position = position || profile.position;
    profile.description = description || profile.description;
    profile.contactEmail = contactEmail || profile.contactEmail;
    profile.contactPhone = contactPhone || profile.contactPhone;
    
    // Update logo if provided
    if (logo) {
      profile.logo = logo;
    }
    
    // Update social links if provided
    if (socialLinks) {
      profile.socialLinks = {
        linkedin: socialLinks.linkedin || profile.socialLinks.linkedin,
        twitter: socialLinks.twitter || profile.socialLinks.twitter,
        facebook: socialLinks.facebook || profile.socialLinks.facebook
      };
    }
    
    profile.isComplete = true;
    profile.updatedAt = Date.now();

    await profile.save();

    res.json({
      success: true,
      data: {
        name: profile.companyName,
        industry: profile.industry,
        size: profile.companySize,
        location: profile.location,
        website: profile.website,
        position: profile.position,
        description: profile.description,
        contactEmail: profile.contactEmail,
        contactPhone: profile.contactPhone,
        logo: profile.logo,
        socialLinks: {
          linkedin: profile.socialLinks.linkedin,
          twitter: profile.socialLinks.twitter,
          facebook: profile.socialLinks.facebook
        },
        isComplete: profile.isComplete
      }
    });

  } catch (error) {
    console.error('Error in updateCompanyProfile:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

exports.createCompanyProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (user.role !== 'recruiter') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Recruiter only route.'
      });
    }
    let profile = await AdminProfile.findOne({ user: req.user.id });
    if (profile) {
      return res.status(400).json({
        success: false,
        message: 'Profile already exists'
      });
    }

    const {
      name,
      industry,
      size,
      location,
      website,
      position,
      description,
      contactEmail,
      contactPhone,
      logo,
      socialLinks
    } = req.body;
    
    profile = new AdminProfile({
      user: req.user.id,
      companyName: name,
      industry,
      companySize: size,
      location,
      website,
      position,
      description,
      contactEmail,
      contactPhone,
      logo,
      socialLinks: {
        linkedin: socialLinks?.linkedin || '',
        twitter: socialLinks?.twitter || '',
        facebook: socialLinks?.facebook || ''
      },
      isComplete: true
    });

    await profile.save();

    res.status(201).json({
      success: true,
      data: {
        name: profile.companyName,
        industry: profile.industry,
        size: profile.companySize,
        location: profile.location,
        website: profile.website,
        position: profile.position,
        description: profile.description,
        contactEmail: profile.contactEmail,
        contactPhone: profile.contactPhone,
        logo: profile.logo,
        socialLinks: {
          linkedin: profile.socialLinks.linkedin,
          twitter: profile.socialLinks.twitter,
          facebook: profile.socialLinks.facebook
        },
        isComplete: profile.isComplete
      }
    });

  } catch (error) {
    console.error('Error in createCompanyProfile:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};