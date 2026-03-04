// controllers/sa/saDatabaseController.js
const dbService = require('../../services/saDatabaseService');

const getDatabases = async (req, res) => {
    try {
        const databases = await dbService.getDatabases();
        res.status(200).json(databases);
    } catch (error) {
        console.error('Error fetching databases:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = {
    getDatabases,
};