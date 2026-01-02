// api/get-available-slots.js:

const admin = require('firebase-admin');

if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch (error) {
    console.error('ERRORE DEFINITIVO: Inizializzazione Firebase fallita.', error);
  }
}

const db = admin.firestore();

// 1. Definisci le origini consentite
const ALLOWED_ORIGINS = [
    'https://localmente-v3-core.web.app',
    'https://localmente-site.web.app', 
    'https://www.civora.it', 
    'http://localhost:3000', // Aggiunto per lo sviluppo locale
    'http://127.0.0.1:5500', // Aggiunto per lo sviluppo locale (se usato con Live Server)
];

// 2. Funzione per impostare dinamicamente l'header CORS
function setCorsHeaders(req, res) {
    const origin = req.headers.origin;
    
    if (ALLOWED_ORIGINS.includes(origin)) { 
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
        if (req.headers.host && (req.headers.host.includes('localhost') || req.headers.host.includes('127.0.0.1'))) {
            res.setHeader('Access-Control-Allow-Origin', origin || '*'); 
        }
    }

    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
}


module.exports = async (req, res) => {
  
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non consentito. Utilizzare POST.' });
  }

  try {
    const { action, bookingType, vendorId } = req.body; 

    if (action === 'save_service_booking') {
        const payload = req.body;
        
        if (!payload.vendorId || !payload.serviceId || !payload.customerName || !payload.startDateTime || !payload.endDateTime) {
            return res.status(400).json({ error: 'Dati di prenotazione incompleti per il salvataggio.' });
        }

        const startDateTime = new Date(payload.startDateTime);
        const endDateTime = new Date(payload.endDateTime);

        if (isNaN(startDateTime) || isNaN(endDateTime)) {
            return res.status(400).json({ error: 'Date/Ore non valide nel payload di salvataggio. Assicurati siano stringhe ISO.' });
        }
        
        const bookingData = {
            vendorId: payload.vendorId,
            serviceId: payload.serviceId,
            customerName: payload.customerName,
            customerPhone: payload.customerPhone || null,
            customerEmail: payload.customerEmail || null,
            customerId: payload.customerId || null,
            bookedServiceName: payload.bookedServiceName,
            bookedServicePrice: payload.bookedServicePrice,
            type: payload.type || 'cura_persona', 
            status: payload.status || 'pending', 
            
            startDateTime: admin.firestore.Timestamp.fromDate(startDateTime),
            endDateTime: admin.firestore.Timestamp.fromDate(endDateTime),
            
            // selectedServiceVariant: payload.selectedServiceVariant || null, // Mantenuto se il frontend lo invia (ma UI semplificata non lo farà)
            // assignedResourceIds: payload.assignedResourceIds || [],        // Mantenuto se il frontend lo invia (ma UI semplificata non lo farà)
            
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            source: payload.source || 'website', 
            appointmentCode: payload.appointmentCode || ('WEB_' + Date.now().toString().slice(-6) + Math.floor(Math.random() * 1000).toString().padStart(3, '0'))
        };

        // Aggiungi solo se presenti nel payload, per mantenere flessibilità se il frontend invia ancora
        if (payload.selectedServiceVariant) bookingData.selectedServiceVariant = payload.selectedServiceVariant;
        if (payload.assignedResourceIds) bookingData.assignedResourceIds = payload.assignedResourceIds;
        
        const docRef = await db.collection('bookings').add(bookingData);

        return res.status(200).json({ 
            success: true, 
            message: 'Prenotazione creata con successo.',
            bookingId: docRef.id
        });
    }

    if (bookingType === 'rental_fleet_check') {
        return res.status(400).json({ error: 'Logica noleggio non implementata in questo contesto.' });
    } else if (action === 'getAvailableSlots') {
      const { serviceId, date, variantId } = req.body; 
      
      if (!vendorId || !serviceId || !date) {
        return res.status(400).json({ error: 'Dati mancanti per la verifica del servizio.' });
      }

      // 1. Carica i dati necessari (ignorando le risorse individuali)
      const [serviceDoc, vendorDoc, bookingsSnapshot] = await Promise.all([
          db.collection('offers').doc(serviceId).get(),
          db.collection('vendors').doc(vendorId).get(),
          db.collection('bookings')
            .where('vendorId', '==', vendorId)
            .where('startDateTime', '>=', new Date(date + 'T00:00:00Z'))
            .where('startDateTime', '<=', new Date(date + 'T23:59:59Z'))
            .where('status', 'in', ['confirmed', 'paid', 'pending', 'rescheduled']) // Include tutti gli stati che bloccano uno slot
            .get()
      ]);

      if (!serviceDoc.exists) { return res.status(404).json({ error: 'Servizio non trovato.' }); }
      const serviceData = serviceDoc.data();
      
      let serviceDuration = serviceData.serviceDuration;

      if (!serviceDuration) { return res.status(400).json({ error: 'Durata del servizio non specificata.' }); }

      if (!vendorDoc.exists || !vendorDoc.data().opening_hours_structured) { return res.status(200).json({ slots: [], message: 'Orari non configurati.' }); }
      
      // 2. Calcola l'orario di lavoro per il giorno
      const dateString = date + 'T00:00:00.000Z'; 
      const dateObj = new Date(dateString); 
      
      const dayOfWeek = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"][dateObj.getUTCDay()];
      const todayHours = vendorDoc.data().opening_hours_structured.find(d => d.day === dayOfWeek);
      
      if (!todayHours || !todayHours.isOpen) { return res.status(200).json({ slots: [], message: 'Negozio chiuso.' }); }

      // 3. Prepara i dati per il calcolo
      const existingBookings = bookingsSnapshot.docs.map(doc => ({
        start: doc.data().startDateTime.toDate(), 
        end: doc.data().endDateTime.toDate()     
      }));

      const availableSlots = [];
      const slotIncrement = 15; // Slot di intervallo di 15 minuti

      // 4. Inizia il calcolo
      for (const slot of todayHours.slots) {
          if (!slot.from || !slot.to) continue;
          
          const [startHour, startMinute] = slot.from.split(':').map(Number);
          const [endHour, endMinute] = slot.to.split(':').map(Number);
          
          let currentTime = new Date(date + 'T00:00:00Z'); 
          currentTime.setUTCHours(startHour, startMinute, 0, 0); 

          const endOfWorkSlot = new Date(date + 'T00:00:00Z');
          endOfWorkSlot.setUTCHours(endHour, endMinute, 0, 0);

          const nowUtc = new Date();
          const startSearchTime = (currentTime < nowUtc && dateObj.toDateString() === nowUtc.toDateString()) ? nowUtc : currentTime;
          
          let currentSlotTime = new Date(startSearchTime);
          
          // Arrotonda l'ora corrente al prossimo incremento di 15 minuti (solo se siamo nel giorno di oggi)
          if (dateObj.toDateString() === nowUtc.toDateString()) {
              const currentMins = currentSlotTime.getUTCMinutes();
              const remainder = currentMins % slotIncrement;
              if (remainder !== 0) {
                  currentSlotTime.setUTCMinutes(currentMins + (slotIncrement - remainder));
              }
          }

          if (currentSlotTime >= endOfWorkSlot) continue; 

          // 5. Loop per trovare gli slot - LOGICA SEMPLIFICATA
          while (currentSlotTime < endOfWorkSlot) {
              const potentialEndTime = new Date(currentSlotTime.getTime() + serviceDuration * 60000);
              if (potentialEndTime > endOfWorkSlot) break; 

              let isAvailable = true;
              
              // SEMPLIFICAZIONE: Tratta il VENDOR come un'unica risorsa.
              // Verifichiamo se c'è UNA QUALSIASI prenotazione che si sovrappone per questo VENDOR.
              const isTimeSlotBusyForVendor = existingBookings.some(booking =>
                  currentSlotTime < booking.end && potentialEndTime > booking.start
              );
              
              if (isTimeSlotBusyForVendor) {
                  isAvailable = false; 
              }
              
              if (isAvailable) {
                  const hours = String(currentSlotTime.getUTCHours()).padStart(2, '0');
                  const minutes = String(currentSlotTime.getUTCMinutes()).padStart(2, '0');
                  availableSlots.push(`${hours}:${minutes}`);
              }
              
              currentSlotTime.setUTCMinutes(currentSlotTime.getUTCMinutes() + slotIncrement);
          }
      }
      
      // 6. Ritorna gli slot
      return res.status(200).json({ slots: availableSlots });
    }
  } catch (error) {
    console.error('Errore in get-available-slots:', error);
    res.status(500).json({ error: 'Errore interno del server.', details: error.message });
  }
};
