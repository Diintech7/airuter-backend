const express = require("express")
const router = express.Router()
const User = require("../models/User")
const Profile = require("../models/Profile")
const Partner = require("../models/Partner")
const Candidate = require("../models/Candidate")
const AdminProfile = require("../models/AdminProfile")
const Admin = require("../models/Admin")

// Get profile name based on user role
router.get("/profile-name", require("../middleware/candidateAuth").optionalAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Not authenticated" })
    }

    // Candidate
    if (req.userRole === "candidate") {
      const candidate = await Candidate.findById(req.user._id).populate("partner", "partnerName logo").select("name email partner")
      if (!candidate) {
        return res.status(404).json({ success: false, message: "Candidate not found" })
      }
      return res.json({
        success: true,
        name: candidate.name,
        email: candidate.email,
        partnerName: candidate.partner?.partnerName || "",
        partnerLogo: candidate.partner?.logo || "",
        role: "candidate",
      })
    }

    // Admin
    if (req.userRole === "admin") {
      const admin = await Admin.findById(req.user._id).select("firstName lastName email")
      if (!admin) {
        return res.status(404).json({ success: false, message: "Admin not found" })
      }
      return res.json({
        success: true,
        name: `${admin.firstName} ${admin.lastName}`,
        email: admin.email,
        role: "admin",
      })
    }

    // User/JobSeeker/Recruiter/Partner
    const user = await User.findById(req.user._id).select("role name email profile")
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" })
    }
    let profileName = user.name
    let companyName = ""
    let companyLogo = ""
    let userEmail = user.email
    let profileData = {}

    // Handle different user roles
    if (user.role === "recruiter") {
      const adminProfile = await AdminProfile.findOne({ user: user._id })
      if (adminProfile) {
        profileName = adminProfile.companyName
        companyName = adminProfile.companyName
        companyLogo = adminProfile.logo
        userEmail = adminProfile.contactEmail || user.email
      }
    } else if (user.role === "partner") {
      const partner = await Partner.findOne({ user: user._id })
      if (partner) {
        profileName = partner.partnerName
        companyName = partner.partnerName
        companyLogo = partner.logo
        userEmail = partner.email || user.email
      }
    } else if (user.role === "jobSeeker") {
      if (typeof user.getDisplayName === "function") {
        profileName = user.getDisplayName()
      }
      profileData = {
        firstName: user.profile?.firstName || "",
        lastName: user.profile?.lastName || "",
        phone: user.profile?.phone || "",
        location: user.profile?.location || {},
        skills: user.profile?.skills || [],
        experience: user.profile?.experience || 0,
        profileCompleted: user.profileCompleted || false,
        resume: user.profile?.resume || null,
        preferences: user.profile?.preferences || {}
      }
    }

    const response = {
      success: true,
      name: profileName,
      email: userEmail,
      role: user.role,
    }

    // Add role-specific data
    if (user.role === "recruiter" || user.role === "partner") {
      response.companyName = companyName
      response.companyLogo = companyLogo
    }

    if (user.role === "jobSeeker") {
      response.profileData = profileData
    }

    res.json(response)
  } catch (error) {
    console.error("Error fetching profile name:", error)
    res.status(500).json({ success: false, message: "Server error" })
  }
})

// Get jobSeeker profile details
router.get("/jobseeker-profile", async (req, res) => {
  try {
    const token = req.cookies.usertoken || req.headers.authorization?.split(" ")[1]
    
    if (!token) {
      return res.status(401).json({ success: false, message: "Not authenticated" })
    }

    const user = await User.findOne({}).select("-password")
    
    if (!user || user.role !== "jobSeeker") {
      return res.status(404).json({ success: false, message: "JobSeeker not found" })
    }

    res.json({
      success: true,
      profile: {
        id: user._id,
        name: user.name,
        email: user.email,
        displayName: user.getDisplayName(),
        profileCompleted: user.profileCompleted,
        isActive: user.isActive,
        lastLogin: user.lastLogin,
        createdAt: user.createdAt,
        ...user.profile
      }
    })
  } catch (error) {
    console.error("Error fetching jobSeeker profile:", error)
    res.status(500).json({ success: false, message: "Server error" })
  }
})

