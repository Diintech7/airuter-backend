const express = require("express")
const router = express.Router()
const { protect } = require("../middleware/auth")
const Partner = require("../models/Partner")

// Get partner profile
router.get("/profile", protect, async (req, res) => {
  try {
    const partner = await Partner.findOne({ user: req.user.id }).populate("user", "name email")

    if (!partner) {
      return res.status(404).json({
        success: false,
        message: "Partner profile not found",
      })
    }

    res.json({
      success: true,
      partner: {
        id: partner._id,
        partnerName: partner.partnerName,
        category: partner.category,
        email: partner.email,
        logo: partner.logo,
        website: partner.website,
        location: partner.location,
        description: partner.description,
        contactNumber: partner.contactNumber,
        adminContactPerson: partner.adminContactPerson,
        isActive: partner.isActive,
        isVerified: partner.isVerified,
        socialLinks: partner.socialLinks,
        establishedYear: partner.establishedYear,
      },
    })
  } catch (error) {
    console.error("Error fetching partner profile:", error)
    res.status(500).json({
      success: false,
      message: "Server error while fetching partner profile",
    })
  }
})

module.exports = router
