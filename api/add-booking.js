// api/add-booking.js

const admin = require('firebase-admin');

// Inizializzazione Firebase Admin
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch (error) {
    console.error('ERRORE: Inizializzazione Firebase fallita.', error);
  }
}

const db = admin.firestore();

function setCorsHeaders(req, res) {
    // Ora che vercel.json ha "*", dobbiamo solo assicurarci di impostare METHODS e HEADERS
    const origin = req.headers.origin;
    if (origin) {
         // L'header Access-Control-Allow-Origin è gestito da vercel.json, 
         // ma lo riflettiamo qui se necessario.
         res.setHeader('Access-Control-Allow-Origin', origin); 
    }
    
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
}


module.exports = async (req, res) => {
  
    setCorsHeaders(req, res);

    // GESTIONE ESPLICITA E CORRETTA DEL METODO OPTIONS PER STATO 200
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Metodo non consentito. Utilizzare POST.' });
    }

    try {
        const payload = req.body;
        // La validazione essenziale
        if (!payload.vendorId || !payload.serviceId || !payload.customerName) {
            return res.status(400).json({ error: 'Dati di prenotazione incompleti.' });
        }

        // --- CONVERSIONE DATE ---
        const startDateTime = new Date(payload.startDateTime);
        const endDateTime = new Date(payload.endDateTime);

        if (isNaN(startDateTime) || isNaN(endDateTime)) {
            return res.status(400).json({ error: 'Date/Ore non valide nel payload.' });
        }
        
        // --- PREPARAZIONE DATI ---
        const bookingData = {
            vendorId: payload.vendorId,
            serviceId: payload.serviceId,
            customerName: payload.customerName,
            customerPhone: payload.customerPhone,
            bookedServiceName: payload.bookedServiceName,
            bookedServicePrice: payload.bookedServicePrice,
            type: payload.type || 'cura_persona', 
            status: payload.status || 'pending', 
            
            // Timestamp di Firestore
            startDateTime: admin.firestore.Timestamp.fromDate(startDateTime),
            endDateTime: admin.firestore.Timestamp.fromDate(endDateTime),
            
            selectedServiceVariant: payload.selectedServiceVariant || null,
            
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            source: 'website', 
        };

        // --- SALVATAGGIO ---
        const docRef = await db.collection('bookings').add(bookingData);

        // --- RISPOSTA ---
        return res.status(200).json({ 
            success: true, 
            message: 'Prenotazione creata con successo.',
            bookingId: docRef.id
        });

    } catch (error) {
        console.error('Errore nel salvare la prenotazione (add-booking):', error);
        return res.status(500).json({ error: 'Errore interno nel salvataggio della prenotazione.', details: error.message });
    }
};
