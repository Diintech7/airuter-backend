const jwt = require("jsonwebtoken")
const { JWT_SECRET } = require("../auth/config")
const User = require("../models/User")
const Admin = require("../models/Admin")
const Candidate = require("../models/Candidate")

// Enhanced token generation with role-specific data
const generateToken = (user, role = "user") => {
  const permissions = []

  // Set permissions based on role
  if (role === "recruiter") {
    permissions.push("recruiter")
  } else if (role === "partner") {
    permissions.push("partner", "recruiter") // Partners get both permissions
  } else if (role === "admin") {
    permissions.push("admin")
  } else if (role === "candidate") {
    permissions.push("candidate")
  }

  const payload = {
    id: user._id,
    role: role,
    email: user.email,
    permissions: permissions,
    // Add role-specific data
    ...(role === "candidate" && { partner: user.partner }),
    ...(role === "admin" && { adminPermissions: user.permissions }),
    ...(role === "recruiter" && { company: user.company }),
    ...(role === "partner" && { partnerData: user.partnerData, company: user.company }),
  }

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: "30d",
  })
}

// Enhanced authentication check that determines user type and dashboard route
const checkAuth = async (req, res, next) => {
  try {
    let token

    // Check multiple token sources
    if (req.cookies && req.cookies.usertoken) {
      token = req.cookies.usertoken
    } else if (req.cookies && req.cookies.admintoken) {
      token = req.cookies.admintoken
    } else if (req.cookies && req.cookies.candidatetoken) {
      token = req.cookies.candidatetoken
    } else if (req.headers.authorization?.startsWith("Bearer")) {
      token = req.headers.authorization.split(" ")[1]
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "No authentication token found",
        redirect: "/auth",
      })
    }

    const decoded = jwt.verify(token, JWT_SECRET)
    let user = null
    let dashboardRoute = "/dashboard"

    console.log("Decoded token:", decoded)

    // Determine user type and set appropriate dashboard route
    switch (decoded.role) {
      case "admin":
        user = await Admin.findById(decoded.id).select("-password")
        dashboardRoute = "/admin/dashboard"
        break

      case "candidate":
        user = await Candidate.findById(decoded.id)
          .populate("partner", "partnerName category location")
          .select("-password -resetPasswordToken -resetPasswordExpire")
        dashboardRoute = "/candidate/dashboard"
        break

      case "partner":
        user = await User.findById(decoded.id).select("-password")
        dashboardRoute = "/partner/overview"
        break

      case "recruiter":
        user = await User.findById(decoded.id).select("-password")
        dashboardRoute = "/dashboard"
        break

      case "jobSeeker":
      case "user":
        user = await User.findById(decoded.id).select("-password")
        dashboardRoute = "/dashboard"
        break

      default:
        // Try to find user in User collection first
        user = await User.findById(decoded.id).select("-password")
        if (!user) {
          // If not found, try Candidate collection
          user = await Candidate.findById(decoded.id)
            .populate("partner", "partnerName category location")
            .select("-password -resetPasswordToken -resetPasswordExpire")
          if (user) {
            dashboardRoute = "/candidate/dashboard"
          }
        }
        if (!user) {
          dashboardRoute = "/dashboard"
        }
    }

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found",
        redirect: "/auth",
      })
    }

    // Check if user is active (for most user types)
    if (
      (decoded.role === "candidate" || decoded.role === "user" || decoded.role === "jobSeeker") &&
      user.isActive === false
    ) {
      return res.status(401).json({
        success: false,
        message: "Account is inactive",
        redirect: "/auth",
      })
    }

    // Check if admin is approved
    if (decoded.role === "admin" && user.status !== "approved") {
      return res.status(401).json({
        success: false,
        message: "Admin account not approved",
        redirect: "/admin/login",
      })
    }

    // Set user data in request
    req.user = user
    req.userRole = decoded.role
    req.userPermissions = decoded.permissions || []
    req.dashboardRoute = dashboardRoute
    req.isAuthenticated = true

    // Set role-specific flags
    req.isAdmin = decoded.role === "admin"
    req.isCandidate = decoded.role === "candidate"
    req.isRecruiter = decoded.role === "recruiter" || req.userPermissions.includes("recruiter")
    req.isPartner = decoded.role === "partner" || req.userPermissions.includes("partner")
    req.isUser = decoded.role === "user" || decoded.role === "jobSeeker"

    console.log("Auth check successful:", {
      role: decoded.role,
      permissions: decoded.permissions,
      isRecruiter: req.isRecruiter,
      isPartner: req.isPartner,
      isUser: req.isUser,
      dashboardRoute: dashboardRoute,
    })

    next()
  } catch (error) {
    console.error("Authentication error:", error)
    return res.status(401).json({
      success: false,
      message: "Invalid authentication token",
      redirect: "/auth",
    })
  }
}

