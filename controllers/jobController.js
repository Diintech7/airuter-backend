const JobApplication = require('../models/JobApplication');
const Job = require('../models/Job');
const User = require('../models/User');
const { OpenAI } = require('openai');

// Initialize OpenAI with API key from environment variables
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Generate job details with AI
exports.generateJobDetails = async (req, res) => {
  try {
    const { title, company, type, location, currency = 'USD' } = req.body;
    
    if (!title || !company || !type || !location) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Create a prompt for OpenAI
    const prompt = `
      Generate comprehensive details for a job posting with the following information:
      Job Title: ${title}
      Company: ${company}
      Job Type: ${type}
      Location: ${location}
      Currency: ${currency}

      Please provide the following in a JSON format:
      1. A detailed job description (2-3 paragraphs)
      2. 5-7 job requirements as an array of strings
      3. 5-7 job responsibilities as an array of strings
      4. 5-8 required skills as an array of strings
      5. 3-5 benefits as an array of strings
      6. Recommended experience range (min and max in years)
      7. Suggested salary range (min and max in ${currency})

      Format the response as a JSON object with these exact keys:
      {
        "description": "string",
        "requirements": ["string"],
        "responsibilities": ["string"],
        "skills": ["string"],
        "benefits": ["string"],
        "experience": {"min": number, "max": number},
        "salary": {"min": number, "max": number, "currency": "${currency}"}
      }

      Return only valid JSON without code blocks or explanations.
    `;

    // Call OpenAI API
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are a professional job description writer who specializes in creating comprehensive, accurate job listings. Return only valid JSON with the exact keys requested, without markdown code blocks or explanations."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 1500
    });

    // Parse the response to get the generated job details
    let generatedContent;
    console.log("OpenAI response received");
    try {
      // Extract the JSON from the response
      const responseText = response.choices[0].message.content.trim();
      console.log("Raw response text:", responseText);
      
      // Try to parse the JSON, handling potential markdown code blocks
      let jsonText = responseText;
      
      // Remove markdown code block if present
      if (jsonText.startsWith("```json")) {
        jsonText = jsonText.replace(/```json\n/, "").replace(/\n```$/, "");
      } else if (jsonText.startsWith("```")) {
        jsonText = jsonText.replace(/```\n/, "").replace(/\n```$/, "");
      }
      
      generatedContent = JSON.parse(jsonText);
      
      // Add fallbacks for any missing fields
      generatedContent = {
        description: generatedContent.description || "",
        requirements: generatedContent.requirements || [],
        responsibilities: generatedContent.responsibilities || [],
        skills: generatedContent.skills || [],
        benefits: generatedContent.benefits || [],
        experience: generatedContent.experience || { min: 0, max: 0 },
        salary: {
          min: generatedContent.salary?.min || 0,
          max: generatedContent.salary?.max || 0,
          currency: currency // Use the provided currency
        }
      };
      
      console.log("Processed content:", generatedContent);
    } catch (parseError) {
      console.error("Error parsing OpenAI response:", parseError);
      return res.status(500).json({ message: 'Failed to parse AI response' });
    }

    // Send the generated content back to the client
    res.json(generatedContent);
  } catch (error) {
    console.error("Error generating job details:", error);
    res.status(500).json({ message: error.message || 'Failed to generate job details' });
  }
};

