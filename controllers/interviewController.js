const JobApplication = require("../models/JobApplication")
const { createRoom } = require("../services/100msService")
const { sendEmail } = require("../services/emailService")
const { v4: uuidv4 } = require("uuid")
const InterviewResponse = require("../models/InterviewResponse")
const OpenAIService = require("../services/nvidiaService")
const Interview = require("../models/Interview")

// Add new endpoint for generating adaptive questions
exports.generateAdaptiveQuestion = async (req, res) => {
  console.log("[Generate Adaptive Question] Request received:", req.body)
  try {
    const { roomId, previousQA, document, questionNumber } = req.body

    // Find the interview to get context
    const interview = await Interview.findOne({ roomId })
    if (!interview) {
      return res.status(404).json({ message: "Interview not found" })
    }

    // Build context more efficiently - limit to last 2 Q&As to reduce prompt size
    const recentQA = previousQA.slice(-2)
    const previousContext = recentQA.map((qa, index) => `Q: ${qa.question}\nA: ${qa.answer}`).join("\n\n")

    // Create a more focused, shorter prompt for faster generation
    const prompt = `Based on the candidate's recent responses, generate ONE specific follow-up question for a technical interview.

RECENT RESPONSES:
${previousContext}

JOB REQUIREMENTS: ${document.substring(0, 500)}...

Generate a ${questionNumber === 1 ? "technical depth" : questionNumber === 2 ? "problem-solving" : "experience-based"} question that builds on their answers. Keep it conversational and specific.

Question:`

    // Use a shorter timeout for faster response
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 6000) // 6 second timeout

    try {
      const aiResponse = await OpenAIService.generateText(prompt, {
        signal: controller.signal,
        maxTokens: 100, // Limit response length for faster generation
      })
      clearTimeout(timeoutId)

      // Clean up the response
      let question = aiResponse.trim()
      question = question.replace(/^["']|["']$/g, "")
      question = question.replace(/^Question:\s*/i, "")

      if (!question.endsWith("?")) {
        question += "?"
      }

      console.log("[Generate Adaptive Question] Generated question:", question)

      res.json({
        success: true,
        question: question,
      })
    } catch (error) {
      clearTimeout(timeoutId)
      throw error
    }
  } catch (error) {
    console.error("[Generate Adaptive Question] Error:", error)

    // Fast fallback questions
    const fallbackQuestions = [
      "How would you approach debugging a complex issue in your recent project?",
      "What's the most challenging technical decision you've made recently?",
      "How do you stay updated with new technologies in your field?",
    ]

    const fallbackQuestion =
      fallbackQuestions[req.body.questionNumber - 1] ||
      "What motivates you to continuously improve your technical skills?"

    res.json({
      success: true,
      question: fallbackQuestion,
    })
  }
}

exports.scheduleInterview = async (req, res) => {
  console.log("[Schedule Interview] Request received:", req.body)
  try {
    const { applicationId, document, date, time, questions } = req.body

    const application = await JobApplication.findById(applicationId).populate("applicant").populate("job")

    if (!application) {
      return res.status(404).json({ message: "Application not found" })
    }

    const roomId = uuidv4()
    const interviewLink = `https://www.airuter.com/interview/${roomId}`

    // For the new adaptive system, we don't pre-generate all questions
    // We'll generate them dynamically during the interview
    const interviewQuestions = []

    const interview = new Interview({
      roomId,
      date,
      time,
      document,
      jobTitle: application.job.title,
      applicantEmail: application.applicant.email,
      applicantId: application.applicant._id,
      questions: interviewQuestions, // Start with empty array
    })
    await interview.save()

    // Update the JobApplication
    application.interview = interview._id
    application.interviewRoomId = roomId
    await application.save()

    await sendEmail({
      to: application.applicant.email,
      subject: "Mock Interview Invitation",
      text: `You have been invited for a mock interview for the position of ${application.job.title}. Please join the room on ${date} at ${time}.`,
      interviewLink,
    })

    res.json({
      success: true,
      message: "Interview scheduled successfully!",
      interviewLink,
      questions: interviewQuestions,
    })
  } catch (error) {
    console.error("[Schedule Interview] Error:", error)
    res.status(500).json({ message: error.message })
  }
}

exports.getInterviewDetails = async (req, res) => {
  console.log("[Get Interview Details] Request received for room ID:", req.params.roomId)
  try {
    const { roomId } = req.params

    const interview = await Interview.findOne({ roomId })
    if (!interview) {
      console.error("[Get Interview Details] Interview not found for room ID:", roomId)
      return res.status(404).json({ message: "Interview not found" })
    }

    console.log("[Get Interview Details] Interview details fetched:", interview)
    res.json({
      date: interview.date,
      time: interview.time,
      jobTitle: interview.jobTitle,
      document: interview.document,
    })
  } catch (error) {
    console.error("[Get Interview Details] Error:", error)
    res.status(500).json({ message: error.message })
  }
}

exports.getInterviewQuestions = async (req, res) => {
  console.log("[Get Interview Questions] Request received for room ID:", req.params.roomId)
  try {
    const { roomId } = req.params

    const interview = await Interview.findOne({ roomId })

    if (!interview) {
      console.error("[Get Interview Questions] Interview not found for room ID:", roomId)
      return res.status(404).json({ message: "Interview not found" })
    }

    // For the new adaptive system, we return basic questions initially
    // The adaptive questions will be generated dynamically
    const basicQuestions = [
      "Tell me about yourself and your background.",
      "What are your key strengths and how do they relate to this role?",
      "Describe a challenging project you've worked on recently.",
    ]

    console.log("[Get Interview Questions] Returning basic questions for adaptive interview")
    res.json({ questions: basicQuestions })
  } catch (error) {
    console.error("[Get Interview Questions] Error:", error)
    res.status(500).json({ message: error.message })
  }
}

exports.submitResponse = async (req, res) => {
  console.log("[Submit Response] Request received for room ID:", req.params.roomId)
  try {
    const { roomId } = req.params
    const { question, response } = req.body

    await InterviewResponse.create({
      roomId,
      question,
      response,
    })

    console.log("[Submit Response] Response saved for room ID:", roomId)
    res.json({ success: true, message: "Response submitted successfully!" })
  } catch (error) {
    console.error("[Submit Response] Error:", error)
    res.status(500).json({ message: error.message })
  }
}

exports.analyzeResponses = async (req, res) => {
  console.log("[Analyze Responses] Request received for room ID:", req.body.roomId)
  try {
    const { roomId, questions, answers } = req.body

    // Ensure questions and answers are defined
    if (!questions || !answers) {
      throw new Error("Questions or answers are missing in the request body.")
    }

    // Find the interview by roomId
    const interview = await Interview.findOne({ roomId })
    if (!interview) {
      console.error("[Analyze Responses] Interview not found for room ID:", roomId)
      return res.status(404).json({ message: "Interview not found" })
    }

    const analysisPrompt = `PROVIDE A VALID JSON RESPONSE EXACTLY MATCHING THIS STRUCTURE:
{
  "overallScores": {
    "selfIntroduction": 7,
    "projectExplanation": 7,
    "englishCommunication": 7
  },
  "feedback": {
    "selfIntroduction": {
      "strengths": "Detailed feedback on strengths",
      "areasOfImprovement": "Detailed feedback on areas to improve"
    },
    "projectExplanation": {
      "strengths": "Detailed feedback on strengths",
      "areasOfImprovement": "Detailed feedback on areas to improve"
    },
    "englishCommunication": {
      "strengths": "Detailed feedback on strengths",
      "areasOfImprovement": "Detailed feedback on areas to improve"
    }
  },
  "focusAreas": [
    "Key area to focus on for improvement",
    "Another area to focus on for improvement",
    "Third most important area to focus on"
  ]
}

INTERVIEW DATA:
${questions.map((q, i) => `Question ${i + 1}: ${q}\nResponse: ${answers[i]}`).join("\n\n")}

INSTRUCTIONS:
- Respond ONLY with the JSON
- Ensure valid JSON syntax
- Scores should be between 1-10
- Evaluate the candidate holistically across all answers
- For Self Introduction: Assess how well they presented their background, skills, and career goals
- For Project Explanation: Evaluate their ability to explain technical projects clearly and highlight their contributions
- For English Communication: Assess overall fluency, grammar, vocabulary, and clarity across all answers
- In focusAreas, list 3-5 specific, actionable improvement areas ordered by priority
- Consider that this was an adaptive interview with personalized follow-up questions`

    const aiResponse = await OpenAIService.generateText(analysisPrompt)

    let parsedAnalysis
    try {
      // Extract JSON from the response
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/s)
      if (!jsonMatch) {
        console.error("No valid JSON found in response:", aiResponse)
        throw new Error("No valid JSON object found")
      }

      // Parse the JSON
      parsedAnalysis = JSON.parse(jsonMatch[0])

      // Validate and ensure the structure is correct
      if (!parsedAnalysis.overallScores || !parsedAnalysis.feedback || !parsedAnalysis.focusAreas) {
        throw new Error("Invalid analysis structure")
      }

      // Ensure we have all required scores and feedback sections
      const requiredFields = ["selfIntroduction", "projectExplanation", "englishCommunication"]

      for (const field of requiredFields) {
        // Check and set default scores if missing
        if (!parsedAnalysis.overallScores[field]) {
          parsedAnalysis.overallScores[field] = 5
        }

        // Check and set default feedback if missing
        if (!parsedAnalysis.feedback[field]) {
          parsedAnalysis.feedback[field] = {
            strengths: "Unable to generate detailed feedback",
            areasOfImprovement: "Unable to generate detailed feedback",
          }
        } else {
          // Ensure the feedback has both strengths and areas of improvement
          if (!parsedAnalysis.feedback[field].strengths) {
            parsedAnalysis.feedback[field].strengths = "Unable to generate detailed feedback"
          }
          if (!parsedAnalysis.feedback[field].areasOfImprovement) {
            parsedAnalysis.feedback[field].areasOfImprovement = "Unable to generate detailed feedback"
          }
        }
      }

      // Ensure focusAreas is an array with at least 3 items
      if (!Array.isArray(parsedAnalysis.focusAreas) || parsedAnalysis.focusAreas.length < 1) {
        parsedAnalysis.focusAreas = [
          "Improve communication clarity and structure",
          "Enhance technical explanation skills",
          "Work on presentation of self-introduction",
        ]
      }
    } catch (parseError) {
      console.error("Parsing error:", parseError)
      console.error("Problematic response:", aiResponse)

      // Fallback to a default analysis structure
      parsedAnalysis = {
        overallScores: {
          selfIntroduction: 5,
          projectExplanation: 5,
          englishCommunication: 5,
        },
        feedback: {
          selfIntroduction: {
            strengths: "Unable to generate detailed feedback",
            areasOfImprovement: "Unable to generate detailed feedback",
          },
          projectExplanation: {
            strengths: "Unable to generate detailed feedback",
            areasOfImprovement: "Unable to generate detailed feedback",
          },
          englishCommunication: {
            strengths: "Unable to generate detailed feedback",
            areasOfImprovement: "Unable to generate detailed feedback",
          },
        },
        focusAreas: [
          "Improve communication clarity and structure",
          "Enhance technical explanation skills",
          "Work on presentation of self-introduction",
        ],
      }
    }

    // Logging for debugging
    console.log("[Analyze Responses] Generated Analysis:", JSON.stringify(parsedAnalysis, null, 2))

    // Save the analysis to the interview document
    interview.analysis = {
      overallScores: parsedAnalysis.overallScores,
      feedback: parsedAnalysis.feedback,
      focusAreas: parsedAnalysis.focusAreas,
      analyzedAt: new Date(),
    }

    await interview.save()
    console.log("[Analyze Responses] Analysis saved to database for room ID:", roomId)

    res.json({
      success: true,
      message: "Analysis completed and saved",
      analysis: parsedAnalysis,
    })
  } catch (error) {
    console.error("[Analyze Responses] Error:", error)
    const defaultAnalysis = {
      overallScores: {
        selfIntroduction: 5,
        projectExplanation: 5,
        englishCommunication: 5,
      },
      feedback: {
        selfIntroduction: {
          strengths: "Unable to generate analysis",
          areasOfImprovement: "Unable to generate analysis",
        },
        projectExplanation: {
          strengths: "Unable to generate analysis",
          areasOfImprovement: "Unable to generate analysis",
        },
        englishCommunication: {
          strengths: "Unable to generate analysis",
          areasOfImprovement: "Unable to generate analysis",
        },
      },
      focusAreas: [
        "Improve oral communication skills",
        "Structure technical explanations more clearly",
        "Develop more comprehensive self-introduction",
      ],
    }

    // Attempt to save default analysis if there's an interview
    try {
      if (req.body.roomId) {
        const interview = await Interview.findOne({ roomId: req.body.roomId })
        if (interview) {
          interview.analysis = {
            ...defaultAnalysis,
            analyzedAt: new Date(),
          }
          await interview.save()
          console.log("[Analyze Responses] Default analysis saved for room ID:", req.body.roomId)
        }
      }
    } catch (saveError) {
      console.error("[Analyze Responses] Error saving default analysis:", saveError)
    }

    res.status(500).json({
      success: false,
      message: "Analysis failed",
      analysis: defaultAnalysis,
    })
  }
}

