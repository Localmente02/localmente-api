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
    'https://localmente-site.web.app', // LA NUOVA ORIGINE CHE CAUSAVA IL PROBLEMA
    // Aggiungi qui anche gli URL di test o localhost se necessario
];

// 2. Funzione per impostare dinamicamente l'header CORS
function setCorsHeaders(req, res) {
    const origin = req.headers.origin;
    
    // Se l'origine non è definita (ad esempio, chiamata da browser) o non è nella lista, usiamo un fallback.
    // Nel tuo caso, vogliamo rispondere con l'origine esatta se consentita.
    if (ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } 
    // Opzione alternativa di debug: res.setHeader('Access-Control-Allow-Origin', '*'); 
    // MA è meno sicuro, preferiamo la lista esplicita.

    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
}


module.exports = async (req, res) => {
  
  // Imposta gli header di risposta in base all'origine della richiesta
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    // La richiesta preflight OPTIONS deve solo restituire 200 con gli header impostati
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non consentito. Utilizzare POST.' });
  }

  try {
    const { bookingType, vendorId } = req.body;

    if (bookingType === 'rental_fleet_check') {
      const { startDate, endDate } = req.body;
      if (!vendorId || !startDate || !endDate) {
        return res.status(400).json({ error: 'Dati mancanti per la verifica della flotta.' });
      }
      
      const start = new Date(startDate);
      const end = new Date(endDate);

      const vehiclesSnapshot = await db.collection('noleggio_veicoli').where('vendorId', '==', vendorId).get();
      
      if (vehiclesSnapshot.empty) {
        return res.status(200).json({ availableVehicles: [], unavailableVehicles: [] });
      }
      
      const allVehicles = vehiclesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const allVehicleIds = allVehicles.map(v => v.id);

      const bookingsSnapshot = await db.collection('bookings')
        .where('vendorId', '==', vendorId)
        .where('serviceId', 'in', allVehicleIds)
        .where('type', '==', 'noleggio')
        .where('status', 'in', ['confirmed', 'paid']) // Aggiungo 'paid' per sicurezza
        .get();

      const conflictingBookings = bookingsSnapshot.docs.map(doc => {
          const booking = doc.data();
          const bookingStart = booking.startDateTime.toDate();
          const bookingEnd = booking.endDateTime.toDate();
          if (start < bookingEnd && end > bookingStart) {
              return {
                  vehicleId: booking.serviceId,
                  customerName: booking.customerName,
                  endDate: bookingEnd.toISOString().split('T')[0]
              };
          }
          return null;
      }).filter(Boolean);

      const unavailableVehicleIds = new Set(conflictingBookings.map(b => b.vehicleId));

      const availableVehicles = allVehicles
        .filter(v => !unavailableVehicleIds.has(v.id))
        .map(v => ({ id: v.id, model: v.model, price: v.pricePerDay }));

      const unavailableVehicles = allVehicles
        .filter(v => unavailableVehicleIds.has(v.id))
        .map(v => {
            const conflict = conflictingBookings.find(b => b.vehicleId === v.id);
            // Assicurati che conflict esista prima di accedere alle sue proprietà
            if (conflict) {
                return {
                    id: v.id,
                    model: v.model,
                    conflictInfo: `Prenotato da ${conflict.customerName} fino al ${new Date(conflict.endDate).toLocaleDateString('it-IT')}`
                };
            }
            return { id: v.id, model: v.model, conflictInfo: 'Non disponibile (dettagli non trovati)' };
        });

      return res.status(200).json({ availableVehicles, unavailableVehicles });

    } else {
      // --- LOGICA PER I SERVIZI (slots) ---
      const { serviceId, date } = req.body;
      if (!vendorId || !serviceId || !date) {
        return res.status(400).json({ error: 'Dati mancanti per la verifica del servizio.' });
      }

      const [serviceDoc, vendorDoc, resourcesSnapshot, bookingsSnapshot] = await Promise.all([
          db.collection('offers').doc(serviceId).get(),
          db.collection('vendors').doc(vendorId).get(),
          db.collection('vendors').doc(vendorId).collection('resources').get(),
          db.collection('bookings')
            .where('vendorId', '==', vendorId)
            .where('startDateTime', '>=', new Date(date + 'T00:00:00Z'))
            .where('startDateTime', '<=', new Date(date + 'T23:59:59Z'))
            .where('status', 'in', ['confirmed', 'paid']) // Considera solo le prenotazioni confermate/pagate
            .get()
      ]);

      if (!serviceDoc.exists || !serviceDoc.data().serviceDuration) { return res.status(404).json({ error: 'Servizio non trovato o senza durata.' }); }
      const serviceData = serviceDoc.data();
      const serviceDuration = serviceData.serviceDuration;
      const requirements = serviceData.requirements || [];

      if (!vendorDoc.exists || !vendorDoc.data().opening_hours_structured) { return res.status(200).json({ slots: [], message: 'Orari non configurati.' }); }
      
      const dateObj = new Date(date + 'T00:00:00Z');
      // getUTCDay() ritorna 0=Dom, 1=Lun...
      const dayOfWeek = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"][dateObj.getUTCDay()];
      const todayHours = vendorDoc.data().opening_hours_structured.find(d => d.day === dayOfWeek);
      
      if (!todayHours || !todayHours.isOpen) { return res.status(200).json({ slots: [], message: 'Negozio chiuso.' }); }

      const allResources = resourcesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const existingBookings = bookingsSnapshot.docs.map(doc => ({
        start: doc.data().startDateTime.toDate(),
        end: doc.data().endDateTime.toDate(),
        assignedResourceIds: doc.data().assignedResourceIds || []
      }));

      const availableSlots = [];
      const slotIncrement = 15; // Incremento di 15 minuti per slot

      for (const slot of todayHours.slots) {
          if (!slot.from || !slot.to) continue;
          
          // Usiamo la data di oggi e applichiamo l'orario di lavoro (UTC)
          const [startHour, startMinute] = slot.from.split(':').map(Number);
          const [endHour, endMinute] = slot.to.split(':').map(Number);
          
          let currentTime = new Date(date + 'T00:00:00Z');
          currentTime.setUTCHours(startHour, startMinute, 0, 0);
          
          const endOfWorkSlot = new Date(date + 'T00:00:00Z');
          endOfWorkSlot.setUTCHours(endHour, endMinute, 0, 0);

          // Controllo per non mostrare slot nel passato (rispetto all'ora attuale UTC)
          const nowUtc = new Date();
          const startSearchTime = (currentTime < nowUtc) ? nowUtc : currentTime;
          
          // Allineamento al primo slot valido
          let currentSlotTime = new Date(startSearchTime);
          // Arrotonda all'incremento più vicino (es. se ora è 10:07, arrotonda a 10:15)
          const currentMins = currentSlotTime.getUTCMinutes();
          const remainder = currentMins % slotIncrement;
          if (remainder !== 0) {
              currentSlotTime.setUTCMinutes(currentMins + (slotIncrement - remainder));
          }

          // Se l'orario arrotondato supera l'inizio della fascia oraria, saltiamo questa fascia
          if (currentSlotTime >= endOfWorkSlot) continue;


          while (currentSlotTime < endOfWorkSlot) {
              const potentialEndTime = new Date(currentSlotTime.getTime() + serviceDuration * 60000);
              if (potentialEndTime > endOfWorkSlot) break;

              let areAllRequirementsMet = true;
              
              if (requirements.length > 0) {
                  // Caso con risorse (staff o cabine)
                  for (const req of requirements) {
                      const resourcesInGroup = allResources.filter(r => r.groupId === req.groupId);
                      
                      // 3. Controlla quante risorse nel gruppo sono disponibili
                      const availableResourcesInGroup = resourcesInGroup.filter(resource => {
                          const isBusy = existingBookings.some(booking => 
                              booking.assignedResourceIds.includes(resource.id) &&
                              // Conflitto se il nuovo slot inizia prima che la vecchia prenotazione finisca 
                              // E il nuovo slot finisce dopo che la vecchia prenotazione è iniziata
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
                  // Caso SENZA risorse (assumi che lo studio possa gestire solo 1 servizio alla volta)
                  const isTimeSlotBusy = existingBookings.some(booking =>
                      currentSlotTime < booking.end && potentialEndTime > booking.start
                  );
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
      
      return res.status(200).json({ slots: availableSlots });
    }
  } catch (error) {
    console.error('Errore in get-available-slots:', error);
    res.status(500).json({ error: 'Errore interno del server.', details: error.message });
  }
};
