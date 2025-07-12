require("dotenv").config()
const express = require("express")
const http = require("http")
const WebSocket = require("ws")
const cors = require("cors")
const connectDB = require("./config/db")
const chatRoutes = require("./routes/chat")
const resumeRoutes = require("./routes/resumeRoutes")
const { setupWebSocketServer } = require("./websocket/streamingServer")
const { setupDeepgramServer } = require("./websocket/deepgramServer")
const fileUpload = require("express-fileupload")
const authRoutes = require("./routes/auth")
const profileRoutes = require("./routes/profile")
const jobRoutes = require("./routes/jobs")
const jobApplicationRoutes = require("./routes/jobApplications")
const jobsAppliedRoutes = require("./routes/jobsApplied")
const interviewRoutes = require("./routes/interviewRoutes")
const companyProfileRoutes = require("./routes/companyProfile")
const datastoreRoutes = require("./routes/datastore")
const adminAuthRoutes = require("./routes/adminAuth")
const userManagementRoutes = require("./routes/userManagement")
const recuriterManagemnet = require("./routes/recruiterManagement")
const adminRoutes = require("./routes/adminRoutes")
const shortRoutes = require("./routes/shortRoutes")
const patners = require("./routes/partnerManagement")
const candidateRoutes = require("./routes/candidateRoutes")
const partnerJobAccessRoutes = require("./routes/partnerJobAccess")
const candidateAuth = require("./routes/candidateRoute")
const cookieParser = require("cookie-parser")
const profileRoutess = require("./routes/profileRoutes")
const { validateToken, checkAuth } = require("./middleware/candidateAuth")
const { setupUnifiedVoiceServer } = require("./websocket/unifiedVoiceServer")
const adminProfileRoutes = require("./routes/adminProfile")
const partnerProfileRoutes = require("./routes/partnerProfile")
const candidateProfileRoutes = require("./routes/candidateProfile")

const app = express()
const server = http.createServer(app)
const fs = require("fs")
const path = require("path")
const passport = require("passport")

const uploadDir = path.join(__dirname, "uploads")
const tempDir = path.join(__dirname, "temp")

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true })
}

const PORT = process.env.PORT || 5000

// Enhanced server startup with WebSocket logging
server.listen(PORT, () => {
  console.log("=".repeat(80))
  console.log(`🚀 SERVER STARTED ON PORT ${PORT}`)
  console.log("=".repeat(80))
  console.log("📡 WebSocket Endpoints Available:")
  console.log("   - ws://localhost:" + PORT + "/ws/unified-voice (SIP Voice Communication)")
  console.log("   - ws://localhost:" + PORT + "/ws/transcribe (Speech-to-Text)")
  console.log("   - ws://localhost:" + PORT + "/ws/speech (Text-to-Speech)")
  console.log("   - ws://localhost:" + PORT + "/ws/interview (Interview Sessions)")
  console.log("")
  console.log("🔐 Authentication endpoints available:")
  console.log("   - GET /api/auth/check (Universal auth check)")
  console.log("   - GET /api/auth/validate (User validation)")
  console.log("   - GET /api/candidate/validate (Candidate validation)")
  console.log("   - GET /api/admin/validate (Admin validation)")
  console.log("=".repeat(80))
})

connectDB()

app.use(
  cors({
    origin: "https://www.airuter.com",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
)

// Add cookie parser middleware
app.use(cookieParser())
app.use(passport.initialize())

app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.options("*", cors())

app.use((err, req, res, next) => {
  if (err.name === "CORSError") {
    res.status(403).json({
      success: false,
      message: "CORS error: " + err.message,
    })
  } else {
    next(err)
  }
})

app.use(
  fileUpload({
    useTempFiles: true,
    tempFileDir: tempDir,
    limits: { fileSize: 10 * 1024 * 1024 },
    abortOnLimit: true,
    createParentPath: true,
    debug: true,
  }),
)

app.use((error, req, res, next) => {
  if (error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      success: false,
      message: "File is too large. Maximum size is 10MB",
    })
  }

  if (error.code === "ENOENT") {
    return res.status(400).json({
      success: false,
      message: "Temp directory is not accessible",
    })
  }

  console.error("File upload error:", error)
  return res.status(500).json({
    success: false,
    message: "File upload failed",
    error: process.env.NODE_ENV === "development" ? error.message : undefined,
  })
})

// Authentication validation endpoints
app.get("/api/auth/validate", validateToken)
app.get("/api/candidate/validate", validateToken)
app.get("/api/admin/validate", validateToken)

