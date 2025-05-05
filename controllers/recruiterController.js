// controllers/recruiterController.js
const User = require('../models/User');
const Job = require('../models/Job');
const JobApplication = require('../models/JobApplication');
const AdminProfile = require('../models/AdminProfile');

// Get all recruiters with company details from AdminProfile
exports.getAllRecruiters = async (req, res) => {
  try {
    // Find all recruiters
    const recruiters = await User.find({ role: 'recruiter' })
      .select('-password')
      .sort({ createdAt: -1 });
    
    // Get admin profile data for each recruiter
    const recruitersWithProfiles = await Promise.all(
      recruiters.map(async (recruiter) => {
        const adminProfile = await AdminProfile.findOne({ user: recruiter._id });
        
        return {
          ...recruiter._doc,
          company: adminProfile ? {
            name: adminProfile.companyName,
            position: adminProfile.position,
            website: adminProfile.website,
            industry: adminProfile.industry,
            size: adminProfile.companySize,
            logo: adminProfile.logo,
            location: adminProfile.location,
            description: adminProfile.description
          } : recruiter.company
        };
      })
    );
    
    res.json({
      success: true,
      recruiters: recruitersWithProfiles
    });
  } catch (error) {
    console.error('Error fetching recruiters:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching recruiters'
    });
  }
};

// Get recruiter with job statistics and hiring data
exports.getRecruiterDetails = async (req, res) => {
  try {
    const { recruiterId } = req.params;
    
    // Find recruiter
    const recruiter = await User.findOne({
      _id: recruiterId,
      role: 'recruiter'
    }).select('-password');
    
    if (!recruiter) {
      return res.status(404).json({
        success: false,
        message: 'Recruiter not found'
      });
    }
    
    // Get admin profile data
    const adminProfile = await AdminProfile.findOne({ user: recruiterId });
    
    // Merge company data from AdminProfile if available
    const recruiterWithProfile = {
      ...recruiter._doc,
      company: adminProfile ? {
        name: adminProfile.companyName,
        position: adminProfile.position,
        website: adminProfile.website,
        industry: adminProfile.industry,
        size: adminProfile.companySize,
        location: adminProfile.location,
        description: adminProfile.description,
        logo: adminProfile.logo,
        contactInfo: {
          email: adminProfile.contactEmail,
          phone: adminProfile.contactPhone
        },
        socialLinks: adminProfile.socialLinks
      } : recruiter.company
    };
    
    // Get jobs from this recruiter
    const recruiterJobs = await Job.find({ recruiter: recruiterId });
    const jobIds = recruiterJobs.map(job => job._id);
    
    // Count various metrics
    const totalJobs = recruiterJobs.length;
    const activeJobs = recruiterJobs.filter(job => job.status === 'active').length;
    
    // Get application statistics
    const applications = await JobApplication.find({ job: { $in: jobIds } });
    const totalApplications = applications.length;
    const totalHired = applications.filter(app => app.status === 'accepted').length;
    
    // Get recent jobs
    const recentJobs = await Job.find({ recruiter: recruiterId })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('title company status createdAt');
    
    res.json({
      success: true,
      recruiter: recruiterWithProfile,
      stats: {
        totalJobs,
        activeJobs,
        totalApplications,
        totalHired
      },
      recentJobs
    });
  } catch (error) {
    console.error('Error fetching recruiter details:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching recruiter details'
    });
  }
};

// Create new recruiter with admin profile
exports.createRecruiter = async (req, res) => {
  try {
    const { name, email, password, company } = req.body;

    // Validate required fields
    if (!name || !email || !password || !company) {
      return res.status(400).json({
        success: false,
        message: 'Please provide name, email, password and company details'
      });
    }

    // Check if user with this email already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    // Create new recruiter
    const newRecruiter = new User({
      name,
      email,
      password, // Password will be hashed via pre-save hook
      role: 'recruiter',
      company: {
        name: company.name,
        position: company.position,
        website: company.website
      },
      isActive: true,
      createdAt: new Date()
    });

    await newRecruiter.save();

    // Create admin profile for the recruiter
    const newAdminProfile = new AdminProfile({
      user: newRecruiter._id,
      companyName: company.name,
      position: company.position,
      website: company.website,
      industry: company.industry || '',
      companySize: company.size || '',
      location: company.location || '',
      description: company.description || '',
      contactEmail: email,
      contactPhone: company.phone || '',
      isComplete: false,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await newAdminProfile.save();

    res.status(201).json({
      success: true,
      message: 'Recruiter added successfully',
      recruiter: {
        id: newRecruiter._id,
        name: newRecruiter.name,
        email: newRecruiter.email,
        company: {
          name: newAdminProfile.companyName,
          position: newAdminProfile.position,
          website: newAdminProfile.website
        }
      }
    });
  } catch (error) {
    console.error('Error creating recruiter:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while creating recruiter'
    });
  }
};

// Update recruiter with admin profile
exports.updateRecruiter = async (req, res) => {
  try {
    const { recruiterId } = req.params;
    const { name, email, company, status } = req.body;
    
    // Find recruiter
    const recruiter = await User.findOne({
      _id: recruiterId,
      role: 'recruiter'
    });
    
    if (!recruiter) {
      return res.status(404).json({
        success: false,
        message: 'Recruiter not found'
      });
    }

    // Update user fields if provided
    if (name) recruiter.name = name;
    if (email) recruiter.email = email;
    if (company) {
      recruiter.company = {
        name: company.name || recruiter.company?.name,
        position: company.position || recruiter.company?.position,
        website: company.website || recruiter.company?.website
      };
    }

    // Update status if provided
    if (status !== undefined) {
      recruiter.isActive = status;
    }

    await recruiter.save();

    // Find or create admin profile
    let adminProfile = await AdminProfile.findOne({ user: recruiterId });
    
    if (!adminProfile && company) {
      // Create new admin profile if it doesn't exist
      adminProfile = new AdminProfile({
        user: recruiterId,
        companyName: company.name,
        position: company.position,
        website: company.website,
        updatedAt: new Date()
      });
    } else if (adminProfile && company) {
      // Update existing admin profile
      if (company.name) adminProfile.companyName = company.name;
      if (company.position) adminProfile.position = company.position;
      if (company.website) adminProfile.website = company.website;
      if (company.industry) adminProfile.industry = company.industry;
      if (company.size) adminProfile.companySize = company.size;
      if (company.location) adminProfile.location = company.location;
      if (company.description) adminProfile.description = company.description;
      if (email) adminProfile.contactEmail = email;
      if (company.phone) adminProfile.contactPhone = company.phone;
      if (company.logo) adminProfile.logo = company.logo;
      
      adminProfile.updatedAt = new Date();
    }

    if (adminProfile) {
      await adminProfile.save();
    }

    res.json({
      success: true,
      message: 'Recruiter updated successfully',
      recruiter: {
        id: recruiter._id,
        name: recruiter.name,
        email: recruiter.email,
        company: adminProfile ? {
          name: adminProfile.companyName,
          position: adminProfile.position,
          website: adminProfile.website,
          industry: adminProfile.industry,
          size: adminProfile.companySize
        } : recruiter.company,
        isActive: recruiter.isActive
      }
    });
  } catch (error) {
    console.error('Error updating recruiter:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating recruiter'
    });
  }
};

