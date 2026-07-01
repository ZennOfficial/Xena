const express = require('express');
const VPSController = require('../controllers/vpsController');
const { logger } = require('../utils/logger');

const router = express.Router();

// Get user's VPS
router.get("/myServer", VPSController.getMyServer);

// Add new VPS
router.post("/addServer", VPSController.addServer);

// Delete VPS
router.post("/delServer", VPSController.deleteServer);

// Send command to VPS
router.post("/sendCommand", VPSController.sendCommand);

router.get("/cncSend", VPSController.cncSend);

module.exports = router;