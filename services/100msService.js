const axios = require('axios');

const createRoom = async (roomDetails) => {
  try {
    // Verify the token is loaded correctly
    if (!process.env.HMS_ACCESS_TOKEN) {
      throw new Error('100ms access token is missing. Please check your .env file.');
    }

    // Remove the duration field from the request body
    const { duration, ...rest } = roomDetails;

    const response = await axios.post('https://api.100ms.live/v2/rooms', rest, {
      headers: {
        'Authorization': `Bearer ${process.env.HMS_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data;
  } catch (error) {
    console.error('Error creating 100ms room:', error);
    throw error;
  }
};

module.exports = { createRoom };