const express = require("express")
const router = express.Router()
const User = require("../models/User")
const Profile = require("../models/Profile")
const Partner = require("../models/Partner")
const Candidate = require("../models/Candidate")
const AdminProfile = require("../models/AdminProfile")
const Admin = require("../models/Admin")

// Get profile name based on user role
router.get("/profile-name", async (req, res) => {
  try {
    const token = req.cookies.usertoken || req.cookies.admintoken || req.headers.authorization?.split(" ")[1]
    const candidateToken = req.cookies.candidatetoken

    if (!token && !candidateToken) {
      return res.status(401).json({ success: false, message: "Not authenticated" })
    }

    // Handle candidate case
    if (candidateToken) {
      const candidate = await Candidate.findOne({}).populate("partner", "partnerName logo").select("name email partner")

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

    // Handle admin case
    if (req.cookies.admintoken) {
      const admin = await Admin.findOne({}).select("firstName lastName email")

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

    // Handle regular user case
    const user = await User.findOne({}).select("role name email")

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" })
    }

    let profileName = user.name
    let companyName = ""
    let companyLogo = ""
    let userEmail = user.email

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
    }

    res.json({
      success: true,
      name: profileName,
      email: userEmail,
      companyName,
      companyLogo,
      role: user.role,
    })
  } catch (error) {
    console.error("Error fetching profile name:", error)
    res.status(500).json({ success: false, message: "Server error" })
  }
})

module.exports = router