// Add a new endpoint to get all interview analyses for admin review
exports.getInterviewAnalyses = async (req, res) => {
  console.log("[Get Interview Analyses] Request received")
  try {
    // Query interviews with analysis data
    const interviews = await Interview.find({
      "analysis.analyzedAt": { $ne: null }, // Only get interviews that have been analyzed
    }).select("roomId jobTitle applicantEmail analysis recordedAt")

    if (!interviews || interviews.length === 0) {
      console.log("[Get Interview Analyses] No analyses found")
      return res.json({ analyses: [] })
    }

    const analyses = interviews.map((interview) => ({
      roomId: interview.roomId,
      jobTitle: interview.jobTitle,
      applicantEmail: interview.applicantEmail,
      scores: interview.analysis.overallScores,
      focusAreas: interview.analysis.focusAreas,
      analyzedAt: interview.analysis.analyzedAt,
      recordedAt: interview.recordedAt,
      screenRecordingUrl: interview.screenRecordingUrl,
    }))

    console.log("[Get Interview Analyses] Found analyses:", analyses.length)
    res.json({ analyses })
  } catch (error) {
    console.error("[Get Interview Analyses] Error:", error)
    res.status(500).json({
      success: false,
      message: "Failed to fetch interview analyses",
      error: error.message,
    })
  }
}

