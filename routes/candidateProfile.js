const express = require("express")
const router = express.Router()
const { protectCandidate } = require("../middleware/candidateAuth")
const Candidate = require("../models/Candidate")

// Get candidate profile with partner information
router.get("/profile", protectCandidate, async (req, res) => {
  try {
    const candidate = await Candidate.findById(req.user._id)
      .populate("partner", "partnerName category logo location")
      .populate("user", "name email")
      .select("-password -resetPasswordToken -resetPasswordExpire")

    if (!candidate) {
      return res.status(404).json({
        success: false,
        message: "Candidate profile not found",
      })
    }

    res.json({
      success: true,
      candidate: {
        id: candidate._id,
        name: candidate.name,
        email: candidate.email,
        mobileNumber: candidate.mobileNumber,
        registrationNumber: candidate.registrationNumber,
        dateOfBirth: candidate.dateOfBirth,
        gender: candidate.gender,
        address: candidate.address,
        education: candidate.education,
        skills: candidate.skills,
        experience: candidate.experience,
        documents: candidate.documents,
        jobPreferences: candidate.jobPreferences,
        enrolledCourse: candidate.enrolledCourse,
        partner: candidate.partner,
        isVerified: candidate.isVerified,
        verificationStatus: candidate.verificationStatus,
        isActive: candidate.isActive,
        createdAt: candidate.createdAt,
      },
    })
  } catch (error) {
    console.error("Error fetching candidate profile:", error)
    res.status(500).json({
      success: false,
      message: "Server error while fetching candidate profile",
    })
  }
})

// Update candidate profile
router.put("/profile", protectCandidate, async (req, res) => {
  try {
    const candidate = await Candidate.findById(req.user._id)

    if (!candidate) {
      return res.status(404).json({
        success: false,
        message: "Candidate profile not found",
      })
    }

    // Update allowed fields
    const allowedUpdates = [
      "name",
      "mobileNumber",
      "dateOfBirth",
      "gender",
      "address",
      "education",
      "skills",
      "experience",
      "jobPreferences",
      "notes",
    ]

    allowedUpdates.forEach((field) => {
      if (req.body[field] !== undefined) {
        candidate[field] = req.body[field]
      }
    })

    candidate.updatedAt = new Date()
    await candidate.save()

    res.json({
      success: true,
      message: "Profile updated successfully",
      candidate: candidate.getSummary(),
    })
  } catch (error) {
    console.error("Error updating candidate profile:", error)
    res.status(500).json({
      success: false,
      message: "Server error while updating candidate profile",
    })
  }
})

module.exports = router