// Create a new job
exports.createJob = async (req, res) => {
  try {
    const jobData = {
      ...req.body,
      recruiter: req.user.id,
      salary: {
        min: req.body.salary.min,
        max: req.body.salary.max,
        currency: req.body.salary.currency || 'USD'
      },
      logo: req.body.logo || ''
    };
    const job = new Job(jobData);
    await job.save();
    
    // Update recruiter's job count
    await User.findByIdAndUpdate(req.user.id, { $inc: { jobsPosted: 1 } });
    
    res.status(201).json(job);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Get all jobs with filters
exports.getJobs = async (req, res) => {
  try {
    const {
      search, location, type,
      experienceMin, experienceMax,
      salaryMin, salaryMax,
      skills, status, page = 1, limit = 10, sort = 'createdAt', order = 'desc'
    } = req.query;

    let query = { status: status || 'active' };

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { company: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    if (location) query.location = { $regex: location, $options: 'i' };
    if (type) query.type = type;
    if (experienceMin) query['experience.min'] = { $gte: parseInt(experienceMin) };
    if (experienceMax) query['experience.max'] = { $lte: parseInt(experienceMax) };
    if (salaryMin) query['salary.min'] = { $gte: parseInt(salaryMin) };
    if (salaryMax) query['salary.max'] = { $lte: parseInt(salaryMax) };
    if (skills) {
      const skillsArray = skills.split(',').map(skill => skill.trim());
      query.skills = { $all: skillsArray };
    }

    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Sorting
    const sortOption = {};
    sortOption[sort] = order === 'asc' ? 1 : -1;

    // Count total matching documents for pagination
    const total = await Job.countDocuments(query);
    
    // Get jobs with pagination, sorting, and population
    const jobs = await Job.find(query)
      .populate('recruiter', 'name email company')
      .sort(sortOption)
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      jobs,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get recruiter's jobs with stats
exports.getRecruiterJobs = async (req, res) => {
  try {
    const { status, sort = 'createdAt', order = 'desc' } = req.query;
    
    // Build query
    let query = { recruiter: req.user.id };
    if (status && status !== 'all') {
      query.status = status;
    }

    // Sorting option
    const sortOption = {};
    sortOption[sort] = order === 'asc' ? 1 : -1;
    
    // Get jobs with sorting
    const jobs = await Job.find(query)
      .sort(sortOption);
    
    // Get application stats
    const jobIds = jobs.map(job => job._id);
    const applications = await JobApplication.find({ job: { $in: jobIds } });
    
    // Calculate stats per job
    const jobStats = {};
    applications.forEach(app => {
      if (!jobStats[app.job]) {
        jobStats[app.job] = { total: 0, pending: 0, reviewed: 0, shortlisted: 0, rejected: 0 };
      }
      jobStats[app.job].total += 1;
      jobStats[app.job][app.status] += 1;
    });
    
    // Calculate overall stats
    const stats = {
      total: jobs.length,
      active: jobs.filter(job => job.status === 'active').length,
      draft: jobs.filter(job => job.status === 'draft').length,
      closed: jobs.filter(job => job.status === 'closed').length,
      hidden: jobs.filter(job => job.status === 'hidden').length,
      applications: {
        total: applications.length,
        pending: applications.filter(app => app.status === 'pending').length,
        reviewed: applications.filter(app => app.status === 'reviewed').length,
        shortlisted: applications.filter(app => app.status === 'shortlisted').length,
        rejected: applications.filter(app => app.status === 'rejected').length
      }
    };
    
    // Add application stats to each job
    const enrichedJobs = jobs.map(job => {
      const jobData = job.toObject();
      jobData.applicationStats = jobStats[job._id] || { total: 0, pending: 0, reviewed: 0, shortlisted: 0, rejected: 0 };
      return jobData;
    });

    res.json({
      jobs: enrichedJobs,
      stats
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update job
exports.updateJob = async (req, res) => {
  try {
    const updateData = { ...req.body };
    
    // Handle salary update properly
    if (req.body.salary) {
      updateData.salary = {
        min: req.body.salary.min,
        max: req.body.salary.max,
        currency: req.body.salary.currency || 'USD'
      };
    }

    // Handle logo update
    if (req.body.logo !== undefined) {
      updateData.logo = req.body.logo;
    }

    const job = await Job.findOneAndUpdate(
      { _id: req.params.id, recruiter: req.user.id },
      updateData,
      { new: true, runValidators: true }
    );

    if (!job) {
      return res.status(404).json({ message: 'Job not found or you do not have permission to update it' });
    }

    res.json(job);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Delete job
exports.deleteJob = async (req, res) => {
  try {
    // Start a session for transaction
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
      // Find the job to delete
      const job = await Job.findOne({
        _id: req.params.id,
        recruiter: req.user.id
      }).session(session);

      if (!job) {
        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({ message: 'Job not found or you do not have permission to delete it' });
      }

      // Delete associated applications
      await JobApplication.deleteMany({ job: req.params.id }).session(session);
      
      // Delete the job
      await Job.deleteOne({ _id: req.params.id }).session(session);
      
      // Update user's jobs count
      await User.findByIdAndUpdate(req.user.id, { $inc: { jobsPosted: -1 } }).session(session);
      
      // Commit the transaction
      await session.commitTransaction();
      session.endSession();
      
      res.json({ 
        message: 'Job and all associated applications deleted successfully',
        jobId: req.params.id
      });
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get job by ID
exports.getJobById = async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .populate('recruiter', 'name email company');
    
    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }

    res.json(job);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Toggle job status (active/hidden/closed/draft)
exports.toggleJobStatus = async (req, res) => {
  try {
    const { status } = req.body;
    
    // Validate status
    const validStatuses = ['active', 'hidden', 'closed', 'draft'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status value' });
    }
    
    const job = await Job.findOneAndUpdate(
      { _id: req.params.id, recruiter: req.user.id },
      { status },
      { new: true }
    );
    
    if (!job) {
      return res.status(404).json({ message: 'Job not found or you do not have permission to update it' });
    }
    
    res.json(job);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get job statistics
exports.getJobStats = async (req, res) => {
  try {
    const jobId = req.params.id;
    
    // Check if job belongs to recruiter
    const job = await Job.findOne({
      _id: jobId,
      recruiter: req.user.id
    });
    
    if (!job) {
      return res.status(404).json({ message: 'Job not found or you do not have permission to view it' });
    }
    
    // Get application stats
    const applications = await JobApplication.find({ job: jobId });
    
    // Calculate view stats (assuming you store job views somewhere)
    const viewStats = {
      totalViews: job.views || 0,
      uniqueViews: job.uniqueViews || 0,
      // You could add more metrics here
    };
    
    // Application statistics
    const applicationStats = {
      total: applications.length,
      byStatus: {
        pending: applications.filter(app => app.status === 'pending').length,
        reviewed: applications.filter(app => app.status === 'reviewed').length,
        shortlisted: applications.filter(app => app.status === 'shortlisted').length,
        rejected: applications.filter(app => app.status === 'rejected').length
      },
      conversionRate: applications.length > 0 ? 
        ((applications.filter(app => app.status === 'shortlisted').length / applications.length) * 100).toFixed(2) + '%' : 
        '0%'
    };
    
    res.json({
      job: {
        id: job._id,
        title: job.title,
        status: job.status,
        createdAt: job.createdAt
      },
      viewStats,
      applicationStats
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Duplicate a job post
exports.duplicateJob = async (req, res) => {
  try {
    // Find original job
    const originalJob = await Job.findOne({
      _id: req.params.id,
      recruiter: req.user.id
    });
    
    if (!originalJob) {
      return res.status(404).json({ message: 'Job not found or you do not have permission to duplicate it' });
    }
    
    // Create new job object from original
    const jobData = originalJob.toObject();
    
    // Remove fields that should be unique or generated
    delete jobData._id;
    delete jobData.createdAt;
    delete jobData.updatedAt;
    
    // Set as draft and add "(Copy)" to title
    jobData.status = 'draft';
    jobData.title = `${jobData.title} (Copy)`;
    
    // Set new application deadline (2 weeks from now)
    const twoWeeksFromNow = new Date();
    twoWeeksFromNow.setDate(twoWeeksFromNow.getDate() + 14);
    jobData.applicationDeadline = twoWeeksFromNow;
    
    // Create and save new job
    const newJob = new Job(jobData);
    await newJob.save();
    
    // Update recruiter's job count
    await User.findByIdAndUpdate(req.user.id, { $inc: { jobsPosted: 1 } });
    
    res.status(201).json(newJob);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get applicants for a specific job
exports.getJobApplicants = async (req, res) => {
  try {
    const jobId = req.params.id;
    
    // Verify job belongs to recruiter
    const job = await Job.findOne({
      _id: jobId,
      recruiter: req.user.id
    });
    
    if (!job) {
      return res.status(404).json({ message: 'Job not found or you do not have permission to view applicants' });
    }
    
    // Get applications with populated user data
    const applications = await JobApplication.find({ job: jobId })
      .populate('applicant', 'name email profileImage')
      .sort({ createdAt: -1 });
    
    // Application statistics
    const stats = {
      total: applications.length,
      pending: applications.filter(app => app.status === 'pending').length,
      reviewed: applications.filter(app => app.status === 'reviewed').length,
      shortlisted: applications.filter(app => app.status === 'shortlisted').length,
      rejected: applications.filter(app => app.status === 'rejected').length
    };
    
    res.json({
      job: {
        id: job._id,
        title: job.title,
        company: job.company,
        status: job.status
      },
      applications,
      stats
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update multiple jobs at once (bulk update)
exports.bulkUpdateJobs = async (req, res) => {
  try {
    const { jobIds, status } = req.body;
    
    if (!jobIds || !Array.isArray(jobIds) || jobIds.length === 0) {
      return res.status(400).json({ message: 'No job IDs provided' });
    }
    
    // Validate status
    const validStatuses = ['active', 'hidden', 'closed', 'draft'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status value' });
    }
    
    // Update all jobs that belong to the recruiter
    const result = await Job.updateMany(
      { 
        _id: { $in: jobIds },
        recruiter: req.user.id
      },
      { status }
    );
    
    res.json({
      message: `Updated ${result.modifiedCount} job(s)`,
      modified: result.modifiedCount,
      matched: result.matchedCount
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = exports;