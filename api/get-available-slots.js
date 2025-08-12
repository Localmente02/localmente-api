// File: api/get-available-slots.js

// Usiamo la stessa sintassi delle tue altre funzioni per coerenza
const admin = require('firebase-admin');

// La configurazione di Firebase Admin è già gestita a livello di progetto Vercel
// grazie alle variabili d'ambiente. Ci assicuriamo solo che sia inizializzata.
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
  } catch (error) {
    console.error('Firebase admin initialization error', error);
  }
}

const db = admin.firestore();

// Funzione principale, come le altre tue
module.exports = async (req, res) => {
  // La gestione CORS è centralizzata in vercel.json, quindi non serve qui.

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non consentito. Utilizzare POST.' });
  }

  try {
    const { vendorId, serviceId, date } = req.body;

    if (!vendorId || !serviceId || !date) {
      return res.status(400).json({ error: 'Dati mancanti: vendorId, serviceId, e date sono richiesti.' });
    }

    // 1. Recupera i dati del servizio per conoscere la durata
    const serviceDoc = await db.collection('offers').doc(serviceId).get();
    if (!serviceDoc.exists || !serviceDoc.data().serviceDuration) {
      return res.status(404).json({ error: 'Servizio non trovato o senza una durata specificata.' });
    }
    const serviceDuration = serviceDoc.data().serviceDuration;

    // 2. Recupera gli orari di apertura del vendor
    const vendorDoc = await db.collection('vendors').doc(vendorId).get();
    if (!vendorDoc.exists || !vendorDoc.data().opening_hours_structured) {
        // Orari di default se non specificati, per non bloccare tutto
        return res.status(200).json({ slots: [], message: 'Orari di apertura non configurati.' });
    }
    
    const dateObj = new Date(date);
    const dayOfWeek = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"][dateObj.getUTCDay()];
    const todayHours = vendorDoc.data().opening_hours_structured.find(d => d.day === dayOfWeek);

    if (!todayHours || !todayHours.isOpen) {
        return res.status(200).json({ slots: [], message: 'Negozio chiuso in questa data.' });
    }

    // 3. Recupera tutte le prenotazioni per quel giorno
    const startOfDay = new Date(date);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const bookingsSnapshot = await db.collection('bookings')
      .where('vendorId', '==', vendorId)
      .where('startTime', '>=', startOfDay)
      .where('startTime', '<=', endOfDay)
      .get();
    
    const existingBookings = bookingsSnapshot.docs.map(doc => ({
      start: doc.data().startTime.toDate(),
      end: doc.data().endTime.toDate(),
    }));

    // 4. Calcola gli slot disponibili
    const availableSlots = [];
    const slotIncrement = 15; // Controlliamo ogni 15 minuti

    // Cicla attraverso le fasce orarie del giorno (es. mattina e pomeriggio)
    for (const slot of todayHours.slots) {
        const [startHour, startMinute] = slot.from.split(':').map(Number);
        const [endHour, endMinute] = slot.to.split(':').map(Number);

        let currentTime = new Date(startOfDay);
        currentTime.setUTCHours(startHour, startMinute, 0, 0);
        
        const endOfWorkSlot = new Date(startOfDay);
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