// Universal authentication check endpoint
app.get("/api/auth/check", async (req, res) => {
  try {
    let token
    let tokenType = "none"

    // Check for different token types
    if (req.cookies.usertoken) {
      token = req.cookies.usertoken
      tokenType = "user"
    } else if (req.cookies.admintoken) {
      token = req.cookies.admintoken
      tokenType = "admin"
    } else if (req.cookies.candidatetoken) {
      token = req.cookies.candidatetoken
      tokenType = "candidate"
    } else if (req.headers.authorization?.startsWith("Bearer")) {
      token = req.headers.authorization.split(" ")[1]
      tokenType = "bearer"
    }

    if (!token) {
      return res.json({
        success: false,
        authenticated: false,
        message: "No authentication token found",
        redirect: "/auth",
      })
    }

    // Use checkAuth middleware to validate token
    await checkAuth(req, res, () => {
      res.json({
        success: true,
        authenticated: true,
        tokenType: tokenType,
        user: {
          id: req.user._id,
          email: req.user.email,
          role: req.userRole,
          permissions: req.userPermissions,
          name: req.user.name || req.user.firstName,
          ...(req.isCandidate && {
            partner: req.user.partner,
            partnerName: req.user.partner?.partnerName,
          }),
          ...(req.isRecruiter && { company: req.user.company }),
          ...(req.isAdmin && { status: req.user.status }),
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
    console.error("Auth check error:", error)
    res.status(401).json({
      success: false,
      authenticated: false,
      message: "Authentication check failed",
      redirect: "/auth",
    })
  }
})

// Route configurations
app.use("/api/chat", chatRoutes)
app.use("/api/resume", resumeRoutes)
app.use("/api/auth", authRoutes)
app.use("/api/profile", profileRoutes)
app.use("/api/jobs", jobRoutes)
app.use("/api/jobss", partnerJobAccessRoutes)
app.use("/api/applications", jobApplicationRoutes)
app.use("/api/jobs-applied", jobsAppliedRoutes)
app.use("/api/interview", interviewRoutes)
app.use("/api/company/profile", companyProfileRoutes)
app.use("/api/datastore", datastoreRoutes)
app.use("/api/admin", adminRoutes)
app.use("/api/admin", adminAuthRoutes)
app.use("/api/admin", userManagementRoutes)
app.use("/api/admin", recuriterManagemnet)
app.use("/api/shorts", shortRoutes)
app.use("/api/partner", patners)
app.use("/api/candidates", candidateRoutes)
app.use("/api/profile", profileRoutess)
app.use("/api/admin", adminProfileRoutes)
app.use("/api/partner", partnerProfileRoutes)
app.use("/api/candidate", candidateProfileRoutes)

// Candidate authentication routes
app.use("/api/candidate", candidateAuth)

// Partner job access routes
app.use("/api/partner/job-access", partnerJobAccessRoutes)
app.use("/api/partners", partnerJobAccessRoutes)

// Legacy candidate authentication check endpoint (keep for backwards compatibility)
app.get("/api/candidate/check-auth", async (req, res) => {
  try {
    await checkAuth(req, res, () => {
      if (req.isCandidate) {
        res.json({
          success: true,
          authenticated: true,
          role: "candidate",
          candidate: req.user,
          dashboardRoute: "/candidate/dashboard",
        })
      } else {
        res.json({
          success: false,
          authenticated: false,
          message: "Not a candidate account",
          redirect: req.dashboardRoute || "/auth",
        })
      }
    })
  } catch (error) {
    res.json({
      success: false,
      authenticated: false,
      message: "Candidate authentication failed",
      redirect: "/candidate/login",
    })
  }
})

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({
    success: false,
    message: "An internal server error occurred",
    error: process.env.NODE_ENV === "development" ? err.message : undefined,
  })
})

// WebSocket servers with enhanced logging
const wss = new WebSocket.Server({ noServer: true })
const deepgramWss = new WebSocket.Server({ noServer: true })
const interviewWss = new WebSocket.Server({ noServer: true })
const unifiedVoiceWss = new WebSocket.Server({ noServer: true })

console.log("🔧 Setting up WebSocket servers...")
setupWebSocketServer(wss)
setupDeepgramServer(deepgramWss)
setupUnifiedVoiceServer(unifiedVoiceWss)
console.log("✅ All WebSocket servers configured")

// Enhanced WebSocket upgrade handler with detailed logging
server.on("upgrade", (request, socket, head) => {
  const pathname = request.url
  const clientIP = request.socket.remoteAddress
  const timestamp = new Date().toISOString()

  console.log("🔄 WebSocket upgrade request:")
  console.log(`   Path: ${pathname}`)
  console.log(`   Client IP: ${clientIP}`)
  console.log(`   Timestamp: ${timestamp}`)

  if (pathname.startsWith("/ws/unified-voice")) {
    console.log("📞 Routing to Unified Voice WebSocket (SIP Communication)")
    unifiedVoiceWss.handleUpgrade(request, socket, head, (ws) => {
      unifiedVoiceWss.emit("connection", ws, request)
    })
  } else if (pathname.startsWith("/ws/transcribe")) {
    console.log("🎙️ Routing to Deepgram Transcription WebSocket")
    deepgramWss.handleUpgrade(request, socket, head, (ws) => {
      deepgramWss.emit("connection", ws, request)
    })
  } else if (pathname.startsWith("/ws/speech")) {
    console.log("🔊 Routing to Speech WebSocket")
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request)
    })
  } else if (pathname.startsWith("/ws/interview")) {
    console.log("💼 Routing to Interview WebSocket")
    interviewWss.handleUpgrade(request, socket, head, (ws) => {
      interviewWss.emit("connection", ws, request)
    })
  } else {
    console.log("❌ Unknown WebSocket path, destroying connection:", pathname)
    socket.destroy()
  }
})

// Enhanced process error handling
process.on("unhandledRejection", (err) => {
  console.error("❌ Unhandled Promise Rejection:", err)
  console.error("Stack trace:", err.stack)
})

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err)
  console.error("Stack trace:", err.stack)
  process.exit(1)
})

// Graceful shutdown handling
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received, shutting down gracefully...")
  server.close(() => {
    console.log("✅ Server closed")
    process.exit(0)
  })
})

process.on("SIGINT", () => {
  console.log("🛑 SIGINT received, shutting down gracefully...")
  server.close(() => {
    console.log("✅ Server closed")
    process.exit(0)
  })
})
