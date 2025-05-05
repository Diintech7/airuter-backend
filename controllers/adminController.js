// controllers/adminController.js
const User = require('../models/User');
const Job = require('../models/Job');
const JobApplication = require('../models/JobApplication');
const Interview = require('../models/Interview');
const AdminProfile = require('../models/AdminProfile');

/**
 * Get comprehensive admin dashboard statistics
 * @route GET /api/admin/dashboard/stats
 * @access Private/Admin
 */
exports.getDashboardStats = async (req, res) => {
  try {
    // User statistics
    const totalUsers = await User.countDocuments({ role: 'user' });
    const totalRecruiters = await User.countDocuments({ role: 'recruiter' });
    const totalAdmins = await User.countDocuments({ role: 'admin' });
    const activeUsers = await User.countDocuments({ isActive: true, role: 'user' });
    
    // Calculate user growth rate (comparing users created in last 30 days vs previous 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    
    const newUsers = await User.countDocuments({ 
      createdAt: { $gte: thirtyDaysAgo } 
    });
    
    const previousPeriodUsers = await User.countDocuments({ 
      createdAt: { $gte: sixtyDaysAgo, $lt: thirtyDaysAgo } 
    });
    
    const userGrowthRate = previousPeriodUsers === 0 
      ? newUsers * 100 
      : Math.round((newUsers - previousPeriodUsers) / previousPeriodUsers * 100);
    
    // Job statistics
    const totalJobs = await Job.countDocuments();
    const activeJobs = await Job.countDocuments({ status: 'active' });
    
    // Job application statistics
    const totalApplications = await JobApplication.countDocuments();
    const pendingApplications = await JobApplication.countDocuments({ status: 'pending' });
    const shortlistedApplications = await JobApplication.countDocuments({ status: 'shortlisted' });
    const rejectedApplications = await JobApplication.countDocuments({ status: 'rejected' });
    
    // Interview statistics
    const totalInterviews = await Interview.countDocuments();
    const completedInterviews = await Interview.countDocuments({ screenRecordingUrl: { $ne: null } });
    
    // Calculate average time to hire (in days)
    const applications = await JobApplication.find({ status: 'accepted' })
      .select('createdAt updatedAt');
      
    let totalHireDays = 0;
    applications.forEach(app => {
      const hireDays = Math.round((app.updatedAt - app.createdAt) / (1000 * 60 * 60 * 24));
      totalHireDays += hireDays;
    });
    
    const avgTimeToHire = applications.length > 0 
      ? Math.round(totalHireDays / applications.length) 
      : 0;
    
    // Get recent recruitment activity (last 30 days)
    const recentJobs = await Job.countDocuments({ createdAt: { $gte: thirtyDaysAgo } });
    const recentApplications = await JobApplication.countDocuments({ createdAt: { $gte: thirtyDaysAgo } });
    const recentInterviews = await Interview.countDocuments({ createdAt: { $gte: thirtyDaysAgo } });
    
    // Monthly data for charts
    const monthlyData = await getMonthlyData();
    
    // Industry distribution data
    const industries = await AdminProfile.aggregate([
      { $match: { industry: { $ne: "" } } },
      { $group: { _id: "$industry", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);
    
    // User role distribution
    const userRoles = [
      { name: 'Job Seekers', value: totalUsers },
      { name: 'Recruiters', value: totalRecruiters },
      { name: 'Admins', value: totalAdmins }
    ];
    
    // Application status distribution
    const applicationStatuses = [
      { name: 'Pending', value: pendingApplications },
      { name: 'Shortlisted', value: shortlistedApplications },
      { name: 'Rejected', value: rejectedApplications },
      { name: 'Accepted', value: applications.length }
    ];
    
    res.json({
      success: true,
      data: {
        metrics: {
          userGrowthRate: `${userGrowthRate > 0 ? '+' : ''}${userGrowthRate}%`,
          activeUsers,
          totalApplications,
          recruiterActivity: totalRecruiters
        },
        totals: {
          users: totalUsers,
          recruiters: totalRecruiters,
          admins: totalAdmins,
          jobs: totalJobs,
          activeJobs,
          applications: totalApplications,
          interviews: totalInterviews
        },
        platformStats: {
          totalInterviews,
          completedInterviews,
          successfulHires: applications.length,
          avgTimeToHire,
          clientSatisfaction: '94%' // Placeholder - would come from a real feedback system
        },
        charts: {
          monthlyData,
          userRoles,
          applicationStatuses,
          industries: industries.map(i => ({ name: i._id, value: i.count }))
        },
        activity: {
          recentJobs,
          recentApplications,
          recentInterviews
        }
      }
    });
  } catch (error) {
    console.error('Error fetching admin dashboard stats:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching dashboard statistics'
    });
  }
};

/**
 * Helper function to get monthly data for charts
 */
async function getMonthlyData() {
  const months = [];
  const userCounts = [];
  const jobCounts = [];
  const applicationCounts = [];
  
  // Get data for the last 6 months
  for (let i = 5; i >= 0; i--) {
    const date = new Date();
    date.setMonth(date.getMonth() - i);
    
    const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
    const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    
    const monthName = monthStart.toLocaleString('default', { month: 'short' });
    months.push(monthName);
    
    // Count users registered in this month
    const usersInMonth = await User.countDocuments({
      createdAt: { $gte: monthStart, $lte: monthEnd }
    });
    userCounts.push(usersInMonth);
    
    // Count jobs posted in this month
    const jobsInMonth = await Job.countDocuments({
      createdAt: { $gte: monthStart, $lte: monthEnd }
    });
    jobCounts.push(jobsInMonth);
    
    // Count applications submitted in this month
    const applicationsInMonth = await JobApplication.countDocuments({
      createdAt: { $gte: monthStart, $lte: monthEnd }
    });
    applicationCounts.push(applicationsInMonth);
  }
  
  return {
    months,
    users: userCounts,
    jobs: jobCounts,
    applications: applicationCounts
  };
}