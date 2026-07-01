const chatService = require('../services/chatService');

exports.sendChat = (req, res) => {
    const { username, message } = req.body;

    if (!username || !message) {
        return res.status(400).json({ success: false, message: "Data tidak lengkap" });
    }

    const savedMsg = chatService.addMessage(username, message);
    res.status(200).json({ success: true, data: savedMsg });
};

exports.getChat = (req, res) => {
    const messages = chatService.getMessages();

    res.status(200).json({
        success: true,
        messages: messages
    });
};