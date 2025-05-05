const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const Profile = require('../models/Profile');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parseResume } = require('../utils/resumeParser');
const User = require('../models/User');

// Ensure uploads directory exists
const uploadsDir = 'uploads';
if (!fs.existsSync(uploadsDir)){
    fs.mkdirSync(uploadsDir);
}

// Configure multer storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    if (
        file.mimetype === 'application/pdf' ||
        file.mimetype === 'application/msword' ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only PDF and Word documents are allowed.'), false);
    }
};

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    },
    fileFilter: fileFilter
});

// Get profile status
router.get('/status', protect, async (req, res) => {
  try {
    const profile = await Profile.findOne({ user: req.user.id });
    res.json({
      isComplete: profile ? profile.isComplete : false
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

router.get('/role', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json({
      success: true,
      role: user.role
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Update the create profile route in profile.js
router.post('/create', protect, async (req, res) => {
  try {
    let profileData = {
      user: req.user.id,
      isComplete: req.body.isComplete || false,
      updatedAt: Date.now()
    };

    // Only include required fields if not skipping
    if (!req.body.isComplete) {
      // This is a skip case, only set minimal required fields
      profileData = {
        ...profileData,
        firstName: '',
        lastName: '',
        email: ''
      };
    } else {
      // Include all profile fields for complete profile
      profileData = {
        ...profileData,
        firstName: req.body.firstName,
        lastName: req.body.lastName,
        email: req.body.email,
        phone: req.body.phone,
        location: req.body.location,
        title: req.body.title,
        summary: req.body.summary,
        yearsOfExperience: req.body.yearsOfExperience,
        education: req.body.education,
        experience: req.body.experience,
        skills: req.body.skills,
        languages: req.body.languages,
        certifications: req.body.certifications,
        achievements: req.body.achievements
      };
    }

    let profile = await Profile.findOne({ user: req.user.id });
    if (profile) {
      profile = await Profile.findOneAndUpdate(
        { user: req.user.id },
        { $set: profileData },
        { new: true }
      );
    } else {
      profile = new Profile(profileData);
      await profile.save();
    }

    res.json({ success: true, profile });
  } catch (error) {
    console.error('Profile creation error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

router.post('/resume', protect, upload.single('resume'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const parsedData = await parseResume(req.file.path);
        const profileData = {
            ...parsedData,
            user: req.user.id,
            isComplete: true,
            updatedAt: Date.now()
        };

        let profile = await Profile.findOne({ user: req.user.id });
        if (profile) {
            profile = await Profile.findOneAndUpdate(
                { user: req.user.id },
                { $set: profileData },
                { new: true }
            );
        } else {
            profile = new Profile(profileData);
            await profile.save();
        }

        // Clean up the uploaded file
        fs.unlink(req.file.path, (err) => {
            if (err) console.error('Error deleting file:', err);
        });

        res.json({ success: true, profile });
    } catch (error) {
        // Clean up the uploaded file in case of error
        if (req.file) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Error deleting file:', err);
            });
        }
        console.error('Resume parsing error:', error);
        res.status(500).json({ success: false, message: 'Resume parsing failed', error: error.message });
    }
});


// Update profile
router.get('/', protect, async (req, res) => {
  try {
    const profile = await Profile.findOne({ user: req.user.id });
    res.json(profile || null); // Return null if no profile exists
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update profile
router.put('/', protect, async (req, res) => {
  try {
    const profileData = {
      ...req.body,
      user: req.user.id,
      updatedAt: Date.now()
    };

    const profile = await Profile.findOneAndUpdate(
      { user: req.user.id },
      { $set: profileData },
      { new: true, upsert: true }
    );

    res.json(profile);
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;




// const OpenAI = require('openai');
// const pdf = require('pdf-parse');

// const openai = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY
// });

// const analyzeResume = async (req, res) => {
//     try {
//         console.log('Files received:', req.files);
//         console.log('Body received:', req.body);
    
//         if (!req.files || !req.files.resume) {
//           return res.status(400).json({ 
//             success: false,
//             message: 'No resume file was uploaded.'
//           });
//         }
//     // Validate request
//     if (!req.files || Object.keys(req.files).length === 0) {
//       return res.status(400).json({ 
//         success: false,
//         message: 'No files were uploaded.'
//       });
//     }

//     if (!req.files.resume) {
//       return res.status(400).json({ 
//         success: false,
//         message: 'Resume file is required'
//       });
//     }

//     const { jobTitle, keywords, jobDescription } = req.body;
    
//     // Validate required fields
//     if (!jobTitle || !keywords) {
//       return res.status(400).json({
//         success: false,
//         message: 'Job title and keywords are required'
//       });
//     }

//     // Validate file type
//     const resumeFile = req.files.resume;
//     if (resumeFile.mimetype !== 'application/pdf') {
//       return res.status(400).json({
//         success: false,
//         message: 'Only PDF files are allowed'
//       });
//     }

//     // Parse PDF content
//     let resumeText;
//     try {
//         const fs = require('fs');
//         const dataBuffer = fs.readFileSync(resumeFile.tempFilePath);
//         const pdfData = await pdf(dataBuffer);
//         resumeText = pdfData.text;
  
//         if (!resumeText || resumeText.trim().length === 0) {
//           throw new Error('PDF content is empty or could not be extracted');
//         }
  
//         // Clean up temp file
//         fs.unlinkSync(resumeFile.tempFilePath);
        
//       } catch (pdfError) {
//         console.error('PDF parsing error:', pdfError);
//         return res.status(400).json({
//           success: false,
//           message: 'Could not parse PDF file. Please ensure the file is not corrupted and contains extractable text.',
//           details: pdfError.message
//         });
//       }

//     // Initial analysis with GPT-4
//     const initialAnalysis = await openai.chat.completions.create({
//         model: "gpt-4",
//         messages: [
//           {
//             role: "system",
//             content: `You are an expert HR professional and ATS system analyzer. You must respond ONLY with a valid JSON object containing resume analysis data. Do not include any explanatory text outside the JSON structure.`
//           },
//           {
//             role: "user",
//             // In resumeController.js, update the user content in the initialAnalysis prompt
// content: `Analyze this resume for a ${jobTitle} position. 
// Keywords to match: ${keywords}
// Job Description: ${jobDescription || 'Not provided'}

// Resume content: ${resumeText}

// Respond with ONLY a JSON object in this exact format, with no additional text:
// {
//   "score": <number between 0-100>,
//   "skillsScore": <number between 0-100>,
//   "experienceScore": <number between 0-100>,
//   "educationScore": <number between 0-100>,
//   "keywordsScore": <number between 0-100>,
//   "formatScore": <number between 0-100>,
//   "keyFindings": ["finding1", "finding2", "finding3"],
//   "suggestions": ["suggestion1", "suggestion2", "suggestion3"],
//   "feedback": [
//     {
//       "category": "Skills Match",
//       "score": <number between 0-100>,
//       "message": "detailed feedback about skills"
//     },
//     {
//       "category": "Experience",
//       "score": <number between 0-100>,
//       "message": "detailed feedback about experience"
//     },
//     {
//       "category": "Education",
//       "score": <number between 0-100>,
//       "message": "detailed feedback about education"
//     },
//     {
//       "category": "Keywords Match",
//       "score": <number between 0-100>,
//       "message": "detailed feedback about keyword matches"
//     },
//     {
//       "category": "Format & Structure",
//       "score": <number between 0-100>,
//       "message": "detailed feedback about resume format"
//     }
//   ]
// }`
//           }
//         ],
//         temperature: 0.3, // Lower temperature for more consistent formatting
//         max_tokens: 2000
//       });
  
//       // Add safety check for response format
//       let analysis;
//       try {
//         const responseContent = initialAnalysis.choices[0].message.content.trim();
//         console.log('GPT Response:', responseContent); // Debug log
//         analysis = JSON.parse(responseContent);
        
//         // Validate expected structure
//         const requiredFields = ['score', 'skillsScore', 'experienceScore', 'educationScore', 
//                               'keywordsScore', 'formatScore', 'keyFindings', 'suggestions', 'feedback'];
        
//         const missingFields = requiredFields.filter(field => !(field in analysis));
//         if (missingFields.length > 0) {
//           throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
//         }
//       } catch (parseError) {
//         console.error('Raw GPT response:', initialAnalysis.choices[0].message.content);
//         console.error('Parse error:', parseError);
//         return res.status(500).json({
//           success: false,
//           message: 'Error processing analysis results',
//           error: process.env.NODE_ENV === 'development' ? parseError.message : undefined
//         });
//       }
  
//       // Modified detailed insights prompt
//       const detailedInsights = await openai.chat.completions.create({
//         model: "gpt-4",
//         messages: [
//           {
//             role: "system",
//             content: "You are an expert HR professional. Provide a detailed analysis as a single string with proper formatting."
//           },
//           {
//             role: "user",
//             content: `Based on this resume analysis: ${JSON.stringify(analysis)}, 
//             provide detailed HR insights and specific recommendations for improvement.
//             Format your response as a single string with clear sections and bullet points.
//             Consider the job title: ${jobTitle}
//             Consider these keywords: ${keywords}`
//           }
//         ],
//         temperature: 0.7,
//         max_tokens: 1000
//       });
  
//       // Combine analyses and send response
//       const finalResponse = {
//         success: true,
//         data: {
//           ...analysis,
//           detailedInsights: detailedInsights.choices[0].message.content
//         }
//       };
  
//       res.json(finalResponse);
  
//     } catch (err) {
//       console.error('Error analyzing resume:', err);
//       res.status(500).json({ 
//         success: false,
//         message: 'Error analyzing resume',
//         error: process.env.NODE_ENV === 'development' ? err.toString() : 'Internal server error'
//       });
//     }
//   };

// module.exports = {
//   analyzeResume
// };


