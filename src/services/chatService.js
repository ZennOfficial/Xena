const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../data/publicChat.json');

function loadMessages() {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '[]');
    }

    return JSON.parse(fs.readFileSync(filePath));
}

function saveMessages(messages) {
    fs.writeFileSync(filePath, JSON.stringify(messages, null, 2));
}

exports.addMessage = (username, message) => {
    const messages = loadMessages();

    const newMessage = {
        username,
        message,
        time: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        }),
        timestamp: Date.now()
    };

    messages.push(newMessage);

    if (messages.length > 100) {
        messages.shift();
    }

    saveMessages(messages);

    return newMessage;
};

exports.getMessages = () => {
    return loadMessages();
};