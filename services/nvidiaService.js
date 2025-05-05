const { OpenAI } = require('openai');

class OpenAIService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY, // Ensure this is set in your .env file
      // No need for custom baseURL when using OpenAI's standard API
    });
  }

  async generateText(prompt, options = {}) {
    try {
      const completion = await this.openai.chat.completions.create({
        model: "gpt-3.5-turbo", // Default to GPT-3.5 Turbo, can be changed as needed
        messages: [{ role: "user", content: prompt }],
        temperature: options.temperature || 0.7,
        top_p: options.top_p || 0.95,
        max_tokens: options.max_tokens || 1024,
        stream: false
      });

      const generatedText = completion.choices[0].message.content;
      console.log('[OpenAI Service] Raw response:', generatedText); // Log the raw response for debugging
      return generatedText;
    } catch (error) {
      console.error('[OpenAI Service] Error:', error);
      throw new Error(`OpenAI API generation failed: ${error.message}`);
    }
  }
}

module.exports = new OpenAIService();