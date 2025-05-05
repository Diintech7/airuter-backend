require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const connectDB = require('./config/db');
const chatRoutes = require('./routes/chat');
const resumeRoutes = require('./routes/resumeRoutes');
const { setupWebSocketServer } = require('./websocket/streamingServer');
const { setupDeepgramServer } = require('./websocket/deepgramServer');
const fileUpload = require('express-fileupload');
const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const jobRoutes = require('./routes/jobs');
const jobApplicationRoutes = require('./routes/jobApplications');
const jobsAppliedRoutes = require('./routes/jobsApplied');
const interviewRoutes = require('./routes/interviewRoutes');
const companyProfileRoutes = require('./routes/companyProfile');
const datastoreRoutes = require('./routes/datastore');
const adminAuthRoutes = require('./routes/adminAuth'); 
const userManagementRoutes = require('./routes/userManagement');
const recuriterManagemnet = require('./routes/recruiterManagement');
const adminRoutes = require('./routes/adminRoutes');
const shortRoutes = require('./routes/shortRoutes'); // Added shortRoutes
const app = express();
const server = http.createServer(app);
const fs = require('fs');
const path = require('path');
const passport = require('passport');

const uploadDir = path.join(__dirname, 'uploads');
const tempDir = path.join(__dirname, 'temp');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

connectDB();

app.use(cors({
  origin: 'https://auriter-frontend.vercel.app',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(passport.initialize());

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.options('*', cors());

app.use((err, req, res, next) => {
  if (err.name === 'CORSError') {
    res.status(403).json({
      success: false,
      message: 'CORS error: ' + err.message
    });
  } else {
    next(err);
  }
});

app.use(fileUpload({
  useTempFiles: true,
  tempFileDir: tempDir,
  limits: { fileSize: 10 * 1024 * 1024 },
  abortOnLimit: true,
  createParentPath: true,
  debug: true
}));

app.use((error, req, res, next) => {
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      message: 'File is too large. Maximum size is 10MB'
    });
  }

  if (error.code === 'ENOENT') {
    return res.status(400).json({
      success: false,
      message: 'Temp directory is not accessible'
    });
  }

  console.error('File upload error:', error);
  return res.status(500).json({
    success: false,
    message: 'File upload failed',
    error: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
});

app.use('/api/chat', chatRoutes);
app.use('/api/resume', resumeRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/applications', jobApplicationRoutes);
app.use('/api/jobs-applied', jobsAppliedRoutes);
app.use('/api/interview', interviewRoutes);
app.use('/api/company/profile', companyProfileRoutes);
app.use('/api/datastore', datastoreRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin', adminAuthRoutes); 
app.use('/api/admin', userManagementRoutes);
app.use('/api/admin', recuriterManagemnet);
app.use('/api/shorts', shortRoutes); // Added shorts routes

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'An internal server error occurred',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

const wss = new WebSocket.Server({ noServer: true });
const deepgramWss = new WebSocket.Server({ noServer: true });
const interviewWss = new WebSocket.Server({ noServer: true });

setupWebSocketServer(wss);
setupDeepgramServer(deepgramWss);

server.on('upgrade', (request, socket, head) => {
  const pathname = request.url;

  if (pathname.startsWith('/ws/transcribe')) {
    deepgramWss.handleUpgrade(request, socket, head, (ws) => {
      deepgramWss.emit('connection', ws, request);
    });
  } else if (pathname.startsWith('/ws/speech')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else if (pathname.startsWith('/ws/interview')) {
    interviewWss.handleUpgrade(request, socket, head, (ws) => {
      interviewWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Promise Rejection:', err);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});