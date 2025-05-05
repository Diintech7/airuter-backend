const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const generateQuestionsFromDocument = async (document) => {
  const prompt = `Generate 5 technical interview questions based on the following document:\n\n${document}`;
  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 500,
  });
  return response.choices[0].message.content.split('\n').filter((q) => q.trim());
};

module.exports = { generateQuestionsFromDocument };