exports.getInterviewAnalysis = async (req, res) => {
  console.log("[Get Interview Analysis] Request received for room ID:", req.params.roomId)
  try {
    const { roomId } = req.params

    const interview = await Interview.findOne({ roomId }).select(
      "roomId jobTitle applicantEmail analysis screenRecordingUrl recordedAt",
    )

    if (!interview || !interview.analysis || !interview.analysis.analyzedAt) {
      console.error("[Get Interview Analysis] Analysis not found for room ID:", roomId)
      return res.status(404).json({ message: "Interview analysis not found" })
    }

    console.log("[Get Interview Analysis] Analysis found for room ID:", roomId)
    res.json({
      success: true,
      interview: {
        roomId: interview.roomId,
        jobTitle: interview.jobTitle,
        applicantEmail: interview.applicantEmail,
        analysis: interview.analysis,
        screenRecordingUrl: interview.screenRecordingUrl,
        recordedAt: interview.recordedAt,
      },
    })
  } catch (error) {
    console.error("[Get Interview Analysis] Error:", error)
    res.status(500).json({
      success: false,
      message: "Failed to fetch interview analysis",
      error: error.message,
    })
  }
}

exports.saveRecording = async (req, res) => {
  try {
    const { videoUrl } = req.body
    const { roomId } = req.body

    if (!videoUrl) {
      console.error("No video URL provided")
      return res.status(400).json({
        success: false,
        message: "Video URL is required",
      })
    }

    const interview = await Interview.findOneAndUpdate(
      { roomId },
      {
        screenRecordingUrl: videoUrl,
        recordedAt: new Date(),
      },
      { new: true },
    )

    if (!interview) {
      console.error("Interview not found for room ID:", roomId)
      return res.status(404).json({
        success: false,
        message: "Interview not found",
      })
    }

    res.json({
      success: true,
      message: "Recording URL saved successfully",
      interview: {
        recordingUrl: interview.screenRecordingUrl,
        recordedAt: interview.recordedAt,
      },
    })
  } catch (error) {
    console.error("Error saving recording URL:", error)
    res.status(500).json({
      success: false,
      message: "Failed to save recording URL",
      error: error.message,
    })
  }
}

