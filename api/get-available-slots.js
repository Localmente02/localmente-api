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
        // Fallback per localhost o altri ambienti di sviluppo non esplicitamente listati ma sicuri
        if (req.headers.host && (req.headers.host.includes('localhost') || req.headers.host.includes('127.0.0.1'))) {
            res.setHeader('Access-Control-Allow-Origin', origin || '*'); 
        } else {
            // Per tutte le altre origini non consentite o sconosciute, non impostare l'header
            // o impostalo a un'origine fissa di default se necessario per evitare errori CORS su frontend non autorizzati ma con fetch validi.
            // Per una funzione serverless Vercel, non impostare l'header è spesso la scelta più sicura.
        }
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
            status: payload.status || 'pending', // Default a 'pending'
            
            // Timestamp di Firestore
            startDateTime: admin.firestore.Timestamp.fromDate(startDateTime),
            endDateTime: admin.firestore.Timestamp.fromDate(endDateTime),
            
            selectedServiceVariant: payload.selectedServiceVariant || null,
            assignedResourceIds: payload.assignedResourceIds || [], 
            
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
            // MODIFICA CRUCIALE QUI: Includere TUTTI gli stati che devono bloccare uno slot
            .where('status', 'in', ['confirmed', 'paid', 'pending', 'rescheduled']) // AGGIUNTO 'pending' e 'rescheduled'
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
      // Usa parseISOString per garantire che la data sia sempre in UTC e corretta per il fuso orario del server
      const dateString = date + 'T00:00:00.000Z'; // Assumi che la 'date' sia una stringa 'YYYY-MM-DD'
      const dateObj = new Date(dateString); // Questo creerà un oggetto Date in UTC
      
      const dayOfWeek = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"][dateObj.getUTCDay()];
      const todayHours = vendorDoc.data().opening_hours_structured.find(d => d.day === dayOfWeek);
      
      if (!todayHours || !todayHours.isOpen) { return res.status(200).json({ slots: [], message: 'Negozio chiuso.' }); }

      // 3. Prepara i dati per il calcolo
      const allResources = resourcesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const existingBookings = bookingsSnapshot.docs.map(doc => ({
        start: doc.data().startDateTime.toDate(), // Converti il Timestamp in oggetto Date
        end: doc.data().endDateTime.toDate(),     // Converti il Timestamp in oggetto Date
        assignedResourceIds: doc.data().assignedResourceIds || []
      }));

      const availableSlots = [];
      const slotIncrement = 15; // Slot di intervallo di 15 minuti

      // 4. Inizia il calcolo
      for (const slot of todayHours.slots) {
          if (!slot.from || !slot.to) continue;
          
          const [startHour, startMinute] = slot.from.split(':').map(Number);
          const [endHour, endMinute] = slot.to.split(':').map(Number);
          
          // Costruisci gli oggetti Date per gli orari di inizio e fine dello slot di lavoro.
          // È fondamentale che siano nello stesso fuso orario o in UTC coerente.
          // Dato che il frontend invia la data, e Firestore immagazzina in Timestamp,
          // quando facciamo `new Date(date + 'T...')` stiamo creando Date locali o UTC a seconda dell'implementazione di Date.
          // Usiamo `setUTCHours` per garantire coerenza con gli orari di apertura che sono "stringhe senza fuso orario".
          
          let currentTime = new Date(date + 'T00:00:00Z'); // Inizia all'inizio del giorno UTC
          currentTime.setUTCHours(startHour, startMinute, 0, 0); // Imposta le ore/minuti dello slot di lavoro

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

          if (currentSlotTime >= endOfWorkSlot) continue; // Se l'ora arrotondata supera la fine dello slot, salta

          // 5. Loop per trovare gli slot
          while (currentSlotTime < endOfWorkSlot) {
              const potentialEndTime = new Date(currentSlotTime.getTime() + serviceDuration * 60000);
              if (potentialEndTime > endOfWorkSlot) break; // Se il servizio supera la fine dello slot di lavoro, non proporlo

              let areAllRequirementsMet = true;
              
              if (requirements.length > 0) {
                  // Logica con requisiti (Barbiere A, Cabina 1, ecc.)
                  for (const req of requirements) {
                      const resourcesInGroup = allResources.filter(r => r.groupId === req.groupId);
                      
                      // Per ogni risorsa nel gruppo, verifica se è impegnata
                      const availableResourcesInGroup = resourcesInGroup.filter(resource => {
                          const isBusy = existingBookings.some(booking => {
                              // Se la prenotazione esistente HA risorse assegnate E una di queste è la risorsa corrente
                              const isResourceAssignedToBooking = booking.assignedResourceIds.includes(resource.id);
                              
                              // Se la prenotazione esistente NON HA risorse assegnate,
                              // e il gruppo ha una sola risorsa, allora quella risorsa è implicitamente occupata.
                              // Questo è per servizi che richiedono 'una risorsa' ma non specificano 'quale'.
                              const isImplicitlyAssignedToSingleResource = (!booking.assignedResourceIds.length && resourcesInGroup.length === 1);

                              // Controlla la sovrapposizione temporale
                              const isTimeOverlap = (currentSlotTime < booking.end && potentialEndTime > booking.start);

                              return (isResourceAssignedToBooking || isImplicitlyAssignedToSingleResource) && isTimeOverlap;
                          });
                          return !isBusy; // La risorsa è disponibile se NON è impegnata
                      });

                      if (availableResourcesInGroup.length < req.quantity) {
                          areAllRequirementsMet = false;
                          break; // Non ci sono abbastanza risorse per questo requisito, passa al prossimo slot di tempo
                      }
                  }
              } else {
                  // Logica SENZA requisiti (tratta il VENDOR come un'unica risorsa)
                  // Verifichiamo se c'è UNA QUALSIASI prenotazione che si sovrappone per questo VENDOR.
                  const isTimeSlotBusyForVendor = existingBookings.some(booking =>
                      currentSlotTime < booking.end && potentialEndTime > booking.start
                  );
                  
                  if (isTimeSlotBusyForVendor) {
                      areAllRequirementsMet = false; // Se c'è una prenotazione che si sovrappone, l'orario è occupato per il vendor
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
