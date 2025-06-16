// routes/partnerJobAccess.js
const express = require('express');
const router = express.Router();
const Job = require('../models/Job');
const Partner = require('../models/Partner');
const Candidate = require('../models/Candidate');
const { protect, isAdmin } = require('../middleware/auth');

// Get all private jobs for admin
router.get('/private', protect, isAdmin, async (req, res) => {
  try {
    const privateJobs = await Job.find({ 
      visibility: 'private',
      status: 'active'
    })
    .populate('recruiter', 'name email')
    .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: privateJobs
    });
  } catch (error) {
    console.error('Error fetching private jobs:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching private jobs'
    });
  }
});

// Get jobs assigned to a specific partner
router.get('/:partnerId/assigned-jobs', protect, isAdmin, async (req, res) => {
  try {
    const { partnerId } = req.params;

    // Find partner
    const partner = await Partner.findById(partnerId);
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner not found'
      });
    }

    // Find jobs that have access granted to this partner
    const assignedJobs = await Job.find({
      'partnerAccess.partnerId': partnerId,
      'partnerAccess.access': 'granted'
    })
    .populate('recruiter', 'name email')
    .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: assignedJobs
    });
  } catch (error) {
    console.error('Error fetching assigned jobs:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching assigned jobs'
    });
  }
});

// Get partner statistics with job access info - THIS WAS MISSING
router.get('/:partnerId/stats', protect, isAdmin, async (req, res) => {
  try {
    const { partnerId } = req.params;

    // Verify partner exists
    const partner = await Partner.findById(partnerId);
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner not found'
      });
    }

    // Get candidate count
    const candidateCount = await Candidate.countDocuments({
      partner: partnerId,
      isActive: true
    });

    // Get assigned jobs count
    const assignedJobsCount = await Job.countDocuments({
      'partnerAccess.partnerId': partnerId,
      'partnerAccess.access': 'granted'
    });

    // Get total private jobs count
    const totalPrivateJobsCount = await Job.countDocuments({
      visibility: 'private',
      status: 'active'
    });

    res.status(200).json({
      success: true,
      data: {
        candidateCount,
        assignedJobsCount,
        totalPrivateJobsCount,
        accessPercentage: totalPrivateJobsCount > 0 
          ? Math.round((assignedJobsCount / totalPrivateJobsCount) * 100) 
          : 0
      }
    });
  } catch (error) {
    console.error('Error fetching partner stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching statistics'
    });
  }
});

// Assign job access to partner
router.post('/assign-to-partner', protect, isAdmin, async (req, res) => {
  try {
    const { jobId, partnerId, access } = req.body;

    // Validate input
    if (!jobId || !partnerId || !access) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    // Find job and partner
    const job = await Job.findById(jobId);
    const partner = await Partner.findById(partnerId);

    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Job not found'
      });
    }

    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner not found'
      });
    }

    // Initialize partnerAccess array if it doesn't exist
    if (!job.partnerAccess) {
      job.partnerAccess = [];
    }

    // Check if partner already has access
    const existingAccessIndex = job.partnerAccess.findIndex(
      pa => pa.partnerId.toString() === partnerId
    );

    if (existingAccessIndex !== -1) {
      // Update existing access
      job.partnerAccess[existingAccessIndex].access = access;
      job.partnerAccess[existingAccessIndex].grantedAt = new Date();
      job.partnerAccess[existingAccessIndex].grantedBy = req.user._id;
    } else {
      // Add new access
      job.partnerAccess.push({
        partnerId: partnerId,
        access: access,
        grantedAt: new Date(),
        grantedBy: req.user._id
      });
    }

    await job.save();

    res.status(200).json({
      success: true,
      message: `Job access ${access} successfully`,
      data: job
    });
  } catch (error) {
    console.error('Error assigning job access:', error);
    res.status(500).json({
      success: false,
      message: 'Error assigning job access'
    });
  }
});

// Revoke job access from partner
router.post('/revoke-partner-access', protect, isAdmin, async (req, res) => {
  try {
    const { jobId, partnerId } = req.body;

    // Validate input
    if (!jobId || !partnerId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    // Find job
    const job = await Job.findById(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Job not found'
      });
    }

    // Remove partner access
    if (job.partnerAccess) {
      job.partnerAccess = job.partnerAccess.filter(
        pa => pa.partnerId.toString() !== partnerId
      );
    }

    await job.save();

    res.status(200).json({
      success: true,
      message: 'Job access revoked successfully'
    });
  } catch (error) {
    console.error('Error revoking job access:', error);
    res.status(500).json({
      success: false,
      message: 'Error revoking job access'
    });
  }
});

// Alternative endpoint for job access stats (keeping the original one for compatibility)
router.get('/:partnerId/job-access-stats', protect, isAdmin, async (req, res) => {
  try {
    const { partnerId } = req.params;

    // Get candidate count
    const candidateCount = await Candidate.countDocuments({
      partner: partnerId,
      isActive: true
    });

    // Get assigned jobs count
    const assignedJobsCount = await Job.countDocuments({
      'partnerAccess.partnerId': partnerId,
      'partnerAccess.access': 'granted'
    });

    // Get total private jobs count
    const totalPrivateJobsCount = await Job.countDocuments({
      visibility: 'private',
      status: 'active'
    });

    res.status(200).json({
      success: true,
      data: {
        candidateCount,
        assignedJobsCount,
        totalPrivateJobsCount,
        accessPercentage: totalPrivateJobsCount > 0 
          ? Math.round((assignedJobsCount / totalPrivateJobsCount) * 100) 
          : 0
      }
    });
  } catch (error) {
    console.error('Error fetching job access stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching statistics'
    });
  }
});

module.exports = router;