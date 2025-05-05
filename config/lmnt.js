const axios = require('axios');

// Create an axios instance for LMNT API
const lmntAPI = axios.create({
  baseURL: 'https://api.lmnt.com/v1',
  timeout: 30000 // 30 second timeout
});

// Function to synthesize speech
const synthesizeSpeech = async (text, options = {}) => {
  if (!process.env.LMNT_API_KEY) {
    throw new Error('LMNT API key not configured');
  }

  const defaultOptions = {
    voice: 'lily',
    format: 'wav',
    model: 'aurora',
    language: 'en',
    sample_rate: 16000,
    speed: 1,
    conversational: false
  };

  try {
    // Combine default options with provided options
    const params = {
      ...defaultOptions,
      ...options,
      text,
      'X-API-Key': process.env.LMNT_API_KEY
    };

    // Convert boolean conversational to string
    if (params.conversational !== undefined) {
      params.conversational = params.conversational.toString();
    }

    // Make GET request with query parameters
    const response = await lmntAPI.get('/ai/speech', {
      params,
      responseType: 'arraybuffer',
      validateStatus: status => status === 200,
      headers: {
        Accept: 'audio/*'
      }
    });

    // Extract metadata from headers
    const metadata = {
      sampleRate: response.headers['x-sample-rate'],
      durationSamples: response.headers['x-duration-samples'],
      contentType: response.headers['content-type']
    };

    return {
      audioData: response.data,
      metadata
    };

  } catch (error) {
    // Handle network errors
    if (error.code === 'ENOTFOUND') {
      throw new Error('Unable to connect to LMNT API. Please check your internet connection.');
    }

    if (error.code === 'ETIMEDOUT') {
      throw new Error('Connection to LMNT API timed out. Please try again.');
    }

    if (error.response) {
      const status = error.response.status;
      switch (status) {
        case 400:
          throw new Error('Invalid request parameters');
        case 401:
          throw new Error('Invalid API key');
        case 403:
          throw new Error('API key lacks permission');
        case 429:
          throw new Error('Rate limit exceeded');
        default:
          throw new Error(`LMNT API Error: ${status}`);
      }
    }

    throw new Error(`Synthesis failed: ${error.message}`);
  }
};

module.exports = { synthesizeSpeech };