// Delete recruiter and associated admin profile
exports.deleteRecruiter = async (req, res) => {
  try {
    const { recruiterId } = req.params;
    
    const recruiter = await User.findOne({
      _id: recruiterId,
      role: 'recruiter'
    });
    
    if (!recruiter) {
      return res.status(404).json({
        success: false,
        message: 'Recruiter not found'
      });
    }

    // Delete associated admin profile
    await AdminProfile.deleteOne({ user: recruiterId });

    // Delete the recruiter
    await recruiter.deleteOne();

    res.json({
      success: true,
      message: 'Recruiter deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting recruiter:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while deleting recruiter'
    });
  }
};

// Get recruiter's company details from admin profile
exports.getRecruiterCompanyDetails = async (req, res) => {
  try {
    const { recruiterId } = req.params;
    
    const adminProfile = await AdminProfile.findOne({ user: recruiterId });
    
    if (!adminProfile) {
      return res.status(404).json({
        success: false,
        message: 'Company profile not found'
      });
    }
    
    res.json({
      success: true,
      companyDetails: {
        name: adminProfile.companyName,
        position: adminProfile.position,
        website: adminProfile.website,
        industry: adminProfile.industry,
        size: adminProfile.companySize,
        location: adminProfile.location,
        description: adminProfile.description,
        contactEmail: adminProfile.contactEmail,
        contactPhone: adminProfile.contactPhone,
        logo: adminProfile.logo,
        socialLinks: adminProfile.socialLinks
      }
    });
  } catch (error) {
    console.error('Error fetching company details:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching company details'
    });
  }
};

// Get recruiter jobs with additional data
exports.getRecruiterJobs = async (req, res) => {
  try {
    const { recruiterId } = req.params;
    
    // Find all jobs by this recruiter
    const jobs = await Job.find({ recruiter: recruiterId })
      .sort({ createdAt: -1 });
    
    // Get application counts for each job
    const jobsWithCounts = await Promise.all(
      jobs.map(async (job) => {
        const applicationsCount = await JobApplication.countDocuments({ job: job._id });
        return {
          ...job._doc,
          applicationsCount
        };
      })
    );
    
    res.json({
      success: true,
      jobs: jobsWithCounts
    });
  } catch (error) {
    console.error('Error fetching recruiter jobs:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching jobs'
    });
  }
};

// Get applications for all jobs by this recruiter
exports.getRecruiterApplications = async (req, res) => {
  try {
    const { recruiterId } = req.params;
    
    // Find all jobs by this recruiter
    const jobs = await Job.find({ recruiter: recruiterId });
    const jobIds = jobs.map(job => job._id);
    
    // Find all applications for these jobs with populated applicant and job info
    const applications = await JobApplication.find({ job: { $in: jobIds } })
      .populate('applicant', 'name email')
      .populate('job', 'title company')
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      applications
    });
  } catch (error) {
    console.error('Error fetching recruiter applications:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching applications'
    });
  }
};

// Add this function to your recruiterController.js file

// Update recruiter status (active/inactive)
exports.updateRecruiterStatus = async (req, res) => {
    try {
      const { recruiterId } = req.params;
      const { status } = req.body;
      
      if (status === undefined) {
        return res.status(400).json({
          success: false,
          message: 'Status is required'
        });
      }
      
      const recruiter = await User.findOne({
        _id: recruiterId,
        role: 'recruiter'
      });
      
      if (!recruiter) {
        return res.status(404).json({
          success: false,
          message: 'Recruiter not found'
        });
      }
      
      recruiter.isActive = status;
      await recruiter.save();
      
      res.json({
        success: true,
        message: `Recruiter ${status ? 'activated' : 'deactivated'} successfully`,
        status: recruiter.isActive
      });
    } catch (error) {
      console.error('Error updating recruiter status:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while updating recruiter status'
      });
    }
  };