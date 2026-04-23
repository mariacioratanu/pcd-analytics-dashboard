const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const { PubSub } = require('@google-cloud/pubsub');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT;
const SUBSCRIPTION_NAME = process.env.SUBSCRIPTION_NAME || 'movie-events-sub';

const firestore = new Firestore({ projectId: PROJECT_ID });
const pubsub = new PubSub({ projectId: PROJECT_ID });

// Colectia Firestore pentru statistici
const statsCollection = firestore.collection('movie-stats');

// Colectia pentru tracking-ul mesajelor procesate (idempotenta)
const processedCollection = firestore.collection('processed-messages');

// Procesarea unui eveniment
async function processEvent(messageId, data) {
    // Verificare idempotenta: a fost deja procesat acest mesaj?
    const processedDoc = await processedCollection.doc(messageId).get();
    if (processedDoc.exists) {
        console.log(JSON.stringify({
            msg: 'Duplicate message skipped',
            messageId,
            movieId: data.movieId
        }));
        return { status: 'duplicate' };
    }

    // Actualizare statistici in Firestore (upsert)
    const statsRef = statsCollection.doc(data.movieId);
    const statsDoc = await statsRef.get();

    if (statsDoc.exists) {
        await statsRef.update({
            viewCount: Firestore.FieldValue.increment(1),
            lastViewed: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
    } else {
        await statsRef.set({
            movieId: data.movieId,
            movieTitle: data.movieTitle || 'Unknown',
            viewCount: 1,
            lastViewed: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
    }

    // Marcare mesaj ca procesat
    await processedCollection.doc(messageId).set({
        processedAt: new Date().toISOString(),
        movieId: data.movieId
    });

    console.log(JSON.stringify({
        msg: 'Event processed',
        messageId,
        movieId: data.movieId,
        event: data.event
    }));

    return { status: 'processed' };
}

// Endpoint pentru Pub/Sub push subscription
app.post('/pubsub/push', async (req, res) => {
    try {
        const message = req.body.message;
        if (!message) {
            return res.status(400).json({ error: 'No message received' });
        }

        const messageId = message.messageId;
        const data = JSON.parse(Buffer.from(message.data, 'base64').toString());

        const result = await processEvent(messageId, data);

        console.log(JSON.stringify({
            msg: 'Push message handled',
            messageId,
            result: result.status
        }));

        res.status(200).json(result);
    } catch (error) {
        console.error(JSON.stringify({ msg: 'Error processing push message', error: error.message }));
        res.status(500).json({ error: error.message });
    }
});

// Endpoint pentru a vedea statisticile
app.get('/stats', async (req, res) => {
    const snapshot = await statsCollection.orderBy('viewCount', 'desc').limit(20).get();
    const stats = [];
    snapshot.forEach(doc => stats.push({ id: doc.id, ...doc.data() }));
    res.json({ stats, count: stats.length });
});

// Endpoint pentru a vedea statisticile unui film specific
app.get('/stats/:movieId', async (req, res) => {
    const doc = await statsCollection.doc(req.params.movieId).get();
    if (!doc.exists) {
        return res.status(404).json({ error: 'No stats found for this movie' });
    }
    res.json(doc.data());
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'analytics-service' });
});

app.post('/crash', (req, res) => {
    console.log('Crash endpoint triggered');
    res.json({ status: 'crashing' });
    setTimeout(() => process.exit(1), 100);
});

app.listen(PORT, () => console.log(`Analytics service running on port ${PORT}`));