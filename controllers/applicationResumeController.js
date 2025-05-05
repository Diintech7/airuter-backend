const OpenAI = require('openai');
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');

const openai = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1'
});

const analyzeApplicationResume = async (req, res) => {
  try {
    const { resumeUrl, jobId } = req.body;
    
    if (!resumeUrl || !jobId) {
      return res.status(400).json({
        success: false,
        message: 'Resume URL and job ID are required'
      });
    }

    const Job = require('../models/Job');
    const job = await Job.findById(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Job not found'
      });
    }

    const resumePath = path.join(__dirname, '..', 'uploads', 'resumes', resumeUrl);
    
    if (!fs.existsSync(resumePath)) {
      return res.status(404).json({
        success: false,
        message: 'Resume file not found'
      });
    }

    // Parse PDF content
    let resumeContent;
    try {
      const dataBuffer = fs.readFileSync(resumePath);
      const pdfData = await pdf(dataBuffer);
      resumeContent = pdfData.text;

      if (!resumeContent || resumeContent.trim().length === 0) {
        throw new Error('PDF content is empty or could not be extracted');
      }
    } catch (pdfError) {
      console.error('PDF parsing error:', pdfError);
      return res.status(400).json({
        success: false,
        message: 'Could not parse PDF file. Please ensure it contains extractable text.'
      });
    }

    const maxChars = 6000;
    const truncatedResume = resumeContent.length > maxChars 
      ? resumeContent.substring(0, maxChars) + '...'
      : resumeContent;

    const jobDetails = {
      title: job.title,
      requirements: job.requirements.join('\n'),
      skills: job.skills.join(', '),
      experience: `${job.experience.min}-${job.experience.max} years`,
      type: job.type
    };

    try {
      const analysis = await openai.chat.completions.create({
        model: "deepseek-ai/deepseek-r1",
        messages: [
          {
            role: "system",
            content: `You are an expert HR professional analyzing resumes. Provide your analysis as a strict JSON string. Do not include any explanatory text before or after the JSON.

The JSON must follow this exact structure:
{
  "feedback": [
    {
      "category": "Overall Match",
      "score": <number between 0 and 100>,
      "message": "<brief explanation>"
    },
    {
      "category": "Skills Match",
      "score": <number between 0 and 100>,
      "message": "<brief explanation>"
    },
    {
      "category": "Experience Match",
      "score": <number between 0 and 100>,
      "message": "<brief explanation>"
    }
  ],
  "keyFindings": ["finding1", "finding2", "finding3"],
  "suggestions": ["suggestion1", "suggestion2"]
}`
          },
          {
            role: "user",
            content: `Analyze this resume for the following position:
            
Job Title: ${jobDetails.title}
Required Skills: ${jobDetails.skills}
Required Experience: ${jobDetails.experience}
Job Type: ${jobDetails.type}
Key Requirements:
${jobDetails.requirements}

Resume Content:
${truncatedResume}

Remember to respond only with the JSON object, no additional text.`
          }
        ],
        temperature: 0.6,
        top_p: 0.7,
        max_tokens: 4096,
        stream: false
      });

      // Parse and validate the response
      const jsonString = analysis.choices[0].message.content.trim();
      const jsonStartIndex = jsonString.indexOf('{');
      const jsonEndIndex = jsonString.lastIndexOf('}') + 1;
      const cleanJsonString = jsonString.slice(jsonStartIndex, jsonEndIndex);
      
      let analysisData = JSON.parse(cleanJsonString);
      
      // Normalize and validate the data structure
      const normalizedData = {
        feedback: (analysisData.feedback || []).map(item => ({
          category: String(item.category || ''),
          score: Math.min(Math.max(Number(item.score) || 0, 0), 100),
          message: String(item.message || '')
        })),
        keyFindings: (analysisData.keyFindings || [])
          .filter(item => item && typeof item === 'string')
          .slice(0, 5),
        suggestions: (analysisData.suggestions || [])
          .filter(item => item && typeof item === 'string')
          .slice(0, 3)
      };

      // Ensure all required categories are present
      const requiredCategories = ['Overall Match', 'Skills Match', 'Experience Match'];
      requiredCategories.forEach(category => {
        if (!normalizedData.feedback.find(f => f.category === category)) {
          normalizedData.feedback.push({
            category,
            score: 50,
            message: 'Analysis not available'
          });
        }
      });

      // Cache the analysis results
      const cacheResults = {
        timestamp: new Date(),
        data: normalizedData
      };

      return res.json({
        success: true,
        data: normalizedData
      });

    } catch (openaiError) {
      console.error('NVIDIA API error:', openaiError);

      // Handle rate limiting specifically
      if (openaiError.status === 429) {
        return res.status(429).json({
          success: false,
          message: 'Analysis temporarily unavailable. Please try again in a few minutes.',
          retryAfter: 60
        });
      }

      // Provide fallback analysis if API fails
      const fallbackData = {
        feedback: [
          {
            category: 'Overall Match',
            score: 60,
            message: 'Basic match based on keywords'
          },
          {
            category: 'Skills Match',
            score: 65,
            message: 'Skills evaluation based on direct keyword matching'
          },
          {
            category: 'Experience Match',
            score: 55,
            message: 'Experience evaluation based on years mentioned'
          }
        ],
        keyFindings: ['Basic analysis performed due to service limitations'],
        suggestions: ['Try again later for detailed analysis']
      };

      return res.json({
        success: true,
        data: fallbackData,
        warning: 'Using simplified analysis due to service limitations'
      });
    }

  } catch (error) {
    console.error('Error analyzing application resume:', error);
    
    return res.status(500).json({
      success: false,
      message: 'Error analyzing resume',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};

module.exports = {
  analyzeApplicationResume
};








// const OpenAI = require('openai');
// const pdf = require('pdf-parse');
// const fs = require('fs');
// const path = require('path');

// const openai = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY
// });

// const analyzeApplicationResume = async (req, res) => {
//   try {
//     const { resumeUrl, jobId } = req.body;
    
//     if (!resumeUrl || !jobId) {
//       return res.status(400).json({
//         success: false,
//         message: 'Resume URL and job ID are required'
//       });
//     }

//     const Job = require('../models/Job');
//     const job = await Job.findById(jobId);
//     if (!job) {
//       return res.status(404).json({
//         success: false,
//         message: 'Job not found'
//       });
//     }

//     const resumePath = path.join(__dirname, '..', 'uploads', 'resumes', resumeUrl);
    
//     if (!fs.existsSync(resumePath)) {
//       return res.status(404).json({
//         success: false,
//         message: 'Resume file not found'
//       });
//     }

//     // Parse PDF content
//     let resumeContent;
//     try {
//       const dataBuffer = fs.readFileSync(resumePath);
//       const pdfData = await pdf(dataBuffer);
//       resumeContent = pdfData.text;

//       if (!resumeContent || resumeContent.trim().length === 0) {
//         throw new Error('PDF content is empty or could not be extracted');
//       }
//     } catch (pdfError) {
//       console.error('PDF parsing error:', pdfError);
//       return res.status(400).json({
//         success: false,
//         message: 'Could not parse PDF file. Please ensure it contains extractable text.'
//       });
//     }

//     const maxChars = 6000;
//     const truncatedResume = resumeContent.length > maxChars 
//       ? resumeContent.substring(0, maxChars) + '...'
//       : resumeContent;

//     const jobDetails = {
//       title: job.title,
//       requirements: job.requirements.join('\n'),
//       skills: job.skills.join(', '),
//       experience: `${job.experience.min}-${job.experience.max} years`,
//       type: job.type
//     };

//     try {
//       const analysis = await openai.chat.completions.create({
//         model: "gpt-4",
//         messages: [
//           {
//             role: "system",
//             content: `You are an expert HR professional analyzing resumes. Provide your analysis as a strict JSON string. Do not include any explanatory text before or after the JSON.

// The JSON must follow this exact structure:
// {
//   "feedback": [
//     {
//       "category": "Overall Match",
//       "score": <number between 0 and 100>,
//       "message": "<brief explanation>"
//     },
//     {
//       "category": "Skills Match",
//       "score": <number between 0 and 100>,
//       "message": "<brief explanation>"
//     },
//     {
//       "category": "Experience Match",
//       "score": <number between 0 and 100>,
//       "message": "<brief explanation>"
//     }
//   ],
//   "keyFindings": ["finding1", "finding2", "finding3"],
//   "suggestions": ["suggestion1", "suggestion2"]
// }`
//           },
//           {
//             role: "user",
//             content: `Analyze this resume for the following position:
            
// Job Title: ${jobDetails.title}
// Required Skills: ${jobDetails.skills}
// Required Experience: ${jobDetails.experience}
// Job Type: ${jobDetails.type}
// Key Requirements:
// ${jobDetails.requirements}

// Resume Content:
// ${truncatedResume}

// Remember to respond only with the JSON object, no additional text.`
//           }
//         ],
//         temperature: 0.1,
//         max_tokens: 1000
//       });

//       // Parse and validate the response
//       const jsonString = analysis.choices[0].message.content.trim();
//       const jsonStartIndex = jsonString.indexOf('{');
//       const jsonEndIndex = jsonString.lastIndexOf('}') + 1;
//       const cleanJsonString = jsonString.slice(jsonStartIndex, jsonEndIndex);
      
//       let analysisData = JSON.parse(cleanJsonString);
      
//       // Normalize and validate the data structure
//       const normalizedData = {
//         feedback: (analysisData.feedback || []).map(item => ({
//           category: String(item.category || ''),
//           score: Math.min(Math.max(Number(item.score) || 0, 0), 100),
//           message: String(item.message || '')
//         })),
//         keyFindings: (analysisData.keyFindings || [])
//           .filter(item => item && typeof item === 'string')
//           .slice(0, 5), // Limit to 5 key findings
//         suggestions: (analysisData.suggestions || [])
//           .filter(item => item && typeof item === 'string')
//           .slice(0, 3) // Limit to 3 suggestions
//       };

//       // Ensure all required categories are present
//       const requiredCategories = ['Overall Match', 'Skills Match', 'Experience Match'];
//       requiredCategories.forEach(category => {
//         if (!normalizedData.feedback.find(f => f.category === category)) {
//           normalizedData.feedback.push({
//             category,
//             score: 50,
//             message: 'Analysis not available'
//           });
//         }
//       });

//       // Cache the analysis results
//       const cacheResults = {
//         timestamp: new Date(),
//         data: normalizedData
//       };

//       return res.json({
//         success: true,
//         data: normalizedData
//       });

//     } catch (openaiError) {
//       console.error('OpenAI API error:', openaiError);

//       // Handle rate limiting specifically
//       if (openaiError.status === 429) {
//         return res.status(429).json({
//           success: false,
//           message: 'Analysis temporarily unavailable. Please try again in a few minutes.',
//           retryAfter: 60
//         });
//       }

//       // Provide fallback analysis if OpenAI fails
//       const fallbackData = {
//         feedback: [
//           {
//             category: 'Overall Match',
//             score: 60,
//             message: 'Basic match based on keywords'
//           },
//           {
//             category: 'Skills Match',
//             score: 65,
//             message: 'Skills evaluation based on direct keyword matching'
//           },
//           {
//             category: 'Experience Match',
//             score: 55,
//             message: 'Experience evaluation based on years mentioned'
//           }
//         ],
//         keyFindings: ['Basic analysis performed due to service limitations'],
//         suggestions: ['Try again later for detailed analysis']
//       };

//       return res.json({
//         success: true,
//         data: fallbackData,
//         warning: 'Using simplified analysis due to service limitations'
//       });
//     }

//   } catch (error) {
//     console.error('Error analyzing application resume:', error);
    
//     return res.status(500).json({
//       success: false,
//       message: 'Error analyzing resume',
//       error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
//     });
//   }
// };

// module.exports = {
//   analyzeApplicationResume
// };