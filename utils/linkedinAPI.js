// utils/linkedinAPI.js

const axios = require('axios');

class LinkedInAPI {
  constructor(accessToken) {
    this.accessToken = accessToken;
    this.baseUrl = 'https://api.linkedin.com/v2';
  }

  // Get basic profile information
  async getBasicProfile() {
    try {
      const response = await axios.get(`${this.baseUrl}/me`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'cache-control': 'no-cache',
          'X-Restli-Protocol-Version': '2.0.0'
        }
      });
      return response.data;
    } catch (error) {
      console.error('LinkedIn API Error:', error);
      throw new Error('Failed to fetch basic profile');
    }
  }

  // Get detailed profile information
  async getFullProfile() {
    try {
      const response = await axios.get(`${this.baseUrl}/me?projection=(id,firstName,lastName,profilePicture(displayImage~:playableStreams),headline,summary,positions,educations,skills,languages,certifications,email)`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'cache-control': 'no-cache',
          'X-Restli-Protocol-Version': '2.0.0'
        }
      });
      return response.data;
    } catch (error) {
      console.error('LinkedIn API Error:', error);
      throw new Error('Failed to fetch full profile');
    }
  }

  // Get email address
  async getEmailAddress() {
    try {
      const response = await axios.get(`${this.baseUrl}/emailAddress?q=members&projection=(elements*(handle~))`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'cache-control': 'no-cache',
          'X-Restli-Protocol-Version': '2.0.0'
        }
      });
      return response.data;
    } catch (error) {
      console.error('LinkedIn API Error:', error);
      throw new Error('Failed to fetch email address');
    }
  }
}

// Transform LinkedIn data to our profile format
const transformLinkedInData = (linkedInData) => {
  return {
    firstName: linkedInData.firstName.localized.en_US,
    lastName: linkedInData.lastName.localized.en_US,
    email: linkedInData.email,
    title: linkedInData.headline,
    summary: linkedInData.summary,
    location: linkedInData.location?.name,
    experience: linkedInData.positions.elements.map(pos => ({
      company: pos.company.name,
      position: pos.title,
      startDate: new Date(pos.startDate.year, pos.startDate.month - 1),
      endDate: pos.endDate ? new Date(pos.endDate.year, pos.endDate.month - 1) : null,
      description: pos.description
    })),
    education: linkedInData.educations.elements.map(edu => ({
      degree: edu.degree,
      institution: edu.schoolName,
      field: edu.fieldOfStudy,
      yearOfCompletion: edu.endDate?.year
    })),
    skills: linkedInData.skills.elements.map(skill => skill.skill.name),
    languages: linkedInData.languages.elements.map(lang => lang.language.name),
    certifications: linkedInData.certifications.elements.map(cert => cert.name)
  };
};

module.exports = {
  LinkedInAPI,
  transformLinkedInData
};