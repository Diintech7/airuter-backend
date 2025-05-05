// Add to your server.js or create a new file for AI interview handling
const WebSocket = require('ws');
const openai = require('./config/openai');

const setupAiInterviewServer = (server) => {
  const wss = new WebSocket.Server({ 
    noServer: true,
    path: '/ws/ai-interview' 
  });

  const interviewSessions = new Map();

  wss.on('connection', async (ws) => {
    console.log('AI Interview client connected');
    let currentSession = null;

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.type) {
          case 'init':
            // Initialize interview session
            currentSession = {
              roomId: data.roomId,
              language: data.language,
              difficulty: data.difficulty,
              userId: data.userId,
              currentQuestion: 0,
              questions: []
            };
            interviewSessions.set(data.roomId, currentSession);

            // Generate initial question
            const response = await openai.chat.completions.create({
              model: "gpt-4",
              messages: [
                {
                  role: "system",
                  content: `You are a technical interviewer conducting a ${data.difficulty} level programming interview for ${data.language}. Ask relevant technical questions, evaluate responses, and provide feedback. Be professional and encouraging.`
                },
                {
                  role: "user",
                  content: "Let's start the interview."
                }
              ]
            });

            const initialQuestion = response.choices[0].message.content;
            ws.send(JSON.stringify({
              type: 'question',
              content: initialQuestion
            }));
            break;

          case 'answer':
            if (!currentSession) break;

            // Evaluate answer and provide feedback
            const evaluation = await openai.chat.completions.create({
              model: "gpt-4",
              messages: [
                {
                  role: "system",
                  content: `You are evaluating a ${currentSession.difficulty} level ${currentSession.language} programming interview answer. Provide constructive feedback and ask follow-up questions if needed.`
                },
                {
                  role: "user",
                  content: `The candidate's answer: ${data.content}`
                }
              ]
            });

            ws.send(JSON.stringify({
              type: 'feedback',
              content: evaluation.choices[0].message.content
            }));
            break;

          case 'end':
            if (currentSession) {
              // Generate interview summary
              const summary = await openai.chat.completions.create({
                model: "gpt-4",
                messages: [
                  {
                    role: "system",
                    content: "Generate a brief summary of the interview performance and provide recommendations for improvement."
                  }
                ]
              });

              ws.send(JSON.stringify({
                type: 'summary',
                content: summary.choices[0].message.content
              }));

              interviewSessions.delete(currentSession.roomId);
              currentSession = null;
            }
            break;
        }
      } catch (error) {
        console.error('Error in AI interview:', error);
        ws.send(JSON.stringify({
          type: 'error',
          content: 'An error occurred during the interview'
        }));
      }
    });

    ws.on('close', () => {
      if (currentSession) {
        interviewSessions.delete(currentSession.roomId);
      }
      console.log('AI Interview client disconnected');
    });
  });

  return wss;
};

module.exports = setupAiInterviewServer;