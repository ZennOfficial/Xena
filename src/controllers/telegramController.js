const telegramService = require('../services/telegramService');

exports.sendCode = async (req, res) => {
    try {
        const result = await telegramService.sendCode(req.body.phoneNumber);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
};

exports.login = async (req, res) => {
    try {
        const { phoneNumber, phoneCodeHash, code } = req.body;
        const result = await telegramService.signIn(phoneNumber, phoneCodeHash, code);
        res.json({ success: true, message: "Login success", user: result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
};

exports.getSessions = (req, res) => {
    const sessions = telegramService.getSavedSessions();
    res.json({ success: true, data: sessions });
};

exports.report = async (req, res) => {
    try {
        const { target, reason, count } = req.body;
        const result = await telegramService.executeReport(target, reason, count);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
};