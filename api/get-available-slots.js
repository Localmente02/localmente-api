// File: api/get-available-slots.js
const admin = require('firebase-admin');

if (!admin.apps.length) {
  try {
    // Tentativo #1: Leggiamo l'intero JSON da UNA variabile d'ambiente.
    // Cambia 'FIREBASE_SERVICE_ACCOUNT_JSON' con il nome della tua variabile se è diverso.
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_PRIVATE_KEY;
    const serviceAccount = JSON.parse(serviceAccountJson);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("Firebase inizializzato con successo usando l'intero JSON.");

  } catch (e) {
    // Se il Tentativo #1 fallisce, proviamo con le chiavi separate (Metodo #2)
    console.warn("Inizializzazione da JSON fallita, provo con le variabili separate...");
    try {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        }),
      });
      console.log("Firebase inizializzato con successo usando le variabili separate.");
    } catch (error) {
      console.error('ERRORE DEFINITIVO: Inizializzazione Firebase fallita con entrambi i metodi.', error);
    }
  }
}

const db = admin.firestore();

// Funzione principale, come le altre tue
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', 'https://localmente-v3-core.web.app');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  res.setHeader('Access-Control-Allow-Origin', 'https://localmente-v3-core.web.app');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non consentito. Utilizzare POST.' });
  }

  try {
    // ... il resto del codice rimane assolutamente identico ...
    const { vendorId, serviceId, date } = req.body;

    if (!vendorId || !serviceId || !date) {
      return res.status(400).json({ error: 'Dati mancanti: vendorId, serviceId, e date sono richiesti.' });
    }

    const serviceDoc = await db.collection('offers').doc(serviceId).get();
    if (!serviceDoc.exists || !serviceDoc.data().serviceDuration) {
      return res.status(404).json({ error: 'Servizio non trovato o senza una durata specificata.' });
    }
    const serviceDuration = serviceDoc.data().serviceDuration;

    const vendorDoc = await db.collection('vendors').doc(vendorId).get();
    if (!vendorDoc.exists || !vendorDoc.data().opening_hours_structured) {
        return res.status(200).json({ slots: [], message: 'Orari di apertura non configurati.' });
    }
    
    const dateObj = new Date(date + 'T00:00:00Z');
    const dayOfWeek = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"][dateObj.getUTCDay()];
    const todayHours = vendorDoc.data().opening_hours_structured.find(d => d.day === dayOfWeek);

    if (!todayHours || !todayHours.isOpen) {
        return res.status(200).json({ slots: [], message: 'Negozio chiuso in questa data.' });
    }

    const startOfDay = new Date(date + 'T00:00:00Z');
    const endOfDay = new Date(date + 'T23:59:59Z');

    const bookingsSnapshot = await db.collection('bookings')
      .where('vendorId', '==', vendorId)
      .where('startTime', '>=', startOfDay)
      .where('startTime', '<=', endOfDay)
      .get();
    
    const existingBookings = bookingsSnapshot.docs.map(doc => ({
      start: doc.data().startTime.toDate(),
      end: doc.data().endTime.toDate(),
    }));

    const availableSlots = [];
    const slotIncrement = 15;

    for (const slot of todayHours.slots) {
        if (!slot.from || !slot.to) continue;
        const [startHour, startMinute] = slot.from.split(':').map(Number);
        const [endHour, endMinute] = slot.to.split(':').map(Number);

        let currentTime = new Date(date + 'T00:00:00Z');
        currentTime.setUTCHours(startHour, startMinute, 0, 0);
        
        const endOfWorkSlot = new Date(date + 'T00:00:00Z');
        endOfWorkSlot.setUTCHours(endHour, endMinute, 0, 0);

        while (currentTime < endOfWorkSlot) {
            const potentialEndTime = new Date(currentTime.getTime() + serviceDuration * 60000);
            if (potentialEndTime > endOfWorkSlot) break;

            let isOverlap = false;
            for (const booking of existingBookings) {
                if (currentTime < booking.end && potentialEndTime > booking.start) {
                    isOverlap = true;
                    break;
                }
            }

            if (!isOverlap) {
                const hours = String(currentTime.getUTCHours()).padStart(2, '0');
                const minutes = String(currentTime.getUTCMinutes()).padStart(2, '0');
                availableSlots.push(`${hours}:${minutes}`);
            }
            
            currentTime.setUTCMinutes(currentTime.getUTCMinutes() + slotIncrement);
        }
    }
    
    res.status(200).json({ slots: availableSlots });

  } catch (error) {
    console.error('Errore in get-available-slots:', error);
    res.status(500).json({ error: 'Errore interno del server.', details: error.message });
  }
};
