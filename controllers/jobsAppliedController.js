// controllers/jobsAppliedController.js
const JobApplication = require('../models/JobApplication');

exports.getMyApplications = async (req, res) => {
  try {
    console.log("Fetching applications for user:", req.user.id);
    
    const applications = await JobApplication.find({ applicant: req.user.id })
      .populate({
        path: 'job',
        select: 'title company location type status'
      })
      .populate('interview') // Add this to populate interview data
      .sort({ createdAt: -1 });
    
    console.log('Applications found:', applications.length);
    
    // Check for applications with missing job references
    const missingJobRefs = applications.filter(app => !app.job);
    if (missingJobRefs.length > 0) {
      console.log('Warning: Found applications with missing job references:', 
        missingJobRefs.map(app => app._id));
    }

    // Transform the data to include application statistics with error handling
    const transformedApplications = applications.map(app => {
      // Handle case where job reference might be missing
      if (!app.job) {
        console.log('Warning: Application missing job reference:', app._id);
        return {
          _id: app._id,
          job: {
            title: 'Unknown Job',
            company: 'Unknown Company',
            location: 'Unknown',
            type: 'Unknown',
            status: 'Unknown'
          },
          status: app.status || 'unknown',
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
          location: app.job.location || 'No Location',
          type: app.job.type || 'No Type',
          status: app.job.status || 'unknown'
        },
        status: app.status || 'unknown',
        coverLetter: app.coverLetter || '',
        additionalNotes: app.additionalNotes || '',
        resume: app.resume || '',
        interview: app.interview || null,
        interviewRoomId: app.interviewRoomId || null,
        createdAt: app.createdAt,
        updatedAt: app.updatedAt
      };
    });

    // Calculate statistics with safe access
    const stats = {
      total: applications.length,
      pending: applications.filter(app => app.status === 'pending').length,
      reviewed: applications.filter(app => app.status === 'reviewed').length,
      shortlisted: applications.filter(app => app.status === 'shortlisted').length,
      accepted: applications.filter(app => app.status === 'accepted').length,
      rejected: applications.filter(app => app.status === 'rejected').length
    };

    res.json({
      applications: transformedApplications,
      stats
    });
  } catch (error) {
    console.error('Error in getMyApplications:', error);
    res.status(500).json({ 
      message: 'Error fetching applications',
      error: error.message 
    });
  }
};

exports.getApplicationDetails = async (req, res) => {
  try {
    console.log("Fetching application details for ID:", req.params.id);
    
    const application = await JobApplication.findOne({
      _id: req.params.id,
      applicant: req.user.id
    })
    .populate('job')
    .populate('interview'); // Add this to populate interview data

    if (!application) {
      console.log("Application not found for ID:", req.params.id);
      return res.status(404).json({ message: 'Application not found' });
    }

    // Prepare safe response, handling potential missing job
    const safeResponse = {
      ...application.toObject(),
      job: application.job || {
        title: 'Unknown Job',
        company: 'Unknown Company',
        location: 'Unknown',
        type: 'Unknown',
        status: 'Unknown'
      }
    };

    res.json(safeResponse);
  } catch (error) {
    console.error('Error in getApplicationDetails:', error);
    res.status(500).json({ 
      message: 'Error fetching application details',
      error: error.message 
    });
  }
};