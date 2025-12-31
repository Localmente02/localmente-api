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
    'https://www.civora.it', // Aggiunto il tuo dominio Civora
    // Aggiungi qui anche gli URL di test o localhost se necessario
];

// 2. Funzione per impostare dinamicamente l'header CORS
function setCorsHeaders(req, res) {
    const origin = req.headers.origin;
    
    if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (req.headers.host && (req.headers.host.includes('localhost') || req.headers.host.includes('127.0.0.1'))) {
        // Permetti localhost per lo sviluppo
        res.setHeader('Access-Control-Allow-Origin', req.headers.host.includes('localhost') ? 'http://localhost:3000' : 'http://127.0.0.1:5500');
    }

    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
}


module.exports = async (req, res) => {
  
  // Imposta gli header di risposta in base all'origine della richiesta
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    // Risponde 200 OK e termina il preflight
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non consentito. Utilizzare POST.' });
  }

  try {
    const { action, bookingType, vendorId } = req.body; 

    // =======================================================
    // NUOVA LOGICA 1: SALVATAGGIO DELLA PRENOTAZIONE (BOOKING)
    // =======================================================
    if (action === 'save_service_booking') {
        const payload = req.body;
        
        // La validazione essenziale del payload di salvataggio
        if (!payload.vendorId || !payload.serviceId || !payload.customerName || !payload.startDateTime || !payload.endDateTime) {
            return res.status(400).json({ error: 'Dati di prenotazione incompleti per il salvataggio.' });
        }

        // --- CONVERSIONE DATE ---
        const startDateTime = new Date(payload.startDateTime);
        const endDateTime = new Date(payload.endDateTime);

        if (isNaN(startDateTime) || isNaN(endDateTime)) {
            return res.status(400).json({ error: 'Date/Ore non valide nel payload di salvataggio. Assicurati siano stringhe ISO.' });
        }
        
        // --- PREPARAZIONE DATI ---
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
            
            // Timestamp di Firestore
            startDateTime: admin.firestore.Timestamp.fromDate(startDateTime),
            endDateTime: admin.firestore.Timestamp.fromDate(endDateTime),
            
            selectedServiceVariant: payload.selectedServiceVariant || null,
            assignedResourceIds: payload.assignedResourceIds || [], // Mantiene le risorse assegnate se inviate
            
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            source: payload.source || 'website', 
            // Aggiungi un codice univoco per il tracking se non viene inviato
            appointmentCode: payload.appointmentCode || ('WEB_' + Date.now().toString().slice(-6) + Math.floor(Math.random() * 1000).toString().padStart(3, '0'))
        };

        // --- SALVATAGGIO ---
        const docRef = await db.collection('bookings').add(bookingData);

        return res.status(200).json({ 
            success: true, 
            message: 'Prenotazione creata con successo.',
            bookingId: docRef.id
        });
    }
    // =======================================================
    // FINE NUOVA LOGICA 1
    // =======================================================


    if (bookingType === 'rental_fleet_check') {
        // ... (Logica noleggio omessa per brevità, non è l'obiettivo)
        return res.status(400).json({ error: 'Logica noleggio non implementata in questo contesto.' });
    } else if (action === 'getAvailableSlots') {
      // --- LOGICA ESISTENTE PER I SERVIZI (slots) ---
      const { serviceId, date, variantId } = req.body;
      
      if (!vendorId || !serviceId || !date) {
        return res.status(400).json({ error: 'Dati mancanti per la verifica del servizio.' });
      }

      // 1. Carica i dati necessari
      const [serviceDoc, vendorDoc, resourcesSnapshot, bookingsSnapshot] = await Promise.all([
          db.collection('offers').doc(serviceId).get(),
          db.collection('vendors').doc(vendorId).get(),
          db.collection('vendors').doc(vendorId).collection('resources').get(),
          db.collection('bookings')
            .where('vendorId', '==', vendorId)
            .where('startDateTime', '>=', new Date(date + 'T00:00:00Z'))
            .where('startDateTime', '<=', new Date(date + 'T23:59:59Z'))
            .where('status', 'in', ['confirmed', 'paid']) 
            .get()
      ]);

      if (!serviceDoc.exists) { return res.status(404).json({ error: 'Servizio non trovato.' }); }
      const serviceData = serviceDoc.data();
      
      // Determina durata e requisiti. Se c'è una variante, usa la sua durata/requisiti se specificati, altrimenti usa i dati base.
      let serviceDuration = serviceData.serviceDuration;
      let requirements = serviceData.requirements || [];

      if (variantId && serviceData.serviceVariants) {
          const variant = serviceData.serviceVariants.find(v => v.id === variantId);
          // Opzionale: se le varianti hanno una durata e requisiti specifici
          // if (variant && variant.duration) serviceDuration = variant.duration;
          // if (variant && variant.requirements) requirements = variant.requirements;
          // Per ora usiamo solo i dati del servizio principale (serviceDuration)
      }

      if (!serviceDuration) { return res.status(400).json({ error: 'Durata del servizio non specificata.' }); }

      if (!vendorDoc.exists || !vendorDoc.data().opening_hours_structured) { return res.status(200).json({ slots: [], message: 'Orari non configurati.' }); }
      
      // 2. Calcola l'orario di lavoro per il giorno
      const dateObj = new Date(date + 'T00:00:00Z');
      const dayOfWeek = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"][dateObj.getUTCDay()];
      const todayHours = vendorDoc.data().opening_hours_structured.find(d => d.day === dayOfWeek);
      
      if (!todayHours || !todayHours.isOpen) { return res.status(200).json({ slots: [], message: 'Negozio chiuso.' }); }

      // 3. Prepara i dati per il calcolo
      const allResources = resourcesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const existingBookings = bookingsSnapshot.docs.map(doc => ({
        start: doc.data().startDateTime.toDate(),
        end: doc.data().endDateTime.toDate(),
        assignedResourceIds: doc.data().assignedResourceIds || []
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
          // Calcola l'ora di inizio ricerca (o ora attuale o inizio slot, il più tardivo)
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

          // 5. Loop per trovare gli slot
          while (currentSlotTime < endOfWorkSlot) {
              const potentialEndTime = new Date(currentSlotTime.getTime() + serviceDuration * 60000);
              if (potentialEndTime > endOfWorkSlot) break;

              let areAllRequirementsMet = true;
              
              if (requirements.length > 0) {
                  // Logica con requisiti (Barbiere A, Cabina 1, ecc.)
                  for (const req of requirements) {
                      const resourcesInGroup = allResources.filter(r => r.groupId === req.groupId);
                      
                      const availableResourcesInGroup = resourcesInGroup.filter(resource => {
                          // Una risorsa è libera se NESSUNA prenotazione la impegna in questo lasso di tempo
                          const isBusy = existingBookings.some(booking => 
                              (booking.assignedResourceIds.includes(resource.id) || !booking.assignedResourceIds.length && resourcesInGroup.length === 1) && // <<< CORREZIONE: Se non è assegnata ma è l'unica nel gruppo, la consideriamo occupata
                              (currentSlotTime < booking.end && potentialEndTime > booking.start)
                          );
                          return !isBusy;
                      });

                      if (availableResourcesInGroup.length < req.quantity) {
                          areAllRequirementsMet = false;
                          break; 
                      }
                  }
              } else {
                  // Logica SENZA requisiti (Barbiere è a persona unica o non usa risorse per il servizio)
                  // Verifichiamo se c'è UNA QUALSIASI prenotazione che si sovrappone.
                  const isTimeSlotBusy = existingBookings.some(booking =>
                      currentSlotTime < booking.end && potentialEndTime > booking.start
                  );
                  
                  // Se c'è una prenotazione che si sovrappone, l'orario è occupato.
                  if (isTimeSlotBusy) {
                      areAllRequirementsMet = false;
                  }
              }
              
              if (areAllRequirementsMet) {
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
