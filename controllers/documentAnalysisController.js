const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

// Function to analyze the document and generate interview questions
exports.analyzeDocument = async (document) => {
  try {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(document.path), {
      filename: document.originalname,
      contentType: document.mimetype,
    });

    const response = await axios.post('https://api.document-analysis.com/analyze', formData, {
      headers: {
        ...formData.getHeaders(),
        Authorization: `Bearer ${process.env.DOCUMENT_ANALYSIS_API_KEY}`,
      },
    });

    return response.data; // Assuming the API returns questions and analysis
  } catch (error) {
    console.error('Error analyzing document:', error.response?.data || error.message);
    throw new Error('Failed to analyze document');
  }
};