exports.getInterviewRecordingsByApplicant = async (req, res) => {
  console.log("[Get Interview Recordings] Request received for applicant:", req.params.email)
  try {
    const { email } = req.params
    const { id } = req.query // Optional applicant ID parameter

    // Create a query object based on available parameters
    const query = {
      screenRecordingUrl: { $ne: null }, // Only get interviews with recordings
    }

    // If applicant ID is provided, use it (preferred method)
    if (id) {
      query.applicantId = id
    } else if (email) {
      // Fall back to email if no ID provided
      query.applicantEmail = email
    } else {
      return res.status(400).json({ message: "Either email or id parameter is required" })
    }

    const interviews = await Interview.find(query).select("roomId jobTitle screenRecordingUrl recordedAt")

    if (!interviews || interviews.length === 0) {
      console.log("[Get Interview Recordings] No recordings found for applicant")
      return res.json({ recordings: [] })
    }

    const recordings = interviews.map((interview) => ({
      roomId: interview.roomId,
      jobTitle: interview.jobTitle,
      screenRecordingUrl: interview.screenRecordingUrl,
      recordedAt: interview.recordedAt,
    }))

    console.log("[Get Interview Recordings] Found recordings:", recordings.length)
    res.json({ recordings })
  } catch (error) {
    console.error("[Get Interview Recordings] Error:", error)
    res.status(500).json({ message: error.message })
  }
}

