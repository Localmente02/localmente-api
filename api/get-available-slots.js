// Importa Firebase Admin SDK per parlare con Firestore dal server
const admin = require('firebase-admin');

// Configurazione di Firebase Admin (assicurati che le tue credenziali siano nelle variabili d'ambiente di Vercel)
// Vercel solitamente gestisce questo in automatico se hai collegato il progetto
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();

// Funzione principale che verrà eseguita da Vercel
module.exports = async (req, res) => {
  // Imposta i permessi CORS per permettere al tuo sito di chiamare questa funzione
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); // O specifica il tuo dominio per più sicurezza
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // Se è una richiesta OPTIONS (pre-flight CORS), rispondi subito
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non consentito' });
  }

  try {
    const { vendorId, serviceId, date } = req.body;

    if (!vendorId || !serviceId || !date) {
      return res.status(400).json({ error: 'Dati mancanti: vendorId, serviceId, e date sono richiesti.' });
    }

    // 1. Recupera i dati del servizio per conoscere la durata
    const serviceDoc = await db.collection('offers').doc(serviceId).get();
    if (!serviceDoc.exists) {
      return res.status(404).json({ error: 'Servizio non trovato.' });
    }
    const serviceDuration = serviceDoc.data().serviceDuration; // in minuti

    // 2. Recupera gli orari di apertura del vendor
    // Per ora simuliamo, in futuro li prenderemo da `vendors/{vendorId}`
    const openingHours = { start: 9, end: 19 }; // Dalle 9:00 alle 19:00

    // 3. Recupera tutte le prenotazioni per quel giorno
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const bookingsSnapshot = await db.collection('bookings')
      .where('vendorId', '==', vendorId)
      .where('startTime', '>=', startOfDay)
      .where('startTime', '<=', endOfDay)
      .get();
    
    const existingBookings = bookingsSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        start: data.startTime.toDate(),
        end: data.endTime.toDate(),
      };
    });

    // 4. Calcola gli slot disponibili
    const availableSlots = [];
    const slotIncrement = 15; // Controlliamo ogni 15 minuti

    let currentTime = new Date(startOfDay);
    currentTime.setHours(openingHours.start, 0, 0, 0);
    
    const endOfWorkDay = new Date(startOfDay);
    endOfWorkDay.setHours(openingHours.end, 0, 0, 0);

    while (currentTime < endOfWorkDay) {
      const potentialEndTime = new Date(currentTime.getTime() + serviceDuration * 60000);

      // Controlla se lo slot finisce dopo l'orario di chiusura
      if (potentialEndTime > endOfWorkDay) {
        break; 
      }

      // Controlla se si sovrappone con prenotazioni esistenti
      let isOverlap = false;
      for (const booking of existingBookings) {
        if (
          (currentTime < booking.end && potentialEndTime > booking.start)
        ) {
          isOverlap = true;
          break;
        }
      }

      if (!isOverlap) {
        const hours = String(currentTime.getHours()).padStart(2, '0');
        const minutes = String(currentTime.getMinutes()).padStart(2, '0');
        availableSlots.push(`${hours}:${minutes}`);
      }
      
      // Passa al prossimo slot
      currentTime.setMinutes(currentTime.getMinutes() + slotIncrement);
    }
    
    // 5. Rispondi con la lista degli slot
    res.status(200).json({ slots: availableSlots });

  } catch (error) {
    console.error('Errore nella funzione get-available-slots:', error);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
};