// Update jobSeeker profile
router.put("/jobseeker-profile", async (req, res) => {
  try {
    const token = req.cookies.usertoken || req.headers.authorization?.split(" ")[1]
    
    if (!token) {
      return res.status(401).json({ success: false, message: "Not authenticated" })
    }

    const user = await User.findOne({})
    
    if (!user || user.role !== "jobSeeker") {
      return res.status(404).json({ success: false, message: "JobSeeker not found" })
    }

    const {
      firstName,
      lastName,
      phone,
      location,
      skills,
      experience,
      education,
      portfolio,
      preferences
    } = req.body

    // Update profile fields
    if (!user.profile) user.profile = {}
    
    if (firstName) user.profile.firstName = firstName
    if (lastName) user.profile.lastName = lastName
    if (phone) user.profile.phone = phone
    if (location) user.profile.location = location
    if (skills) user.profile.skills = skills
    if (experience !== undefined) user.profile.experience = experience
    if (education) user.profile.education = education
    if (portfolio) user.profile.portfolio = portfolio
    if (preferences) user.profile.preferences = preferences

    await user.save()

    res.json({
      success: true,
      message: "Profile updated successfully",
      profile: {
        displayName: user.getDisplayName(),
        profileCompleted: user.profileCompleted,
        ...user.profile
      }
    })
  } catch (error) {
    console.error("Error updating jobSeeker profile:", error)
    res.status(500).json({ success: false, message: "Server error" })
  }
})

// Get all jobSeekers (for admin/recruiter dashboard)
router.get("/jobseekers", async (req, res) => {
  try {
    const { page = 1, limit = 10, search = "", skills = "", location = "" } = req.query
    
    const query = { role: "jobSeeker" }
    
    // Add search filters
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { "profile.firstName": { $regex: search, $options: "i" } },
        { "profile.lastName": { $regex: search, $options: "i" } }
      ]
    }
    
    if (skills) {
      query["profile.skills"] = { $in: skills.split(",") }
    }
    
    if (location) {
      query["profile.location.city"] = { $regex: location, $options: "i" }
    }

    const jobSeekers = await User.find(query)
      .select("-password")
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)

    const total = await User.countDocuments(query)

    res.json({
      success: true,
      jobSeekers: jobSeekers.map(user => ({
        id: user._id,
        name: user.name,
        email: user.email,
        displayName: user.getDisplayName(),
        profileCompleted: user.profileCompleted,
        isActive: user.isActive,
        lastLogin: user.lastLogin,
        createdAt: user.createdAt,
        profile: user.profile
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    })
  } catch (error) {
    console.error("Error fetching jobSeekers:", error)
    res.status(500).json({ success: false, message: "Server error" })
  }
})

// Get jobSeeker statistics
router.get("/jobseeker-stats", async (req, res) => {
  try {
    const totalJobSeekers = await User.countDocuments({ role: "jobSeeker" })
    const activeJobSeekers = await User.countDocuments({ role: "jobSeeker", isActive: true })
    const completedProfiles = await User.countDocuments({ role: "jobSeeker", profileCompleted: true })
    const newThisMonth = await User.countDocuments({
      role: "jobSeeker",
      createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
    })

    // Get top skills
    const skillsAggregation = await User.aggregate([
      { $match: { role: "jobSeeker" } },
      { $unwind: "$profile.skills" },
      { $group: { _id: "$profile.skills", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ])

    res.json({
      success: true,
      stats: {
        totalJobSeekers,
        activeJobSeekers,
        completedProfiles,
        newThisMonth,
        completionRate: totalJobSeekers > 0 ? ((completedProfiles / totalJobSeekers) * 100).toFixed(1) : 0,
        topSkills: skillsAggregation.map(skill => ({ skill: skill._id, count: skill.count }))
      }
    })
  } catch (error) {
    console.error("Error fetching jobSeeker stats:", error)
    res.status(500).json({ success: false, message: "Server error" })
  }
})

module.exports = router