exports.getInterviewByApplicationId = async (req, res) => {
  console.log("[Get Interview By Application ID] Request received for application ID:", req.params.applicationId)
  try {
    const { applicationId } = req.params

    // First, find the job application to get the roomId
    const application = await JobApplication.findById(applicationId)
      .populate("applicant", "name email")
      .populate("job", "title")

    if (!application || !application.interviewRoomId) {
      console.log("[Get Interview By Application ID] No interview found for application ID:", applicationId)
      return res.status(404).json({ message: "No interview found for this application" })
    }

    // Then, find the interview using the roomId
    const interview = await Interview.findOne({ roomId: application.interviewRoomId })

    if (!interview) {
      console.log("[Get Interview By Application ID] Interview not found for room ID:", application.interviewRoomId)
      return res.status(404).json({ message: "Interview details not found" })
    }

    console.log("[Get Interview By Application ID] Interview found:", interview)
    res.json({
      success: true,
      interview: {
        roomId: interview.roomId,
        date: interview.date,
        time: interview.time,
        jobTitle: interview.jobTitle,
        applicant: {
          name: application.applicant.name,
          email: application.applicant.email,
        },
        screenRecordingUrl: interview.screenRecordingUrl,
        recordedAt: interview.recordedAt,
        document: interview.document,
        questions: interview.questions,
        analysis: interview.analysis,
      },
    })
  } catch (error) {
    console.error("[Get Interview By Application ID] Error:", error)
    res.status(500).json({ message: error.message })
  }
}

exports.getInterviewRecordingsByRoomId = async (req, res) => {
  console.log("[Get Interview Recordings] Request received for room ID:", req.params.roomId)
  try {
    const { roomId } = req.params

    // Find the interview by roomId
    const interview = await Interview.findOne({ roomId }).select("roomId jobTitle screenRecordingUrl recordedAt")

    if (!interview) {
      console.log("[Get Interview Recordings] No recording found for room ID:", roomId)
      return res.json({ recordings: [] })
    }

    const recording = {
      roomId: interview.roomId,
      jobTitle: interview.jobTitle,
      screenRecordingUrl: interview.screenRecordingUrl,
      recordedAt: interview.recordedAt,
    }

    console.log("[Get Interview Recordings] Found recording:", recording)
    res.json({ recordings: [recording] })
  } catch (error) {
    console.error("[Get Interview Recordings] Error:", error)
    res.status(500).json({ message: error.message })
  }
}
