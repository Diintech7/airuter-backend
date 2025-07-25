// routes/userManagement.js
const express = require("express")
const router = express.Router()
const { optionalAuth, isAdmin } = require("../middleware/auth")
const User = require("../models/User")
const Profile = require("../models/Profile")
const JobApplication = require("../models/JobApplication")
const bcrypt = require("bcryptjs")
const { JWT_SECRET } = require("../auth/config")
const jwt = require("jsonwebtoken")

router.get("/users", optionalAuth, isAdmin, async (req, res) => {
  try {
    const { role } = req.query
    const filter = {}
    if (role) {
      filter.role = role
    }
    const users = await User.find(filter).select("-password").sort({ createdAt: -1 })
    res.json({
      success: true,
      users,
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error while fetching users",
    })
  }
})

router.get("/users/:userId/applications", optionalAuth, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params
    const user = await User.findById(userId)
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      })
    }
    const totalApplications = await JobApplication.countDocuments({ applicant: userId })
    const activeApplications = await JobApplication.countDocuments({
      applicant: userId,
      status: { $in: ["pending", "reviewed", "shortlisted"] },
    })
    const applicationsByStatus = await JobApplication.aggregate([
      { $match: { applicant: userId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ])
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    const applicationsByDate = await JobApplication.aggregate([
      {
        $match: {
          applicant: userId,
          createdAt: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ])
    res.json({
      success: true,
      totalApplications,
      activeApplications,
      applicationsByStatus,
      applicationsByDate,
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error while fetching user applications",
    })
  }
})

router.get("/users/:userId/applications/list", optionalAuth, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params
    const { status, sort = "newest", page = 1, limit = 10 } = req.query
    const filter = { applicant: userId }
    if (status) {
      filter.status = status
    }
    let sortOption = { createdAt: -1 } // Default: newest first
    if (sort === "oldest") {
      sortOption = { createdAt: 1 }
    }
    const skip = (Number.parseInt(page) - 1) * Number.parseInt(limit)
    const applications = await JobApplication.find(filter)
      .sort(sortOption)
      .skip(skip)
      .limit(Number.parseInt(limit))
      .populate("job", "title company location")
      .lean()
    const totalApplications = await JobApplication.countDocuments(filter)
    res.json({
      success: true,
      applications,
      pagination: {
        total: totalApplications,
        page: Number.parseInt(page),
        pages: Math.ceil(totalApplications / Number.parseInt(limit)),
      },
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error while fetching user applications",
    })
  }
})

router.get("/users/:userId/profile", optionalAuth, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params
    const user = await User.findById(userId).select("-password")
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      })
    }
    const profile = await Profile.findOne({ user: userId })
    res.json({
      success: true,
      user,
      profile,
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error while fetching user profile",
    })
  }
})

router.post("/users", optionalAuth, isAdmin, async (req, res) => {
  try {
    const { name, email, password, role } = req.body
    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Please provide name, email and password",
      })
    }
    const existingUser = await User.findOne({ email })
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "User with this email already exists",
      })
    }
    const newUser = new User({
      name,
      email,
      password,
      role: role || "user", // Default to user
      isActive: true,
    })
    await newUser.save()
    res.status(201).json({
      success: true,
      message: "User added successfully",
      user: {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        isActive: newUser.isActive,
      },
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error while creating user",
    })
  }
})

router.patch("/users/:userId/status", optionalAuth, isAdmin, async (req, res) => {
  try {
    const { isActive } = req.body
    if (typeof isActive !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "isActive must be a boolean value",
      })
    }
    const user = await User.findById(req.params.userId)
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      })
    }
    if (user._id.toString() === req.user.id && isActive === false) {
      return res.status(400).json({
        success: false,
        message: "You cannot deactivate your own account",
      })
    }
    user.isActive = isActive
    await user.save()
    res.json({
      success: true,
      message: `User ${isActive ? "activated" : "deactivated"} successfully`,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
      },
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error while updating user status",
    })
  }
})

router.put("/users/:userId", optionalAuth, isAdmin, async (req, res) => {
  try {
    const { name, email, role } = req.body
    const user = await User.findById(req.params.userId)
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      })
    }
    if (name) user.name = name
    if (email) user.email = email
    if (role && ["user", "recruiter", "admin", "jobSeeker", "partner"].includes(role)) user.role = role

    await user.save()
    res.json({
      success: true,
      message: "User updated successfully",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
      },
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error while updating user",
    })
  }
})

router.delete("/users/:userId", optionalAuth, isAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId)

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      })
    }
    if (user._id.toString() === req.user.id) {
      return res.status(400).json({
        success: false,
        message: "You cannot delete your own account",
      })
    }
    await user.deleteOne()
    res.json({
      success: true,
      message: "User deleted successfully",
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error while deleting user",
    })
  }
})

router.get("/users/:userId/resume", optionalAuth, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params
    const profile = await Profile.findOne({ user: userId })

    if (!profile || !profile.resumePath) {
      return res.status(404).json({
        success: false,
        message: "Resume not found for this user",
      })
    }
    const isFileURL = profile.resumePath.startsWith("http") || profile.resumePath.startsWith("/uploads/")
    res.json({
      success: true,
      profile,
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error while fetching user resume",
    })
  }
})

// Fixed user impersonation endpoint
router.post("/users/:userId/impersonate", optionalAuth, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId).select("-password");
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Generate token with proper role and permissions
    const permissions = [];
    let dashboardRoute = "/dashboard";

    // Set permissions and dashboard route based on user role
    switch (user.role) {
      case "recruiter":
        permissions.push("recruiter");
        dashboardRoute = "/dashboard";
        break;
      case "partner":
        permissions.push("partner", "recruiter");
        dashboardRoute = "/partner/overview";
        break;
      case "jobSeeker":
      case "user":
        permissions.push("user");
        dashboardRoute = "/dashboard";
        break;
      default:
        permissions.push("user");
        dashboardRoute = "/dashboard";
    }

    const tokenPayload = {
      id: user._id,
      role: user.role,
      email: user.email,
      name: user.name,
      permissions: permissions,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, {
      expiresIn: "30d",
    });

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        permissions: permissions,
        isActive: user.isActive,
      },
      dashboardRoute,
    });
  } catch (error) {
    console.error("Impersonation error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during impersonation",
    });
  }
});

module.exports = router