// Middleware to protect routes based on user role
const protect = async (req, res, next) => {
  await checkAuth(req, res, next)
}

// Middleware specifically for candidate routes
const protectCandidate = async (req, res, next) => {
  try {
    await checkAuth(req, res, () => {
      if (!req.isCandidate) {
        return res.status(403).json({
          success: false,
          message: "Access denied. Candidates only.",
          redirect: req.dashboardRoute,
        })
      }
      next()
    })
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Candidate authentication failed",
      redirect: "/candidate/login",
    })
  }
}

// Admin middleware
const protectAdmin = async (req, res, next) => {
  try {
    await checkAuth(req, res, () => {
      if (!req.isAdmin) {
        return res.status(403).json({
          success: false,
          message: "Access denied. Admins only.",
          redirect: req.dashboardRoute,
        })
      }
      next()
    })
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Admin authentication failed",
      redirect: "/admin/login",
    })
  }
}

// Recruiter middleware
const protectRecruiter = async (req, res, next) => {
  try {
    await checkAuth(req, res, () => {
      if (!req.isRecruiter && !req.isPartner) {
        return res.status(403).json({
          success: false,
          message: "Access denied. Recruiters only.",
          redirect: req.dashboardRoute,
        })
      }
      next()
    })
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Recruiter authentication failed",
      redirect: "/auth",
    })
  }
}

// Optional auth middleware that doesn't require authentication
const optionalAuth = async (req, res, next) => {
  try {
    await checkAuth(req, res, next)
  } catch (error) {
    // Continue without authentication
    req.user = null
    req.userRole = null
    req.userPermissions = []
    req.isAuthenticated = false
    req.isAdmin = false
    req.isCandidate = false
    req.isRecruiter = false
    req.isPartner = false
    req.dashboardRoute = "/auth"
    next()
  }
}

// Validation endpoint for frontend
const validateToken = async (req, res) => {
  try {
    await checkAuth(req, res, () => {
      res.json({
        success: true,
        authenticated: true,
        user: {
          id: req.user._id,
          email: req.user.email,
          role: req.userRole,
          permissions: req.userPermissions,
          name: req.user.name || req.user.firstName,
          ...(req.isCandidate && { partner: req.user.partner }),
          ...(req.isRecruiter && { company: req.user.company }),
          ...(req.isPartner && { company: req.user.company }),
        },
        dashboardRoute: req.dashboardRoute,
        flags: {
          isAdmin: req.isAdmin,
          isCandidate: req.isCandidate,
          isRecruiter: req.isRecruiter,
          isPartner: req.isPartner,
        },
      })
    })
  } catch (error) {
    res.status(401).json({
      success: false,
      authenticated: false,
      message: "Token validation failed",
      redirect: "/auth",
    })
  }
}

module.exports = {
  protect,
  protectCandidate,
  protectAdmin,
  protectRecruiter,
  optionalAuth,
  generateToken,
  checkAuth,
  validateToken,
}
