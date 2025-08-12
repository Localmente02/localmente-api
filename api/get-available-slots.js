// File: api/get-available-slots.js
const admin = require('firebase-admin');

if (!admin.apps.length) {
  try {
    // Leggiamo l'intero JSON dalla TUA variabile 'FIREBASE_SERVICE_ACCOUNT_KEY'
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    
  } catch (error) {
    console.error('ERRORE DEFINITIVO: Inizializzazione Firebase fallita.', error);
    // Se fallisce qui, il problema è al 100% nel contenuto della variabile d'ambiente.
  }
}

const db = admin.firestore();

// Funzione principale che verrà eseguita da Vercel
module.exports = async (req, res) => {
  // Gestione della richiesta "pre-flight" OPTIONS per la policy CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', 'https://localmente-v3-core.web.app');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  // Aggiungiamo l'header anche per la risposta POST
  res.setHeader('Access-Control-Allow-Origin', 'https://localmente-v3-core.web.app');

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
        return res.status(200).json({ slots: [], message: 'Orari di apertura non configurati.' });
    }
    
    const dateObj = new Date(date + 'T00:00:00Z'); // Assicuriamo che sia UTC
    const dayOfWeek = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"][dateObj.getUTCDay()];
    const todayHours = vendorDoc.data().opening_hours_structured.find(d => d.day === dayOfWeek);

    if (!todayHours || !todayHours.isOpen) {
        return res.status(200).json({ slots: [], message: 'Negozio chiuso in questa data.' });
    }

    // 3. Recupera tutte le prenotazioni per quel giorno
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

    // 4. Calcola gli slot disponibili
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
    
    // 5. Rispondi con la lista degli slot
    res.status(200).json({ slots: availableSlots });

  } catch (error) {
    console.error('Errore in get-available-slots:', error);
    res.status(500).json({ error: 'Errore interno del server.', details: error.message });
  }
};
