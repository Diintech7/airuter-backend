const { generateToken } = require('../services/authService');

exports.getToken = async (req, res) => {
    try {
        const { roomId, role } = req.body;
        const token = generateToken(roomId, role);
        res.json({ token });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};