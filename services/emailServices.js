// services/emailService.js
const nodemailer = require('nodemailer');

// Configure email transporter
const createTransporter = () => {
  return nodemailer.createTransport({
    service: 'gmail', // or your preferred email service
    auth: {
      user: process.env.EMAIL_USER, // Your email
      pass: process.env.EMAIL_PASS // Your app password
    }
  });
};

// Email template for candidate credentials
const getCandidateCredentialsTemplate = (candidateName, email, password, partnerName, courseName) => {
  return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #4f46e5; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
            .credentials-box { background-color: #e0f2fe; border: 1px solid #0284c7; padding: 20px; margin: 20px 0; border-radius: 8px; }
            .warning { background-color: #fef3c7; border: 1px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 8px; }
            .button { display: inline-block; background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
            .footer { text-align: center; margin-top: 30px; color: #6b7280; font-size: 14px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Welcome to Your Learning Platform!</h1>
            </div>
            <div class="content">
                <h2>Hello ${candidateName},</h2>
                
                <p>Congratulations! You have been successfully enrolled by <strong>${partnerName}</strong> for the course: <strong>${courseName}</strong>.</p>
                
                <p>Your candidate account has been created with the following login credentials:</p>
                
                <div class="credentials-box">
                    <h3>🔐 Your Login Credentials</h3>
                    <p><strong>Email:</strong> ${email}</p>
                    <p><strong>Password:</strong> <code style="background-color: #1f2937; color: #f9fafb; padding: 4px 8px; border-radius: 4px; font-size: 16px;">${password}</code></p>
                </div>
                
                
                
                <p>You can now:</p>
                <ul>
                    <li>Access your course materials</li>
                    <li>Track your learning progress</li>
                    <li>Update your profile information</li>
                    <li>Connect with your instructors</li>
                </ul>
                
                <div style="text-align: center;">
                    <a href="${process.env.FRONTEND_URL || 'https://airuter-backend.onrender.com'}/candidate/login" class="button">
                        Login to Your Account
                    </a>
                </div>
                
                <p>If you have any questions or need assistance, please don't hesitate to contact your course administrator.</p>
                
                <p>Best regards,<br>
                <strong>The Learning Platform Team</strong></p>
            </div>
            <div class="footer">
                <p>This is an automated message. Please do not reply to this email.</p>
                <p>If you didn't expect this email, please contact support immediately.</p>
            </div>
        </div>
    </body>
    </html>
  `;
};

// Function to send candidate credentials email
const sendCandidateCredentials = async (candidateData, password, partnerName) => {
  try {
    const transporter = createTransporter();
    
    const mailOptions = {
      from: {
        name: 'Learning Platform',
        address: process.env.EMAIL_USER
      },
      to: candidateData.email,
      subject: `Welcome to ${partnerName} - Your Account Credentials`,
      html: getCandidateCredentialsTemplate(
        candidateData.name,
        candidateData.email,
        password,
        partnerName,
        candidateData.enrolledCourse.courseName
      )
    };
    
    const result = await transporter.sendMail(mailOptions);
    console.log('Email sent successfully:', result.messageId);
    return { success: true, messageId: result.messageId };
    
  } catch (error) {
    console.error('Error sending email:', error);
    return { success: false, error: error.message };
  }
};

// Function to send password reset email
const sendPasswordResetEmail = async (candidateEmail, candidateName, resetToken) => {
  try {
    const transporter = createTransporter();
    const resetUrl = `${process.env.FRONTEND_URL || 'https://airuter-backend.onrender.com'}/candidate/reset-password/${resetToken}`;
    
    const mailOptions = {
      from: {
        name: 'Learning Platform',
        address: process.env.EMAIL_USER
      },
      to: candidateEmail,
      subject: 'Password Reset Request',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Password Reset Request</h2>
          <p>Hello ${candidateName},</p>
          <p>You requested a password reset. Click the link below to reset your password:</p>
          <a href="${resetUrl}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin: 20px 0;">
            Reset Password
          </a>
          <p>This link will expire in 10 minutes.</p>
          <p>If you didn't request this, please ignore this email.</p>
        </div>
      `
    };
    
    const result = await transporter.sendMail(mailOptions);
    return { success: true, messageId: result.messageId };
    
  } catch (error) {
    console.error('Error sending password reset email:', error);
    return { success: false, error: error.message };
  }
};

module.exports = {
  sendCandidateCredentials,
  sendPasswordResetEmail
};