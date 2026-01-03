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
    'http://localhost:3000', 
    'http://127.0.0.1:5500', 
];

// 2. Funzione per impostare dinamicamente l'header CORS
function setCorsHeaders(req, res) {
    const origin = req.headers.origin;
    
    if (ALLOWED_ORIGINS.includes(origin)) { 
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
        // Allow localhost and 127.0.0.1 for development if the host matches
        if (req.headers.host && (req.headers.host.includes('localhost') || req.headers.host.includes('127.0.0.1'))) {
            res.setHeader('Access-Control-Allow-Origin', origin || '*'); 
        }
    }

    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400'); // Cache preflight requests for 24 hours
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
    const { action, vendorId } = req.body; 

    // =======================================================
    // LOGICA DI SALVATAGGIO DELLA PRENOTAZIONE (BOOKING)
    // =======================================================
    if (action === 'save_service_booking') {
        const payload = req.body;
        
        if (!payload.vendorId || !payload.serviceId || !payload.customerName || !payload.startDateTime || !payload.endDateTime || !payload.bookedTotalOccupiedTime) {
            return res.status(400).json({ error: 'Dati di prenotazione incompleti per il salvataggio. Mancano vendorId, serviceId, customerName, startDateTime, endDateTime o bookedTotalOccupiedTime.' });
        }

        const startDateTime = new Date(payload.startDateTime);
        // L'endDateTime è già stata calcolata correttamente dal frontend usando totalOccupiedTimeMinutes
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
            // customerId: payload.customerId || null, // Rimosso per chiarezza, come discusso
            bookedServiceName: payload.bookedServiceName,
            bookedServicePrice: payload.bookedServicePrice,
            bookedServiceDuration: payload.bookedServiceDuration, // Durata effettiva per il cliente
            bookedPreparationTime: payload.bookedPreparationTime || 0, // Tempo di preparazione
            bookedCleanupTime: payload.bookedCleanupTime || 0, // Tempo di pulizia
            bookedTotalOccupiedTime: payload.bookedTotalOccupiedTime, // Tempo totale di occupazione
            type: payload.type || 'cura_persona', 
            status: payload.status || 'confirmed', // Imposta 'confirmed' per prenotazioni manuali
            
            startDateTime: admin.firestore.Timestamp.fromDate(startDateTime),
            endDateTime: admin.firestore.Timestamp.fromDate(endDateTime), // Questa dovrebbe essere `endDateTime` calcolata
            
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            source: payload.source || 'website', 
            appointmentCode: payload.appointmentCode || ('WEB_' + Date.now().toString().slice(-6) + Math.floor(Math.random() * 1000).toString().padStart(3, '0')),
            isNew: true, // Aggiunto per le notifiche
            
            // Dettagli aggiuntivi cliente/servizio (opzionali)
            customerGender: payload.customerGender || null,
            customerAgeRange: payload.customerAgeRange || null,
            customerNotes: payload.customerNotes || null,
            selectedImageDetails: payload.selectedImageDetails || null,
        };
        
        const docRef = await db.collection('bookings').add(bookingData);

        return res.status(200).json({ 
            success: true, 
            message: 'Prenotazione creata con successo.',
            bookingId: docRef.id
        });
    }
    
    // =======================================================
    // LOGICA PER OTTENERE GLI SLOT DISPONIBILI PER UN SINGOLO GIORNO
    // =======================================================
    else if (action === 'getAvailableSlots') {
      const { serviceId, date } = req.body; 
      
      if (!vendorId || !serviceId || !date) {
        return res.status(400).json({ error: 'Dati mancanti per la verifica del servizio (vendorId, serviceId, date).' });
      }

      // Prepara il range di date per la query delle prenotazioni esistenti
      // Recupera le prenotazioni che iniziano il giorno prima o il giorno target
      const currentDayUTC = new Date(date + 'T00:00:00Z'); // Inizio del giorno target in UTC
      const dayBeforeUTC = new Date(currentDayUTC);
      dayBeforeUTC.setUTCDate(dayBeforeUTC.getUTCDate() - 1); // Inizio del giorno precedente

      const dayEndUTC = new Date(currentDayUTC);
      dayEndUTC.setUTCHours(23, 59, 59, 999); // Fine del giorno target in UTC

      const [serviceDoc, vendorDoc, bookingsSnapshot] = await Promise.all([
          db.collection('artisan_services').doc(serviceId).get(),
          db.collection('vendors').doc(vendorId).get(),
          db.collection('bookings')
            .where('vendorId', '==', vendorId)
            // Cerca prenotazioni che iniziano dal giorno prima fino alla fine del giorno target
            .where('startDateTime', '>=', admin.firestore.Timestamp.fromDate(dayBeforeUTC))
            .where('startDateTime', '<=', admin.firestore.Timestamp.fromDate(dayEndUTC))
            .where('status', 'in', ['confirmed', 'paid', 'pending', 'rescheduled'])
            .get()
      ]);

      if (!serviceDoc.exists) { return res.status(404).json({ error: 'Servizio non trovato.' }); }
      const serviceData = serviceDoc.data();
      
      // Usa totalOccupiedTimeMinutes per il calcolo degli slot
      let totalOccupiedTimeMinutes = serviceData.totalOccupiedTimeMinutes || serviceData.serviceDuration; // Fallback se non definito
      if (!totalOccupiedTimeMinutes || totalOccupiedTimeMinutes <= 0) { return res.status(400).json({ error: 'Durata totale del servizio non specificata o non valida.' }); }

      if (!vendorDoc.exists || !vendorDoc.data().opening_hours_structured) { return res.status(200).json({ slots: [], message: 'Orari del negozio non configurati.' }); }
      
      const dayOfWeek = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"][currentDayUTC.getUTCDay()];
      const todayHours = vendorDoc.data().opening_hours_structured.find(d => d.day === dayOfWeek);
      
      if (!todayHours || !todayHours.isOpen) { return res.status(200).json({ slots: [], message: 'Negozio chiuso in questo giorno.' }); }

      // FILTRA LE PRENOTAZIONI RECUPERATE PER VERIFICARE LA REALE SOVRAPPOSIZIONE CON IL GIORNO TARGET
      const existingBookings = bookingsSnapshot.docs.map(doc => ({
        start: doc.data().startDateTime.toDate(), 
        end: doc.data().endDateTime.toDate(), // endDateTime è già la fine dell'occupazione
      })).filter(booking => {
          // Un booking si sovrappone al giorno target se:
          // (inizio booking < fine giorno target) AND (fine booking > inizio giorno target)
          return booking.start.getTime() < dayEndUTC.getTime() && booking.end.getTime() > currentDayUTC.getTime();
      });


      const availableSlots = [];
      const slotIncrement = 5; // Slot di intervallo di 5 minuti per maggiore precisione

      // Riferimento all'ora attuale (UTC) per bloccare slot nel passato del giorno corrente
      const nowUtc = new Date(); 

      for (const slot of todayHours.slots) {
          if (!slot.from || !slot.to) continue;
          
          const [startHour, startMinute] = slot.from.split(':').map(Number);
          const [endHour, endMinute] = slot.to.split(':').map(Number);
          
          // Costruisci gli oggetti Date per gli orari di inizio e fine dello slot di lavoro (in UTC)
          let currentWorkSlotStart = new Date(currentDayUTC); 
          currentWorkSlotStart.setUTCHours(startHour, startMinute, 0, 0); 

          const currentWorkSlotEnd = new Date(currentDayUTC);
          currentWorkSlotEnd.setUTCHours(endHour, endMinute, 0, 0);
          
          // Se siamo nel giorno corrente, inizia la ricerca dall'ora attuale (arrotondata) o dall'inizio dello slot, il più tardi
          let currentSlotTime = new Date(currentWorkSlotStart); 

          // Arrotonda l'ora corrente al prossimo incremento di `slotIncrement` solo se è il giorno di oggi E l'ora corrente è passata
          if (currentDayUTC.toDateString() === nowUtc.toDateString() && currentSlotTime.getTime() < nowUtc.getTime()) {
              const currentMins = nowUtc.getUTCMinutes();
              const remainder = currentMins % slotIncrement;
              currentSlotTime = new Date(nowUtc); // Inizia dall'ora attuale
              if (remainder !== 0) {
                  currentSlotTime.setUTCMinutes(currentMins + (slotIncrement - remainder));
              }
              currentSlotTime.setUTCSeconds(0,0); // Azzera secondi e millisecondi
          }
          
          // Se l'ora di inizio del ciclo (dopo l'arrotondamento) è già oltre la fine dello slot di lavoro, salta
          if (currentSlotTime.getTime() >= currentWorkSlotEnd.getTime()) continue; 


          while (currentSlotTime.getTime() < currentWorkSlotEnd.getTime()) {
              // Usa totalOccupiedTimeMinutes per determinare la fine dell'occupazione del potenziale slot
              const potentialEndTime = new Date(currentSlotTime.getTime() + totalOccupiedTimeMinutes * 60000);
              if (potentialEndTime.getTime() > currentWorkSlotEnd.getTime()) break; 

              let isAvailable = true;
              let nextJumpTime = new Date(currentSlotTime.getTime() + slotIncrement * 60000); // Default advance

              // Controlla sovrapposizione con prenotazioni esistenti
              for (const booking of existingBookings) {
                  // Condizione di sovrapposizione: (inizio nuovo < fine esistente) E (inizio esistente < fine nuovo)
                  const overlaps = (currentSlotTime.getTime() < booking.end.getTime() && booking.start.getTime() < potentialEndTime.getTime());
                  
                  if (overlaps) {
                      isAvailable = false;
                      // Se c'è una sovrapposizione, dobbiamo saltare oltre la fine della prenotazione che blocca
                      const blockingBookingEndTime = booking.end.getTime();
                      if (blockingBookingEndTime > nextJumpTime.getTime()) { // Se blocca più a lungo del prossimo slot normale
                          let newTime = new Date(blockingBookingEndTime);
                          const mins = newTime.getUTCMinutes();
                          const remainder = mins % slotIncrement;
                          if (remainder !== 0) {
                              newTime.setUTCMinutes(mins + (slotIncrement - remainder));
                          }
                          newTime.setUTCSeconds(0,0); // Azzera secondi e millisecondi
                          nextJumpTime = newTime;
                      }
                      break; // Trovata una sovrapposizione, non serve controllare le altre prenotazioni per questo `currentSlotTime`
                  }
              }
              
              if (isAvailable) {
                  const hours = String(currentSlotTime.getUTCHours()).padStart(2, '0');
                  const minutes = String(currentSlotTime.getUTCMinutes()).padStart(2, '0');
                  availableSlots.push(`${hours}:${minutes}`);
                  // Se disponibile, avanza al prossimo slot standard
                  currentSlotTime.setUTCMinutes(currentSlotTime.getUTCMinutes() + slotIncrement);
              } else {
                  // Se non disponibile, salta all'ora calcolata da `nextJumpTime`
                  currentSlotTime = nextJumpTime;
              }
          }
      }
      
      return res.status(200).json({ slots: availableSlots });
    }
    
    // =======================================================
    // LOGICA PER OTTENERE IL RIEPILOGO MENSILE DELLA DISPONIBILITÀ (per i pallini sul calendario)
    // =======================================================
    else if (action === 'getMonthlyAvailabilitySummary') {
        const { vendorId, serviceId, year, month } = req.body; // month è 0-indexed per JavaScript Date

        if (!vendorId || !serviceId || year === undefined || month === undefined) {
            return res.status(400).json({ error: 'Dati mancanti per il riepilogo mensile (vendorId, serviceId, year, month).' });
        }

        // Calcola il range di date per la query delle prenotazioni esistenti
        const firstDayOfMonth = new Date(Date.UTC(year, month, 1));
        const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));

        // Per recuperare le prenotazioni che iniziano prima del mese ma finiscono dentro,
        // retrocediamo di un giorno l'inizio della query.
        const queryStartDateTime = new Date(firstDayOfMonth);
        queryStartDateTime.setUTCDate(queryStartDateTime.getUTCDate() - 1); 

        const [serviceDoc, vendorDoc] = await Promise.all([
            db.collection('artisan_services').doc(serviceId).get(),
            db.collection('vendors').doc(vendorId).get()
        ]);

        if (!serviceDoc.exists) { return res.status(404).json({ error: 'Servizio non trovato.' }); }
        const serviceData = serviceDoc.data();
        
        // Usa totalOccupiedTimeMinutes per il calcolo degli slot
        let totalOccupiedTimeMinutes = serviceData.totalOccupiedTimeMinutes || serviceData.serviceDuration; // Fallback se non definito
        if (!totalOccupiedTimeMinutes || totalOccupiedTimeMinutes <= 0) { return res.status(400).json({ error: 'Durata totale del servizio non specificata o non valida.' }); }

        if (!vendorDoc.exists || !vendorDoc.data().opening_hours_structured) { return res.status(200).json({ summary: {}, message: 'Orari del negozio non configurati.' }); }
        const vendorOpeningHours = vendorDoc.data().opening_hours_structured;

        const bookingsSnapshot = await db.collection('bookings')
            .where('vendorId', '==', vendorId)
            // Cerca prenotazioni che iniziano dal giorno prima del mese fino alla fine del mese
            .where('startDateTime', '>=', admin.firestore.Timestamp.fromDate(queryStartDateTime))
            .where('startDateTime', '<=', admin.firestore.Timestamp.fromDate(lastDayOfMonth))
            .where('status', 'in', ['confirmed', 'paid', 'pending', 'rescheduled'])
            .get();

        // FILTRA LE PRENOTAZIONI RECUPERATE PER VERIFICARE LA REALE SOVRAPPOSIZIONE CON IL MESE TARGET
        const existingBookings = bookingsSnapshot.docs.map(doc => ({
            start: doc.data().startDateTime.toDate(),
            end: doc.data().endDateTime.toDate(), // endDateTime è già la fine dell'occupazione
        })).filter(booking => {
            // Un booking si sovrappone al mese target se:
            // (inizio booking < fine mese target) AND (fine booking > inizio mese target)
            return booking.start.getTime() < lastDayOfMonth.getTime() && booking.end.getTime() > firstDayOfMonth.getTime();
        });


        const monthlySummary = {};
        const slotIncrement = 5; // Slot di intervallo di 5 minuti per maggiore precisione
        const nowUtc = new Date(); // Data e ora attuali in UTC

        // Loop attraverso ogni giorno del mese
        for (let day = 1; day <= new Date(year, month + 1, 0).getDate(); day++) {
            const currentDate = new Date(Date.UTC(year, month, day)); // Giorno corrente in UTC
            const formattedDate = currentDate.toISOString().split('T')[0]; // "YYYY-MM-DD"

            // Se il giorno è completamente nel passato per questo servizio, salta
            // Si considera "passato" se anche il potenziale primo slot del servizio (minima durata) termina prima di nowUtc
            if (currentDate.getTime() + (totalOccupiedTimeMinutes * 60 * 1000) <= nowUtc.getTime()) {
                monthlySummary[formattedDate] = false; // Nessuna disponibilità
                continue;
            }

            const dayOfWeek = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"][currentDate.getUTCDay()];
            const todayHours = vendorOpeningHours.find(h => h.day === dayOfWeek);

            if (!todayHours || !todayHours.isOpen) {
                monthlySummary[formattedDate] = false; // Negozio chiuso
                continue;
            }

            let hasAvailableSlotForDay = false;
            
            // Loop attraverso gli slot di lavoro del giorno
            for (const slot of todayHours.slots) {
                if (!slot.from || !slot.to) continue;

                const [startHour, startMinute] = slot.from.split(':').map(Number);
                const [endHour, endMinute] = slot.to.split(':').map(Number);

                // Inizio e fine dello slot di lavoro (in UTC per il giorno corrente)
                let currentWorkSlotStart = new Date(currentDate);
                currentWorkSlotStart.setUTCHours(startHour, startMinute, 0, 0);

                const currentWorkSlotEnd = new Date(currentDate);
                currentWorkSlotEnd.setUTCHours(endHour, endMinute, 0, 0);

                // L'ora di inizio effettiva per cercare gli slot, considerando l'ora attuale se è il giorno odierno
                let searchStartTime = new Date(currentWorkSlotStart);

                // Se è il giorno corrente e l'inizio dello slot di lavoro è già passato rispetto all'ora attuale
                if (currentDate.toDateString() === nowUtc.toDateString() && searchStartTime.getTime() < nowUtc.getTime()) {
                    searchStartTime = new Date(nowUtc); // Inizia a cercare dall'ora attuale
                    // Arrotonda all'incremento di slot successivo
                    const currentMins = searchStartTime.getUTCMinutes();
                    const remainder = currentMins % slotIncrement;
                    if (remainder !== 0) {
                        searchStartTime.setUTCMinutes(currentMins + (slotIncrement - remainder));
                    }
                    searchStartTime.setUTCSeconds(0,0);
                }

                // Se dopo gli aggiustamenti searchStartTime è oltre la fine dello slot di lavoro, salta
                if (searchStartTime.getTime() >= currentWorkSlotEnd.getTime()) continue;

                let currentSlotTime = new Date(searchStartTime);

                // Loop interno per trovare il primo slot disponibile nel range di lavoro
                while (currentSlotTime.getTime() < currentWorkSlotEnd.getTime()) {
                    // Usa totalOccupiedTimeMinutes per determinare la fine dell'occupazione del potenziale slot
                    const potentialEndTime = new Date(currentSlotTime.getTime() + totalOccupiedTimeMinutes * 60000);
                    if (potentialEndTime.getTime() > currentWorkSlotEnd.getTime()) break;

                    let isAvailable = true;
                    let nextJumpTime = new Date(currentSlotTime.getTime() + slotIncrement * 60000); // Default advance

                    for (const booking of existingBookings) {
                        const overlaps = (currentSlotTime.getTime() < booking.end.getTime() && booking.start.getTime() < potentialEndTime.getTime());
                        
                        if (overlaps) {
                            isAvailable = false;
                            const blockingBookingEndTime = booking.end.getTime();
                            if (blockingBookingEndTime > nextJumpTime.getTime()) {
                                let newTime = new Date(blockingBookingEndTime);
                                const mins = newTime.getUTCMinutes();
                                const remainder = mins % slotIncrement;
                                if (remainder !== 0) {
                                    newTime.setUTCMinutes(mins + (slotIncrement - remainder));
                                }
                                newTime.setUTCSeconds(0,0);
                                nextJumpTime = newTime;
                            }
                            break; 
                        }
                    }

                    if (isAvailable) {
                        hasAvailableSlotForDay = true;
                        break; // Trovato almeno uno slot disponibile per questo giorno
                    } else {
                        currentSlotTime = nextJumpTime;
                    }
                }
                if (hasAvailableSlotForDay) break; // Se trovato uno slot per il giorno, esci dal loop degli slot di lavoro
            }
            monthlySummary[formattedDate] = hasAvailableSlotForDay;
        }

        return res.status(200).json({ summary: monthlySummary, message: 'Riepilogo disponibilità mensile generato.' });
    }

    // =======================================================
    // NUOVA LOGICA: OTTENERE GLI SLOT DISPONIBILI PER UN RANGE DI DATE E PIÙ SERVIZI (per FullCalendar)
    // =======================================================
    else if (action === 'getAvailableSlotsRange') {
        const { vendorId, serviceIds, start_date, end_date } = req.body;

        if (!vendorId || !serviceIds || !Array.isArray(serviceIds) || serviceIds.length === 0 || !start_date || !end_date) {
            return res.status(400).json({ error: 'Dati mancanti per il recupero degli slot per range (vendorId, serviceIds, start_date, end_date).' });
        }

        const startDateObj = new Date(start_date + 'T00:00:00Z');
        const endDateObj = new Date(end_date + 'T23:59:59Z');

        // Prepara il range di date per la query delle prenotazioni esistenti
        // Retrocediamo di un giorno l'inizio della query per catturare le prenotazioni che iniziano prima ma si estendono nel range.
        const queryStartDate = new Date(startDateObj);
        queryStartDate.setUTCDate(queryStartDate.getUTCDate() - 1); 

        // Carica tutti i servizi richiesti e gli orari di apertura del venditore in una volta
        const [servicesSnapshot, vendorDoc] = await Promise.all([
            db.collection('artisan_services').where(admin.firestore.FieldPath.documentId(), 'in', serviceIds).get(),
            db.collection('vendors').doc(vendorId).get()
        ]);

        const servicesData = new Map();
        servicesSnapshot.docs.forEach(doc => {
            servicesData.set(doc.id, doc.data());
        });

        if (!vendorDoc.exists || !vendorDoc.data().opening_hours_structured) {
            return res.status(200).json({ availableSlots: {}, message: 'Orari del venditore non configurati.' });
        }
        const vendorOpeningHours = vendorDoc.data().opening_hours_structured;

        // Carica tutte le prenotazioni esistenti per l'intero range di date, con un buffer iniziale
        const bookingsSnapshot = await db.collection('bookings')
            .where('vendorId', '==', vendorId)
            // Cerca prenotazioni che iniziano dal giorno prima del range fino alla fine del range
            .where('startDateTime', '>=', admin.firestore.Timestamp.fromDate(queryStartDate))
            .where('startDateTime', '<=', admin.firestore.Timestamp.fromDate(endDateObj))
            .where('status', 'in', ['confirmed', 'paid', 'pending', 'rescheduled'])
            .get();

        // FILTRA LE PRENOTAZIONI RECUPERATE PER VERIFICARE LA REALE SOVRAPPOSIZIONE CON IL RANGE TARGET
        const existingBookings = bookingsSnapshot.docs.map(doc => ({
            start: doc.data().startDateTime.toDate(),
            end: doc.data().endDateTime.toDate(),
            serviceId: doc.data().serviceId,
        })).filter(booking => {
            // Un booking si sovrappone al range target se:
            // (inizio booking < fine range target) AND (fine booking > inizio range target)
            return booking.start.getTime() < endDateObj.getTime() && booking.end.getTime() > startDateObj.getTime();
        });


        const availableSlotsPerService = {};
        const slotIncrement = 5; // Intervallo di slot di 5 minuti

        const nowUtc = new Date();

        for (const serviceId of serviceIds) {
            const service = servicesData.get(serviceId);
            if (!service) continue; // Salta se il servizio non è stato trovato o è stato eliminato

            const totalOccupiedTimeMinutes = service.totalOccupiedTimeMinutes || service.serviceDuration; // Fallback se non definito
            if (!totalOccupiedTimeMinutes || totalOccupiedTimeMinutes <= 0) continue; // Salta se la durata non è valida

            availableSlotsPerService[serviceId] = [];

            // Itera per ogni giorno nel range
            // Uso `Date.prototype.setUTCDate` e `Date.prototype.getUTCDate` per evitare problemi di fuso orario con i loop
            for (let d = new Date(startDateObj); d.getTime() <= endDateObj.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
                const currentDate = new Date(d); // Clona la data per evitare modifiche al ciclo
                currentDate.setUTCHours(0, 0, 0, 0); // Normalizza a inizio giornata UTC

                const formattedDate = currentDate.toISOString().split('T')[0];

                // Se il giorno è completamente nel passato per questo servizio, salta
                if (currentDate.getTime() + (totalOccupiedTimeMinutes * 60 * 1000) <= nowUtc.getTime()) {
                     continue;
                }

                const dayOfWeek = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"][currentDate.getUTCDay()];
                const todayHours = vendorOpeningHours.find(h => h.day === dayOfWeek);

                if (!todayHours || !todayHours.isOpen) continue;

                // Filtra le prenotazioni per il giorno corrente dal set di `existingBookings`
                const bookingsForDay = existingBookings.filter(booking => {
                    const bookingDayStart = new Date(booking.start);
                    bookingDayStart.setUTCHours(0, 0, 0, 0);
                    const bookingDayEnd = new Date(booking.end);
                    bookingDayEnd.setUTCHours(23, 59, 59, 999);
                    // Un booking è rilevante per questo `currentDate` se si sovrappone al 24h interval di `currentDate`
                    return booking.start.getTime() < new Date(currentDate).setUTCHours(23,59,59,999) && booking.end.getTime() > currentDate.getTime();
                });

                for (const slot of todayHours.slots) {
                    if (!slot.from || !slot.to) continue;

                    const [startHour, startMinute] = slot.from.split(':').map(Number);
                    const [endHour, endMinute] = slot.to.split(':').map(Number);

                    let currentWorkSlotStart = new Date(currentDate);
                    currentWorkSlotStart.setUTCHours(startHour, startMinute, 0, 0);

                    const currentWorkSlotEnd = new Date(currentDate);
                    currentWorkSlotEnd.setUTCHours(endHour, endMinute, 0, 0);

                    let searchStartTime = new Date(currentWorkSlotStart);

                    if (currentDate.toDateString() === nowUtc.toDateString() && searchStartTime.getTime() < nowUtc.getTime()) {
                        searchStartTime = new Date(nowUtc);
                        const currentMins = searchStartTime.getUTCMinutes();
                        const remainder = currentMins % slotIncrement;
                        if (remainder !== 0) {
                            searchStartTime.setUTCMinutes(currentMins + (slotIncrement - remainder));
                        }
                        searchStartTime.setUTCSeconds(0,0);
                    }
                    if (searchStartTime.getTime() >= currentWorkSlotEnd.getTime()) continue;

                    let currentSlotTime = new Date(searchStartTime);

                    while (currentSlotTime.getTime() < currentWorkSlotEnd.getTime()) {
                        const potentialEndTime = new Date(currentSlotTime.getTime() + totalOccupiedTimeMinutes * 60000);
                        if (potentialEndTime.getTime() > currentWorkSlotEnd.getTime()) break;

                        let isAvailable = true;
                        let nextJumpTime = new Date(currentSlotTime.getTime() + slotIncrement * 60000);

                        for (const booking of bookingsForDay) {
                            const overlaps = (currentSlotTime.getTime() < booking.end.getTime() && booking.start.getTime() < potentialEndTime.getTime());
                            
                            if (overlaps) {
                                isAvailable = false;
                                const blockingBookingEndTime = booking.end.getTime();
                                if (blockingBookingEndTime > nextJumpTime.getTime()) {
                                    let newTime = new Date(blockingBookingEndTime);
                                    const mins = newTime.getUTCMinutes();
                                    const remainder = mins % slotIncrement;
                                    if (remainder !== 0) {
                                        newTime.setUTCMinutes(mins + (slotIncrement - remainder));
                                    }
                                    newTime.setUTCSeconds(0,0);
                                    nextJumpTime = newTime;
                                }
                                break;
                            }
                        }

                        if (isAvailable) {
                            availableSlotsPerService[serviceId].push({
                                serviceId: serviceId,
                                time: currentSlotTime.toISOString(),
                                duration: totalOccupiedTimeMinutes // Tempo di occupazione
                            });
                            currentSlotTime.setUTCMinutes(currentSlotTime.getUTCMinutes() + slotIncrement);
                        } else {
                            currentSlotTime = nextJumpTime;
                        }
                    }
                }
            }
        }
        return res.status(200).json({ availableSlots: availableSlotsPerService, message: 'Slot disponibili per range di servizi generati.' });
    }
    // =======================================================
    // NUOVA LOGICA: REGISTRAZIONE CLIENTE PREFERITO
    // =======================================================
    else if (action === 'register_preferred_client') {
        const { vendorId, name, surname, phone, email, notes } = req.body;

        if (!vendorId || !name || !phone) {
            return res.status(400).json({ error: 'Dati cliente incompleti. ID negoziante, nome e telefono sono obbligatori.' });
        }
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
             return res.status(400).json({ error: 'Formato email non valido.' });
        }
        if (vendorId.length !== 20) { 
            return res.status(400).json({ error: 'ID negoziante non valido.' });
        }
        
        const vendorRef = db.collection('vendors').doc(vendorId);
        const vendorDoc = await vendorRef.get();
        if (!vendorDoc.exists) {
            return res.status(404).json({ error: 'Negoziante non trovato.' });
        }

        // Verifica se un cliente con lo stesso nome e telefono esiste già per questo venditore
        const existingClientSnap = await vendorRef.collection('clients')
            .where('name', '==', name)
            .where('phone', '==', phone)
            .limit(1)
            .get();

        if (!existingClientSnap.empty) {
            // Se esiste, aggiorniamo il cliente esistente invece di crearne uno nuovo
            const existingClientDoc = existingClientSnap.docs[0];
            const updatedData = {
                surname: surname || existingClientDoc.data().surname || null,
                email: email || existingClientDoc.data().email || null,
                notes: notes || existingClientDoc.data().notes || null,
                lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
                source: 'civora_storefront_update', // Aggiornato dalla vetrina
            };
            await existingClientDoc.ref.update(updatedData);
            return res.status(200).json({ 
                success: true, 
                message: 'Cliente preferito aggiornato con successo.',
                clientId: existingClientDoc.id
            });
        }


        // Altrimenti, aggiungi un nuovo documento
        const clientData = {
            name: name,
            surname: surname || null,
            phone: phone,
            email: email || null,
            notes: notes || null,
            registeredAt: admin.firestore.FieldValue.serverTimestamp(),
            lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
            source: 'civora_storefront',
        };

        const docRef = await vendorRef.collection('clients').add(clientData);

        return res.status(200).json({ 
            success: true, 
            message: 'Cliente preferito registrato con successo.',
            clientId: docRef.id
        });
    }

  } catch (error) {
    console.error('Errore nella funzione Vercel:', error);
    res.status(500).json({ error: 'Errore interno del server.', details: error.message });
  }
};
