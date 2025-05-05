const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

// Enhanced section patterns with more variations
const SECTION_PATTERNS = {
  EDUCATION: /(?:education|academic|qualification|educational background|university|college|school)s?\b/i,
  EXPERIENCE: /(?:experience|employment|work history|professional background|professional experience|intern experience)s?\b/i,
  SKILLS: /(?:skills|technical skills|core competencies|expertise|proficiencies|technologies used)s?\b/i,
  LANGUAGES: /(?:languages?|language proficiency)s?\b/i,
  CERTIFICATIONS: /(?:certifications?|certificates|professional certifications|qualifications)s?\b/i,
  PROJECTS: /(?:projects?|project experience|personal projects|portfolio)s?\b/i,
  SUMMARY: /(?:summary|professional summary|profile|about|objective)s?\b/i,
  ACHIEVEMENTS: /(?:achievements?|accomplishments?|awards|honors)s?\b/i
};

// Enhanced data patterns
const DATA_PATTERNS = {
  EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
  PHONE: /(?:\+?\d{1,3}[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}/,
  DATE: /(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*[-–—]?\s*)?(?:\d{4}|Present|Current|Ongoing)/i,
  DEGREE: /(?:Bachelor|Master|PhD|B\.?[A-Z][A-Za-z]*\.?|M\.?[A-Z][A-Za-z]*\.?|Ph\.?D\.?|Associate|Diploma)[^,\n]*/i,
  LOCATION: /(?:[\w\s]+,\s*[\w\s]+,\s*\d{5,6})|(?:[\w\s]+,\s*[\w\s]+)/,
  CGPA: /(?:\d+(?:\.\d+)?)\s*(?:CGPA|GPA)/i,
  URLS: /(https?:\/\/[^\s]+)/g
};

// Helper function to extract content between sections
const extractSectionContent = (text, startPattern, endPatterns) => {
  const match = text.match(new RegExp(`(?:^|\\n).*${startPattern.source}.*\\n`, 'i'));
  if (!match) return null;

  const startIndex = match.index;
  let endIndex = text.length;

  for (const pattern of endPatterns) {
    const nextMatch = text.slice(startIndex + match[0].length).match(new RegExp(`\\n.*${pattern.source}.*\\n`, 'i'));
    if (nextMatch) {
      const possibleEnd = startIndex + match[0].length + nextMatch.index;
      if (possibleEnd < endIndex) {
        endIndex = possibleEnd;
      }
    }
  }

  return {
    content: text.slice(startIndex, endIndex).trim(),
    startIndex,
    endIndex
  };
};

// Enhanced education parser
const parseEducation = (text) => {
  const educationSection = extractSectionContent(
    text,
    SECTION_PATTERNS.EDUCATION,
    Object.values(SECTION_PATTERNS).filter(p => p !== SECTION_PATTERNS.EDUCATION)
  );
  
  if (!educationSection) return [];

  const entries = educationSection.content
    .split(/\n{2,}/)
    .filter(entry => entry.trim().length > 0);

  return entries.map(entry => {
    const lines = entry.split('\n').map(line => line.trim());
    const degreeMatch = entry.match(DATA_PATTERNS.DEGREE);
    const dateMatch = entry.match(DATA_PATTERNS.DATE);
    const cgpaMatch = entry.match(DATA_PATTERNS.CGPA);
    
    // Find institution line by excluding known patterns
    const institutionLine = lines.find(line => 
      !line.match(DATA_PATTERNS.DEGREE) && 
      !line.match(DATA_PATTERNS.DATE) &&
      !line.match(DATA_PATTERNS.CGPA) &&
      !line.match(SECTION_PATTERNS.EDUCATION)
    );

    return {
      degree: degreeMatch ? degreeMatch[0].trim() : '',
      institution: institutionLine ? institutionLine.trim() : '',
      field: lines.find(line => /major|field|concentration|specialization/i.test(line))?.replace(/.*:\s*/, '').trim() || '',
      yearOfCompletion: dateMatch ? parseInt(dateMatch[0].match(/\d{4}/)?.[0]) : null,
      gpa: cgpaMatch ? parseFloat(cgpaMatch[0]) : null
    };
  }).filter(edu => edu.degree || edu.institution);
};

// Enhanced experience parser
const parseExperience = (text) => {
  const experienceSection = extractSectionContent(
    text,
    SECTION_PATTERNS.EXPERIENCE,
    Object.values(SECTION_PATTERNS).filter(p => p !== SECTION_PATTERNS.EXPERIENCE)
  );
  
  if (!experienceSection) return [];

  const entries = experienceSection.content
    .split(/\n{2,}/)
    .filter(entry => entry.trim().length > 0);

  return entries.map(entry => {
    const lines = entry.split('\n').map(line => line.trim());
    const dateMatches = entry.match(new RegExp(DATA_PATTERNS.DATE.source, 'gi')) || [];
    const locationMatch = entry.match(DATA_PATTERNS.LOCATION);
    
    // Find company and position lines
    const companyLine = lines.find(line => 
      /inc\.|ltd\.|corp\.|company|technologies|solutions/i.test(line) ||
      line.includes('(') && line.includes(')')
    );
    
    const positionLine = lines.find(line => 
      /engineer|developer|manager|director|analyst|consultant|specialist|intern/i.test(line) &&
      line !== companyLine
    );

    // Extract description bullets
    const descriptionLines = lines.filter(line => 
      (line.startsWith('•') || line.startsWith('-') || line.startsWith('➢')) &&
      line !== companyLine &&
      line !== positionLine
    );

    return {
      company: companyLine ? companyLine.replace(/^\W+|\W+$/, '').trim() : '',
      position: positionLine ? positionLine.trim() : '',
      location: locationMatch ? locationMatch[0].trim() : '',
      startDate: dateMatches[0] || '',
      endDate: dateMatches[1] || 'Present',
      description: descriptionLines.join('\n').trim()
    };
  }).filter(exp => exp.company || exp.position);
};

// Enhanced skills parser
const parseSkills = (text) => {
  const skillsSection = extractSectionContent(
    text,
    SECTION_PATTERNS.SKILLS,
    Object.values(SECTION_PATTERNS).filter(p => p !== SECTION_PATTERNS.SKILLS)
  );
  
  if (!skillsSection) return [];

  // Handle different skill formats
  const skillLines = skillsSection.content.split('\n');
  const skills = new Set();

  skillLines.forEach(line => {
    // Remove category labels
    line = line.replace(/^(?:Frontend|Backend|Other skills|Technologies used):/i, '');
    
    // Split by common separators
    line.split(/[,•|:]/)
      .map(skill => skill.trim())
      .filter(skill => 
        skill.length > 0 && 
        !SECTION_PATTERNS.SKILLS.test(skill) &&
        !/^[^a-zA-Z]*$/.test(skill)
      )
      .forEach(skill => skills.add(skill));
  });

  return Array.from(skills);
};

// Parse projects section
const parseProjects = (text) => {
  const projectsSection = extractSectionContent(
    text,
    SECTION_PATTERNS.PROJECTS,
    Object.values(SECTION_PATTERNS).filter(p => p !== SECTION_PATTERNS.PROJECTS)
  );
  
  if (!projectsSection) return [];

  const entries = projectsSection.content
    .split(/\n{2,}/)
    .filter(entry => entry.trim().length > 0);

  return entries.map(entry => {
    const lines = entry.split('\n').map(line => line.trim());
    const urlMatch = entry.match(DATA_PATTERNS.URLS);
    
    // Find title line
    const titleLine = lines[0].replace(/\(.*?\)/, '').trim();
    
    // Extract description bullets
    const descriptionLines = lines.filter(line => 
      (line.startsWith('•') || line.startsWith('-') || line.startsWith('➢')) ||
      line.startsWith('Technologies used:')
    );

    return {
      title: titleLine,
      url: urlMatch ? urlMatch[0] : '',
      description: descriptionLines.join('\n').trim(),
      technologies: lines.find(line => line.startsWith('Technologies used:'))
        ?.replace('Technologies used:', '')
        .split(',')
        .map(tech => tech.trim()) || []
    };
  });
};

// Main parser function
const parseResume = async (filePath) => {
  try {
    let text = '';
    const fileExt = path.extname(filePath).toLowerCase();

    if (fileExt === '.pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData = await pdf(dataBuffer);
      text = pdfData.text;
    } else if (fileExt === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      text = result.value;
    } else {
      throw new Error('Unsupported file format');
    }

    // Normalize text
    text = text
      .replace(/\r\n/g, '\n')
      .replace(/\t/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Extract basic information
    const emailMatch = text.match(DATA_PATTERNS.EMAIL);
    const phoneMatch = text.match(DATA_PATTERNS.PHONE);
    const locationMatch = text.match(DATA_PATTERNS.LOCATION);
    const urlsMatch = text.match(DATA_PATTERNS.URLS);
    
    // Extract name from the first line
    const firstLine = text.split('\n')[0].trim();
    const nameParts = firstLine.split(/\s+/).filter(part => 
      !DATA_PATTERNS.EMAIL.test(part) && 
      !DATA_PATTERNS.PHONE.test(part) &&
      !DATA_PATTERNS.LOCATION.test(part)
    );

    // Parse all sections
    const parsedData = {
      firstName: nameParts[0] || '',
      lastName: nameParts.slice(1).join(' ') || '',
      email: emailMatch ? emailMatch[0] : '',
      phone: phoneMatch ? phoneMatch[0] : '',
      location: locationMatch ? locationMatch[0] : '',
      links: urlsMatch || [],
      summary: '',
      education: parseEducation(text),
      experience: parseExperience(text),
      skills: parseSkills(text),
      projects: parseProjects(text),
      languages: [], // Implement similar to skills parser
      certifications: [], // Implement similar to skills parser
      achievements: [] // Implement similar to skills parser
    };

    // Extract summary/objective if present
    const summarySection = extractSectionContent(
      text,
      SECTION_PATTERNS.SUMMARY,
      Object.values(SECTION_PATTERNS).filter(p => p !== SECTION_PATTERNS.SUMMARY)
    );
    if (summarySection) {
      parsedData.summary = summarySection.content
        .split('\n')
        .slice(1)
        .join(' ')
        .trim();
    }

    // Set title from most recent experience
    if (parsedData.experience.length > 0) {
      parsedData.title = parsedData.experience[0].position;
    }

    return parsedData;
  } catch (error) {
    console.error('Resume parsing error:', error);
    throw error;
  }
};

module.exports = {
  parseResume
};