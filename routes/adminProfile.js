const express = require("express")
const router = express.Router()
const { protectAdmin } = require("../middleware/candidateAuth")
const Admin = require("../models/Admin")

// Get admin profile
router.get("/profile", protectAdmin, async (req, res) => {
  try {
    const admin = await Admin.findById(req.user._id).select("-password")

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Admin profile not found",
      })
    }

    res.json({
      success: true,
      admin: {
        id: admin._id,
        firstName: admin.firstName,
        lastName: admin.lastName,
        name: `${admin.firstName} ${admin.lastName}`,
        email: admin.email,
        username: admin.username,
        phoneNumber: admin.phoneNumber,
        department: admin.department,
        status: admin.status,
        createdAt: admin.createdAt,
        lastLogin: admin.lastLogin,
      },
    })
  } catch (error) {
    console.error("Error fetching admin profile:", error)
    res.status(500).json({
      success: false,
      message: "Server error while fetching admin profile",
    })
  }
})

module.exports = router
