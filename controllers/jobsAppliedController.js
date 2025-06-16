// controllers/jobsAppliedController.js - Enhanced version
const JobApplication = require('../models/JobApplication');

exports.getMyApplications = async (req, res) => {
  try {
    // Get user ID from request (works for both candidates and regular users)
    const userId = req.user?.id || req.user?._id || req.candidate?.id || req.candidate?._id;
    
    if (!userId) {
      console.log("No user ID found in request");
      return res.status(401).json({
        success: false,
        message: 'User identification failed'
      });
    }

    console.log("Fetching applications for user:", userId);
    console.log("User type:", {
      isCandidate: req.isCandidate,
      isRegularUser: req.isRegularUser,
      userRole: req.userRole
    });
    
    const applications = await JobApplication.find({ applicant: userId })
      .populate({
        path: 'job',
        select: 'title company location type status createdAt updatedAt'
      })
      .populate({
        path: 'interview',
        select: 'date time status recordedAt screenRecordingUrl analysis'
      })
      .sort({ createdAt: -1 });
    
    console.log('Applications found:', applications.length);
    
    // Check for applications with missing job references
    const missingJobRefs = applications.filter(app => !app.job);
    const warnings = [];
    
    if (missingJobRefs.length > 0) {
      const warningMsg = `Found ${missingJobRefs.length} applications with missing job references`;
      console.warn(warningMsg);
      warnings.push(warningMsg);
    }

    // Transform the data to include application statistics with error handling
    const transformedApplications = applications.map(app => {
      // Handle case where job reference might be missing
      if (!app.job) {
        console.log('Warning: Application missing job reference:', app._id);
        return {
          _id: app._id,
          job: {
            title: 'Job No Longer Available',
            company: 'Unknown Company',
            location: 'Not Specified',
            type: 'Not Specified',
            status: 'unknown'
          },
          status: app.status || 'pending',
          coverLetter: app.coverLetter || '',
          additionalNotes: app.additionalNotes || '',
          resume: app.resume || '',
          interview: app.interview || null,
          interviewRoomId: app.interviewRoomId || null,
          createdAt: app.createdAt,
          updatedAt: app.updatedAt
        };
      }
      
      // Normal case where job exists
      return {
        _id: app._id,
        job: {
          title: app.job.title || 'No Title',
          company: app.job.company || 'No Company',
          location: app.job.location || 'Remote',
          type: app.job.type || 'Full-time',
          status: app.job.status || 'active'
        },
        status: app.status || 'pending',
        coverLetter: app.coverLetter || '',
        additionalNotes: app.additionalNotes || '',
        resume: app.resume || '',
        interview: app.interview ? {
          ...app.interview.toObject(),
          // Ensure analysis data is properly formatted
          analysis: app.interview.analysis ? {
            ...app.interview.analysis,
            analyzedAt: app.interview.analysis.analyzedAt || null,
            overallScores: app.interview.analysis.overallScores || {}
          } : null
        } : null,
        interviewRoomId: app.interviewRoomId || null,
        createdAt: app.createdAt,
        updatedAt: app.updatedAt
      };
    });

    // Calculate comprehensive statistics
    const stats = {
      total_applications: applications.length,
      pending: applications.filter(app => app.status === 'pending').length,
      reviewed: applications.filter(app => app.status === 'reviewed').length,
      shortlisted: applications.filter(app => app.status === 'shortlisted').length,
      accepted: applications.filter(app => app.status === 'accepted').length,
      rejected: applications.filter(app => app.status === 'rejected').length,
      // Additional useful stats
      with_interviews: applications.filter(app => app.interview || app.interviewRoomId).length,
      recent_applications: applications.filter(app => {
        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
        return new Date(app.createdAt) > oneWeekAgo;
      }).length
    };

    const response = {
      success: true,
      applications: transformedApplications,
      stats,
      meta: {
        total: applications.length,
        userType: req.isCandidate ? 'candidate' : 'user',
        userId: userId
      }
    };

    // Add warnings if any
    if (warnings.length > 0) {
      response.warnings = warnings;
    }

    res.json(response);
    
  } catch (error) {
    console.error('Error in getMyApplications:', error);
    res.status(500).json({ 
      success: false,
      message: 'Error fetching applications',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};

exports.getApplicationDetails = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.candidate?.id || req.candidate?._id;
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User identification failed'
      });
    }

    console.log("Fetching application details for ID:", req.params.id, "User:", userId);
    
    const application = await JobApplication.findOne({
      _id: req.params.id,
      applicant: userId
    })
    .populate({
      path: 'job',
      select: 'title company location type status description requirements salary'
    })
    .populate({
      path: 'interview',
      select: 'date time status recordedAt screenRecordingUrl analysis meetingLink'
    });

    if (!application) {
      console.log("Application not found for ID:", req.params.id);
      return res.status(404).json({ 
        success: false,
        message: 'Application not found or access denied'
      });
    }

    // Prepare safe response, handling potential missing job
    const safeResponse = {
      success: true,
      application: {
        ...application.toObject(),
        job: application.job || {
          title: 'Job No Longer Available',
          company: 'Unknown Company',
          location: 'Not Specified',
          type: 'Not Specified',
          status: 'unknown',
          description: 'This job posting is no longer available.',
          requirements: [],
          salary: 'Not specified'
        }
      }
    };

    res.json(safeResponse);
    
  } catch (error) {
    console.error('Error in getApplicationDetails:', error);
    res.status(500).json({ 
      success: false,
      message: 'Error fetching application details',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};