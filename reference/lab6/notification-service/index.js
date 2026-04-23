const express = require('express');
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 8080;

// Simuleaza o latenta de procesare variabila
const simulateWork = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'notification-service' });
});

app.post('/notify', async (req, res) => {
    const { event, movieId, movieTitle } = req.body;
    const delay = Math.floor(Math.random() * 200) + 50; // 50-250ms

    await simulateWork(delay);

    console.log(JSON.stringify({
        msg: 'Notification sent',
        event,
        movieId,
        movieTitle,
        processingTime: `${delay}ms`,
        timestamp: new Date().toISOString()
    }));

    res.json({ status: 'sent', processingTime: `${delay}ms` });
});

app.post('/crash', (req, res) => {
    console.log('Crash endpoint triggered');
    res.json({ status: 'crashing' });
    setTimeout(() => process.exit(1), 100);
});

app.listen(PORT, () => console.log(`Notification service running on port ${PORT}`));