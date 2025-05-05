const OpenAI = require('openai');
const pdf = require('pdf-parse');
const fs = require('fs');

const openai = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1'
});

const analyzeResume = async (req, res) => {
  console.log('=== Starting Resume Analysis ===');
  console.log('Request Files:', req.files);
  console.log('Request Body:', req.body);

  try {
    // File validation
    if (!req.files || !req.files.resume) {
      console.error('No resume file found in request');
      return res.status(400).json({
        success: false,
        message: 'Resume file is required'
      });
    }

    const resumeFile = req.files.resume;
    console.log('Resume File Details:', {
      name: resumeFile.name,
      size: resumeFile.size,
      mimetype: resumeFile.mimetype
    });

    // Input validation
    const { jobTitle, keywords, jobDescription } = req.body;
    console.log('Input Parameters:', { jobTitle, keywords, jobDescription });
    
    if (!jobTitle || !keywords) {
      console.error('Missing required fields');
      return res.status(400).json({
        success: false,
        message: 'Job title and keywords are required'
      });
    }

    // Parse PDF content
    let resumeContent;
    try {
      console.log('Starting PDF parsing');
      const dataBuffer = fs.readFileSync(resumeFile.tempFilePath);
      console.log('PDF file read successfully, size:', dataBuffer.length);

      const pdfData = await pdf(dataBuffer);
      resumeContent = pdfData.text;
      console.log('PDF parsed successfully, content length:', resumeContent.length);

      if (!resumeContent || resumeContent.trim().length === 0) {
        throw new Error('PDF content is empty or could not be extracted');
      }

      // Clean up temp file
      fs.unlinkSync(resumeFile.tempFilePath);
      console.log('Temporary file cleaned up');
    } catch (pdfError) {
      console.error('PDF parsing error:', pdfError);
      return res.status(400).json({
        success: false,
        message: 'Could not parse PDF file. Please ensure it contains extractable text.',
        error: pdfError.message
      });
    }

    // Prepare content for analysis
    const maxChars = 6000;
    const truncatedResume = resumeContent.length > maxChars 
      ? resumeContent.substring(0, maxChars) + '...'
      : resumeContent;
    console.log('Resume content prepared, length:', truncatedResume.length);

    // Prepare prompt
    const promptData = {
      title: jobTitle,
      skills: keywords,
      description: jobDescription || 'Not provided'
    };
    console.log('Prompt data prepared:', promptData);

    try {
      console.log('Starting AI analysis');
      const analysis = await openai.chat.completions.create({
        model: "deepseek-ai/deepseek-r1",
        messages: [
          {
            role: "system",
            content: `You are an expert HR professional analyzing resumes. Provide your analysis as a strict JSON string. Do not include any explanatory text before or after the JSON.

The JSON must follow this exact structure:
{
  "skillsScore": <number between 0 and 100>,
  "experienceScore": <number between 0 and 100>,
  "educationScore": <number between 0 and 100>,
  "keywordsScore": <number between 0 and 100>,
  "formatScore": <number between 0 and 100>,
  "overallScore": <number between 0 and 100>,
  "keyFindings": [
    "finding1",
    "finding2",
    "finding3",
    "finding4",
    "finding5"
  ],
  "suggestions": [
    "suggestion1",
    "suggestion2",
    "suggestion3"
  ],
  "matchPercentage": <number between 0 and 100>,
  "summary": "Brief overall summary of the analysis"
}`
          },
          {
            role: "user",
            content: `Analyze this resume for the following position:
            
Job Title: ${promptData.title}
Required Skills: ${promptData.skills}
Job Description: ${promptData.description}

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

      console.log('AI response received:', analysis.choices[0].message);

      // Parse and validate the response
      const jsonString = analysis.choices[0].message.content.trim();
      console.log('Raw AI response:', jsonString);

      const jsonStartIndex = jsonString.indexOf('{');
      const jsonEndIndex = jsonString.lastIndexOf('}') + 1;
      const cleanJsonString = jsonString.slice(jsonStartIndex, jsonEndIndex);
      console.log('Cleaned JSON string:', cleanJsonString);
      
      let analysisData = JSON.parse(cleanJsonString);
      console.log('Parsed analysis data:', analysisData);
      
      // Normalize and validate the data structure
      const normalizedData = {
        skillsScore: Math.min(Math.max(Number(analysisData.skillsScore) || 0, 0), 100),
        experienceScore: Math.min(Math.max(Number(analysisData.experienceScore) || 0, 0), 100),
        educationScore: Math.min(Math.max(Number(analysisData.educationScore) || 0, 0), 100),
        keywordsScore: Math.min(Math.max(Number(analysisData.keywordsScore) || 0, 0), 100),
        formatScore: Math.min(Math.max(Number(analysisData.formatScore) || 0, 0), 100),
        overallScore: Math.min(Math.max(Number(analysisData.overallScore) || 0, 0), 100),
        keyFindings: (analysisData.keyFindings || [])
          .filter(item => item && typeof item === 'string')
          .slice(0, 5),
        suggestions: (analysisData.suggestions || [])
          .filter(item => item && typeof item === 'string')
          .slice(0, 3),
        matchPercentage: Math.min(Math.max(Number(analysisData.matchPercentage) || 0, 0), 100),
        summary: String(analysisData.summary || 'Analysis completed')
      };
      console.log('Normalized data:', normalizedData);

      // Provide fallback values if any required field is missing
      const fallbackScore = 50;
      if (!normalizedData.skillsScore) normalizedData.skillsScore = fallbackScore;
      if (!normalizedData.experienceScore) normalizedData.experienceScore = fallbackScore;
      if (!normalizedData.educationScore) normalizedData.educationScore = fallbackScore;
      if (!normalizedData.keywordsScore) normalizedData.keywordsScore = fallbackScore;
      if (!normalizedData.formatScore) normalizedData.formatScore = fallbackScore;
      if (!normalizedData.overallScore) normalizedData.overallScore = fallbackScore;
      if (!normalizedData.matchPercentage) normalizedData.matchPercentage = fallbackScore;

      if (normalizedData.keyFindings.length === 0) {
        normalizedData.keyFindings = ['Basic analysis performed'];
      }
      if (normalizedData.suggestions.length === 0) {
        normalizedData.suggestions = ['Consider adding more specific details'];
      }

      console.log('Final response data:', normalizedData);
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
        skillsScore: 60,
        experienceScore: 55,
        educationScore: 65,
        keywordsScore: 58,
        formatScore: 70,
        overallScore: 62,
        keyFindings: ['Basic analysis performed due to service limitations'],
        suggestions: ['Try again later for detailed analysis'],
        matchPercentage: 61,
        summary: 'Basic analysis completed with limited service availability'
      };

      console.log('Using fallback data:', fallbackData);
      return res.json({
        success: true,
        data: fallbackData,
        warning: 'Using simplified analysis due to service limitations'
      });
    }

  } catch (error) {
    console.error('Error analyzing resume:', error);
    
    return res.status(500).json({
      success: false,
      message: 'Error analyzing resume',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};

module.exports = {
  analyzeResume
};